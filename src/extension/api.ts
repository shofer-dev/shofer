import { EventEmitter } from "events"
import fs from "fs/promises"
import * as path from "path"
import * as os from "os"

import * as vscode from "vscode"
import pWaitFor from "p-wait-for"

import {
	type ShoferAPI,
	type ShoferSettings,
	type ShoferEvents,
	type ProviderSettings,
	type ProviderSettingsEntry,
	type TaskEvent,
	type CreateTaskOptions,
	type HistoryItem,
	ShoferEventName,
	TaskCommandName,
	isSecretStateKey,
	IpcOrigin,
	IpcMessageType,
} from "@shofer/types"
import { IpcServer } from "@shofer/ipc"

import { Package } from "../shared/package"
import { ShoferProvider } from "../core/webview/ShoferProvider"
import { openShoferInNewTab } from "../activate/registerCommands"
import { getCommands } from "../services/command/commands"
import { getModels } from "../api/providers/fetchers/modelCache"
import { utilLog } from "../utils/logging/subsystems"
import { getRecentLogs, getLogLevel, getLogKnownCategories } from "../utils/logging"
import { buildJsonTrace } from "../integrations/misc/export-json"
import { formatContentBlockToMarkdown, getTaskFileName } from "../integrations/misc/export-markdown"
import { createWorkflowTask, discoverWorkflows } from "../core/workflow/index"

export class API extends EventEmitter<ShoferEvents> implements ShoferAPI {
	private readonly outputChannel: vscode.OutputChannel
	private readonly sidebarProvider: ShoferProvider
	private readonly context: vscode.ExtensionContext
	private readonly ipc?: IpcServer
	private readonly log: (...args: unknown[]) => void
	private logfile?: string

