import { safeWriteJson } from "../../utils/safeWriteJson"
import { registry, incWebviewPushError, FAST_BUCKETS_MS } from "../../metrics/registry"
import * as path from "path"
import * as os from "os"
import * as fs from "fs/promises"
import { getRooDirectoriesForCwd } from "../../services/shofer-config/index.js"
import pWaitFor from "p-wait-for"
import * as vscode from "vscode"

import {
	type Language,
	type GlobalState,
	type ShoferMessage,
	type TelemetrySetting,
	// UserSettingsConfig removed with cloud
	type ModelRecord,
	type Command as SlashCommand,
	type WebviewMessage,
	type EditQueuedMessagePayload,
	TelemetryEventName,
	ShoferSettings,
	ExperimentId,
	checkoutDiffPayloadSchema,
	checkoutRestorePayloadSchema,
	webviewMetricsPushSchema,
} from "@shofer/types"
import { customToolRegistry } from "@shofer/core"
import { TelemetryService } from "@shofer/telemetry"

import { type ApiMessage } from "../task-persistence/apiMessages"
import { saveTaskMessages } from "../task-persistence"

import { ShoferProvider } from "./ShoferProvider"
import { handleCheckpointRestoreOperation } from "./checkpointRestoreHandler"
import { generateErrorDiagnostics } from "./diagnosticsHandler"
import {
	handleRequestSkills,
	handleCreateSkill,
	handleDeleteSkill,
	handleMoveSkill,
	handleUpdateSkillModes,
	handleOpenSkillFile,
} from "./skillsMessageHandler"
import { changeLanguage, t } from "../../i18n"
import { Package } from "../../shared/package"
import { type RouterName, toRouterName } from "../../shared/api"
import { MessageEnhancer } from "./messageEnhancer"

import { CodeIndexManager } from "../../services/code-index/manager"
import { GitIndexManager } from "../../services/git-index/git-index-manager"
import { checkExistKey } from "../../shared/checkExistApiConfig"
import { experimentDefault } from "../../shared/experiments"
import { syncExperimentContextKeys } from "../../activate/experimentContextKeys"
import { Terminal } from "../../integrations/terminal/Terminal"
import { openFile } from "../../integrations/misc/open-file"
import { openImage, saveImage } from "../../integrations/misc/image-handler"
import { selectImages } from "../../integrations/misc/process-images"
import { getTheme } from "../../integrations/theme/getTheme"
import { searchWorkspaceFiles } from "../../services/search/file-search"
import { fileExistsAtPath } from "../../utils/fs"
import { playTts, setTtsEnabled, setTtsSpeed, stopTts } from "../../utils/tts"
import { searchCommits } from "../../utils/git"
import { exportSettings, importSettingsWithFeedback } from "../config/importExport"
import { getOpenAiModels } from "../../api/providers/openai"
import { getVsCodeLmModels } from "../../api/providers/vscode-lm"
import { openMention } from "../mentions"
import { resolveImageMentions } from "../mentions/resolveImageMentions"
import { ShoferIgnoreController } from "../ignore/ShoferIgnoreController"
import { getWorkspacePath } from "../../utils/path"
import { isPathOutsideWorkspace } from "../../utils/pathUtils"
import { Mode, defaultModeSlug } from "../../shared/modes"
import { getModels, flushModels } from "../../api/providers/fetchers/modelCache"
import { GetModelsOptions } from "../../shared/api"
import { generateSystemPrompt } from "./generateSystemPrompt"
import { resolveDefaultSaveUri, saveLastExportPath } from "../../utils/export"
import { getCommand } from "../../utils/commands"

const ALLOWED_VSCODE_SETTINGS = new Set(["terminal.integrated.inheritEnv"])

import { MarketplaceManager, MarketplaceItemType } from "../../services/marketplace"
import { webviewLog, scrollLog } from "../../utils/logging/subsystems"
import {
	handleListWorktrees,
	handleCreateWorktree,
	handleDeleteWorktree,
	handleGetAvailableBranches,
	handleGetWorktreeDefaults,
	handleGetWorktreeIncludeStatus,
	handleCheckBranchWorktreeInclude,
	handleCreateWorktreeInclude,
	handleCheckoutBranch,
	handleGetWorktreeStatus,
} from "./worktree"

/**
 * Re-initialize the Assistant Agent manager for the current workspace.
 *
 * Triggered by:
 *  - Any change to an `assistantAgent*` setting (link change, override change, …).
 *  - ANY mutation of the API Configuration profiles (save/upsert/rename/load/
 *    delete) — the linked profile's `providerSettings` (e.g. the
 *    `anthropicBeta1MContext` flag, the model id, or even just renaming /
 *    re-loading a profile) directly drives the resolved context window the
 *    popover displays. Without this hook, toggling the 1M-beta on the linked
 *    profile would leave the manager pinned to the value it cached at
 *    activation time.
 *
 * Cheap to call: `initialize()` short-circuits when nothing material changed
 * downstream (it always rebuilds `_config` and the LLM client, but that's a
 * single profile lookup + one model-info read).
 */
async function reinitializeAssistantAgent(provider: ShoferProvider): Promise<void> {
	try {
		const { AssistantAgentManager } = await import("../../services/assistant-agent/manager")
		const folder = vscode.workspace.workspaceFolders?.[0]
		if (!folder) return
		const mgr = AssistantAgentManager.getInstance(provider.context, folder.uri.fsPath)
		if (mgr) {
			await mgr.initialize()
		}
	} catch (error) {
		webviewLog.error("[AssistantAgentManager] re-initialize failed:", error)
	}
}