	constructor(
		outputChannel: vscode.OutputChannel,
		provider: ShoferProvider,
		socketPath?: string,
		enableLogging = false,
	) {
		super()

		this.outputChannel = outputChannel
		this.sidebarProvider = provider
		this.context = provider.context

		if (enableLogging) {
			this.log = (...args: unknown[]) => {
				this.outputChannelLog(...args)
				utilLog.info(args.map((a) => String(a)).join(" "))
			}

			this.logfile = path.join(os.tmpdir(), "shofer-code-messages.log")
		} else {
			this.log = () => {}
		}

		this.registerListeners(this.sidebarProvider)

		if (socketPath) {
			const ipc = (this.ipc = new IpcServer(socketPath, this.log))

			ipc.listen()
			this.log(`[API] ipc server started: socketPath=${socketPath}, pid=${process.pid}, ppid=${process.ppid}`)

			ipc.on(IpcMessageType.TaskCommand, async (clientId, command) => {
				const sendResponse = (eventName: ShoferEventName, payload: unknown[]) => {
					ipc.send(clientId, {
						type: IpcMessageType.TaskEvent,
						origin: IpcOrigin.Server,
						data: { eventName, payload } as TaskEvent,
					})
				}

				switch (command.commandName) {
					case TaskCommandName.StartNewTask:
						this.log(
							`[API] StartNewTask -> ${command.data.text}, ${JSON.stringify(command.data.configuration)}`,
						)
						await this.startNewTask(command.data)
						break
					case TaskCommandName.CancelTask:
						this.log(`[API] CancelTask`)
						await this.cancelCurrentTask()
						break
					case TaskCommandName.CloseTask:
						this.log(`[API] CloseTask`)
						await vscode.commands.executeCommand("workbench.action.files.saveFiles")
						await vscode.commands.executeCommand("workbench.action.closeWindow")
						break
					case TaskCommandName.ResumeTask:
						this.log(`[API] ResumeTask -> ${command.data}`)
						try {
							await this.resumeTask(command.data)
						} catch (error) {
							const errorMessage = error instanceof Error ? error.message : String(error)
							this.log(`[API] ResumeTask failed for taskId ${command.data}: ${errorMessage}`)
							// Don't rethrow - we want to prevent IPC server crashes.
							// The error is logged for debugging purposes.
						}
						break
					case TaskCommandName.SendMessage:
						this.log(`[API] SendMessage -> ${command.data.text}`)
						await this.sendMessage(command.data.text, command.data.images)
						break
					case TaskCommandName.GetCommands:
						try {
							const commands = await getCommands(this.sidebarProvider.cwd)

							sendResponse(ShoferEventName.CommandsResponse, [
								commands.map((cmd) => ({
									name: cmd.name,
									source: cmd.source,
									filePath: cmd.filePath,
									description: cmd.description,
									argumentHint: cmd.argumentHint,
								})),
							])
						} catch (error) {
							sendResponse(ShoferEventName.CommandsResponse, [[]])
						}

						break
					case TaskCommandName.GetModes:
						try {
							const modes = await this.sidebarProvider.getModes()
							sendResponse(ShoferEventName.ModesResponse, [modes])
						} catch (error) {
							sendResponse(ShoferEventName.ModesResponse, [[]])
						}

						break
					case TaskCommandName.GetModels:
						try {
							sendResponse(ShoferEventName.ModelsResponse, [{}])
						} catch (error) {
							sendResponse(ShoferEventName.ModelsResponse, [{}])
						}

						break
					case TaskCommandName.DeleteQueuedMessage:
						this.log(`[API] DeleteQueuedMessage -> ${command.data}`)
						try {
							this.deleteQueuedMessage(command.data)
						} catch (error) {
							const errorMessage = error instanceof Error ? error.message : String(error)
							this.log(`[API] DeleteQueuedMessage failed for messageId ${command.data}: ${errorMessage}`)
						}
						break
					case TaskCommandName.ShowTaskWithId:
						this.log(`[API] ShowTaskWithId -> ${command.data.taskId}`)
						try {
							await this.showTaskWithId(command.data.taskId, {
								keepCurrentTask: command.data.keepCurrentTask,
							})
						} catch (error) {
							const errorMessage = error instanceof Error ? error.message : String(error)
							this.log(`[API] ShowTaskWithId failed: ${errorMessage}`)
						}
						break
					case TaskCommandName.RenameTask:
						this.log(`[API] RenameTask -> ${command.data.taskId}`)
						try {
							await this.renameTask(command.data.taskId, command.data.name)
						} catch (error) {
							const errorMessage = error instanceof Error ? error.message : String(error)
							this.log(`[API] RenameTask failed: ${errorMessage}`)
						}
						break
					case TaskCommandName.ArchiveTask:
						this.log(`[API] ArchiveTask -> ${command.data}`)
						try {
							await this.archiveTask(command.data)
						} catch (error) {
							const errorMessage = error instanceof Error ? error.message : String(error)
							this.log(`[API] ArchiveTask failed: ${errorMessage}`)
						}
						break
					case TaskCommandName.UnarchiveTask:
						this.log(`[API] UnarchiveTask -> ${command.data}`)
						try {
							await this.unarchiveTask(command.data)
						} catch (error) {
							const errorMessage = error instanceof Error ? error.message : String(error)
							this.log(`[API] UnarchiveTask failed: ${errorMessage}`)
						}
						break
					case TaskCommandName.PinTask:
						this.log(`[API] PinTask -> ${command.data}`)
						try {
							await this.pinTask(command.data)
						} catch (error) {
							const errorMessage = error instanceof Error ? error.message : String(error)
							this.log(`[API] PinTask failed: ${errorMessage}`)
						}
						break
					case TaskCommandName.UnpinTask:
						this.log(`[API] UnpinTask -> ${command.data}`)
						try {
							await this.unpinTask(command.data)
						} catch (error) {
							const errorMessage = error instanceof Error ? error.message : String(error)
							this.log(`[API] UnpinTask failed: ${errorMessage}`)
						}
						break
					case TaskCommandName.DeleteTask:
						this.log(`[API] DeleteTask -> ${command.data.taskId}`)
						try {
							await this.deleteTask(command.data.taskId, command.data.cascadeSubtasks)
						} catch (error) {
							const errorMessage = error instanceof Error ? error.message : String(error)
							this.log(`[API] DeleteTask failed: ${errorMessage}`)
						}
						break
					case TaskCommandName.GetTaskMarkdownExport:
						this.log(`[API] GetTaskMarkdownExport -> ${command.data}`)
						try {
							const markdown = await this.getTaskMarkdownExport(command.data)
							sendResponse(ShoferEventName.TaskCompleted, [
								command.data,
								{ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 },
								{ totalTools: 0, toolsCount: {} },
								{ rating: "well", isSubtask: false, exportContent: markdown },
							])
						} catch (error) {
							this.log(
								`[API] GetTaskMarkdownExport failed: ${error instanceof Error ? error.message : String(error)}`,
							)
						}
						break
					case TaskCommandName.GetTaskJsonExport:
						this.log(`[API] GetTaskJsonExport -> ${command.data}`)
						try {
							const jsonExport = await this.getTaskJsonExport(command.data)
							sendResponse(ShoferEventName.TaskCompleted, [
								command.data,
								{ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 },
								{ totalTools: 0, toolsCount: {} },
								{ rating: "well", isSubtask: false, exportContent: JSON.stringify(jsonExport) },
							])
						} catch (error) {
							this.log(
								`[API] GetTaskJsonExport failed: ${error instanceof Error ? error.message : String(error)}`,
							)
						}
						break
					case TaskCommandName.ExportConfiguration:
						this.log(`[API] ExportConfiguration`)
						try {
							const configJson = this.exportConfiguration()
							sendResponse(ShoferEventName.ModelsResponse, [{ config: configJson }])
						} catch (error) {
							this.log(
								`[API] ExportConfiguration failed: ${error instanceof Error ? error.message : String(error)}`,
							)
						}
						break
					case TaskCommandName.ImportConfiguration:
						this.log(`[API] ImportConfiguration`)
						try {
							await this.importConfiguration(command.data)
						} catch (error) {
							const errorMessage = error instanceof Error ? error.message : String(error)
							this.log(`[API] ImportConfiguration failed: ${errorMessage}`)
						}
						break
				}
			})
		}
	}

	public override emit<K extends keyof ShoferEvents>(
		eventName: K,
		...args: K extends keyof ShoferEvents ? ShoferEvents[K] : never
	) {
		const data = { eventName: eventName as ShoferEventName, payload: args } as TaskEvent
		this.ipc?.broadcast({ type: IpcMessageType.TaskEvent, origin: IpcOrigin.Server, data })
		return super.emit(eventName, ...args)
	}

	public async startNewTask({
		configuration,
		text,
		images,
		newTab,
		taskId,
	}: {
		configuration?: ShoferSettings
		text?: string
		images?: string[]
		newTab?: boolean
		taskId?: string
	}) {
		const taskConfiguration = configuration ?? {}
		let provider: ShoferProvider

		if (newTab) {
			await vscode.commands.executeCommand("workbench.action.files.revert")
			await vscode.commands.executeCommand("workbench.action.closeAllEditors")

			provider = await openShoferInNewTab({ context: this.context, outputChannel: this.outputChannel })
			this.registerListeners(provider)
		} else {
			await vscode.commands.executeCommand(`${Package.name}.SidebarProvider.focus`)

			provider = this.sidebarProvider
		}

		await provider.removeShoferFromStack()
		await provider.postInitState()
		await provider.postMessageToWebview({ type: "action", action: "chatButtonClicked" })
		await provider.postMessageToWebview({ type: "invoke", invoke: "newChat", text, images })

		const options: CreateTaskOptions = {
			consecutiveMistakeLimit: Number.MAX_SAFE_INTEGER,
			...(taskId ? { taskId } : {}),
		}

		const task = await provider.createTask(text, images, undefined, options, taskConfiguration)

		if (!task) {
			throw new Error("Failed to create task due to policy restrictions")
		}

		return task.taskId
	}

	public async resumeTask(taskId: string): Promise<void> {
		await vscode.commands.executeCommand(`${Package.name}.SidebarProvider.focus`)
		await this.waitForWebviewLaunch(5_000)

		const { historyItem } = await this.sidebarProvider.getTaskWithId(taskId)
		await this.sidebarProvider.createTaskWithHistoryItem(historyItem)

		if (this.sidebarProvider.viewLaunched) {
			await this.sidebarProvider.postMessageToWebview({ type: "action", action: "chatButtonClicked" })
		} else {
			this.log(
				`[API#resumeTask] webview not launched after resume for task ${taskId}; continuing in headless mode`,
			)
		}
	}