export const webviewMessageHandler = async (
	provider: ShoferProvider,
	message: WebviewMessage,
	marketplaceManager?: MarketplaceManager,
) => {
	// Utility functions provided for concise get/update of global state via contextProxy API.
	const getGlobalState = <K extends keyof GlobalState>(key: K) => provider.contextProxy.getValue(key)
	const updateGlobalState = async <K extends keyof GlobalState>(key: K, value: GlobalState[K]) =>
		await provider.contextProxy.setValue(key, value)

	const getCurrentCwd = () => {
		return provider.getCurrentTask()?.cwd || provider.cwd
	}

	const getCurrentMode = async (): Promise<string> => {
		const currentTask = provider.getCurrentTask()

		if (currentTask) {
			try {
				return await currentTask.getTaskMode()
			} catch (error) {
				provider.log(
					`Error resolving current task mode for command discovery: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
				)
			}
		}

		// No focused task: fall back to the global default mode (tier-3). The
		// pre-task mode selection is owned by the webview dropdown and is not
		// visible here, so command discovery uses the persistent default.
		const state = await provider.getState()
		return state?.mode ?? defaultModeSlug
	}

	const getDiscoveredCommands = async (): Promise<SlashCommand[]> => {
		const { getCommands } = await import("../../services/command/commands")
		const commands = await getCommands(getCurrentCwd())

		const commandList: SlashCommand[] = commands.map((command) => ({
			name: command.name,
			source: command.source,
			filePath: command.filePath,
			description: command.description,
			argumentHint: command.argumentHint,
		}))

		const existingCommandNames = new Set(commandList.map((command) => command.name))
		const skillsManager = provider.getSkillsManager()

		if (!skillsManager) {
			return commandList
		}

		const currentMode = await getCurrentMode()
		const availableSkills = skillsManager.getSkillsForMode(currentMode)

		for (const skill of availableSkills) {
			if (existingCommandNames.has(skill.name)) {
				continue
			}

			existingCommandNames.add(skill.name)
			commandList.push({
				name: skill.name,
				source: skill.source,
				filePath: skill.path,
				description: skill.description,
			})
		}

		return commandList
	}

	/**
	 * Resolves image file mentions in incoming messages.
	 * Matches read_file behavior: respects size limits and model capabilities.
	 */
	const resolveIncomingImages = async (payload: { text?: string; images?: string[] }) => {
		const text = payload.text ?? ""
		const images = payload.images
		const currentTask = provider.getCurrentTask()
		const state = await provider.getState()
		const resolved = await resolveImageMentions({
			text,
			images,
			cwd: getCurrentCwd(),
			shoferIgnoreController: currentTask?.shoferIgnoreController,
			maxImageFileSize: state.maxImageFileSize,
			maxTotalImageSize: state.maxTotalImageSize,
		})
		return resolved
	}
	/**
	 * Shared utility to find message indices based on timestamp.
	 * When multiple messages share the same timestamp (e.g., after condense),
	 * this function prefers non-summary messages to ensure user operations
	 * target the intended message rather than the summary.
	 */
	const findMessageIndices = (messageTs: number, currentShofer: any) => {
		// Find the exact message by timestamp, not the first one after a cutoff
		const messageIndex = currentShofer.shoferMessages.findIndex((msg: ShoferMessage) => msg.ts === messageTs)

		// Find all matching API messages by timestamp
		const allApiMatches = currentShofer.apiConversationHistory
			.map((msg: ApiMessage, idx: number) => ({ msg, idx }))
			.filter(({ msg }: { msg: ApiMessage }) => msg.ts === messageTs)

		// Prefer non-summary message if multiple matches exist (handles timestamp collision after condense)
		const preferred = allApiMatches.find(({ msg }: { msg: ApiMessage }) => !msg.isSummary) || allApiMatches[0]
		const apiConversationHistoryIndex = preferred?.idx ?? -1

		return { messageIndex, apiConversationHistoryIndex }
	}

	/**
	 * Fallback: find first API history index at or after a timestamp.
	 * Used when the exact user message isn't present in apiConversationHistory (e.g., after condense).
	 */
	const findFirstApiIndexAtOrAfter = (ts: number, currentShofer: any) => {
		if (typeof ts !== "number") return -1
		return currentShofer.apiConversationHistory.findIndex(
			(msg: ApiMessage) => typeof msg?.ts === "number" && (msg.ts as number) >= ts,
		)
	}

	/**
	 * Handles message deletion operations with user confirmation
	 */
	const handleDeleteOperation = async (messageTs: number): Promise<void> => {
		// Check if there's a checkpoint before this message
		const currentShofer = provider.getCurrentTask()
		let hasCheckpoint = false

		if (!currentShofer) {
			await vscode.window.showErrorMessage(t("common:errors.message.no_active_task_to_delete"))
			return
		}

		const { messageIndex } = findMessageIndices(messageTs, currentShofer)

		if (messageIndex !== -1) {
			// Find the last checkpoint before this message
			const checkpoints = currentShofer.shoferMessages.filter(
				(msg) => msg.say === "checkpoint_saved" && msg.ts > messageTs,
			)
			hasCheckpoint = checkpoints.length > 0
		}

		// Send message to webview to show delete confirmation dialog
		await provider.postMessageToWebview({
			type: "showDeleteMessageDialog",
			messageTs,
			hasCheckpoint,
		})
	}

	/**
	 * Handles confirmed message deletion from webview dialog
	 */
	const handleDeleteMessageConfirm = async (messageTs: number, restoreCheckpoint?: boolean): Promise<void> => {
		const currentShofer = provider.getCurrentTask()
		if (!currentShofer) {
			webviewLog.error("[handleDeleteMessageConfirm] No current shofer available")
			return
		}

		const { messageIndex, apiConversationHistoryIndex } = findMessageIndices(messageTs, currentShofer)
		// Determine API truncation index with timestamp fallback if exact match not found
		let apiIndexToUse = apiConversationHistoryIndex
		const tsThreshold = currentShofer.shoferMessages[messageIndex]?.ts
		if (apiIndexToUse === -1 && typeof tsThreshold === "number") {
			apiIndexToUse = findFirstApiIndexAtOrAfter(tsThreshold, currentShofer)
		}

		if (messageIndex === -1) {
			await vscode.window.showErrorMessage(t("common:errors.message.message_not_found", { messageTs }))
			return
		}

		try {
			const targetMessage = currentShofer.shoferMessages[messageIndex]

			// If checkpoint restoration is requested, find and restore to the last checkpoint before this message
			if (restoreCheckpoint) {
				// Find the last checkpoint before this message
				const checkpoints = currentShofer.shoferMessages.filter(
					(msg) => msg.say === "checkpoint_saved" && msg.ts > messageTs,
				)

				const nextCheckpoint = checkpoints[0]

				if (nextCheckpoint && nextCheckpoint.text) {
					await handleCheckpointRestoreOperation({
						provider,
						currentShofer,
						messageTs: targetMessage.ts!,
						messageIndex,
						checkpoint: { hash: nextCheckpoint.text },
						operation: "delete",
					})
				} else {
					// No checkpoint found before this message
					webviewLog.info("[handleDeleteMessageConfirm] No checkpoint found before message")
					vscode.window.showWarningMessage("No checkpoint found before this message")
				}
			} else {
				// For non-checkpoint deletes, preserve checkpoint associations for remaining messages
				// Store checkpoints from messages that will be preserved
				const preservedCheckpoints = new Map<number, any>()
				for (let i = 0; i < messageIndex; i++) {
					const msg = currentShofer.shoferMessages[i]
					if (msg?.checkpoint && msg.ts) {
						preservedCheckpoints.set(msg.ts, msg.checkpoint)
					}
				}

				// Delete this message and all subsequent messages using MessageManager
				await currentShofer.messageManager.rewindToTimestamp(targetMessage.ts!, { includeTargetMessage: false })

				// Restore checkpoint associations for preserved messages
				for (const [ts, checkpoint] of preservedCheckpoints) {
					const msgIndex = currentShofer.shoferMessages.findIndex((msg) => msg.ts === ts)
					if (msgIndex !== -1) {
						currentShofer.shoferMessages[msgIndex].checkpoint = checkpoint
					}
				}

				// Save the updated messages with restored checkpoints
				await saveTaskMessages({
					messages: currentShofer.shoferMessages,
					taskId: currentShofer.taskId,
					globalStoragePath: provider.contextProxy.globalStorageUri.fsPath,
				})

				// Update the UI to reflect the deletion
				await provider.postInitState()
			}
		} catch (error) {
			webviewLog.error("Error in delete message:", error)
			vscode.window.showErrorMessage(
				t("common:errors.message.error_deleting_message", {
					error: error instanceof Error ? error.message : String(error),
				}),
			)
		}
	}

	/**
	 * Handles message editing operations with user confirmation
	 */
	const handleEditOperation = async (messageTs: number, editedContent: string, images?: string[]): Promise<void> => {
		// Check if there's a checkpoint before this message
		const currentShofer = provider.getCurrentTask()
		let hasCheckpoint = false
		if (currentShofer) {
			const { messageIndex } = findMessageIndices(messageTs, currentShofer)
			if (messageIndex !== -1) {
				// Find the last checkpoint before this message
				const checkpoints = currentShofer.shoferMessages.filter(
					(msg) => msg.say === "checkpoint_saved" && msg.ts > messageTs,
				)

				hasCheckpoint = checkpoints.length > 0
			} else {
				webviewLog.info("[webviewMessageHandler] Edit - Message not found in shoferMessages!")
			}
		} else {
			webviewLog.info("[webviewMessageHandler] Edit - No currentShofer available!")
		}

		// Send message to webview to show edit confirmation dialog
		await provider.postMessageToWebview({
			type: "showEditMessageDialog",
			messageTs,
			text: editedContent,
			hasCheckpoint,
			images,
		})
	}

	/**
	 * Handles confirmed message editing from webview dialog
	 */
	const handleEditMessageConfirm = async (
		messageTs: number,
		editedContent: string,
		restoreCheckpoint?: boolean,
		images?: string[],
	): Promise<void> => {
		const currentShofer = provider.getCurrentTask()
		if (!currentShofer) {
			webviewLog.error("[handleEditMessageConfirm] No current shofer available")
			return
		}

		// Use findMessageIndices to find messages based on timestamp
		const { messageIndex, apiConversationHistoryIndex } = findMessageIndices(messageTs, currentShofer)

		if (messageIndex === -1) {
			const errorMessage = t("common:errors.message.message_not_found", { messageTs })
			webviewLog.error("[handleEditMessageConfirm]", errorMessage)
			await vscode.window.showErrorMessage(errorMessage)
			return
		}

		try {
			const targetMessage = currentShofer.shoferMessages[messageIndex]

			// If checkpoint restoration is requested, find and restore to the last checkpoint before this message
			if (restoreCheckpoint) {
				// Find the last checkpoint before this message
				const checkpoints = currentShofer.shoferMessages.filter(
					(msg) => msg.say === "checkpoint_saved" && msg.ts > messageTs,
				)

				const nextCheckpoint = checkpoints[0]

				if (nextCheckpoint && nextCheckpoint.text) {
					await handleCheckpointRestoreOperation({
						provider,
						currentShofer,
						messageTs: targetMessage.ts!,
						messageIndex,
						checkpoint: { hash: nextCheckpoint.text },
						operation: "edit",
						editData: {
							editedContent,
							images,
							apiConversationHistoryIndex,
						},
					})
					// The task will be cancelled and reinitialized by checkpointRestore
					// The pending edit will be processed in the reinitialized task
					return
				} else {
					// No checkpoint found before this message
					webviewLog.info("[handleEditMessageConfirm] No checkpoint found before message")
					vscode.window.showWarningMessage("No checkpoint found before this message")
					// Continue with non-checkpoint edit
				}
			}

			// For non-checkpoint edits, remove the ORIGINAL user message being edited and all subsequent messages
			// Determine the correct starting index to delete from (prefer the last preceding user_feedback message)
			let deleteFromMessageIndex = messageIndex
			let deleteFromApiIndex = apiConversationHistoryIndex

			// Find the nearest preceding user message to ensure we replace the original, not just the assistant reply
			for (let i = messageIndex; i >= 0; i--) {
				const m = currentShofer.shoferMessages[i]
				if (m?.say === "user_feedback") {
					deleteFromMessageIndex = i
					// Align API history truncation to the same user message timestamp if present
					const userTs = m.ts
					if (typeof userTs === "number") {
						const apiIdx = currentShofer.apiConversationHistory.findIndex(
							(am: ApiMessage) => am.ts === userTs,
						)
						if (apiIdx !== -1) {
							deleteFromApiIndex = apiIdx
						}
					}
					break
				}
			}

			// Timestamp fallback for API history when exact user message isn't present
			if (deleteFromApiIndex === -1) {
				const tsThresholdForEdit = currentShofer.shoferMessages[deleteFromMessageIndex]?.ts
				if (typeof tsThresholdForEdit === "number") {
					deleteFromApiIndex = findFirstApiIndexAtOrAfter(tsThresholdForEdit, currentShofer)
				}
			}

			// Store checkpoints from messages that will be preserved
			const preservedCheckpoints = new Map<number, any>()
			for (let i = 0; i < deleteFromMessageIndex; i++) {
				const msg = currentShofer.shoferMessages[i]
				if (msg?.checkpoint && msg.ts) {
					preservedCheckpoints.set(msg.ts, msg.checkpoint)
				}
			}

			// Delete the original (user) message and all subsequent messages using MessageManager
			const rewindTs = currentShofer.shoferMessages[deleteFromMessageIndex]?.ts
			if (rewindTs) {
				await currentShofer.messageManager.rewindToTimestamp(rewindTs, { includeTargetMessage: false })
			}

			// Restore checkpoint associations for preserved messages
			for (const [ts, checkpoint] of preservedCheckpoints) {
				const msgIndex = currentShofer.shoferMessages.findIndex((msg) => msg.ts === ts)
				if (msgIndex !== -1) {
					currentShofer.shoferMessages[msgIndex].checkpoint = checkpoint
				}
			}

			// Save the updated messages with restored checkpoints
			await saveTaskMessages({
				messages: currentShofer.shoferMessages,
				taskId: currentShofer.taskId,
				globalStoragePath: provider.contextProxy.globalStorageUri.fsPath,
			})

			// Update the UI to reflect the deletion
			await provider.postInitState()

			await currentShofer.submitUserMessage(editedContent, images)
		} catch (error) {
			webviewLog.error("Error in edit message:", error)
			vscode.window.showErrorMessage(
				t("common:errors.message.error_editing_message", {
					error: error instanceof Error ? error.message : String(error),
				}),
			)
		}
	}

	/**
	 * Handles message modification operations (delete or edit) with confirmation dialog
	 * @param messageTs Timestamp of the message to operate on
	 * @param operation Type of operation ('delete' or 'edit')
	 * @param editedContent New content for edit operations
	 * @returns Promise<void>
	 */
	const handleMessageModificationsOperation = async (
		messageTs: number,
		operation: "delete" | "edit",
		editedContent?: string,
		images?: string[],
	): Promise<void> => {
		if (operation === "delete") {
			await handleDeleteOperation(messageTs)
		} else if (operation === "edit" && editedContent) {
			await handleEditOperation(messageTs, editedContent, images)
		}
	}

	switch (message.type) {
		case "webviewLog": {
			const text = message.text ?? ""
			// Route [scroll:*] messages to the Scroll subsystem logger so
			// they appear under the "Scroll" category in Settings → Logging.
			if (text.startsWith("[scroll:")) {
				scrollLog.info(text)
			} else {
				webviewLog.info(text)
			}
			// Also keep the existing debug path for the output channel.
			provider.debug?.(`[webview] ${text}`)
			break
		}
		case "requestTaskLogs": {
			// On-demand snapshot for the "Logs" tab. The webview asks for a
			// specific task/workflow id; we return the buffered lines. Live
			// updates thereafter arrive via the `taskLogAppended` stream.
			const taskLogTaskId = typeof message.taskId === "string" ? message.taskId : undefined
			// Resolve the import BEFORE touching the watch, so setting the watch and
			// reading the snapshot happen with no await between them. That keeps the
			// snapshot and the live stream from both delivering the same line.
			const { getTaskLogs } = await import("../../utils/logging")
			provider.setLogsWatchTaskId(taskLogTaskId)
			if (!taskLogTaskId) break
			await provider.postMessageToWebview({
				type: "taskLogs",
				taskLogTaskId,
				taskLogs: getTaskLogs(taskLogTaskId),
			})
			break
		}
		case "getBlobContent": {
			// §4.3: webview-side resolution of a `<shofer-blob/>` reference.
			// The renderer requests by sha256; we route to the currently
			// focused task's BlobStore. If no task is current or the blob
			// is missing on disk, return an error payload — the UI shows a
			// banner rather than silently hiding.
			const sha256 = typeof message.sha256 === "string" ? message.sha256 : undefined
			if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256)) {
				await provider.postMessageToWebview({
					type: "blobContent",
					blob: { sha256: sha256 ?? "", bytes: 0, error: "invalid sha256" },
				})
				break
			}
			const task = provider.getCurrentTask()
			if (!task) {
				await provider.postMessageToWebview({
					type: "blobContent",
					blob: { sha256, bytes: 0, error: "no active task" },
				})
				break
			}
			try {
				const store = await task.getBlobStore()
				const content = await store.read(sha256)
				await provider.postMessageToWebview({
					type: "blobContent",
					blob:
						content === undefined
							? { sha256, bytes: 0, error: "not found" }
							: { sha256, bytes: Buffer.byteLength(content, "utf8"), content },
				})
			} catch (error) {
				await provider.postMessageToWebview({
					type: "blobContent",
					blob: {
						sha256,
						bytes: 0,
						error: error instanceof Error ? error.message : String(error),
					},
				})
			}
			break
		}
		case "pushMetrics": {
			// Phase 4: webview → extension host metric push.
			// Validate the typed `metrics` payload at the trust boundary;
			// reject untyped or malformed pushes (records into
			// `shofer_metrics_webview_push_errors_total`).
			const parsed = webviewMetricsPushSchema.safeParse(message.metrics)
			if (!parsed.success) {
				incWebviewPushError()
				break
			}
			for (const h of parsed.data.histograms ?? []) {
				registry.observeHistogram(
					h.name,
					"Webview-pushed histogram observation.",
					h.value,
					FAST_BUCKETS_MS,
					h.labels,
				)
			}
			for (const c of parsed.data.counters ?? []) {
				registry.incCounter(c.name, "Webview-pushed counter increment.", c.labels, c.value)
			}
			break
		}
		case "webviewDidLaunch":
			provider.log("[webview-lifecycle] webviewDidLaunch received — webview initialized or re-initialized")
			// Now that the renderer's JS has executed and its message listener
			// is wired, it is safe to start the ping/pong heartbeat. Starting
			// it earlier (e.g. in resolveWebviewView) would count every ping
			// sent during bundle load as a liveness miss → infinite reset loop.
			provider._onWebviewLaunched()
			// Load custom modes first
			const customModes = await provider.customModesManager.getCustomModes()
			await updateGlobalState("customModes", customModes)

			provider.postInitState()
			provider.workspaceTracker?.initializeFilePaths() // Don't await.

			// Always push the current parallel task state so the TaskSelector has
			// up-to-date data when the webview loads.
			{
				const managedTasks = provider.getManagedTasks()
				provider.postMessageToWebview({
					type: "parallelTasksUpdated",
					parallelTasks: managedTasks.map((s) => ({
						id: s.id,
						name: s.name,
						taskId: s.taskId,
						workspace: s.workspace,
						createdAt: s.createdAt,
						lastActiveAt: s.lastActiveAt,
						state: s.state,
						activeTimeMs: s.activeTimeMs,
					})),
					focusedTaskId: provider.taskManager.getFocusedTaskId(),
				})

				// Send existing task notifications so the badge count is correct
				// when the webview loads (notifications may have accumulated before
				// the webview was ready to receive events).
				const notifications = provider.getTaskNotifications()
				for (const notification of notifications) {
					provider.postMessageToWebview({
						type: "taskNotification",
						notification: {
							taskId: notification.targetTaskId,
							type: notification.type,
							message: notification.message,
							timestamp: notification.timestamp,
						},
					})
				}
			}

			getTheme().then((theme) => provider.postMessageToWebview({ type: "theme", text: JSON.stringify(theme) }))

			// If MCP Hub is already initialized, update the webview with
			// current server list.
			const mcpHub = provider.getMcpHub()

			if (mcpHub) {
				provider.postMessageToWebview({ type: "mcpServers", mcpServers: mcpHub.getAllServers() })
			}

			provider.providerSettingsManager
				.listConfig()
				.then(async (listApiConfig) => {
					if (!listApiConfig) {
						return
					}

					if (listApiConfig.length === 1) {
						// Check if first time init then sync with exist config.
						if (!checkExistKey(listApiConfig[0])) {
							const { apiConfiguration } = await provider.getState()

							// Only save if the current configuration has meaningful settings
							// (e.g., API keys). This prevents saving a default "anthropic"
							// fallback when no real config exists, which can happen during
							// CLI initialization before provider settings are applied.
							if (checkExistKey(apiConfiguration)) {
								await provider.providerSettingsManager.saveConfig(
									listApiConfig[0].name ?? "default",
									apiConfiguration,
								)

								listApiConfig[0].apiProvider = apiConfiguration.apiProvider
							}
						}
					}

					const currentConfigName = getGlobalState("currentApiConfigName")

					if (currentConfigName) {
						if (!(await provider.providerSettingsManager.hasConfig(currentConfigName))) {
							// Current config name not valid, get first config in list.
							const name = listApiConfig[0]?.name
							await updateGlobalState("currentApiConfigName", name)

							if (name) {
								await provider.activateProviderProfile({ name })
								return
							}
						}
					}

					await Promise.all([
						await updateGlobalState("listApiConfigMeta", listApiConfig),
						await provider.postMessageToWebview({ type: "listApiConfig", listApiConfig }),
					])
				})
				.catch((error) =>
					provider.log(
						`Error list api configuration: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
					),
				)

			// Enable telemetry by default (when unset) or when explicitly enabled
			provider.getStateToPostToWebview().then((state) => {
				const { telemetrySetting } = state
				const isOptedIn = telemetrySetting !== "disabled"
				TelemetryService.instance.updateTelemetryState(isOptedIn)
			})

			provider.isViewLaunched = true
			break
		case "newTask":
			// Use createManagedTask to preserve current task in background (parallel execution).
			// The old task continues running while the new task is focused in the UI.
			try {
				const resolved = await resolveIncomingImages({ text: message.text, images: message.images })

				const messageText = resolved.text

				// Auto-create worktree when the webview signals that no worktree was
				// explicitly picked (neither a specific worktree nor explicit "Current branch").
				let worktreeDir = message.worktreeDir
				if (message.autoCreateWorktree && !worktreeDir) {
					const defaults = await handleGetWorktreeDefaults(provider)
					const createResult = await handleCreateWorktree(provider, {
						path: defaults.suggestedPath,
						branch: defaults.suggestedBranch,
						baseBranch: undefined, // defaults to HEAD
						createNewBranch: true,
					})
					if (createResult.success && createResult.worktree) {
						worktreeDir = createResult.worktree.path
					} else {
						// Worktree creation (or its required submodule init) failed.
						// Abort — don't start a task with a broken/missing worktree.
						await provider.postMessageToWebview({ type: "invoke", invoke: "newChat" })
						vscode.window.showErrorMessage(`Failed to create worktree: ${createResult.message}`)
						return
					}
				}

				// Pre-task mode / API-config seeds chosen in the chat dropdown.
				// When absent, createTask falls back to the global Settings defaults.
				await provider.createManagedTask(undefined, messageText, resolved.images, worktreeDir, {
					mode: message.mode,
					apiConfigName: message.apiConfigName,
				})
				// Task created successfully - notify the UI to reset
				await provider.postMessageToWebview({ type: "invoke", invoke: "newChat" })
			} catch (error) {
				// For all errors, reset the UI and show error
				await provider.postMessageToWebview({ type: "invoke", invoke: "newChat" })
				// Show error to user
				vscode.window.showErrorMessage(
					`Failed to create task: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
			break
		case "customInstructions":
			await provider.updateCustomInstructions(message.text)
			break

		case "askResponse":
			{
				const resolved = await resolveIncomingImages({ text: message.text, images: message.images })

				const messageText = resolved.text

				const currentTask = provider.getCurrentTask()
				currentTask?.handleWebviewAskResponse(message.askResponse!, messageText, resolved.images)
			}
			break

		case "updateSettings":
			if (message.updatedSettings) {
				// Track whether any assistant-agent setting changed so we can
				// re-initialize the manager after the proxy writes complete
				// (otherwise stale config — e.g. the previous DEFAULT_MAX_CONTEXT_TOKENS
				// or the previous API Configuration profile — keeps driving the popover).
				let assistantAgentChanged = false
				for (const [key, value] of Object.entries(message.updatedSettings)) {
					let newValue = value

					if (key.startsWith("assistantAgent")) {
						assistantAgentChanged = true
					}
					if (key === "language") {
						newValue = value ?? "en"
						changeLanguage(newValue as Language)
					} else if (key === "allowedCommands") {
						const commands = value ?? []

						newValue = Array.isArray(commands)
							? commands.filter((cmd) => typeof cmd === "string" && cmd.trim().length > 0)
							: []

						await vscode.workspace
							.getConfiguration(Package.name)
							.update("allowedCommands", newValue, vscode.ConfigurationTarget.Global)
					} else if (key === "deniedCommands") {
						const commands = value ?? []

						newValue = Array.isArray(commands)
							? commands.filter((cmd) => typeof cmd === "string" && cmd.trim().length > 0)
							: []

						await vscode.workspace
							.getConfiguration(Package.name)
							.update("deniedCommands", newValue, vscode.ConfigurationTarget.Global)
					} else if (key === "ttsEnabled") {
						newValue = value ?? true
						setTtsEnabled(newValue as boolean)
					} else if (key === "ttsSpeed") {
						newValue = value ?? 1.0
						setTtsSpeed(newValue as number)
					} else if (key === "terminalShellIntegrationTimeout") {
						if (value !== undefined) {
							Terminal.setShellIntegrationTimeout(value as number)
						}
					} else if (key === "terminalShellIntegrationDisabled") {
						if (value !== undefined) {
							Terminal.setShellIntegrationDisabled(value as boolean)
						}
					} else if (key === "terminalCommandDelay") {
						if (value !== undefined) {
							Terminal.setCommandDelay(value as number)
						}
					} else if (key === "terminalPowershellCounter") {
						if (value !== undefined) {
							Terminal.setPowershellCounter(value as boolean)
						}
					} else if (key === "terminalZshClearEolMark") {
						if (value !== undefined) {
							Terminal.setTerminalZshClearEolMark(value as boolean)
						}
					} else if (key === "terminalZshOhMy") {
						if (value !== undefined) {
							Terminal.setTerminalZshOhMy(value as boolean)
						}
					} else if (key === "terminalZshP10k") {
						if (value !== undefined) {
							Terminal.setTerminalZshP10k(value as boolean)
						}
					} else if (key === "terminalZdotdir") {
						if (value !== undefined) {
							Terminal.setTerminalZdotdir(value as boolean)
						}
					} else if (key === "execaShellPath") {
						Terminal.setExecaShellPath(value as string | undefined)
					} else if (key === "mcpEnabled") {
						newValue = value ?? true
						const mcpHub = provider.getMcpHub()

						if (mcpHub) {
							await mcpHub.handleMcpEnabledChange(newValue as boolean)
						}
					} else if (key === "experiments") {
						if (!value) {
							continue
						}

						newValue = {
							...(getGlobalState("experiments") ?? experimentDefault),
							...(value as Record<ExperimentId, boolean>),
						}
						// Re-fire setContext so toolbar buttons gated by an
						// experiment flag (e.g. Refresh Webview / Reload Window)
						// appear or disappear without requiring a window reload.
						syncExperimentContextKeys(newValue as Record<ExperimentId, boolean>)
					} else if (key === "customSupportPrompts") {
						if (!value) {
							continue
						}
					} else if (key === "logLevel") {
						if (value && typeof value === "string") {
							// Wire log level change into the live transport immediately.
							const { setLogLevel } = await import("../../utils/logging")
							setLogLevel(value as "debug" | "info" | "warn" | "error" | "fatal")
						}
					} else if (key === "logCategories") {
						// Wire category whitelist into the live transport immediately.
						const { setLogCategories } = await import("../../utils/logging")
						if (Array.isArray(value) && value.length > 0) {
							setLogCategories(value as string[])
						} else {
							setLogCategories(undefined) // show all
						}
					}

					await provider.contextProxy.setValue(key as keyof ShoferSettings, newValue)
				}

				if (assistantAgentChanged) {
					await reinitializeAssistantAgent(provider)
				}

				await provider.postInitState()
			}

			break

		case "terminalOperation":
			if (message.terminalOperation) {
				provider.getCurrentTask()?.handleTerminalOperation(message.terminalOperation)
			}
			break
		case "updateCostLimit":
			// Live-edit the cost cap on a running task and persist it to history.
			// Affects only the root task (subtasks resolve via the parent chain).
			if (message.taskId && message.costLimit) {
				const task = provider.taskManager.getManagedTaskInstance(message.taskId)
				if (task) {
					// Walk to root \u2014 the cap lives only on the root task.
					let root = task
					while (root.parentTask) {
						root = root.parentTask
					}
					root.costLimit = message.costLimit
					root.invalidateCostLimitCache()
				}
				try {
					const { historyItem } = await provider.getTaskWithId(message.taskId)
					if (historyItem) {
						await provider.updateTaskHistory({
							...historyItem,
							costLimit: message.costLimit,
						})
					}
				} catch (err) {
					provider.log(
						`[updateCostLimit] persist failed for ${message.taskId}: ${err instanceof Error ? err.message : String(err)}`,
					)
				}
				await provider.postInitState()
			}
			break
		case "clearTask":
			// Clear task resets the current task.
			await provider.clearTask()
			await provider.postInitState()
			break
		case "didShowAnnouncement":
			await updateGlobalState("lastShownAnnouncementId", provider.latestAnnouncementId)
			await provider.postInitState()
			break
		case "selectImages":
			const images = await selectImages()
			await provider.postMessageToWebview({
				type: "selectedImages",
				images,
				context: message.context,
				messageTs: message.messageTs,
			})
			break
		case "exportCurrentTask":
			const currentTaskId = provider.getCurrentTask()?.taskId
			if (currentTaskId) {
				provider.exportTaskWithId(currentTaskId)
			}
			break
		case "exportCurrentTaskJson":
			const currentTaskIdJson = provider.getCurrentTask()?.taskId
			if (currentTaskIdJson) {
				provider.exportTaskWithIdJson(currentTaskIdJson)
			}
			break
		case "shareCurrentTask":
			const shareTaskId = provider.getCurrentTask()?.taskId
			const shoferMessages = provider.getCurrentTask()?.shoferMessages

			if (!shareTaskId) {
				vscode.window.showErrorMessage(t("common:errors.share_no_active_task"))
				break
			}

			vscode.window.showErrorMessage(t("common:errors.share_not_available"))
			break
		case "showTaskWithId":
			await provider.focusTask(message.text!)
			break
		case "loadOlderMessages":
			await provider.loadOlderShoferMessages()
			break
		case "condenseTaskContextRequest":
			provider.condenseTaskContext(message.text!)
			break
		case "deleteTaskWithId":
			provider.deleteTaskWithId(message.text!)
			break
		case "deleteMultipleTasksWithIds": {
			const ids = message.ids

			if (Array.isArray(ids)) {
				// Process in batches of 20 (or another reasonable number)
				const batchSize = 20
				const results = []

				// Only log start and end of the operation
				webviewLog.info(`Batch deletion started: ${ids.length} tasks total`)

				for (let i = 0; i < ids.length; i += batchSize) {
					const batch = ids.slice(i, i + batchSize)

					const batchPromises = batch.map(async (id) => {
						try {
							await provider.deleteTaskWithId(id)
							return { id, success: true }
						} catch (error) {
							// Keep error logging for debugging purposes
							webviewLog.info(
								`Failed to delete task ${id}: ${error instanceof Error ? error.message : String(error)}`,
							)
							return { id, success: false }
						}
					})

					// Process each batch in parallel but wait for completion before starting the next batch
					const batchResults = await Promise.all(batchPromises)
					results.push(...batchResults)

					// Update the UI after each batch to show progress
					await provider.postInitState()
				}

				// Log final results
				const successCount = results.filter((r) => r.success).length
				const failCount = results.length - successCount
				webviewLog.info(
					`Batch deletion completed: ${successCount}/${ids.length} tasks successful, ${failCount} tasks failed`,
				)
			}
			break
		}
		case "exportTaskWithId":
			provider.exportTaskWithId(message.text!)
			break
		case "exportTaskWithIdJson":
			provider.exportTaskWithIdJson(message.text!)
			break
		case "getTaskWithAggregatedCosts": {
			try {
				const taskId = message.text
				if (!taskId) {
					throw new Error("Task ID is required")
				}
				const result = await provider.getTaskWithAggregatedCosts(taskId)
				await provider.postMessageToWebview({
					type: "taskWithAggregatedCosts",
					// IMPORTANT: ChatView stores aggregatedCostsMap keyed by message.text (taskId)
					// so we must include it here.
					text: taskId,
					historyItem: result.historyItem,
					aggregatedCosts: result.aggregatedCosts,
				})
			} catch (error) {
				webviewLog.error("Error getting task with aggregated costs:", error)
				await provider.postMessageToWebview({
					type: "taskWithAggregatedCosts",
					// Include taskId when available for correlation in UI logs.
					text: message.text,
					error: error instanceof Error ? error.message : String(error),
				})
			}
			break
		}
		case "getTaskInteractions": {
			try {
				const rootTaskId = message.text
				if (!rootTaskId) {
					throw new Error("Root task ID is required")
				}
				const interactions = await provider.getTaskInteractions(rootTaskId)
				await provider.postMessageToWebview({
					type: "taskInteractions",
					// Keyed by root task id so the Sequence view can correlate.
					text: rootTaskId,
					taskInteractions: interactions,
				})
			} catch (error) {
				webviewLog.error("Error getting task interactions:", error)
				await provider.postMessageToWebview({
					type: "taskInteractions",
					text: message.text,
					error: error instanceof Error ? error.message : String(error),
				})
			}
			break
		}
		case "importSettings": {
			await importSettingsWithFeedback({
				providerSettingsManager: provider.providerSettingsManager,
				contextProxy: provider.contextProxy,
				customModesManager: provider.customModesManager,
				provider: provider,
			})

			break
		}
		case "exportSettings":
			await exportSettings({
				providerSettingsManager: provider.providerSettingsManager,
				contextProxy: provider.contextProxy,
			})

			break
		case "resetState":
			await provider.resetState()
			break
		case "flushRouterModels":
			const routerNameFlush: RouterName = toRouterName(message.text)
			// Note: flushRouterModels is a generic flush without credentials
			// For providers that need credentials, use their specific handlers
			await flushModels({ provider: routerNameFlush } as GetModelsOptions, true)
			break
		case "requestRouterModels":
			const { apiConfiguration } = await provider.getState()

			// Optional single provider filter from webview
			const requestedProvider = message?.values?.provider
			const providerFilter = requestedProvider ? toRouterName(requestedProvider) : undefined

			// Optional refresh flag to flush cache before fetching (useful for providers requiring credentials)
			const shouldRefresh = message?.values?.refresh === true

			const routerModels: Record<RouterName, ModelRecord> = providerFilter
				? ({} as Record<RouterName, ModelRecord>)
				: {
						openrouter: {},
						"vercel-ai-gateway": {},
						litellm: {},
						requesty: {},
						unbound: {},
						ollama: {},
						lmstudio: {},
						poe: {},
						shofer: {},
					}

			const safeGetModels = async (options: GetModelsOptions): Promise<ModelRecord> => {
				try {
					return await getModels(options)
				} catch (error) {
					webviewLog.error(
						`Failed to fetch models in webviewMessageHandler requestRouterModels for ${options.provider}:`,
						error,
					)

					throw error // Re-throw to be caught by Promise.allSettled.
				}
			}

			// Base candidates (only those handled by this aggregate fetcher)
			const candidates: { key: RouterName; options: GetModelsOptions }[] = [
				{ key: "openrouter", options: { provider: "openrouter" } },
				{
					key: "requesty",
					options: {
						provider: "requesty",
						apiKey: apiConfiguration.requestyApiKey,
						baseUrl: apiConfiguration.requestyBaseUrl,
					},
				},
				{
					key: "unbound",
					options: {
						provider: "unbound",
						apiKey: apiConfiguration.unboundApiKey,
					},
				},
				{ key: "vercel-ai-gateway", options: { provider: "vercel-ai-gateway" } },
			]

			// LiteLLM is conditional on baseUrl+apiKey
			const litellmApiKey = apiConfiguration.litellmApiKey || message?.values?.litellmApiKey
			const litellmBaseUrl = apiConfiguration.litellmBaseUrl || message?.values?.litellmBaseUrl

			if (litellmApiKey && litellmBaseUrl) {
				// If explicit credentials are provided in message.values (from Refresh Models button),
				// flush the cache first to ensure we fetch fresh data with the new credentials
				if (message?.values?.litellmApiKey || message?.values?.litellmBaseUrl) {
					await flushModels({ provider: "litellm", apiKey: litellmApiKey, baseUrl: litellmBaseUrl }, true)
				}

				candidates.push({
					key: "litellm",
					options: { provider: "litellm", apiKey: litellmApiKey, baseUrl: litellmBaseUrl },
				})
			}

			// Poe is conditional on apiKey
			const poeApiKey = apiConfiguration.poeApiKey || message?.values?.poeApiKey
			const poeBaseUrl = apiConfiguration.poeBaseUrl || message?.values?.poeBaseUrl

			if (poeApiKey) {
				if (message?.values?.poeApiKey || message?.values?.poeBaseUrl) {
					await flushModels({ provider: "poe", apiKey: poeApiKey, baseUrl: poeBaseUrl }, true)
				}

				candidates.push({
					key: "poe",
					options: { provider: "poe", apiKey: poeApiKey, baseUrl: poeBaseUrl },
				})
			}

			// Apply single provider filter if specified
			const modelFetchPromises = providerFilter
				? candidates.filter(({ key }) => key === providerFilter)
				: candidates

			// If refresh flag is set and we have a specific provider, flush its cache first
			if (shouldRefresh && providerFilter && modelFetchPromises.length > 0) {
				const targetCandidate = modelFetchPromises[0]
				await flushModels(targetCandidate.options, true)
			}

			const results = await Promise.allSettled(
				modelFetchPromises.map(async ({ key, options }) => {
					const models = await safeGetModels(options)
					return { key, models } // The key is `ProviderName` here.
				}),
			)

			results.forEach((result, index) => {
				const routerName = modelFetchPromises[index].key

				if (result.status === "fulfilled") {
					routerModels[routerName] = result.value.models

					// Ollama and LM Studio settings pages still need these events. They are not fetched here.
				} else {
					// Handle rejection: Post a specific error message for this provider.
					const errorMessage = result.reason instanceof Error ? result.reason.message : String(result.reason)
					webviewLog.error(`Error fetching models for ${routerName}:`, result.reason)

					routerModels[routerName] = {} // Ensure it's an empty object in the main routerModels message.

					provider.postMessageToWebview({
						type: "singleRouterModelFetchResponse",
						success: false,
						error: errorMessage,
						values: { provider: routerName },
					})
				}
			})

			provider.postMessageToWebview({
				type: "routerModels",
				routerModels,
				values: providerFilter ? { provider: requestedProvider } : undefined,
			})
			break
		case "requestOllamaModels": {
			// Specific handler for Ollama models only.
			const { apiConfiguration: ollamaApiConfig } = await provider.getState()
			try {
				const ollamaOptions = {
					provider: "ollama" as const,
					baseUrl: ollamaApiConfig.ollamaBaseUrl,
					apiKey: ollamaApiConfig.ollamaApiKey,
				}
				// Flush cache and refresh to ensure fresh models.
				await flushModels(ollamaOptions, true)

				const ollamaModels = await getModels(ollamaOptions)

				if (Object.keys(ollamaModels).length > 0) {
					provider.postMessageToWebview({ type: "ollamaModels", ollamaModels: ollamaModels })
				}
			} catch (error) {
				// Silently fail - user hasn't configured Ollama yet
				webviewLog.info("Ollama models fetch failed:", error)
			}
			break
		}
		case "requestLmStudioModels": {
			// Specific handler for LM Studio models only.
			const { apiConfiguration: lmStudioApiConfig } = await provider.getState()
			try {
				const lmStudioOptions = {
					provider: "lmstudio" as const,
					baseUrl: lmStudioApiConfig.lmStudioBaseUrl,
				}
				// Flush cache and refresh to ensure fresh models.
				await flushModels(lmStudioOptions, true)

				const lmStudioModels = await getModels(lmStudioOptions)

				if (Object.keys(lmStudioModels).length > 0) {
					provider.postMessageToWebview({
						type: "lmStudioModels",
						lmStudioModels: lmStudioModels,
					})
				}
			} catch (error) {
				// Silently fail - user hasn't configured LM Studio yet.
				webviewLog.info("LM Studio models fetch failed:", error)
			}
			break
		}
		case "requestRooModels": {
			// Shofer models no longer available since cloud services were removed
			provider.postMessageToWebview({
				type: "singleRouterModelFetchResponse",
				success: true,
				values: {},
			})
			break
		}
		case "requestRooCreditBalance": {
			// Shofer credit balance no longer available since cloud services were removed
			const requestId = message.requestId
			provider.postMessageToWebview({
				type: "shoferCreditBalance",
				requestId,
				values: { error: "Cloud services removed" },
			})
			break
		}
		case "requestOpenAiModels":
			if (message?.values?.baseUrl && message?.values?.apiKey) {
				const openAiModels = await getOpenAiModels(
					message?.values?.baseUrl,
					message?.values?.apiKey,
					message?.values?.openAiHeaders,
				)

				provider.postMessageToWebview({ type: "openAiModels", openAiModels })
			}

			break
		case "requestVsCodeLmModels":
			const vsCodeLmModels = await getVsCodeLmModels()
			// TODO: Cache like we do for OpenRouter, etc?
			provider.postMessageToWebview({ type: "vsCodeLmModels", vsCodeLmModels })
			break
		case "openImage":
			openImage(message.text!, { values: message.values })
			break
		case "saveImage":
			if (message.dataUri) {
				const matches = message.dataUri.match(/^data:image\/([a-zA-Z]+);base64,(.+)$/)
				if (!matches) {
					// Let saveImage handle invalid URI error
					saveImage(message.dataUri, vscode.Uri.file(""))
					break
				}
				const format = matches[1]
				const defaultFileName = `img_${Date.now()}.${format}`

				const defaultUri = await resolveDefaultSaveUri(
					provider.contextProxy,
					"lastImageSavePath",
					defaultFileName,
					{
						useWorkspace: false,
						fallbackDir: path.join(os.homedir(), "Downloads"),
					},
				)

				const savedUri = await saveImage(message.dataUri, defaultUri)

				if (savedUri) {
					await saveLastExportPath(provider.contextProxy, "lastImageSavePath", savedUri)
				}
			}
			break
		case "openFile":
			let filePath: string = message.text!
			if (!path.isAbsolute(filePath)) {
				filePath = path.join(getCurrentCwd(), filePath)
			}
			openFile(filePath, message.values as { create?: boolean; content?: string; line?: number })
			break
		case "readFileContent": {
			const relPath = message.text || ""
			if (!relPath) {
				provider.postMessageToWebview({
					type: "fileContent",
					fileContent: { path: relPath, content: null, error: "No path provided" },
				})
				break
			}
			try {
				const cwd = getCurrentCwd()
				if (!cwd) {
					provider.postMessageToWebview({
						type: "fileContent",
						fileContent: { path: relPath, content: null, error: "No workspace path available" },
					})
					break
				}
				const absPath = path.resolve(cwd, relPath)
				// Workspace-boundary validation: prevent path traversal attacks
				if (isPathOutsideWorkspace(absPath)) {
					provider.postMessageToWebview({
						type: "fileContent",
						fileContent: { path: relPath, content: null, error: "Path is outside workspace" },
					})
					break
				}
				const content = await fs.readFile(absPath, "utf-8")
				provider.postMessageToWebview({ type: "fileContent", fileContent: { path: relPath, content } })
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err)
				provider.postMessageToWebview({
					type: "fileContent",
					fileContent: { path: relPath, content: null, error: errorMsg },
				})
			}
			break
		}
		case "openMention":
			openMention(getCurrentCwd(), message.text)
			break
		case "openExternal":
			if (message.url) {
				vscode.env.openExternal(vscode.Uri.parse(message.url))
			}
			break
		case "checkpointDiff":
			const result = checkoutDiffPayloadSchema.safeParse(message.payload)

			if (result.success) {
				await provider.getCurrentTask()?.checkpointDiff(result.data)
			}

			break
		case "checkpointRestore": {
			const result = checkoutRestorePayloadSchema.safeParse(message.payload)

			if (result.success) {
				await provider.cancelTask()

				try {
					await pWaitFor(() => provider.getCurrentTask()?.isInitialized === true, { timeout: 3_000 })
				} catch (error) {
					vscode.window.showErrorMessage(t("common:errors.checkpoint_timeout"))
				}

				try {
					await provider.getCurrentTask()?.checkpointRestore(result.data)
				} catch (error) {
					vscode.window.showErrorMessage(t("common:errors.checkpoint_failed"))
				}
			}

			break
		}
		case "cancelTask":
			await provider.cancelTask()
			break
		case "changedFiles/get": {
			await provider.pushChangedFilesUpdate()
			break
		}
		case "changedFiles/showDiff": {
			const relPath = message.text || ""
			if (!relPath) break
			const task = provider.getCurrentTask()
			if (!task) break
			try {
				const { getOriginalContent, getFinalContent } = await import("../file-changes/ChangedFilesService")
				const original = (await getOriginalContent(task, relPath)) ?? ""
				const cwd = getCurrentCwd()
				if (!cwd) break
				const absPath = path.resolve(cwd, relPath)
				if (isPathOutsideWorkspace(absPath)) break
				const leftUri = vscode.Uri.parse(
					`shofer-original:/${encodeURIComponent(relPath)}?${Buffer.from(original, "utf8").toString("base64")}`,
				)
				// Right side = this task's own "final" copy (what it last wrote), NOT the
				// live workspace file. This keeps the diff consistent with the changelist
				// (base -> final) and immune to edits made by other tasks/sessions in the
				// same worktree. Fall back to the live file only when no final snapshot
				// exists yet (captureFinal is best-effort/async).
				const finalContent = await getFinalContent(task, relPath)
				const rightUri =
					finalContent !== null
						? vscode.Uri.parse(
								`shofer-original:/${encodeURIComponent(relPath)}?${Buffer.from(finalContent, "utf8").toString("base64")}`,
							)
						: vscode.Uri.file(absPath)
				const title = `${path.basename(relPath)} (Shofer changes)`
				await vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, title)
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err)
				vscode.window.showErrorMessage(`Failed to open Shofer diff: ${errorMsg}`)
			}
			break
		}
		case "changedFiles/revert": {
			const relPath = message.text || ""
			if (!relPath) break
			const task = provider.getCurrentTask()
			if (!task) break
			if (task.isStreaming) {
				vscode.window.showWarningMessage(t("common:fileChanges.blockedTaskRunning"))
				break
			}
			try {
				const { restoreFile, getFinalContent } = await import("../file-changes/ChangedFilesService")
				// If the file on disk diverges from the last captured "final"
				// state, the user has manual edits we'd be discarding.
				const finalContent = await getFinalContent(task, relPath)
				let userEdited = false
				try {
					const cwd = getCurrentCwd()
					if (cwd) {
						const current = await fs.readFile(path.resolve(cwd, relPath), "utf-8")
						userEdited = finalContent !== null && current !== finalContent
					}
				} catch {
					// File missing on disk while final exists -> treat as user edit.
					userEdited = finalContent !== null
				}
				if (userEdited) {
					const choice = await vscode.window.showWarningMessage(
						t("common:fileChanges.revertConfirmUserEdits", { path: relPath }),
						{ modal: true },
						t("common:fileChanges.revertConfirmYes"),
					)
					if (choice !== t("common:fileChanges.revertConfirmYes")) break
				}
				await restoreFile(task, relPath)
				await provider.pushChangedFilesUpdate()
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err)
				vscode.window.showErrorMessage(`Revert failed: ${errorMsg}`)
			}
			break
		}
		case "changedFiles/revertAll": {
			const task = provider.getCurrentTask()
			if (!task) break
			if (task.isStreaming) {
				vscode.window.showWarningMessage(t("common:fileChanges.blockedTaskRunning"))
				break
			}
			const choice = await vscode.window.showWarningMessage(
				t("common:fileChanges.revertAllConfirm"),
				{ modal: true },
				t("common:fileChanges.revertConfirmYes"),
			)
			if (choice !== t("common:fileChanges.revertConfirmYes")) break
			try {
				const { restoreAll } = await import("../file-changes/ChangedFilesService")
				await restoreAll(task)
				await provider.pushChangedFilesUpdate()
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err)
				vscode.window.showErrorMessage(`Revert all failed: ${errorMsg}`)
			}
			break
		}
		case "changedFiles/accept": {
			const relPath = message.text || ""
			if (!relPath) break
			const task = provider.getCurrentTask()
			if (!task) break
			// LLM hint: accept only updates internal tracking metadata
			// (copies final → base, removes final snapshot); it does NOT
			// modify workspace files, so it's safe to allow while streaming.
			try {
				const { acceptFile } = await import("../file-changes/ChangedFilesService")
				await acceptFile(task, relPath)
				await provider.pushChangedFilesUpdate()
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err)
				vscode.window.showErrorMessage(`Accept failed: ${errorMsg}`)
			}
			break
		}
		case "changedFiles/acceptAll": {
			const task = provider.getCurrentTask()
			if (!task) break
			// LLM hint: acceptAll only updates internal tracking metadata;
			// it's safe to allow while streaming (see acceptFile comment above).
			try {
				const { acceptAll } = await import("../file-changes/ChangedFilesService")
				await acceptAll(task)
				await provider.pushChangedFilesUpdate()
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err)
				vscode.window.showErrorMessage(`Accept all failed: ${errorMsg}`)
			}
			break
		}
		case "cancelAutoApproval":
			// Cancel any pending auto-approval timeout for the current task
			provider.getCurrentTask()?.cancelAutoApprovalTimeout()
			break
		case "allowedCommands": {
			// Validate and sanitize the commands array
			const commands = message.commands ?? []
			const validCommands = Array.isArray(commands)
				? commands.filter((cmd) => typeof cmd === "string" && cmd.trim().length > 0)
				: []

			await updateGlobalState("allowedCommands", validCommands)

			// Also update workspace settings.
			await vscode.workspace
				.getConfiguration(Package.name)
				.update("allowedCommands", validCommands, vscode.ConfigurationTarget.Global)

			break
		}
		case "deniedCommands": {
			// Validate and sanitize the commands array
			const commands = message.commands ?? []
			const validCommands = Array.isArray(commands)
				? commands.filter((cmd) => typeof cmd === "string" && cmd.trim().length > 0)
				: []

			await updateGlobalState("deniedCommands", validCommands)

			// Also update workspace settings.
			await vscode.workspace
				.getConfiguration(Package.name)
				.update("deniedCommands", validCommands, vscode.ConfigurationTarget.Global)

			break
		}
		case "openCustomModesSettings": {
			const customModesFilePath = await provider.customModesManager.getCustomModesFilePath()

			if (customModesFilePath) {
				openFile(customModesFilePath)
			}

			break
		}
		case "openKeyboardShortcuts": {
			// Open VSCode keyboard shortcuts settings and optionally filter to show the Shofer commands
			const searchQuery = message.text || ""
			if (searchQuery) {
				// Open with a search query pre-filled
				await vscode.commands.executeCommand("workbench.action.openGlobalKeybindings", searchQuery)
			} else {
				// Just open the keyboard shortcuts settings
				await vscode.commands.executeCommand("workbench.action.openGlobalKeybindings")
			}
			break
		}
		case "openMcpSettings": {
			const mcpSettingsFilePath = await provider.getMcpHub()?.getMcpSettingsFilePath()

			if (mcpSettingsFilePath) {
				openFile(mcpSettingsFilePath)
			}

			break
		}
		case "openProjectMcpSettings": {
			if (!vscode.workspace.workspaceFolders?.length) {
				vscode.window.showErrorMessage(t("common:errors.no_workspace"))
				return
			}

			const workspaceFolder = getCurrentCwd()
			const shoferDir = path.join(workspaceFolder, ".shofer")
			const mcpPath = path.join(shoferDir, "mcp.json")

			try {
				await fs.mkdir(shoferDir, { recursive: true })
				const exists = await fileExistsAtPath(mcpPath)

				if (!exists) {
					await safeWriteJson(mcpPath, { mcpServers: {} }, { prettyPrint: true })
				}

				await openFile(mcpPath)
			} catch (error) {
				vscode.window.showErrorMessage(t("mcp:errors.create_json", { error: `${error}` }))
			}

			break
		}
		case "deleteMcpServer": {
			if (!message.serverName) {
				break
			}

			try {
				await provider.getMcpHub()?.deleteServer(message.serverName, message.source as "global" | "project")

				// Refresh the webview state
				await provider.postInitState()
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error)
				provider.log(`Failed to delete MCP server: ${errorMessage}`)
				// Error messages are already handled by McpHub.deleteServer
			}
			break
		}
		case "restartMcpServer": {
			try {
				await provider.getMcpHub()?.restartConnection(message.text!, message.source as "global" | "project")
			} catch (error) {
				provider.log(
					`Failed to retry connection for ${message.text}: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
				)
			}
			break
		}
		case "toggleToolEnabledForPrompt": {
			try {
				await provider
					.getMcpHub()
					?.toggleToolEnabledForPrompt(
						message.serverName!,
						message.source as "global" | "project",
						message.toolName!,
						Boolean(message.isEnabled),
					)
			} catch (error) {
				provider.log(
					`Failed to toggle enabled for prompt for tool ${message.toolName}: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
				)
			}
			break
		}
		case "toggleMcpServer": {
			try {
				await provider
					.getMcpHub()
					?.toggleServerDisabled(
						message.serverName!,
						message.disabled!,
						message.source as "global" | "project",
					)
			} catch (error) {
				provider.log(
					`Failed to toggle MCP server ${message.serverName}: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
				)
			}
			break
		}
		case "taskSyncEnabled":
			// Task sync removed with cloud services
			break

		case "refreshAllMcpServers": {
			const mcpHub = provider.getMcpHub()

			if (mcpHub) {
				await mcpHub.refreshAllConnections()
			}

			break
		}

		case "ttsEnabled":
			const ttsEnabled = message.bool ?? true
			await updateGlobalState("ttsEnabled", ttsEnabled)
			setTtsEnabled(ttsEnabled)
			provider.postConfigUpdate("ttsEnabled", ttsEnabled)
			break
		case "ttsSpeed":
			const ttsSpeed = message.value ?? 1.0
			await updateGlobalState("ttsSpeed", ttsSpeed)
			setTtsSpeed(ttsSpeed)
			provider.postConfigUpdate("ttsSpeed", ttsSpeed)
			break
		case "playTts":
			if (message.text) {
				playTts(message.text, {
					onStart: () => provider.postMessageToWebview({ type: "ttsStart", text: message.text }),
					onStop: () => provider.postMessageToWebview({ type: "ttsStop", text: message.text }),
				})
			}

			break
		case "stopTts":
			stopTts()
			break

		case "updateVSCodeSetting": {
			const { setting, value } = message

			if (setting !== undefined && value !== undefined) {
				if (ALLOWED_VSCODE_SETTINGS.has(setting)) {
					await vscode.workspace.getConfiguration().update(setting, value, true)
				} else {
					vscode.window.showErrorMessage(`Cannot update restricted VSCode setting: ${setting}`)
				}
			}

			break
		}
		case "getVSCodeSetting":
			const { setting } = message

			if (setting) {
				try {
					await provider.postMessageToWebview({
						type: "vsCodeSetting",
						setting,
						value: vscode.workspace.getConfiguration().get(setting),
					})
				} catch (error) {
					webviewLog.error(`Failed to get VSCode setting ${message.setting}:`, error)

					await provider.postMessageToWebview({
						type: "vsCodeSetting",
						setting,
						error: `Failed to get setting: ${error instanceof Error ? error.message : String(error)}`,
						value: undefined,
					})
				}
			}

			break

		case "mode":
			await provider.handleUserModeSwitch(message.text as Mode)
			break
		case "updatePrompt":
			if (message.promptMode && message.customPrompt !== undefined) {
				const existingPrompts = getGlobalState("customModePrompts") ?? {}
				const updatedPrompts = { ...existingPrompts, [message.promptMode]: message.customPrompt }
				await updateGlobalState("customModePrompts", updatedPrompts)
				provider.postConfigUpdate("customModePrompts", updatedPrompts)

				if (TelemetryService.hasInstance()) {
					// Determine which setting was changed by comparing objects
					const oldPrompt = existingPrompts[message.promptMode] || {}
					const newPrompt = message.customPrompt
					const changedSettings = Object.keys(newPrompt).filter(
						(key) =>
							JSON.stringify((oldPrompt as Record<string, unknown>)[key]) !==
							JSON.stringify((newPrompt as Record<string, unknown>)[key]),
					)

					if (changedSettings.length > 0) {
						TelemetryService.instance.captureModeSettingChanged(changedSettings[0])
					}
				}
			}
			break
		case "deleteMessage": {
			if (!provider.getCurrentTask()) {
				await vscode.window.showErrorMessage(t("common:errors.message.no_active_task_to_delete"))
				break
			}

			if (typeof message.value !== "number" || !message.value) {
				await vscode.window.showErrorMessage(t("common:errors.message.invalid_timestamp_for_deletion"))
				break
			}

			await handleMessageModificationsOperation(message.value, "delete")
			break
		}
		case "submitEditedMessage": {
			if (
				provider.getCurrentTask() &&
				typeof message.value === "number" &&
				message.value &&
				message.editedMessageContent
			) {
				await handleMessageModificationsOperation(
					message.value,
					"edit",
					message.editedMessageContent,
					message.images,
				)
			}
			break
		}

		case "hasOpenedModeSelector":
			await updateGlobalState("hasOpenedModeSelector", message.bool ?? true)
			provider.postConfigUpdate("hasOpenedModeSelector", message.bool ?? true)
			break

		case "lockApiConfigAcrossModes": {
			const enabled = message.bool ?? false
			await provider.context.workspaceState.update("lockApiConfigAcrossModes", enabled)

			provider.postConfigUpdate("lockApiConfigAcrossModes", enabled)
			break
		}

		case "toggleApiConfigPin":
			if (message.text) {
				const currentPinned = getGlobalState("pinnedApiConfigs") ?? {}
				const updatedPinned: Record<string, boolean> = { ...currentPinned }

				if (currentPinned[message.text]) {
					delete updatedPinned[message.text]
				} else {
					updatedPinned[message.text] = true
				}

				await updateGlobalState("pinnedApiConfigs", updatedPinned)
				provider.postConfigUpdate("pinnedApiConfigs", updatedPinned)
			}
			break
		case "enhancementApiConfigId":
			await updateGlobalState("enhancementApiConfigId", message.text)
			provider.postConfigUpdate("enhancementApiConfigId", message.text)
			break

		case "autoApprovalEnabled":
			await updateGlobalState("autoApprovalEnabled", message.bool ?? false)
			provider.postConfigUpdate("autoApprovalEnabled", message.bool ?? false)
			break
		case "enhancePrompt":
			if (message.text) {
				try {
					const state = await provider.getState()

					const {
						apiConfiguration,
						customSupportPrompts,
						listApiConfigMeta = [],
						enhancementApiConfigId,
						includeTaskHistoryInEnhance,
					} = state

					const currentShofer = provider.getCurrentTask()

					const result = await MessageEnhancer.enhanceMessage({
						text: message.text,
						apiConfiguration,
						customSupportPrompts,
						listApiConfigMeta,
						enhancementApiConfigId,
						includeTaskHistoryInEnhance,
						currentShoferMessages: currentShofer?.shoferMessages,
						providerSettingsManager: provider.providerSettingsManager,
					})

					if (result.success && result.enhancedText) {
						MessageEnhancer.captureTelemetry(currentShofer?.taskId, includeTaskHistoryInEnhance)
						await provider.postMessageToWebview({ type: "enhancedPrompt", text: result.enhancedText })
					} else {
						throw new Error(result.error || "Unknown error")
					}
				} catch (error) {
					provider.log(
						`Error enhancing prompt: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
					)

					vscode.window.showErrorMessage(t("common:errors.enhance_prompt"))
					await provider.postMessageToWebview({ type: "enhancedPrompt" })
				}
			}
			break
		case "getSystemPrompt":
			try {
				const systemPrompt = await generateSystemPrompt(provider, message)

				await provider.postMessageToWebview({
					type: "systemPrompt",
					text: systemPrompt,
					mode: message.mode,
				})
			} catch (error) {
				provider.log(
					`Error getting system prompt:  ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
				)
				vscode.window.showErrorMessage(t("common:errors.get_system_prompt"))
			}
			break
		case "copySystemPrompt":
			try {
				const systemPrompt = await generateSystemPrompt(provider, message)

				await vscode.env.clipboard.writeText(systemPrompt)
				await vscode.window.showInformationMessage(t("common:info.clipboard_copy"))
			} catch (error) {
				provider.log(
					`Error getting system prompt:  ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
				)
				vscode.window.showErrorMessage(t("common:errors.get_system_prompt"))
			}
			break
		case "searchCommits": {
			const cwd = getCurrentCwd()
			if (cwd) {
				try {
					const commits = await searchCommits(message.query || "", cwd)
					await provider.postMessageToWebview({
						type: "commitSearchResults",
						commits,
					})
				} catch (error) {
					provider.log(
						`Error searching commits: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
					)
					vscode.window.showErrorMessage(t("common:errors.search_commits"))
				}
			}
			break
		}
		case "grepSearch": {
			const workspacePath = getCurrentCwd()

			if (!workspacePath) {
				// Handle case where workspace path is not available
				await provider.postMessageToWebview({
					type: "fileSearchResults",
					results: [],
					requestId: message.requestId,
					error: "No workspace path available",
				})
				break
			}
			try {
				// Call file search service with query from message
				const results = await searchWorkspaceFiles(
					message.query || "",
					workspacePath,
					20, // Use default limit, as filtering is now done in the backend
				)

				// Get the ShoferIgnoreController from the current task, or create a new one
				const currentTask = provider.getCurrentTask()
				let shoferIgnoreController = currentTask?.shoferIgnoreController
				let tempController: ShoferIgnoreController | undefined

				// If no current task or no controller, create a temporary one
				if (!shoferIgnoreController) {
					tempController = new ShoferIgnoreController(workspacePath)
					await tempController.initialize()
					shoferIgnoreController = tempController
				}

				try {
					// Get showShoferIgnoredFiles setting from state
					const { showShoferIgnoredFiles = false } = (await provider.getState()) ?? {}

					// Filter results using ShoferIgnoreController if showShoferIgnoredFiles is false
					let filteredResults = results
					if (!showShoferIgnoredFiles && shoferIgnoreController) {
						const allowedPaths = shoferIgnoreController.filterPaths(results.map((r) => r.path))
						filteredResults = results.filter((r) => allowedPaths.includes(r.path))
					}

					// Send results back to webview
					await provider.postMessageToWebview({
						type: "fileSearchResults",
						results: filteredResults,
						requestId: message.requestId,
					})
				} finally {
					// Dispose temporary controller to prevent resource leak
					tempController?.dispose()
				}
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error)

				// Send error response to webview
				await provider.postMessageToWebview({
					type: "fileSearchResults",
					results: [],
					error: errorMessage,
					requestId: message.requestId,
				})
			}
			break
		}
		case "updateTodoList": {
			// Route the user-edited todo list to the current task's per-instance
			// pending approval snapshot, scoping the edit to the correct task.
			// Replaces the former module-level global `approvedTodoList`.
			const payload = message.payload as { todos?: any[] }
			const todos = payload?.todos
			if (Array.isArray(todos)) {
				const currentTask = provider.getCurrentTask()
				if (currentTask) {
					currentTask.pendingTodoApproval = todos as any
				}
			}
			break
		}
		case "refreshCustomTools": {
			try {
				const toolDirs = getRooDirectoriesForCwd(getCurrentCwd()).map((dir) => path.join(dir, "tools"))
				await customToolRegistry.loadFromDirectories(toolDirs)

				await provider.postMessageToWebview({
					type: "customToolsResult",
					tools: customToolRegistry.getAllSerialized(),
				})
			} catch (error) {
				await provider.postMessageToWebview({
					type: "customToolsResult",
					tools: [],
					error: error instanceof Error ? error.message : String(error),
				})
			}

			break
		}
		case "saveApiConfiguration":
			if (message.text && message.apiConfiguration) {
				try {
					await provider.providerSettingsManager.saveConfig(message.text, message.apiConfiguration)
					const listApiConfig = await provider.providerSettingsManager.listConfig()
					await updateGlobalState("listApiConfigMeta", listApiConfig)
					await reinitializeAssistantAgent(provider)
				} catch (error) {
					provider.log(
						`Error save api configuration: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
					)
					vscode.window.showErrorMessage(t("common:errors.save_api_config"))
				}
			}
			break
		case "upsertApiConfiguration":
			if (message.text && message.apiConfiguration) {
				// bool === false means "save without activating" — the Save path
				// passes activate=false so editing a profile doesn't clobber
				// the global default. Omitted bool (undefined) defaults to
				// activate=true in upsertProviderProfile (backward-compatible).
				const activate = message.bool !== false
				await provider.upsertProviderProfile(message.text, message.apiConfiguration, activate)
				await reinitializeAssistantAgent(provider)
			}
			break
		case "renameApiConfiguration":
			if (message.values && message.apiConfiguration) {
				try {
					const { oldName, newName } = message.values

					if (oldName === newName) {
						break
					}

					// Load the old configuration to get its ID.
					const { id } = await provider.providerSettingsManager.getProfile({ name: oldName })

					// Create a new configuration with the new name and old ID.
					await provider.providerSettingsManager.saveConfig(newName, { ...message.apiConfiguration, id })

					// Delete the old configuration.
					await provider.providerSettingsManager.deleteConfig(oldName)

					// Re-activate to update the global settings related to the
					// currently activated provider profile.
					await provider.activateProviderProfile({ name: newName })
					await reinitializeAssistantAgent(provider)
				} catch (error) {
					provider.log(
						`Error rename api configuration: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
					)

					vscode.window.showErrorMessage(t("common:errors.rename_api_config"))
				}
			}
			break
		case "loadApiConfiguration":
			if (message.text) {
				try {
					// This is a global default change (from Settings → Providers →
					// Configuration Profile dropdown) — it must NOT retroactively
					// overwrite existing tasks' sticky provider profiles.
					// Pass persistTaskHistory: false so running/history tasks keep
					// whatever profile they were created with.
					await provider.activateProviderProfile({ name: message.text }, { persistTaskHistory: false })
					await reinitializeAssistantAgent(provider)
				} catch (error) {
					provider.log(
						`Error load api configuration: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
					)
					vscode.window.showErrorMessage(t("common:errors.load_api_config"))
				}
			}
			break
		case "setDefaultApiConfiguration":
			if (message.text) {
				await provider.setDefaultApiConfiguration(message.text)
				await reinitializeAssistantAgent(provider)
			}
			break
		case "loadApiConfigurationForEdit":
			if (message.text) {
				try {
					await provider.loadApiConfigurationForEdit(message.text)
				} catch (error) {
					provider.log(
						`Error load api configuration for edit: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
					)
					vscode.window.showErrorMessage(t("common:errors.load_api_config"))
				}
			}
			break
		case "loadApiConfigurationById":
			if (message.text) {
				try {
					await provider.activateProviderProfile({ id: message.text })
					await reinitializeAssistantAgent(provider)
				} catch (error) {
					provider.log(
						`Error load api configuration by ID: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
					)
					vscode.window.showErrorMessage(t("common:errors.load_api_config"))
				}
			}
			break
		case "deleteApiConfiguration":
			if (message.text) {
				const answer = await vscode.window.showInformationMessage(
					t("common:confirmation.delete_config_profile"),
					{ modal: true },
					t("common:answers.yes"),
				)

				if (answer !== t("common:answers.yes")) {
					break
				}

				const oldName = message.text

				const newName = (await provider.providerSettingsManager.listConfig()).filter(
					(c) => c.name !== oldName,
				)[0]?.name

				if (!newName) {
					vscode.window.showErrorMessage(t("common:errors.delete_api_config"))
					return
				}

				try {
					await provider.providerSettingsManager.deleteConfig(oldName)
					await provider.activateProviderProfile({ name: newName })
					await reinitializeAssistantAgent(provider)
				} catch (error) {
					provider.log(
						`Error delete api configuration: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
					)

					vscode.window.showErrorMessage(t("common:errors.delete_api_config"))
				}
			}
			break
		case "deleteMessageConfirm":
			if (!message.messageTs) {
				await vscode.window.showErrorMessage(t("common:errors.message.cannot_delete_missing_timestamp"))
				break
			}

			if (typeof message.messageTs !== "number") {
				await vscode.window.showErrorMessage(t("common:errors.message.cannot_delete_invalid_timestamp"))
				break
			}

			await handleDeleteMessageConfirm(message.messageTs, message.restoreCheckpoint)
			break
		case "editMessageConfirm":
			if (message.messageTs && message.text) {
				const resolved = await resolveIncomingImages({ text: message.text, images: message.images })
				await handleEditMessageConfirm(
					message.messageTs,
					resolved.text,
					message.restoreCheckpoint,
					resolved.images,
				)
			}
			break
		case "getListApiConfiguration":
			try {
				const listApiConfig = await provider.providerSettingsManager.listConfig()
				await updateGlobalState("listApiConfigMeta", listApiConfig)
				provider.postMessageToWebview({ type: "listApiConfig", listApiConfig })
			} catch (error) {
				provider.log(
					`Error get list api configuration: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
				)
				vscode.window.showErrorMessage(t("common:errors.list_api_config"))
			}
			break

		case "updateMcpTimeout":
			if (message.serverName && typeof message.timeout === "number") {
				try {
					await provider
						.getMcpHub()
						?.updateServerTimeout(
							message.serverName,
							message.timeout,
							message.source as "global" | "project",
						)
				} catch (error) {
					provider.log(
						`Failed to update timeout for ${message.serverName}: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
					)
					vscode.window.showErrorMessage(t("common:errors.update_server_timeout"))
				}
			}
			break
		case "updateCustomMode":
			if (message.modeConfig) {
				try {
					// Check if this is a new mode or an update to an existing mode
					const existingModes = await provider.customModesManager.getCustomModes()
					const isNewMode = !existingModes.some((mode) => mode.slug === message.modeConfig?.slug)

					await provider.customModesManager.updateCustomMode(message.modeConfig.slug, message.modeConfig)
					// Update state after saving the mode
					const customModes = await provider.customModesManager.getCustomModes()
					await updateGlobalState("customModes", customModes)
					await provider.postInitState()

					// Track telemetry for custom mode creation or update
					if (TelemetryService.hasInstance()) {
						if (isNewMode) {
							// This is a new custom mode
							TelemetryService.instance.captureCustomModeCreated(
								message.modeConfig.slug,
								message.modeConfig.name,
							)
						} else {
							// Determine which setting was changed by comparing objects
							const existingMode = existingModes.find((mode) => mode.slug === message.modeConfig?.slug)
							const changedSettings = existingMode
								? Object.keys(message.modeConfig).filter(
										(key) =>
											JSON.stringify((existingMode as Record<string, unknown>)[key]) !==
											JSON.stringify((message.modeConfig as Record<string, unknown>)[key]),
									)
								: []

							if (changedSettings.length > 0) {
								TelemetryService.instance.captureModeSettingChanged(changedSettings[0])
							}
						}
					}
				} catch (error) {
					// Error already shown to user by updateCustomMode
					// Just prevent unhandled rejection and skip state updates
				}
			}
			break
		case "deleteCustomMode":
			if (message.slug) {
				// Get the mode details to determine source and rules folder path
				const customModes = await provider.customModesManager.getCustomModes()
				const modeToDelete = customModes.find((mode) => mode.slug === message.slug)

				if (!modeToDelete) {
					break
				}

				// Determine the scope based on source (project or global)
				const scope = modeToDelete.source || "global"

				// Determine the rules folder path
				let rulesFolderPath: string
				if (scope === "project") {
					const workspacePath = getWorkspacePath()
					if (workspacePath) {
						rulesFolderPath = path.join(workspacePath, ".shofer", `rules-${message.slug}`)
					} else {
						rulesFolderPath = path.join(".shofer", `rules-${message.slug}`)
					}
				} else {
					// Global scope - use OS home directory
					const homeDir = os.homedir()
					rulesFolderPath = path.join(homeDir, ".shofer", `rules-${message.slug}`)
				}

				// Check if the rules folder exists
				const rulesFolderExists = await fileExistsAtPath(rulesFolderPath)

				// If this is a check request, send back the folder info
				if (message.checkOnly) {
					await provider.postMessageToWebview({
						type: "deleteCustomModeCheck",
						slug: message.slug,
						rulesFolderPath: rulesFolderExists ? rulesFolderPath : undefined,
					})
					break
				}

				// Delete the mode
				await provider.customModesManager.deleteCustomMode(message.slug)

				// Delete the rules folder if it exists
				if (rulesFolderExists) {
					try {
						await fs.rm(rulesFolderPath, { recursive: true, force: true })
						provider.debug?.(`Deleted rules folder for mode ${message.slug}: ${rulesFolderPath}`)
					} catch (error) {
						provider.debug?.(`Failed to delete rules folder for mode ${message.slug}: ${error}`)
						// Notify the user about the failure
						vscode.window.showErrorMessage(
							t("common:errors.delete_rules_folder_failed", {
								rulesFolderPath,
								error: error instanceof Error ? error.message : String(error),
							}),
						)
						// Continue with mode deletion even if folder deletion fails
					}
				}

				// Reset the launcher handoff and/or focused task off the deleted mode.
				await provider.handleModeDeleted(message.slug as Mode)
			}
			break
		case "exportMode":
			if (message.slug) {
				try {
					// Get custom mode prompts to check if built-in mode has been customized
					const customModePrompts = getGlobalState("customModePrompts") || {}
					const customPrompt = customModePrompts[message.slug]

					// Export the mode with any customizations merged directly
					const result = await provider.customModesManager.exportModeWithRules(message.slug, customPrompt)

					if (result.success && result.yaml) {
						const defaultUri = await resolveDefaultSaveUri(
							provider.contextProxy,
							"lastModeExportPath",
							`${message.slug}-export.yaml`,
							{
								useWorkspace: true,
								fallbackDir: path.join(os.homedir(), "Downloads"),
							},
						)

						// Show save dialog
						const saveUri = await vscode.window.showSaveDialog({
							defaultUri,
							filters: {
								"YAML files": ["yaml", "yml"],
							},
							title: "Save mode export",
						})

						if (saveUri && result.yaml) {
							// Save the directory for next time
							await saveLastExportPath(provider.contextProxy, "lastModeExportPath", saveUri)

							// Write the file to the selected location
							await fs.writeFile(saveUri.fsPath, result.yaml, "utf-8")

							// Send success message to webview
							provider.postMessageToWebview({
								type: "exportModeResult",
								success: true,
								slug: message.slug,
							})

							// Show info message
							vscode.window.showInformationMessage(t("common:info.mode_exported", { mode: message.slug }))
						} else {
							// User cancelled the save dialog
							provider.postMessageToWebview({
								type: "exportModeResult",
								success: false,
								error: "Export cancelled",
								slug: message.slug,
							})
						}
					} else {
						// Send error message to webview
						provider.postMessageToWebview({
							type: "exportModeResult",
							success: false,
							error: result.error,
							slug: message.slug,
						})
					}
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : String(error)
					provider.log(`Failed to export mode ${message.slug}: ${errorMessage}`)

					// Send error message to webview
					provider.postMessageToWebview({
						type: "exportModeResult",
						success: false,
						error: errorMessage,
						slug: message.slug,
					})
				}
			}
			break
		case "importMode":
			try {
				// Get last used directory for import
				const lastImportPath = getGlobalState("lastModeImportPath")
				let defaultUri: vscode.Uri | undefined

				if (lastImportPath) {
					// Use the directory from the last import
					const lastDir = path.dirname(lastImportPath)
					defaultUri = vscode.Uri.file(lastDir)
				} else {
					// Default to workspace or home directory
					const workspaceFolders = vscode.workspace.workspaceFolders
					if (workspaceFolders && workspaceFolders.length > 0) {
						defaultUri = vscode.Uri.file(workspaceFolders[0].uri.fsPath)
					}
				}

				// Show file picker to select YAML file
				const fileUri = await vscode.window.showOpenDialog({
					canSelectFiles: true,
					canSelectFolders: false,
					canSelectMany: false,
					defaultUri,
					filters: {
						"YAML files": ["yaml", "yml"],
					},
					title: "Select mode export file to import",
				})

				if (fileUri && fileUri[0]) {
					// Save the directory for next time
					await updateGlobalState("lastModeImportPath", fileUri[0].fsPath)

					// Read the file content
					const yamlContent = await fs.readFile(fileUri[0].fsPath, "utf-8")

					// Import the mode with the specified source level
					const result = await provider.customModesManager.importModeWithRules(
						yamlContent,
						message.source || "project", // Default to project if not specified
					)

					if (result.success) {
						// Update state after importing
						const customModes = await provider.customModesManager.getCustomModes()
						await updateGlobalState("customModes", customModes)
						await provider.postInitState()

						// Send success message to webview, include the imported slug so UI can switch
						provider.postMessageToWebview({
							type: "importModeResult",
							success: true,
							slug: result.slug,
						})

						// Show success message
						vscode.window.showInformationMessage(t("common:info.mode_imported"))
					} else {
						// Send error message to webview
						provider.postMessageToWebview({
							type: "importModeResult",
							success: false,
							error: result.error,
						})

						// Show error message
						vscode.window.showErrorMessage(t("common:errors.mode_import_failed", { error: result.error }))
					}
				} else {
					// User cancelled the file dialog - reset the importing state
					provider.postMessageToWebview({
						type: "importModeResult",
						success: false,
						error: "cancelled",
					})
				}
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error)
				provider.log(`Failed to import mode: ${errorMessage}`)

				// Send error message to webview
				provider.postMessageToWebview({
					type: "importModeResult",
					success: false,
					error: errorMessage,
				})

				// Show error message
				vscode.window.showErrorMessage(t("common:errors.mode_import_failed", { error: errorMessage }))
			}
			break
		case "checkRulesDirectory":
			if (message.slug) {
				const hasContent = await provider.customModesManager.checkRulesDirectoryHasContent(message.slug)

				provider.postMessageToWebview({
					type: "checkRulesDirectoryResult",
					slug: message.slug,
					hasContent: hasContent,
				})
			}
			break
		case "telemetrySetting": {
			const telemetrySetting = message.text as TelemetrySetting
			const previousSetting = getGlobalState("telemetrySetting") || "unset"
			const isOptedIn = telemetrySetting !== "disabled"
			const wasPreviouslyOptedIn = previousSetting !== "disabled"

			// If turning telemetry OFF, fire event BEFORE disabling
			if (wasPreviouslyOptedIn && !isOptedIn && TelemetryService.hasInstance()) {
				TelemetryService.instance.captureTelemetrySettingsChanged(previousSetting, telemetrySetting)
			}

			// Update the telemetry state
			await updateGlobalState("telemetrySetting", telemetrySetting)

			if (TelemetryService.hasInstance()) {
				TelemetryService.instance.updateTelemetryState(isOptedIn)
			}

			// If turning telemetry ON, fire event AFTER enabling
			if (!wasPreviouslyOptedIn && isOptedIn && TelemetryService.hasInstance()) {
				TelemetryService.instance.captureTelemetrySettingsChanged(previousSetting, telemetrySetting)
			}

			provider.postConfigUpdate("telemetrySetting", telemetrySetting)
			break
		}
		case "debugSetting": {
			await vscode.workspace
				.getConfiguration(Package.name)
				.update("debug", message.bool ?? false, vscode.ConfigurationTarget.Global)
			provider.postConfigUpdate("debug", message.bool ?? false)
			break
		}
		case "shoferCloudSignIn": {
			vscode.window.showErrorMessage("Cloud services have been removed.")
			break
		}
		case "cloudLandingPageSignIn": {
			vscode.window.showErrorMessage("Cloud services have been removed.")
			break
		}
		case "shoferCloudSignOut": {
			break
		}
		case "openAiCodexSignIn": {
			try {
				const { openAiCodexOAuthManager } = await import("../../integrations/openai-codex/oauth")
				const authUrl = openAiCodexOAuthManager.startAuthorizationFlow()

				// Open the authorization URL in the browser
				await vscode.env.openExternal(vscode.Uri.parse(authUrl))

				// Wait for the callback in a separate promise (non-blocking)
				openAiCodexOAuthManager
					.waitForCallback()
					.then(async () => {
						vscode.window.showInformationMessage("Successfully signed in to OpenAI Codex")
						await provider.postInitState()
					})
					.catch((error) => {
						provider.log(`OpenAI Codex OAuth callback failed: ${error}`)
						if (!String(error).includes("timed out")) {
							vscode.window.showErrorMessage(`OpenAI Codex sign in failed: ${error.message || error}`)
						}
					})
			} catch (error) {
				provider.log(`OpenAI Codex OAuth failed: ${error}`)
				vscode.window.showErrorMessage("OpenAI Codex sign in failed.")
			}
			break
		}
		case "openAiCodexSignOut": {
			try {
				const { openAiCodexOAuthManager } = await import("../../integrations/openai-codex/oauth")
				await openAiCodexOAuthManager.clearCredentials()
				vscode.window.showInformationMessage("Signed out from OpenAI Codex")
				await provider.postInitState()
			} catch (error) {
				provider.log(`OpenAI Codex sign out failed: ${error}`)
				vscode.window.showErrorMessage("OpenAI Codex sign out failed.")
			}
			break
		}
		case "walkthroughOpen": {
			await vscode.commands.executeCommand(
				"workbench.action.openWalkthrough",
				"shoferdev.shofer#shofer.getStarted",
				false,
			)
			break
		}
		case "shoferCloudManualUrl": {
			try {
				if (!message.text) {
					vscode.window.showErrorMessage(t("common:errors.manual_url_empty"))
					break
				}

				// Parse the callback URL to extract parameters
				const callbackUrl = message.text.trim()
				const uri = vscode.Uri.parse(callbackUrl)

				if (!uri.query) {
					throw new Error(t("common:errors.manual_url_no_query"))
				}

				const query = new URLSearchParams(uri.query)
				const code = query.get("code")
				const state = query.get("state")
				const organizationId = query.get("organizationId")

				if (!code || !state) {
					throw new Error(t("common:errors.manual_url_missing_params"))
				}

				// Cloud auth callback no longer supported
				vscode.window.showErrorMessage("Cloud services have been removed.")

				await provider.postInitState()
			} catch (error) {
				provider.log(`ManualUrl#handleAuthCallback failed: ${error}`)
				const errorMessage = error instanceof Error ? error.message : t("common:errors.manual_url_auth_failed")

				// Show error message through VS Code UI
				vscode.window.showErrorMessage(`${t("common:errors.manual_url_auth_error")}: ${errorMessage}`)
			}

			break
		}
		case "clearCloudAuthSkipModel": {
			// Clear the flag that indicates auth completed without model selection
			await provider.context.globalState.update("shofer-auth-skip-model", undefined)
			await provider.postInitState()
			break
		}
		case "switchOrganization": {
			// Organization switching removed with cloud services
			break
		}
		case "saveCodeIndexSettingsAtomic": {
			if (!message.codeIndexSettings) {
				break
			}

			const settings = message.codeIndexSettings

			try {
				// Check if embedder provider has changed. Only compare when the
				// incoming payload includes the provider field — with the refactored
				// secrets-only save path the field is absent (undefined), which must
				// not be treated as a change from the persisted value.
				const currentConfig = getGlobalState("codebaseIndexConfig") || {}
				const embedderProviderChanged =
					settings.codebaseIndexEmbedderProvider !== undefined &&
					currentConfig.codebaseIndexEmbedderProvider !== settings.codebaseIndexEmbedderProvider

				// Save global state settings atomically
				const globalStateConfig = {
					...currentConfig,
					codebaseIndexEnabled: settings.codebaseIndexEnabled,
					codebaseIndexQdrantUrl: settings.codebaseIndexQdrantUrl,
					codebaseIndexEmbedderProvider: settings.codebaseIndexEmbedderProvider,
					codebaseIndexEmbedderBaseUrl: settings.codebaseIndexEmbedderBaseUrl,
					codebaseIndexEmbedderModelId: settings.codebaseIndexEmbedderModelId,
					codebaseIndexEmbedderModelDimension: settings.codebaseIndexEmbedderModelDimension, // Generic dimension
					codebaseIndexOpenAiCompatibleBaseUrl: settings.codebaseIndexOpenAiCompatibleBaseUrl,
					codebaseIndexBedrockRegion: settings.codebaseIndexBedrockRegion,
					codebaseIndexBedrockProfile: settings.codebaseIndexBedrockProfile,
					codebaseIndexSearchMaxResults: settings.codebaseIndexSearchMaxResults,
					codebaseIndexSearchMinScore: settings.codebaseIndexSearchMinScore,
					codebaseIndexOpenRouterSpecificProvider: settings.codebaseIndexOpenRouterSpecificProvider,
				}

				// Save global state first
				await updateGlobalState("codebaseIndexConfig", globalStateConfig)

				// Save secrets directly using context proxy
				if (settings.codeIndexOpenAiKey !== undefined) {
					await provider.contextProxy.storeSecret("codeIndexOpenAiKey", settings.codeIndexOpenAiKey)
				}
				if (settings.codeIndexQdrantApiKey !== undefined) {
					await provider.contextProxy.storeSecret("codeIndexQdrantApiKey", settings.codeIndexQdrantApiKey)
				}
				if (settings.codebaseIndexOpenAiCompatibleApiKey !== undefined) {
					await provider.contextProxy.storeSecret(
						"codebaseIndexOpenAiCompatibleApiKey",
						settings.codebaseIndexOpenAiCompatibleApiKey,
					)
				}
				if (settings.codebaseIndexGeminiApiKey !== undefined) {
					await provider.contextProxy.storeSecret(
						"codebaseIndexGeminiApiKey",
						settings.codebaseIndexGeminiApiKey,
					)
				}
				if (settings.codebaseIndexMistralApiKey !== undefined) {
					await provider.contextProxy.storeSecret(
						"codebaseIndexMistralApiKey",
						settings.codebaseIndexMistralApiKey,
					)
				}
				if (settings.codebaseIndexVercelAiGatewayApiKey !== undefined) {
					await provider.contextProxy.storeSecret(
						"codebaseIndexVercelAiGatewayApiKey",
						settings.codebaseIndexVercelAiGatewayApiKey,
					)
				}
				if (settings.codebaseIndexOpenRouterApiKey !== undefined) {
					await provider.contextProxy.storeSecret(
						"codebaseIndexOpenRouterApiKey",
						settings.codebaseIndexOpenRouterApiKey,
					)
				}

				// Send success response first - settings are saved regardless of validation
				await provider.postMessageToWebview({
					type: "codeIndexSettingsSaved",
					success: true,
					settings: globalStateConfig,
				})

				// Update webview state
				await provider.postInitState()

				// Then handle validation and initialization for the current workspace
				const currentCodeIndexManager = provider.getCurrentWorkspaceCodeIndexManager()
				if (currentCodeIndexManager) {
					// If embedder provider changed, perform proactive validation
					if (embedderProviderChanged) {
						try {
							// Force handleSettingsChange which will trigger validation
							await currentCodeIndexManager.handleSettingsChange()
						} catch (error) {
							// Validation failed - the error state is already set by handleSettingsChange
							provider.log(
								`Embedder validation failed after provider change: ${error instanceof Error ? error.message : String(error)}`,
							)
							// Send validation error to webview
							await provider.postMessageToWebview({
								type: "indexingStatusUpdate",
								values: currentCodeIndexManager.getCurrentStatus(),
							})
							// Exit early - don't try to start indexing with invalid configuration
							break
						}
					} else {
						// No provider change, just handle settings normally
						try {
							await currentCodeIndexManager.handleSettingsChange()
						} catch (error) {
							// Log but don't fail - settings are saved
							provider.log(
								`Settings change handling error: ${error instanceof Error ? error.message : String(error)}`,
							)
						}
					}

					// Wait a bit more to ensure everything is ready
					await new Promise((resolve) => setTimeout(resolve, 200))

					// Auto-start indexing after settings save.
					//
					// Important: isFeatureEnabled / isFeatureConfigured read from
					// _configManager, which is only populated inside initialize(). A
					// freshly-created manager therefore always returns false for both,
					// making a guard like `if (isEnabled && isConfigured)` a
					// chicken-and-egg deadlock. Instead, we call initialize()
					// unconditionally when not yet initialized — initialize() will
					// load the config itself and decide whether to start indexing.
					// For an already-initialized manager (e.g. after handleSettingsChange
					// recreated services and left the orchestrator in Standby), we
					// check the live flags and kick startIndexing() directly.
					if (!currentCodeIndexManager.isInitialized) {
						try {
							await currentCodeIndexManager.initialize(provider.contextProxy)
							provider.debug?.(`Code index manager initialized after settings save`)
						} catch (error) {
							provider.log(
								`Code index initialization failed: ${error instanceof Error ? error.message : String(error)}`,
							)
							await provider.postMessageToWebview({
								type: "indexingStatusUpdate",
								values: currentCodeIndexManager.getCurrentStatus(),
							})
						}
					} else if (
						currentCodeIndexManager.isFeatureEnabled &&
						currentCodeIndexManager.isFeatureConfigured &&
						currentCodeIndexManager.state !== "Indexing"
					) {
						// Manager was already initialized (e.g. handleSettingsChange
						// recreated services) but indexing hasn't started. Kick it off.
						try {
							await currentCodeIndexManager.startIndexing()
							provider.debug?.(`Code index started after settings save`)
						} catch (error) {
							provider.log(
								`Code index start failed after settings save: ${error instanceof Error ? error.message : String(error)}`,
							)
							await provider.postMessageToWebview({
								type: "indexingStatusUpdate",
								values: currentCodeIndexManager.getCurrentStatus(),
							})
						}
					}
				} else {
					// No workspace open - send error status
					provider.debug?.("Cannot save code index settings: No workspace folder open")
					await provider.postMessageToWebview({
						type: "indexingStatusUpdate",
						values: {
							systemStatus: "Error",
							message: t("embeddings:orchestrator.indexingRequiresWorkspace"),
							processedItems: 0,
							totalItems: 0,
							currentItemUnit: "items",
						},
					})
				}
			} catch (error) {
				provider.log(
					`Error saving code index settings: ${error instanceof Error ? error.message : String(error)}`,
				)
				await provider.postMessageToWebview({
					type: "codeIndexSettingsSaved",
					success: false,
					error: error instanceof Error ? error.message : "Failed to save settings",
				})
			}
			break
		}

		case "updateCodebaseIndexConfig": {
			// Merge a partial patch into the persisted `codebaseIndexConfig`
			// global state (a single nested object). The popover's
			// code-enable + git-enable toggles use this so they can flip one
			// field without rewriting the whole config + secrets that
			// `saveCodeIndexSettingsAtomic` requires. We must NOT route
			// through generic `updateSettings` here: those handlers treat
			// each key as a top-level ContextProxy entry and would write to
			// a non-existent state slot, leaving the nested config (and the
			// popover's bound checkbox) unchanged on the next state
			// broadcast.
			//
			// In addition to persisting, this handler is the single
			// lifecycle entry point for the popover's enable toggles: when
			// `codebaseIndexEnabled` or `codebaseIndexGitEnabled` flips we
			// drive the respective manager's `handleSettingsChange` so
			// indexing starts/stops immediately without an explicit "Start"
			// button. This is the UX the popover relies on after the
			// dedicated start/stop buttons were removed.
			const patch = message.codebaseIndexConfigPartial
			if (!patch || typeof patch !== "object") {
				break
			}
			try {
				const currentConfig = getGlobalState("codebaseIndexConfig") || {}
				const codeEnableFlipped =
					"codebaseIndexEnabled" in patch &&
					Boolean(patch.codebaseIndexEnabled) !== Boolean(currentConfig.codebaseIndexEnabled)
				const gitEnableFlipped =
					"codebaseIndexGitEnabled" in patch &&
					Boolean(patch.codebaseIndexGitEnabled) !== Boolean(currentConfig.codebaseIndexGitEnabled)
				const merged = { ...currentConfig, ...patch }
				await updateGlobalState("codebaseIndexConfig", merged)
				await provider.postInitState()

				if (codeEnableFlipped) {
					const codeManager = provider.getCurrentWorkspaceCodeIndexManager()
					if (codeManager) {
						try {
							if (!codeManager.isInitialized) {
								// Manager never initialized — run full initialization which
								// will load config and start indexing if enabled/configured.
								await codeManager.initialize(provider.contextProxy)
							} else {
								await codeManager.handleSettingsChange()
								// If toggled ON and not yet indexing, kick it off.
								if (
									patch.codebaseIndexEnabled &&
									codeManager.isFeatureEnabled &&
									codeManager.isFeatureConfigured &&
									codeManager.state !== "Indexing"
								) {
									await codeManager.startIndexing()
								}
							}
							await provider.postMessageToWebview({
								type: "indexingStatusUpdate",
								values: codeManager.getCurrentStatus(),
							})
						} catch (error) {
							provider.log(
								`Error toggling code indexing: ${error instanceof Error ? error.message : String(error)}`,
							)
						}
					}
				}

				if (gitEnableFlipped) {
					const gitManager = GitIndexManager.getInstance(provider.context)
					if (gitManager) {
						try {
							await gitManager.handleSettingsChange(provider.contextProxy)
							const status = gitManager.getCurrentStatus()
							await provider.postMessageToWebview({
								type: "gitIndexingStatusUpdate",
								values: {
									systemStatus: status.systemStatus,
									message: status.message ?? "",
									processedItems: 0,
									totalItems: 0,
									currentItemUnit: "commits",
									workspacePath: gitManager.workspacePath,
									indexedCommitCount: status.indexedCommitCount,
									latestCommitHash: status.latestCommitHash,
								},
							})
						} catch (error) {
							provider.log(
								`Error toggling git indexing: ${error instanceof Error ? error.message : String(error)}`,
							)
						}
					}
				}
			} catch (error) {
				provider.log(
					`Error updating codebaseIndexConfig: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
			break
		}

		case "requestIndexingStatus": {
			const manager = provider.getCurrentWorkspaceCodeIndexManager()
			if (!manager) {
				// No manager instance for this workspace — the feature is
				// effectively disabled (either no workspace open or the toggle
				// was off at activation). Surface as "Disabled" so the badge
				// can render the idle/grey state without inferring it from a
				// separate config lookup.
				provider.postMessageToWebview({
					type: "indexingStatusUpdate",
					values: {
						systemStatus: "Disabled",
						message: t("embeddings:orchestrator.indexingRequiresWorkspace"),
						processedItems: 0,
						totalItems: 0,
						currentItemUnit: "items",
						workerspacePath: undefined,
					},
				})
				return
			}

			const status = manager
				? manager.getCurrentStatus()
				: {
						systemStatus: "Standby",
						message: "No workspace folder open",
						processedItems: 0,
						totalItems: 0,
						currentItemUnit: "items",
						workspacePath: undefined,
					}

			provider.postMessageToWebview({
				type: "indexingStatusUpdate",
				values: status,
			})
			break
		}
		case "assistantAgentAction": {
			// Routes assistant-agent toolbar actions from the in-webview status badge
			// to the corresponding extension commands. Used by the popover that
			// replaced the former VS Code status bar item.
			const action = message.text
			switch (action) {
				case "start":
					await vscode.commands.executeCommand("shofer.assistantAgent.start")
					break
				case "stop":
					await vscode.commands.executeCommand("shofer.assistantAgent.stop")
					break
				case "clear":
					await vscode.commands.executeCommand("shofer.assistantAgent.clearContext")
					break
				case "chat":
					await vscode.commands.executeCommand("shofer.assistantAgent.showChat")
					break
			}
			break
		}
		case "requestAssistantAgentStatus": {
			provider.sendAssistantAgentStatus()
			break
		}
		case "requestCodeIndexSecretStatus": {
			// Check if secrets are set using the VSCode context directly for async access
			const hasOpenAiKey = !!(await provider.context.secrets.get("codeIndexOpenAiKey"))
			const hasQdrantApiKey = !!(await provider.context.secrets.get("codeIndexQdrantApiKey"))
			const hasOpenAiCompatibleApiKey = !!(await provider.context.secrets.get(
				"codebaseIndexOpenAiCompatibleApiKey",
			))
			const hasGeminiApiKey = !!(await provider.context.secrets.get("codebaseIndexGeminiApiKey"))
			const hasMistralApiKey = !!(await provider.context.secrets.get("codebaseIndexMistralApiKey"))
			const hasVercelAiGatewayApiKey = !!(await provider.context.secrets.get(
				"codebaseIndexVercelAiGatewayApiKey",
			))
			const hasOpenRouterApiKey = !!(await provider.context.secrets.get("codebaseIndexOpenRouterApiKey"))

			provider.postMessageToWebview({
				type: "codeIndexSecretStatus",
				values: {
					hasOpenAiKey,
					hasQdrantApiKey,
					hasOpenAiCompatibleApiKey,
					hasGeminiApiKey,
					hasMistralApiKey,
					hasVercelAiGatewayApiKey,
					hasOpenRouterApiKey,
				},
			})
			break
		}
		case "toggleWorkspaceIndexing": {
			try {
				const manager = provider.getCurrentWorkspaceCodeIndexManager()
				if (!manager) {
					provider.log("Cannot toggle workspace indexing: No workspace folder open")
					return
				}
				const enabled = message.bool ?? false
				await manager.setWorkspaceEnabled(enabled)
				if (enabled && manager.isFeatureEnabled && manager.isFeatureConfigured) {
					await manager.initialize(provider.contextProxy)
					manager.startIndexing()
				} else if (!enabled) {
					manager.stopIndexing()
				}
				provider.postMessageToWebview({
					type: "indexingStatusUpdate",
					values: manager.getCurrentStatus(),
				})
			} catch (error) {
				provider.log(
					`Error toggling workspace indexing: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
			break
		}
		case "setAutoEnableDefault": {
			try {
				const manager = provider.getCurrentWorkspaceCodeIndexManager()
				if (!manager) {
					provider.log("Cannot set auto-enable default: No workspace folder open")
					return
				}
				// Capture prior state for every manager before persisting the global change
				const allManagers = CodeIndexManager.getAllInstances()
				const priorStates = new Map(allManagers.map((m) => [m, m.isWorkspaceEnabled]))
				await manager.setAutoEnableDefault(message.bool ?? true)
				// Apply stop/start to every affected manager
				for (const m of allManagers) {
					const wasEnabled = priorStates.get(m)!
					const isNowEnabled = m.isWorkspaceEnabled
					if (wasEnabled && !isNowEnabled) {
						m.stopIndexing()
					} else if (!wasEnabled && isNowEnabled && m.isFeatureEnabled && m.isFeatureConfigured) {
						await m.initialize(provider.contextProxy)
						m.startIndexing()
					}
				}
				provider.postMessageToWebview({
					type: "indexingStatusUpdate",
					values: manager.getCurrentStatus(),
				})
			} catch (error) {
				provider.log(
					`Error setting auto-enable default: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
			break
		}
		case "clearIndexData": {
			try {
				const manager = provider.getCurrentWorkspaceCodeIndexManager()
				if (!manager) {
					provider.log("Cannot clear index data: No workspace folder open")
					provider.postMessageToWebview({
						type: "indexCleared",
						values: {
							success: false,
							error: t("embeddings:orchestrator.indexingRequiresWorkspace"),
						},
					})
					return
				}
				await manager.clearIndexData()
				provider.postMessageToWebview({ type: "indexCleared", values: { success: true } })
			} catch (error) {
				provider.log(`Error clearing index data: ${error instanceof Error ? error.message : String(error)}`)
				provider.postMessageToWebview({
					type: "indexCleared",
					values: {
						success: false,
						error: error instanceof Error ? error.message : String(error),
					},
				})
			}
			break
		}
		case "clearGitIndexData": {
			try {
				const manager = GitIndexManager.getInstance(provider.context)
				if (!manager) {
					provider.log("Cannot clear git index data: No workspace folder open")
					provider.postMessageToWebview({
						type: "gitIndexCleared",
						values: { success: false, error: "No workspace folder open" },
					})
					return
				}
				await manager.clearIndexData()
				provider.postMessageToWebview({ type: "gitIndexCleared", values: { success: true } })
			} catch (error) {
				provider.log(`Error clearing git index data: ${error instanceof Error ? error.message : String(error)}`)
				provider.postMessageToWebview({
					type: "gitIndexCleared",
					values: {
						success: false,
						error: error instanceof Error ? error.message : String(error),
					},
				})
			}
			break
		}
		case "requestGitIndexingStatus": {
			try {
				const manager = GitIndexManager.getInstance(provider.context)
				if (manager) {
					const status = manager.getCurrentStatus()
					provider.postMessageToWebview({
						type: "gitIndexingStatusUpdate",
						values: {
							systemStatus: status.systemStatus,
							message: status.message ?? "",
							processedItems: 0,
							totalItems: 0,
							currentItemUnit: "commits",
							workspacePath: manager.workspacePath,
							indexedCommitCount: status.indexedCommitCount,
							latestCommitHash: status.latestCommitHash,
						},
					})
				}
			} catch (error) {
				provider.log(
					`Error requesting git indexing status: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
			break
		}
		case "focusPanelRequest": {
			// Execute the focusPanel command to focus the WebView
			await vscode.commands.executeCommand(getCommand("focusPanel"))
			break
		}
		case "filterMarketplaceItems": {
			if (marketplaceManager && message.filters) {
				try {
					await marketplaceManager.updateWithFilteredItems({
						type: message.filters.type as MarketplaceItemType | undefined,
						search: message.filters.search,
						tags: message.filters.tags,
					})
					await provider.postInitState()
				} catch (error) {
					webviewLog.error("Marketplace: Error filtering items:", error)
					vscode.window.showErrorMessage("Failed to filter marketplace items")
				}
			}
			break
		}

		case "fetchMarketplaceData": {
			// Fetch marketplace data on demand
			await provider.fetchMarketplaceData()
			break
		}

		case "installMarketplaceItem": {
			if (marketplaceManager && message.mpItem && message.mpInstallOptions) {
				try {
					const configFilePath = await marketplaceManager.installMarketplaceItem(
						message.mpItem,
						message.mpInstallOptions,
					)
					await provider.postInitState()
					webviewLog.info(`Marketplace item installed and config file opened: ${configFilePath}`)

					// Send success message to webview
					provider.postMessageToWebview({
						type: "marketplaceInstallResult",
						success: true,
						slug: message.mpItem.id,
					})
				} catch (error) {
					webviewLog.error(`Error installing marketplace item: ${error}`)
					// Send error message to webview
					provider.postMessageToWebview({
						type: "marketplaceInstallResult",
						success: false,
						error: error instanceof Error ? error.message : String(error),
						slug: message.mpItem.id,
					})
				}
			}
			break
		}

		case "removeInstalledMarketplaceItem": {
			if (marketplaceManager && message.mpItem && message.mpInstallOptions) {
				try {
					await marketplaceManager.removeInstalledMarketplaceItem(message.mpItem, message.mpInstallOptions)
					await provider.postInitState()

					// Send success message to webview
					provider.postMessageToWebview({
						type: "marketplaceRemoveResult",
						success: true,
						slug: message.mpItem.id,
					})
				} catch (error) {
					webviewLog.error(`Error removing marketplace item: ${error}`)

					// Show error message to user
					vscode.window.showErrorMessage(
						`Failed to remove marketplace item: ${error instanceof Error ? error.message : String(error)}`,
					)

					// Send error message to webview
					provider.postMessageToWebview({
						type: "marketplaceRemoveResult",
						success: false,
						error: error instanceof Error ? error.message : String(error),
						slug: message.mpItem.id,
					})
				}
			} else {
				// MarketplaceManager not available or missing required parameters
				const errorMessage = !marketplaceManager
					? "Marketplace manager is not available"
					: "Missing required parameters for marketplace item removal"
				webviewLog.error(errorMessage)

				vscode.window.showErrorMessage(errorMessage)

				if (message.mpItem?.id) {
					provider.postMessageToWebview({
						type: "marketplaceRemoveResult",
						success: false,
						error: errorMessage,
						slug: message.mpItem.id,
					})
				}
			}
			break
		}

		case "installMarketplaceItemWithParameters": {
			if (marketplaceManager && message.payload && "item" in message.payload && "parameters" in message.payload) {
				try {
					const configFilePath = await marketplaceManager.installMarketplaceItem(message.payload.item, {
						parameters: message.payload.parameters,
					})
					await provider.postInitState()
					webviewLog.info(
						`Marketplace item with parameters installed and config file opened: ${configFilePath}`,
					)
				} catch (error) {
					webviewLog.error(`Error installing marketplace item with parameters: ${error}`)
					vscode.window.showErrorMessage(
						`Failed to install marketplace item: ${error instanceof Error ? error.message : String(error)}`,
					)
				}
			}
			break
		}

		case "switchTab": {
			if (message.tab) {
				// Capture tab shown event for all switchTab messages (which are user-initiated).
				if (TelemetryService.hasInstance()) {
					TelemetryService.instance.captureTabShown(message.tab)
				}

				await provider.postMessageToWebview({
					type: "action",
					action: "switchTab",
					tab: message.tab,
					values: message.values,
				})
			}
			break
		}
		case "requestCommands": {
			try {
				const commandList = await getDiscoveredCommands()
				await provider.postMessageToWebview({ type: "commands", commands: commandList })
			} catch (error) {
				provider.log(`Error fetching commands: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`)
				await provider.postMessageToWebview({ type: "commands", commands: [] })
			}
			break
		}
		case "requestModes": {
			try {
				const modes = await provider.getModes()
				await provider.postMessageToWebview({ type: "modes", modes })
			} catch (error) {
				provider.log(`Error fetching modes: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`)
				await provider.postMessageToWebview({ type: "modes", modes: [] })
			}
			break
		}
		case "requestSkills": {
			await handleRequestSkills(provider)
			break
		}
		case "createSkill": {
			await handleCreateSkill(provider, message)
			break
		}
		case "deleteSkill": {
			await handleDeleteSkill(provider, message)
			break
		}
		case "moveSkill": {
			await handleMoveSkill(provider, message)
			break
		}
		case "updateSkillModes": {
			await handleUpdateSkillModes(provider, message)
			break
		}
		case "openSkillFile": {
			await handleOpenSkillFile(provider, message)
			break
		}
		case "openCommandFile": {
			try {
				if (message.text) {
					const { getCommand } = await import("../../services/command/commands")
					const command = await getCommand(getCurrentCwd(), message.text)

					if (command && command.filePath) {
						openFile(command.filePath)
					} else {
						vscode.window.showErrorMessage(t("common:errors.command_not_found", { name: message.text }))
					}
				}
			} catch (error) {
				provider.log(
					`Error opening command file: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
				)
				vscode.window.showErrorMessage(t("common:errors.open_command_file"))
			}
			break
		}
		case "deleteCommand": {
			try {
				if (message.text && message.values?.source) {
					const { getCommand } = await import("../../services/command/commands")
					const command = await getCommand(getCurrentCwd(), message.text)

					if (command && command.filePath) {
						// Delete the command file
						await fs.unlink(command.filePath)
						provider.log(`Deleted command file: ${command.filePath}`)
					} else {
						vscode.window.showErrorMessage(t("common:errors.command_not_found", { name: message.text }))
					}
				}
			} catch (error) {
				provider.log(`Error deleting command: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`)
				vscode.window.showErrorMessage(t("common:errors.delete_command"))
			}
			break
		}
		case "createCommand": {
			try {
				const source = message.values?.source as "global" | "project"
				const fileName = message.text // Custom filename from user input

				if (!source) {
					provider.log("Missing source for createCommand")
					break
				}

				// Determine the commands directory based on source
				let commandsDir: string
				if (source === "global") {
					const globalConfigDir = path.join(os.homedir(), ".shofer")
					commandsDir = path.join(globalConfigDir, "commands")
				} else {
					if (!vscode.workspace.workspaceFolders?.length) {
						vscode.window.showErrorMessage(t("common:errors.no_workspace"))
						return
					}
					// Project commands
					const workspaceRoot = getCurrentCwd()
					if (!workspaceRoot) {
						vscode.window.showErrorMessage(t("common:errors.no_workspace_for_project_command"))
						break
					}
					commandsDir = path.join(workspaceRoot, ".shofer", "commands")
				}

				// Ensure the commands directory exists
				await fs.mkdir(commandsDir, { recursive: true })

				// Use provided filename or generate a unique one
				let commandName: string
				if (fileName && fileName.trim()) {
					let cleanFileName = fileName.trim()

					// Strip leading slash if present
					if (cleanFileName.startsWith("/")) {
						cleanFileName = cleanFileName.substring(1)
					}

					// Remove .md extension if present BEFORE slugification
					if (cleanFileName.toLowerCase().endsWith(".md")) {
						cleanFileName = cleanFileName.slice(0, -3)
					}

					// Slugify the command name: lowercase, replace spaces with dashes, remove special characters
					commandName = cleanFileName
						.toLowerCase()
						.replace(/\s+/g, "-") // Replace spaces with dashes
						.replace(/[^a-z0-9-]/g, "") // Remove special characters except dashes
						.replace(/-+/g, "-") // Replace multiple dashes with single dash
						.replace(/^-|-$/g, "") // Remove leading/trailing dashes

					// Ensure we have a valid command name
					if (!commandName || commandName.length === 0) {
						commandName = "new-command"
					}
				} else {
					// Generate a unique command name
					commandName = "new-command"
					let counter = 1
					let filePath = path.join(commandsDir, `${commandName}.md`)

					while (
						await fs
							.access(filePath)
							.then(() => true)
							.catch(() => false)
					) {
						commandName = `new-command-${counter}`
						filePath = path.join(commandsDir, `${commandName}.md`)
						counter++
					}
				}

				const filePath = path.join(commandsDir, `${commandName}.md`)

				// Check if file already exists
				if (
					await fs
						.access(filePath)
						.then(() => true)
						.catch(() => false)
				) {
					vscode.window.showErrorMessage(t("common:errors.command_already_exists", { commandName }))
					break
				}

				// Create the command file with template content
				const templateContent = t("common:errors.command_template_content")

				await fs.writeFile(filePath, templateContent, "utf8")
				provider.debug?.(`Created new command file: ${filePath}`)

				// Open the new file in the editor
				openFile(filePath)

				// Refresh commands list
				const { getCommands } = await import("../../services/command/commands")
				const commands = await getCommands(getCurrentCwd() || "")
				const commandList = commands.map((command) => ({
					name: command.name,
					source: command.source,
					filePath: command.filePath,
					description: command.description,
					argumentHint: command.argumentHint,
				}))
				await provider.postMessageToWebview({
					type: "commands",
					commands: commandList,
				})
			} catch (error) {
				provider.log(`Error creating command: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`)
				vscode.window.showErrorMessage(t("common:errors.create_command_failed"))
			}
			break
		}

		case "insertTextIntoTextarea": {
			const text = message.text
			if (text) {
				// Send message to insert text into the chat textarea
				await provider.postMessageToWebview({
					type: "insertTextIntoTextarea",
					text: text,
				})
			}
			break
		}
		case "showMdmAuthRequiredNotification": {
			// Show notification that organization requires authentication
			vscode.window.showWarningMessage(t("common:mdm.info.organization_requires_auth"))
			break
		}

		/**
		 * Chat Message Queue
		 */

		case "queueMessage": {
			const resolved = await resolveIncomingImages({ text: message.text, images: message.images })

			const messageText = resolved.text

			const currentTask = provider.getCurrentTask()
			currentTask?.messageQueueService.addMessage(messageText, resolved.images)

			// If the task's loop has already terminated (e.g. `attempt_completion`
			// set `abort=true` to declare the task complete), no future `Task.ask()`
			// will fire to drain the queue — the message would sit there forever
			// and the user would have to click "Send Now" manually. Auto-trigger
			// the same cancel-and-process flow that "Send Now" uses, which restarts
			// the task loop with the dequeued message. Queueing semantics are for
			// "task is doing work"; a completed task is not doing work.
			if (currentTask?.abort) {
				await currentTask.cancelAndProcessQueuedMessages()
			}
			break
		}
		case "removeQueuedMessage": {
			provider.getCurrentTask()?.messageQueueService.removeMessage(message.text ?? "")
			break
		}
		case "editQueuedMessage": {
			if (message.payload) {
				const { id, text, images } = message.payload as EditQueuedMessagePayload
				provider.getCurrentTask()?.messageQueueService.updateMessage(id, text, images)
			}
			break
		}

		case "cancelAndSendQueuedMessages": {
			const currentTask = provider.getCurrentTask()
			if (currentTask) {
				await currentTask.cancelAndProcessQueuedMessages()
			}
			break
		}

		case "dismissUpsell": {
			if (message.upsellId) {
				try {
					// Get current list of dismissed upsells
					const dismissedUpsells = getGlobalState("dismissedUpsells") || []

					// Add the new upsell ID if not already present
					let updatedList = dismissedUpsells
					if (!dismissedUpsells.includes(message.upsellId)) {
						updatedList = [...dismissedUpsells, message.upsellId]
						await updateGlobalState("dismissedUpsells", updatedList)
					}

					// Send updated list back to webview (use the already computed updatedList)
					await provider.postMessageToWebview({
						type: "dismissedUpsells",
						list: updatedList,
					})
				} catch (error) {
					// Fail silently as per Bruno's comment - it's OK to fail silently in this case
					provider.log(`Failed to dismiss upsell: ${error instanceof Error ? error.message : String(error)}`)
				}
			}
			break
		}
		case "getDismissedUpsells": {
			// Send the current list of dismissed upsells to the webview
			const dismissedUpsells = getGlobalState("dismissedUpsells") || []
			await provider.postMessageToWebview({
				type: "dismissedUpsells",
				list: dismissedUpsells,
			})
			break
		}

		case "openMarkdownPreview": {
			if (message.text) {
				try {
					const tmpDir = os.tmpdir()
					const timestamp = Date.now()
					const tempFileName = `shofer-preview-${timestamp}.md`
					const tempFilePath = path.join(tmpDir, tempFileName)

					await fs.writeFile(tempFilePath, message.text, "utf8")

					const doc = await vscode.workspace.openTextDocument(tempFilePath)
					await vscode.commands.executeCommand("markdown.showPreview", doc.uri)
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : String(error)
					provider.log(`Error opening markdown preview: ${errorMessage}`)
					vscode.window.showErrorMessage(`Failed to open markdown preview: ${errorMessage}`)
				}
			}
			break
		}

		case "requestOpenAiCodexRateLimits": {
			try {
				const { openAiCodexOAuthManager } = await import("../../integrations/openai-codex/oauth")
				const accessToken = await openAiCodexOAuthManager.getAccessToken()

				if (!accessToken) {
					provider.postMessageToWebview({
						type: "openAiCodexRateLimits",
						error: "Not authenticated with OpenAI Codex",
					})
					break
				}

				const accountId = await openAiCodexOAuthManager.getAccountId()
				const { fetchOpenAiCodexRateLimitInfo } = await import("../../integrations/openai-codex/rate-limits")
				const rateLimits = await fetchOpenAiCodexRateLimitInfo(accessToken, { accountId })

				provider.postMessageToWebview({
					type: "openAiCodexRateLimits",
					values: rateLimits,
				})
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error)
				provider.log(`Error fetching OpenAI Codex rate limits: ${errorMessage}`)
				provider.postMessageToWebview({
					type: "openAiCodexRateLimits",
					error: errorMessage,
				})
			}
			break
		}

		case "openDebugApiHistory":
		case "openDebugUiHistory": {
			const currentTask = provider.getCurrentTask()
			if (!currentTask) {
				vscode.window.showErrorMessage("No active task to view history for")
				break
			}

			try {
				const { getTaskDirectoryPath } = await import("../../utils/storage")
				const globalStoragePath = provider.contextProxy.globalStorageUri.fsPath
				const taskDirPath = await getTaskDirectoryPath(globalStoragePath, currentTask.taskId)

				const fileName =
					message.type === "openDebugApiHistory" ? "api_conversation_history.jsonl" : "ui_messages.jsonl"
				const sourceFilePath = path.join(taskDirPath, fileName)

				// Check if file exists
				if (!(await fileExistsAtPath(sourceFilePath))) {
					vscode.window.showErrorMessage(`File not found: ${fileName}`)
					break
				}

				// Read the source JSONL file and prettify into a JSON array for viewing.
				const content = await fs.readFile(sourceFilePath, "utf8")
				const lines = content.split("\n")
				const records: unknown[] = []
				let parseError: unknown = undefined
				for (let i = 0; i < lines.length; i++) {
					const line = lines[i]
					if (!line) continue
					try {
						records.push(JSON.parse(line))
					} catch (e) {
						// Tolerate truncated final line; surface anything else.
						if (i !== lines.length - 1) {
							parseError = e
						}
					}
				}
				if (parseError) {
					vscode.window.showErrorMessage(`Failed to parse ${fileName}`)
					break
				}

				// Prettify the JSON
				const prettifiedContent = JSON.stringify(records, null, 2)

				// Create a temporary file
				const tmpDir = os.tmpdir()
				const timestamp = Date.now()
				const tempFileName = `shofer-debug-${message.type === "openDebugApiHistory" ? "api" : "ui"}-${currentTask.taskId.slice(0, 8)}-${timestamp}.json`
				const tempFilePath = path.join(tmpDir, tempFileName)

				await fs.writeFile(tempFilePath, prettifiedContent, "utf8")

				// Open the temp file in VS Code
				const doc = await vscode.workspace.openTextDocument(tempFilePath)
				await vscode.window.showTextDocument(doc, { preview: true })
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error)
				provider.log(`Error opening debug history: ${errorMessage}`)
				vscode.window.showErrorMessage(`Failed to open debug history: ${errorMessage}`)
			}
			break
		}

		case "downloadErrorDiagnostics": {
			const currentTask = provider.getCurrentTask()
			if (!currentTask) {
				vscode.window.showErrorMessage("No active task to generate diagnostics for")
				break
			}

			await generateErrorDiagnostics({
				taskId: currentTask.taskId,
				globalStoragePath: provider.contextProxy.globalStorageUri.fsPath,
				values: message.values,
				log: (msg) => provider.log(msg),
			})
			break
		}

		/**
		 * Git Worktree Management
		 */

		case "listWorktrees": {
			try {
				const { worktrees, isGitRepo, isMultiRoot, isSubfolder, gitRootPath, error } =
					await handleListWorktrees(provider)

				await provider.postMessageToWebview({
					type: "worktreeList",
					worktrees,
					isGitRepo,
					isMultiRoot,
					isSubfolder,
					gitRootPath,
					error,
				})
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error)

				await provider.postMessageToWebview({
					type: "worktreeList",
					worktrees: [],
					isGitRepo: false,
					isMultiRoot: false,
					isSubfolder: false,
					gitRootPath: "",
					error: errorMessage,
				})
			}

			break
		}

		case "createWorktree": {
			try {
				const result = await handleCreateWorktree(
					provider,
					{
						path: message.worktreePath!,
						branch: message.worktreeBranch,
						baseBranch: message.worktreeBaseBranch,
						createNewBranch: message.worktreeCreateNewBranch,
						initSubmodules: message.initSubmodules,
						copyWorktreeInclude: message.copyWorktreeInclude,
					},
					(progress) => {
						provider.postMessageToWebview({
							type: "worktreeCopyProgress",
							copyProgressBytesCopied: progress.bytesCopied,
							copyProgressItemName: progress.itemName,
						})
					},
					(step, detail) => {
						provider.postMessageToWebview({
							type: "worktreeCreationStep",
							worktreeCreationStep: step,
							worktreeCreationStepDetail: detail,
						})
					},
				)

				await provider.postMessageToWebview({
					type: "worktreeResult",
					success: result.success,
					text: result.message,
					worktree:
						result.success && result.worktree
							? {
									path: result.worktree.path,
									branch: result.worktree.branch,
									isCurrent: result.worktree.isCurrent,
								}
							: undefined,
				} as any)
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error)
				await provider.postMessageToWebview({ type: "worktreeResult", success: false, text: errorMessage })
			}

			break
		}

		case "deleteWorktree": {
			try {
				const { success, message: text } = await handleDeleteWorktree(
					provider,
					message.worktreePath!,
					message.worktreeForce ?? false,
				)

				await provider.postMessageToWebview({ type: "worktreeResult", success, text })
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error)
				await provider.postMessageToWebview({ type: "worktreeResult", success: false, text: errorMessage })
			}

			break
		}

		case "getAvailableBranches": {
			try {
				const { localBranches, remoteBranches, currentBranch } = await handleGetAvailableBranches(provider)

				await provider.postMessageToWebview({
					type: "branchList",
					localBranches,
					remoteBranches,
					currentBranch,
				})
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error)

				await provider.postMessageToWebview({
					type: "branchList",
					localBranches: [],
					remoteBranches: [],
					currentBranch: "",
					error: errorMessage,
				})
			}

			break
		}

		case "getWorktreeDefaults": {
			try {
				const { suggestedBranch, suggestedPath } = await handleGetWorktreeDefaults(provider)
				await provider.postMessageToWebview({ type: "worktreeDefaults", suggestedBranch, suggestedPath })
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error)

				await provider.postMessageToWebview({
					type: "worktreeDefaults",
					suggestedBranch: "",
					suggestedPath: "",
					error: errorMessage,
				})
			}

			break
		}

		case "getWorktreeIncludeStatus": {
			try {
				const worktreeIncludeStatus = await handleGetWorktreeIncludeStatus(provider)
				await provider.postMessageToWebview({ type: "worktreeIncludeStatus", worktreeIncludeStatus })
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error)

				await provider.postMessageToWebview({
					type: "worktreeIncludeStatus",
					worktreeIncludeStatus: {
						exists: false,
						hasGitignore: false,
						gitignoreContent: undefined,
					},
					error: errorMessage,
				})
			}

			break
		}

		case "checkBranchWorktreeInclude": {
			try {
				const branch = message.worktreeBranch
				if (!branch) {
					await provider.postMessageToWebview({
						type: "branchWorktreeIncludeResult",
						hasWorktreeInclude: false,
						error: "No branch specified",
					})
					break
				}
				const hasWorktreeInclude = await handleCheckBranchWorktreeInclude(provider, branch)
				await provider.postMessageToWebview({
					type: "branchWorktreeIncludeResult",
					branch,
					hasWorktreeInclude,
				})
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error)
				await provider.postMessageToWebview({
					type: "branchWorktreeIncludeResult",
					hasWorktreeInclude: false,
					error: errorMessage,
				})
			}

			break
		}

		case "createWorktreeInclude": {
			try {
				const { success, message: text } = await handleCreateWorktreeInclude(
					provider,
					message.worktreeIncludeContent ?? "",
				)

				await provider.postMessageToWebview({ type: "worktreeResult", success, text })
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error)
				provider.log(`Error creating worktree include: ${errorMessage}`)
				await provider.postMessageToWebview({ type: "worktreeResult", success: false, text: errorMessage })
			}

			break
		}

		case "checkoutBranch": {
			try {
				const { success, message: text } = await handleCheckoutBranch(provider, message.worktreeBranch!)
				await provider.postMessageToWebview({ type: "worktreeResult", success, text })
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error)
				await provider.postMessageToWebview({ type: "worktreeResult", success: false, text: errorMessage })
			}

			break
		}

		case "browseForWorktreePath": {
			try {
				const options: vscode.OpenDialogOptions = {
					canSelectFiles: false,
					canSelectFolders: true,
					canSelectMany: false,
					openLabel: t("worktrees:selectWorktreeLocation"),
					title: t("worktrees:selectFolderForWorktree"),
					defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri
						? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, "..")
						: undefined,
				}

				const result = await vscode.window.showOpenDialog(options)
				if (result && result[0]) {
					await provider.postMessageToWebview({
						type: "folderSelected",
						path: result[0].fsPath,
					})
				}
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error)
				provider.log(`Error opening folder picker: ${errorMessage}`)
			}

			break
		}

		case "getWorktreeStatus": {
			try {
				const status = await handleGetWorktreeStatus(provider, message.worktreeDir)
				await provider.postMessageToWebview({ type: "worktreeStatus", worktreeStatus: status })
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error)
				provider.log(`Error getting worktree status: ${errorMessage}`)
				await provider.postMessageToWebview({
					type: "worktreeStatus",
					worktreeStatus: {
						branch: "",
						path: "",
						baseBranch: "",
						commitsAhead: 0,
						commitsBehind: 0,
						filesChanged: 0,
						insertions: 0,
						deletions: 0,
						hasUncommittedChanges: false,
						uncommittedCount: 0,
						lastCommit: null,
						mergeReadiness: { hasConflicts: null, conflictedFiles: [] },
						isBaseBranch: false,
						otherWorktrees: [],
					},
				})
			}

			break
		}

		// Parallel task management messages
		case "createParallelTask": {
			try {
				await provider.createManagedTask(message.taskName, message.text, message.images, message.worktreeDir)
				// Notify the UI to reset the chat input and save the outgoing
				// task's draft, matching the "newTask" handler behaviour.
				await provider.postMessageToWebview({ type: "invoke", invoke: "newChat" })
				// Send worktree status update so the UI can show badge info
				await provider.postInitState()
			} catch (error) {
				provider.log(`Error creating managed task: ${error}`)
				// Reset the UI even on failure so the user isn't stuck.
				await provider.postMessageToWebview({ type: "invoke", invoke: "newChat" })
			}
			break
		}

		case "focusParallelTask": {
			try {
				if (message.taskId) {
					await provider.focusTask(message.taskId)
				}
			} catch (error) {
				provider.log(`Error focusing task: ${error}`)
			}
			break
		}

		case "startParallelTask": {
			try {
				if (message.taskId) {
					await provider.startManagedTask(message.taskId)
				}
			} catch (error) {
				provider.log(`Error starting managed task: ${error}`)
			}
			break
		}

		case "pauseParallelTask": {
			try {
				if (message.taskId) {
					await provider.pauseManagedTask(message.taskId)
				}
			} catch (error) {
				provider.log(`Error pausing managed task: ${error}`)
			}
			break
		}

		case "resumeParallelTask": {
			try {
				if (message.taskId) {
					await provider.resumeManagedTask(message.taskId)
				}
			} catch (error) {
				provider.log(`Error resuming managed task: ${error}`)
			}
			break
		}

		case "stopParallelTask": {
			try {
				if (message.taskId) {
					await provider.stopManagedTask(message.taskId)
				}
			} catch (error) {
				provider.log(`Error stopping managed task: ${error}`)
			}
			break
		}

		case "renameParallelTask": {
			try {
				if (message.taskId && message.text) {
					provider.renameManagedTask(message.taskId, message.text)
				}
			} catch (error) {
				provider.log(`Error renaming managed task: ${error}`)
			}
			break
		}

		case "deleteParallelTask": {
			try {
				if (message.taskId) {
					await provider.deleteManagedTask(message.taskId)
				}
			} catch (error) {
				provider.log(`Error deleting managed task: ${error}`)
			}
			break
		}

		case "archiveParallelTask": {
			try {
				if (message.taskId) {
					await provider.archiveManagedTask(message.taskId)
				}
			} catch (error) {
				provider.log(`Error archiving managed task: ${error}`)
			}
			break
		}

		case "unarchiveParallelTask": {
			try {
				if (message.taskId) {
					await provider.unarchiveManagedTask(message.taskId)
				}
			} catch (error) {
				provider.log(`Error unarchiving managed task: ${error}`)
			}
			break
		}

		case "pinParallelTask": {
			try {
				if (message.taskId) {
					await provider.pinManagedTask(message.taskId)
				}
			} catch (error) {
				provider.log(`Error pinning managed task: ${error}`)
			}
			break
		}

		case "unpinParallelTask": {
			try {
				if (message.taskId) {
					await provider.unpinManagedTask(message.taskId)
				}
			} catch (error) {
				provider.log(`Error unpinning managed task: ${error}`)
			}
			break
		}

		case "clearTaskNotification": {
			try {
				if (message.taskId) {
					provider.clearTaskNotification(message.taskId)
				}
			} catch (error) {
				provider.log(`Error clearing task notification: ${error}`)
			}
			break
		}

		// ── Workflow messages ──

		case "launchTask": {
			// Launcher "New Task" path: pop the current task to the background
			// (parallel execution, without aborting it) and reset the webview to a
			// fresh chat surface. The pre-task mode/API-config selection is owned by
			// the webview dropdown (the launcher sets it locally before posting this
			// message), so no backend mode switch happens here.
			try {
				const poppedTask = provider.popFromStackWithoutAborting()
				if (poppedTask) {
					provider.taskManager.registerBackgroundTask(poppedTask)
					provider.log(`[launchTask] Task ${poppedTask.taskId} moved to background (parallel execution)`)
				}

				await provider.refreshWorkspace()
				await provider.postMessageToWebview({ type: "action", action: "chatButtonClicked" })
				await provider.postMessageToWebview({ type: "action", action: "focusInput" })
			} catch (error) {
				provider.log(`Error launching task: ${error}`)
			}
			break
		}

		case "listWorkflows": {
			try {
				const { discoverWorkflows, parseSlang } = await import("../workflow/index")
				const workflows = await discoverWorkflows(provider.cwd)
				// Parse each workflow to extract full metadata (title, description,
				// icon, agents, param descriptions) from the Slang AST.
				const parsedWorkflows = Array.from(workflows.entries()).map(([name, source]) => {
					try {
						const { ast } = parseSlang(source)
						const flow = ast.flows[0]
						if (!flow) {
							return { name, title: name, description: "", icon: undefined, agents: [], params: [] }
						}

						// Extract agent names from AgentDecl nodes in the flow body
						const agents = (flow.body ?? [])
							.filter((b: any) => b.type === "AgentDecl")
							.map((a: any) => a.name)

						// Include param descriptions — they're already parsed by the AST
						const params = (flow.params ?? []).map((p: any) => ({
							name: p.name,
							type: p.paramType,
							description: p.description,
						}))

						return {
							name, // machine identifier (for createWorkflow lookup)
							title: flow.title || name, // human-readable (fall back to name)
							description: flow.description || "",
							icon: flow.icon, // e.g. "rocket", "gear", "search", "code"
							agents,
							params,
						}
					} catch {
						// Graceful fallback for unparseable .slang files
						return { name, title: name, description: "", icon: undefined, agents: [], params: [] }
					}
				})
				await provider.postMessageToWebview({
					type: "workflowsList",
					workflows: parsedWorkflows,
				})
			} catch (error) {
				provider.log(`Error listing workflows: ${error}`)
			}
			break
		}

		case "createWorkflow": {
			try {
				const flowName = message.flowName
				const flowParams = message.flowParams
				if (!flowName) {
					provider.log("[createWorkflow] ERROR: missing flowName")
					break
				}

				provider.log(
					`[createWorkflow] Launching workflow '${flowName}' with params=${JSON.stringify(flowParams ?? {})}`,
				)

				const { createWorkflowTask } = await import("../workflow/index")
				const { discoverWorkflows } = await import("../workflow/index")
				const workflows = await discoverWorkflows(provider.cwd)
				provider.log(
					`[createWorkflow] Discovered ${workflows.size} workflow(s): ${[...workflows.keys()].join(", ") || "(none)"}`,
				)
				const slangSource = workflows.get(flowName)
				if (!slangSource) {
					provider.log(`[createWorkflow] ERROR: flow '${flowName}' not found among discovered workflows`)
					await provider.postMessageToWebview({ type: "invoke", invoke: "newChat" } as any)
					break
				}

				provider.log(
					`[createWorkflow] Slang source for '${flowName}' is ${slangSource.length} chars. First 200: ${slangSource.slice(0, 200)}`,
				)
				const task = await createWorkflowTask(provider, slangSource, flowParams)
				provider.log(
					`[createWorkflow] Created WorkflowTask ${task.taskId} for flow '${flowName}' — ${task.flowState.agents.size} agent(s): ${[...task.flowState.agents.keys()].join(", ")}`,
				)

				// Pop the current task to the background (parallel execution)
				// without aborting it, so the launched workflow becomes the
				// focused task while any prior task keeps running.
				const poppedTask = provider.popFromStackWithoutAborting()
				if (poppedTask) {
					provider.taskManager.registerBackgroundTask(poppedTask)
					provider.log(`[createWorkflow] Task ${poppedTask.taskId} moved to background (workflow launch)`)
				} else {
					provider.log(`[createWorkflow] No task to pop — stack was empty (normal for first task)`)
				}

				// Register with TaskManager and show in TaskSelector
				await provider.addShoferToStack(task)

				// Register with TaskManager so focusTask() can find the live
				// instance via getManagedTaskInstance() on switch-back. Without
				// this, switching away and back using TaskSelector rehydrates
				// a plain Task (not WorkflowTask) and renders "Starting workflow…".
				provider.taskManager.registerBackgroundTask(task)

				// Focus the workflow task so that its interactive asks don't
				// trigger desktop notifications (focusedTaskId guards the
				// needs_input notification in TaskManager.onInteractive).
				try {
					await provider.taskManager.focusTask(task.taskId)
				} catch {
					// focusTask may throw if the task wasn't seeded in managedTasks
					// yet (shouldn't happen as registerBackgroundTask does that).
					provider.log(
						`[createWorkflow] Failed to focus task ${task.taskId} — notification guard may mis-fire`,
					)
				}

				// Seed the workflow extension into persisted history BEFORE the
				// first state broadcast so `currentTaskItem.isWorkflow` is set on
				// the initial frame and the webview routes to WorkflowView
				// immediately (otherwise it briefly renders ChatView until the
				// first in-loop checkpoint lands).
				await task.seedHistory()
				provider.log(`[createWorkflow] Seeded history for ${task.taskId} (isWorkflow=true)`)

				// Notify UI and start the slang loop
				await provider.postMessageToWebview({ type: "invoke", invoke: "newChat" } as any)
				await provider.postInitState()

				// Start the workflow loop
				provider.log(
					`[createWorkflow] Calling task.start() for ${task.taskId} — slangLoopStarted=${(task as any).slangLoopStarted}`,
				)
				task.start()
				provider.log(
					`[createWorkflow] task.start() returned for ${task.taskId} (fire-and-forget — slang loop runs async)`,
				)
			} catch (error) {
				provider.log(`Error creating workflow: ${error}`)
				await provider.postMessageToWebview({ type: "invoke", invoke: "newChat" } as any)
			}
			break
		}

		case "requestParallelTasks": {
			try {
				const managedTasks = provider.getManagedTasks()
				await provider.postMessageToWebview({
					type: "parallelTasksUpdated",
					parallelTasks: managedTasks.map((s) => ({
						id: s.id,
						name: s.name,
						taskId: s.taskId,
						workspace: s.workspace,
						createdAt: s.createdAt,
						lastActiveAt: s.lastActiveAt,
						state: s.state,
						activeTimeMs: s.activeTimeMs,
					})),
				})
			} catch (error) {
				provider.log(`Error requesting managed tasks: ${error}`)
			}
			break
		}

		case "approveBackgroundTask": {
			try {
				if (message.taskId) {
					// Get the task instance and handle the approval
					const task = provider.taskManager.getManagedTaskInstance(message.taskId)
					if (task) {
						// Resume the task with the approval response
						task.handleWebviewAskResponse(
							message.askResponse || "yesButtonClicked",
							message.text,
							message.images,
						)
						provider.clearTaskNotification(message.taskId)
					}
				}
			} catch (error) {
				provider.log(`Error approving background task: ${error}`)
			}
			break
		}

		case "fatal_error": {
			const text = (message as { text?: string }).text ?? "(no message)"
			provider.log(`[fatal_error] ${text}`)
			// The heartbeat alone cannot detect React-level crashes because the
			// raw pong listener in installWebviewCrashGuard (index.tsx) survives
			// React errors and keeps responding to pings. Trigger an explicit
			// reset here so the renderer is restored without waiting for the
			// 10-second liveness window to expire.
			await provider._onFatalError(text)
			break
		}

		case "pong": {
			// Record that the webview responded. The consecutive-miss counter
			// is managed by the heartbeat timer in ShoferProvider.
			provider._recordPong()
			break
		}

		default: {
			// console.log(`Unhandled message type: ${message.type}`)
			//
			// Currently unhandled:
			//
			// "currentApiConfigName" |
			// "codebaseIndexEnabled" |
			// "enhancedPrompt" |
			// "systemPrompt" |
			// "exportModeResult" |
			// "importModeResult" |
			// "checkRulesDirectoryResult" |
			// "browserConnectionResult" |
			// "vsCodeSetting" |
			// "indexingStatusUpdate" |
			// "indexCleared" |
			// "marketplaceInstallResult" |
			// "shareTaskSuccess" |
			// "playSound" |
			// "draggedImages" |
			// "setApiConfigPassword" |
			// "setopenAiCustomModelInfo" |
			// "marketplaceButtonClicked" |
			// "cancelMarketplaceInstall" |
			// "imageGenerationSettings"
			break
		}
	}
}