	public async isTaskInHistory(taskId: string): Promise<boolean> {
		try {
			await this.sidebarProvider.getTaskWithId(taskId)
			return true
		} catch {
			return false
		}
	}

	public getCurrentTaskStack() {
		return this.sidebarProvider.getCurrentTaskStack()
	}

	public async clearCurrentTask(_lastMessage?: string) {
		// Legacy finishSubTask removed; clear current by closing active task instance.
		await this.sidebarProvider.removeShoferFromStack()
		await this.sidebarProvider.postInitState()
	}

	public async cancelCurrentTask() {
		await this.sidebarProvider.cancelTask()
	}

	public async sendMessage(text?: string, images?: string[]) {
		const currentTask = this.sidebarProvider.getCurrentTask()

		// In headless/sandbox flows the webview may not be launched, so routing
		// through invoke=sendMessage drops the message. Deliver directly to the
		// task ask-response channel instead.
		if (!this.sidebarProvider.viewLaunched) {
			if (!currentTask) {
				this.log("[API#sendMessage] no current task in headless mode; message dropped")
				return
			}

			await currentTask.submitUserMessage(text ?? "", images)
			return
		}

		await this.sidebarProvider.postMessageToWebview({ type: "invoke", invoke: "sendMessage", text, images })
	}

	public deleteQueuedMessage(messageId: string) {
		const currentTask = this.sidebarProvider.getCurrentTask()

		if (!currentTask) {
			this.log(`[API#deleteQueuedMessage] no current task; ignoring delete for messageId ${messageId}`)
			return
		}

		currentTask.messageQueueService.removeMessage(messageId)
	}

	public async pressPrimaryButton() {
		await this.sidebarProvider.postMessageToWebview({ type: "invoke", invoke: "primaryButtonClick" })
	}

	public async pressSecondaryButton() {
		await this.sidebarProvider.postMessageToWebview({ type: "invoke", invoke: "secondaryButtonClick" })
	}

	public isReady() {
		return this.sidebarProvider.viewLaunched
	}

	private async waitForWebviewLaunch(timeoutMs: number): Promise<boolean> {
		try {
			await pWaitFor(() => this.sidebarProvider.viewLaunched, {
				timeout: timeoutMs,
				interval: 50,
			})

			return true
		} catch {
			this.log(`[API#waitForWebviewLaunch] webview did not launch within ${timeoutMs}ms`)
			return false
		}
	}

	private registerListeners(provider: ShoferProvider) {
		provider.on(ShoferEventName.TaskCreated, (task) => {
			// Task Lifecycle

			task.on(ShoferEventName.TaskStarted, async () => {
				this.emit(ShoferEventName.TaskStarted, task.taskId)
				await this.fileLog(`[${new Date().toISOString()}] taskStarted -> ${task.taskId}\n`)
			})

			task.on(ShoferEventName.TaskCompleted, async (_, tokenUsage, toolUsage, info) => {
				this.emit(ShoferEventName.TaskCompleted, task.taskId, tokenUsage, toolUsage, {
					rating: info.rating,
					isSubtask: info.isSubtask,
				})

				await this.fileLog(
					`[${new Date().toISOString()}] taskCompleted -> ${task.taskId} | ${JSON.stringify(tokenUsage, null, 2)} | ${JSON.stringify(toolUsage, null, 2)}\n`,
				)
			})

			task.on(ShoferEventName.TaskAborted, (info) => {
				this.emit(ShoferEventName.TaskAborted, task.taskId, info)
			})

			task.on(ShoferEventName.TaskFocused, () => {
				this.emit(ShoferEventName.TaskFocused, task.taskId)
			})

			task.on(ShoferEventName.TaskUnfocused, () => {
				this.emit(ShoferEventName.TaskUnfocused, task.taskId)
			})

			task.on(ShoferEventName.TaskActive, () => {
				this.emit(ShoferEventName.TaskActive, task.taskId)
			})

			task.on(ShoferEventName.TaskInteractive, () => {
				this.emit(ShoferEventName.TaskInteractive, task.taskId)
			})

			task.on(ShoferEventName.TaskResumable, () => {
				this.emit(ShoferEventName.TaskResumable, task.taskId)
			})

			task.on(ShoferEventName.TaskIdle, () => {
				this.emit(ShoferEventName.TaskIdle, task.taskId)
			})

			// Subtask Lifecycle

			task.on(ShoferEventName.TaskPaused, () => {
				this.emit(ShoferEventName.TaskPaused, task.taskId)
			})

			task.on(ShoferEventName.TaskUnpaused, () => {
				this.emit(ShoferEventName.TaskUnpaused, task.taskId)
			})

			task.on(ShoferEventName.TaskSpawned, (childTaskId) => {
				this.emit(ShoferEventName.TaskSpawned, task.taskId, childTaskId)
			})

			task.on(ShoferEventName.TaskDelegated as any, (childTaskId: string) => {
				;(this.emit as any)(ShoferEventName.TaskDelegated, task.taskId, childTaskId)
			})

			task.on(ShoferEventName.TaskDelegationCompleted as any, (childTaskId: string, summary: string) => {
				;(this.emit as any)(ShoferEventName.TaskDelegationCompleted, task.taskId, childTaskId, summary)
			})

			task.on(ShoferEventName.TaskDelegationResumed as any, (childTaskId: string) => {
				;(this.emit as any)(ShoferEventName.TaskDelegationResumed, task.taskId, childTaskId)
			})

			// Task Execution

			task.on(ShoferEventName.Message, async (message) => {
				this.emit(ShoferEventName.Message, { taskId: task.taskId, ...message })

				if (message.message.partial !== true) {
					await this.fileLog(`[${new Date().toISOString()}] ${JSON.stringify(message.message, null, 2)}\n`)
				}
			})

			task.on(ShoferEventName.TaskModeSwitched, (taskId, mode) => {
				this.emit(ShoferEventName.TaskModeSwitched, taskId, mode)
			})

			task.on(ShoferEventName.TaskAskResponded, () => {
				this.emit(ShoferEventName.TaskAskResponded, task.taskId)
			})

			task.on(ShoferEventName.QueuedMessagesUpdated, (taskId, messages) => {
				this.emit(ShoferEventName.QueuedMessagesUpdated, taskId, messages)
			})

			// Task Analytics

			task.on(ShoferEventName.TaskToolFailed, (taskId, tool, error) => {
				this.emit(ShoferEventName.TaskToolFailed, taskId, tool, error)
			})

			task.on(ShoferEventName.TaskTokenUsageUpdated, (_, tokenUsage, toolUsage) => {
				this.emit(ShoferEventName.TaskTokenUsageUpdated, task.taskId, tokenUsage, toolUsage)
			})

			// Let's go!

			this.emit(ShoferEventName.TaskCreated, task.taskId)
		})
	}

	// Logging

	private outputChannelLog(...args: unknown[]) {
		for (const arg of args) {
			if (arg === null) {
				this.outputChannel.appendLine("null")
			} else if (arg === undefined) {
				this.outputChannel.appendLine("undefined")
			} else if (typeof arg === "string") {
				this.outputChannel.appendLine(arg)
			} else if (arg instanceof Error) {
				this.outputChannel.appendLine(`Error: ${arg.message}\n${arg.stack || ""}`)
			} else {
				try {
					this.outputChannel.appendLine(
						JSON.stringify(
							arg,
							(key, value) => {
								if (typeof value === "bigint") return `BigInt(${value})`
								if (typeof value === "function") return `Function: ${value.name || "anonymous"}`
								if (typeof value === "symbol") return value.toString()
								return value
							},
							2,
						),
					)
				} catch (error) {
					this.outputChannel.appendLine(`[Non-serializable object: ${Object.prototype.toString.call(arg)}]`)
				}
			}
		}
	}

	private async fileLog(message: string) {
		if (!this.logfile) {
			return
		}

		try {
			await fs.appendFile(this.logfile, message, "utf8")
		} catch (_) {
			this.logfile = undefined
		}
	}

	// Global Settings Management

	public getConfiguration(): ShoferSettings {
		return Object.fromEntries(
			Object.entries(this.sidebarProvider.getValues()).filter(([key]) => !isSecretStateKey(key)),
		)
	}

	public async setConfiguration(values: ShoferSettings) {
		await this.sidebarProvider.contextProxy.setValues(values)
		await this.sidebarProvider.providerSettingsManager.saveConfig(values.currentApiConfigName || "default", values)
		await this.sidebarProvider.postInitState()
	}

	// Provider Profile Management

	public getProfiles(): string[] {
		return this.sidebarProvider.getProviderProfileEntries().map(({ name }) => name)
	}

	public getProfileEntry(name: string): ProviderSettingsEntry | undefined {
		return this.sidebarProvider.getProviderProfileEntry(name)
	}

	public async createProfile(name: string, profile?: ProviderSettings, activate: boolean = true) {
		const entry = this.getProfileEntry(name)

		if (entry) {
			throw new Error(`Profile with name "${name}" already exists`)
		}

		// upsertProviderProfile saves the config + refreshes live settings when activate=true,
		// but no longer sets currentApiConfigName (that is now the sole responsibility of
		// activateProviderProfile / setDefaultApiConfiguration). When activate is requested,
		// follow up with an explicit activation so the profile becomes the global default.
		// Pass activate=false — upsertProviderProfile just saves; activateProviderProfile
		// below handles the single live refresh + global default set when activate=true.
		const id = await this.sidebarProvider.upsertProviderProfile(name, profile ?? {}, false)

		if (!id) {
			throw new Error(`Failed to create profile with name "${name}"`)
		}

		if (activate) {
			await this.sidebarProvider.activateProviderProfile({ name })
		}

		return id
	}

	public async updateProfile(
		name: string,
		profile: ProviderSettings,
		activate: boolean = true,
	): Promise<string | undefined> {
		const entry = this.getProfileEntry(name)

		if (!entry) {
			throw new Error(`Profile with name "${name}" does not exist`)
		}

		// upsertProviderProfile saves the config + refreshes live settings when activate=true,
		// but no longer sets currentApiConfigName. Activate explicitly when requested.
		// Pass activate=false — upsertProviderProfile just saves; activateProviderProfile
		// below handles the single live refresh + global default set when activate=true.
		const id = await this.sidebarProvider.upsertProviderProfile(name, profile, false)

		if (!id) {
			throw new Error(`Failed to update profile with name "${name}"`)
		}

		if (activate) {
			await this.sidebarProvider.activateProviderProfile({ name })
		}

		return id
	}

	public async upsertProfile(
		name: string,
		profile: ProviderSettings,
		activate: boolean = true,
	): Promise<string | undefined> {
		// upsertProviderProfile saves the config + refreshes live settings when activate=true,
		// but no longer sets currentApiConfigName. Activate explicitly when requested.
		// Pass activate=false — upsertProviderProfile just saves; activateProviderProfile
		// below handles the single live refresh + global default set when activate=true.
		const id = await this.sidebarProvider.upsertProviderProfile(name, profile, false)

		if (!id) {
			throw new Error(`Failed to upsert profile with name "${name}"`)
		}

		if (activate) {
			await this.sidebarProvider.activateProviderProfile({ name })
		}

		return id
	}

	public async deleteProfile(name: string): Promise<void> {
		const entry = this.getProfileEntry(name)

		if (!entry) {
			throw new Error(`Profile with name "${name}" does not exist`)
		}

		await this.sidebarProvider.deleteProviderProfile(entry)
	}

	public getActiveProfile(): string | undefined {
		return this.getConfiguration().currentApiConfigName
	}

	public async setActiveProfile(name: string): Promise<string | undefined> {
		const entry = this.getProfileEntry(name)

		if (!entry) {
			throw new Error(`Profile with name "${name}" does not exist`)
		}

		await this.sidebarProvider.activateProviderProfile({ name })
		return this.getActiveProfile()
	}

	// ─── Task History & Management (TaskSelector parity) ───────────

	public getTaskHistoryItems(): HistoryItem[] {
		return this.sidebarProvider.taskHistoryStore.getAll()
	}

	public async showTaskWithId(taskId: string, options?: { keepCurrentTask?: boolean }): Promise<void> {
		await this.sidebarProvider.showTaskWithId(taskId, options)
	}

	public async renameTask(taskId: string, name: string): Promise<void> {
		const { historyItem } = await this.sidebarProvider.getTaskWithId(taskId)
		if (!historyItem) {
			throw new Error(`Task not found: ${taskId}`)
		}
		await this.sidebarProvider.updateTaskHistory({ ...historyItem, name })
		this.sidebarProvider.renameManagedTask(taskId, name)
	}

	public async archiveTask(taskId: string): Promise<void> {
		await this.sidebarProvider.archiveManagedTask(taskId)
	}

	public async unarchiveTask(taskId: string): Promise<void> {
		await this.sidebarProvider.unarchiveManagedTask(taskId)
	}

	public async pinTask(taskId: string): Promise<void> {
		await this.sidebarProvider.pinManagedTask(taskId)
	}

	public async unpinTask(taskId: string): Promise<void> {
		await this.sidebarProvider.unpinManagedTask(taskId)
	}

	public async deleteTask(taskId: string, cascadeSubtasks: boolean = true): Promise<void> {
		await this.sidebarProvider.deleteTaskWithId(taskId, cascadeSubtasks)
	}

	// ─── Task Export (data-returning variants) ──────────────────────

	public async getTaskMarkdownExport(taskId: string): Promise<string> {
		const { historyItem, apiConversationHistory } = await this.sidebarProvider.getTaskWithId(taskId)

		return apiConversationHistory
			.map((message) => {
				const role = message.role === "user" ? "**User:**" : "**Assistant:**"
				const content = Array.isArray(message.content)
					? message.content.map((block) => formatContentBlockToMarkdown(block as any)).join("\n")
					: message.content
				return `${role}\n\n${content}\n\n`
			})
			.join("---\n\n")
	}

	public async getTaskJsonExport(taskId: string): Promise<Record<string, unknown>> {
		const { historyItem, apiConversationHistory } = await this.sidebarProvider.getTaskWithId(taskId)

		// Read ui_messages for per-request metadata via the JSONL reader.
		let uiMessages: Array<{ type: string; say?: string; ts: number; text?: string }> = []
		try {
			const { readTaskMessages } = await import("../core/task-persistence/taskMessages")
			const globalStoragePath = this.sidebarProvider.contextProxy.globalStorageUri.fsPath
			uiMessages = (await readTaskMessages({ taskId, globalStoragePath })) as typeof uiMessages
		} catch {
			// Fall through with empty uiMessages — the trace will lack per-call metadata.
		}

		const trace = buildJsonTrace(
			taskId,
			historyItem.task || historyItem.ts?.toString() || "",
			historyItem.mode,
			historyItem.ts ? new Date(historyItem.ts).toISOString() : new Date().toISOString(),
			apiConversationHistory,
			uiMessages,
		)

		return trace as unknown as Record<string, unknown>
	}

	// ─── Logging ────────────────────────────────────────────────────

	public getOutputLogs(maxLines: number = 2000): string {
		return getRecentLogs(maxLines)
	}

	// ─── Configuration Import/Export ─────────────────────────────────

	public exportConfiguration(): string {
		const config = this.getConfiguration()
		return JSON.stringify(config, null, 2)
	}

	public async importConfiguration(json: string): Promise<void> {
		let parsed: ShoferSettings
		try {
			parsed = JSON.parse(json) as ShoferSettings
		} catch (err) {
			throw new Error(`Invalid configuration JSON: ${err instanceof Error ? err.message : String(err)}`)
		}
		await this.setConfiguration(parsed)
	}

	// ─── Workflows ─────────────────────────────────────────────────

	public async createWorkflow(slangSource: string, flowParams?: Record<string, unknown>): Promise<string> {
		const task = await createWorkflowTask(this.sidebarProvider, slangSource, flowParams)

		// Pop the current task to the background (same as the webview handler).
		const poppedTask = this.sidebarProvider.popFromStackWithoutAborting()
		if (poppedTask) {
			this.sidebarProvider.taskManager.registerBackgroundTask(poppedTask)
		}

		await this.sidebarProvider.addShoferToStack(task)
		this.sidebarProvider.taskManager.registerBackgroundTask(task)

		try {
			await this.sidebarProvider.taskManager.focusTask(task.taskId)
		} catch {
			this.log(`[createWorkflow] Failed to focus task ${task.taskId}`)
		}

		await task.seedHistory()
		await this.sidebarProvider.postInitState()

		task.start()

		return task.taskId
	}

	public async discoverWorkflows(): Promise<Map<string, string>> {
		return discoverWorkflows(this.sidebarProvider.cwd)
	}
}
