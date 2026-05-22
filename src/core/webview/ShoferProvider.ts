import os from "os"
import * as path from "path"
import fs from "fs/promises"
import EventEmitter from "events"

import { Anthropic } from "@anthropic-ai/sdk"
import delay from "delay"
import axios from "axios"
import pWaitFor from "p-wait-for"
import * as vscode from "vscode"

import {
	type TaskProviderLike,
	type TaskProviderEvents,
	type GlobalState,
	type ProviderName,
	type ProviderSettings,
	type ShoferSettings,
	type ProviderSettingsEntry,
	type StaticAppProperties,
	type DynamicAppProperties,
	type TaskProperties,
	type GitProperties,
	type TelemetryProperties,
	type TelemetryPropertiesProvider,
	type CodeActionId,
	type CodeActionName,
	type TerminalActionId,
	type TerminalActionPromptType,
	type HistoryItem,
	// CloudUserInfo removed
	// CloudOrganizationMembership removed
	type CreateTaskOptions,
	type TokenUsage,
	type ToolUsage,
	type ExtensionMessage,
	type ExtensionState,
	type MarketplaceInstalledMetadata,
	ShoferEventName,
	requestyDefaultModelId,
	openRouterDefaultModelId,
	DEFAULT_WRITE_DELAY_MS,
	ORGANIZATION_ALLOW_ALL,
	DEFAULT_MODES,
	DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
	getModelId,
	isRetiredProvider,
} from "@shofer/types"
import { aggregateTaskCostsRecursive, type AggregatedCosts } from "./aggregateTaskCosts"
import { TelemetryService } from "@shofer/telemetry"

import { Package } from "../../shared/package"
import { findLast } from "../../shared/array"
import { supportPrompt } from "../../shared/support-prompt"
import { GlobalFileNames } from "../../shared/globalFileNames"
import { Mode, defaultModeSlug, getModeBySlug } from "../../shared/modes"
import { experimentDefault } from "../../shared/experiments"
import { formatLanguage } from "../../shared/language"
import { WebviewMessage } from "../../shared/WebviewMessage"
import { EMBEDDING_MODEL_PROFILES } from "../../shared/embeddingModels"
import { ProfileValidator } from "../../shared/ProfileValidator"

import { Terminal } from "../../integrations/terminal/Terminal"
import { downloadTask, getTaskFileName } from "../../integrations/misc/export-markdown"
import { buildJsonTrace, downloadJsonTask, getJsonExportFileName } from "../../integrations/misc/export-json"
import { resolveDefaultSaveUri, saveLastExportPath } from "../../utils/export"
import { getTheme } from "../../integrations/theme/getTheme"
import WorkspaceTracker from "../../integrations/workspace/WorkspaceTracker"

import { McpHub } from "../../services/mcp/McpHub"
import { McpServerManager } from "../../services/mcp/McpServerManager"
import { MarketplaceManager } from "../../services/marketplace"
import { ShadowCheckpointService } from "../../services/checkpoints/ShadowCheckpointService"
import { CodeIndexManager } from "../../services/code-index/manager"
import type { IndexProgressUpdate } from "../../services/code-index/interfaces/manager"
import { GitIndexManager } from "../../services/git-index/git-index-manager"
import { AssistantAgentManager } from "../../services/assistant-agent/manager"
import { SkillsManager } from "../../services/skills/SkillsManager"
import { TaskManager } from "../../services/task-manager/TaskManager"

import { fileExistsAtPath } from "../../utils/fs"
import { setTtsEnabled, setTtsSpeed } from "../../utils/tts"
import { getWorkspaceGitInfo } from "../../utils/git"
import { getWorkspacePath } from "../../utils/path"
import { OrganizationAllowListViolationError } from "../../utils/errors"

import { setPanel } from "../../activate/registerCommands"

import { t } from "../../i18n"

import { buildApiHandler } from "../../api"
import { forceFullModelDetailsLoad, hasLoadedFullDetails } from "../../api/providers/fetchers/lmstudio"

import { ContextProxy } from "../config/ContextProxy"
import { ProviderSettingsManager } from "../config/ProviderSettingsManager"
import { CustomModesManager } from "../config/CustomModesManager"
import { Task } from "../task/Task"

import { webviewMessageHandler } from "./webviewMessageHandler"
import type { ShoferMessage, TodoItem } from "@shofer/types"
import { TaskHistoryStore } from "../task-persistence"
import { getNonce } from "./getNonce"
import { getUri } from "./getUri"
import { REQUESTY_BASE_URL } from "../../shared/utils/requesty"
import { outputError, outputLog, outputWarn } from "../../utils/outputChannelLogger"
import { time } from "../../utils/perf"
import { setProviderReady } from "../../metrics/server"

/**
 * https://github.com/microsoft/vscode-webview-ui-toolkit-samples/blob/main/default/weather-webview/src/providers/WeatherViewProvider.ts
 * https://github.com/KumarVariable/vscode-extension-sidebar-html/blob/master/src/customSidebarViewProvider.ts
 */

export type ShoferProviderEvents = {
	shoferCreated: [shofer: Task]
}

interface PendingEditOperation {
	messageTs: number
	editedContent: string
	images?: string[]
	messageIndex: number
	apiConversationHistoryIndex: number
	timeoutId: NodeJS.Timeout
	createdAt: number
}

export class ShoferProvider
	extends EventEmitter<TaskProviderEvents>
	implements vscode.WebviewViewProvider, TelemetryPropertiesProvider, TaskProviderLike
{
	// Used in package.json as the view's id. This value cannot be changed due
	// to how VSCode caches views based on their id, and updating the id would
	// break existing instances of the extension.
	public static readonly sideBarId = `${Package.name}.SidebarProvider`
	public static readonly tabPanelId = `${Package.name}.TabPanelProvider`
	private static activeInstances: Set<ShoferProvider> = new Set()
	private disposables: vscode.Disposable[] = []
	private webviewDisposables: vscode.Disposable[] = []
	private view?: vscode.WebviewView | vscode.WebviewPanel
	private shoferStack: Task[] = []
	private codeIndexStatusSubscription?: vscode.Disposable
	private codeIndexManager?: CodeIndexManager
	private gitIndexStatusSubscription?: vscode.Disposable
	private gitIndexManager?: GitIndexManager
	private assistantAgentStatusSubscription?: vscode.Disposable
	private assistantAgentManager?: AssistantAgentManager
	private _workspaceTracker?: WorkspaceTracker // workSpaceTracker read-only for access outside this class
	protected mcpHub?: McpHub // Change from private to protected
	protected skillsManager?: SkillsManager
	private marketplaceManager: MarketplaceManager
	private taskCreationCallback: (task: Task) => void
	private taskEventListeners: WeakMap<Task, Array<() => void>> = new WeakMap()
	private currentWorkspacePath: string | undefined
	private _disposed = false

	// Diagnostic: monotonic counter so we can correlate paired lifecycle events
	// (resolve → html-set → visibility change → dispose) for a single WebviewView
	// instance across multiple resolveWebviewView calls.
	private static webviewInstanceCounter = 0
	private webviewInstanceId?: number

	private recentTasksCache?: string[]
	public readonly taskHistoryStore: TaskHistoryStore
	public readonly taskManager: TaskManager
	private taskHistoryStoreInitialized = false
	private globalStateWriteThroughTimer: ReturnType<typeof setTimeout> | null = null
	private static readonly GLOBAL_STATE_WRITE_THROUGH_DEBOUNCE_MS = 5000 // 5 seconds
	private pendingOperations: Map<string, PendingEditOperation> = new Map()
	private static readonly PENDING_OPERATION_TIMEOUT_MS = 30000 // 30 seconds

	/**
	 * Resolvers for blocking foreground subtasks (is_background=false).
	 * Maps child task ID → resolve function that resumes the parent's suspended tool loop.
	 * Set in NewTaskTool before the child starts; fired in resumeBlockingParent() when the
	 * child calls attempt_completion.
	 */
	private blockingChildResolvers: Map<string, (result: string) => void> = new Map()

	/**
	 * Monotonically increasing sequence number for shoferMessages state pushes.
	 * Used by the frontend to reject stale state that arrives out-of-order.
	 */
	private shoferMessagesSeq = 0

	public isViewLaunched = false
	public settingsImportedAt?: number
	public readonly latestAnnouncementId = "apr-2026-v3.52.0-poe-xai-minimax" // v3.52.0 Poe provider, xAI improvements, and MiniMax fixes
	public readonly providerSettingsManager: ProviderSettingsManager
	public readonly customModesManager: CustomModesManager

	// H8: Static-state memoization.
	// mergedAllowedCommands / mergedDeniedCommands are rebuilt on every
	// postStateToWebview call but change only when the underlying
	// settings change.  Cache them with a generation counter bumped
	// by ContextProxy.onDidChange and workspace.onDidChangeConfiguration.
	private _cachedMergedAllowed?: string[]
	private _cachedMergedDenied?: string[]
	private _cachedMergedGen = -1
	private _settingsGeneration = 0
	private _onDidChangeSettingsDisposable?: vscode.Disposable
	// ── Heartbeat / health-check fields ──────────────────────────────────────
	/** Heartbeat timer ID. Cleared on webview reset and on final dispose. */
	private _heartbeatTimer: NodeJS.Timeout | null = null
	/**
	 * Timestamp (epoch ms) of the most recently received `pong` — or, when the
	 * heartbeat first starts, the moment we started ticking. Liveness is
	 * determined by `Date.now() - _lastPongTs > LIVENESS_TIMEOUT_MS`, not by
	 * counting ticks. This avoids the previous tick-driven race where every
	 * tick incremented a miss counter before the in-flight pong could arrive.
	 */
	private _lastPongTs = 0

	/** Interval between `ping` messages sent to the webview (ms). */
	private static readonly HEARTBEAT_INTERVAL_MS = 2_000
	/**
	 * Maximum time the webview may go without responding to a ping before we
	 * declare it dead and reset it. Must be comfortably larger than
	 * `HEARTBEAT_INTERVAL_MS` plus expected main-thread stalls (large file
	 * opens, GC pauses, source-map enhancement, …) so transient hiccups don't
	 * trip the killer.
	 */
	private static readonly LIVENESS_TIMEOUT_MS = 10_000

	private _settingsGenerationConfigDisposable?: vscode.Disposable

	constructor(
		readonly context: vscode.ExtensionContext,
		private readonly outputChannel: vscode.OutputChannel,
		private readonly renderContext: "sidebar" | "editor" = "sidebar",
		public readonly contextProxy: ContextProxy,
		_mdmService?: any,
	) {
		super()

		// Allow many parallel tasks to each register their own ProviderProfileChanged
		// listener without Node.js emitting MaxListenersExceededWarning.
		this.setMaxListeners(100)

		this.currentWorkspacePath = getWorkspacePath()

		ShoferProvider.activeInstances.add(this)

		this.updateGlobalState("codebaseIndexModels", EMBEDDING_MODEL_PROFILES)

		// Initialize the per-task file-based history store.
		// The globalState write-through is debounced separately (not on every mutation)
		// since per-task files are authoritative and globalState is only for downgrade compat.
		this.taskHistoryStore = new TaskHistoryStore(this.contextProxy.globalStorageUri.fsPath, {
			onWrite: async () => {
				this.scheduleGlobalStateWriteThrough()
			},
		})
		this.initializeTaskHistoryStore().catch((error) => {
			this.log(`Failed to initialize TaskHistoryStore: ${error}`)
		})

		// Initialize the TaskManager for parallel task management.
		// Note: We do NOT restore managedTasks from history. The task list for the dropdown
		// comes from taskHistory (same as HistoryView). parallelTasks only tracks tasks with
		// live Task instances (currently running in this session).
		this.taskManager = new TaskManager(this)

		// H8: Subscribe to ContextProxy.onDidChange to invalidate the
		// static-state cache.  When any global setting or secret changes,
		// bump the generation counter so the next postStateToWebview
		// rebuilds merged commands / modes from scratch.
		this._onDidChangeSettingsDisposable = this.contextProxy.onDidChange(({ key }) => {
			if (key === "allowedCommands" || key === "deniedCommands") {
				this._settingsGeneration++
			}
		})
		// Invalidate on workspace-config changes too — mergeAllowedCommands
		// also reads vscode.workspace.getConfiguration("shofer.allowedCommands").
		// Null-guarded: vscode.workspace.onDidChangeConfiguration is not
		// available in test environments where the vscode module is a stub.
		this._settingsGenerationConfigDisposable = vscode.workspace.onDidChangeConfiguration?.((e) => {
			if (e.affectsConfiguration("shofer.allowedCommands") || e.affectsConfiguration("shofer.deniedCommands")) {
				this._settingsGeneration++
			}
		})

		// Set up task event forwarding to webview.
		this.taskManager.on("tasks:updated", (managedTasks) => {
			this.postMessageToWebview({
				type: "parallelTasksUpdated",
				parallelTasks: managedTasks.map((s) => ({
					id: s.id,
					name: s.name,
					taskId: s.taskId,
					workspace: s.workspace,
					createdAt: s.createdAt,
					lastActiveAt: s.lastActiveAt,
					state: s.state,
				})),
				focusedTaskId: this.taskManager.getFocusedTaskId(),
			})
		})

		this.taskManager.on("managedTask:needs-input", (notification) => {
			this.postMessageToWebview({
				type: "taskNotification",
				notification: {
					taskId: notification.targetTaskId,
					type: notification.type,
					message: notification.message,
					timestamp: notification.timestamp,
				},
			})
		})

		// Start configuration loading (which might trigger indexing) in the background.
		// Don't await, allowing activation to continue immediately.

		// Register this provider with the telemetry service to enable it to add
		// properties like mode and provider.
		TelemetryService.instance.setProvider(this)

		this._workspaceTracker = new WorkspaceTracker(this)

		this.providerSettingsManager = new ProviderSettingsManager(this.context)

		this.customModesManager = new CustomModesManager(this.context, async () => {
			await this.postStateToWebviewWithoutShoferMessages()
		})

		// Initialize MCP Hub through the singleton manager
		McpServerManager.getInstance(this.context, this)
			.then((hub) => {
				this.mcpHub = hub
				this.mcpHub.registerClient()
				const hasView = !!(this as any).view
				// The webview may have already launched and received an empty mcpServers list
				// while the hub was still initializing (race condition). Push the real list now.
				this.postMessageToWebview({ type: "mcpServers", mcpServers: hub.getAllServers() }).catch((error) =>
					this.log(`Failed to post initial MCP servers to webview: ${error}`),
				)
			})
			.catch((error) => {
				this.log(`Failed to initialize MCP Hub: ${error}`)
			})

		// Initialize Skills Manager for skill discovery
		this.skillsManager = new SkillsManager(this)
		this.skillsManager.initialize().catch((error) => {
			this.log(`Failed to initialize Skills Manager: ${error}`)
		})

		this.marketplaceManager = new MarketplaceManager(this.context, this.customModesManager)

		// Forward <most> task events to the provider.
		// We do something fairly similar for the IPC-based API.
		this.taskCreationCallback = (instance: Task) => {
			this.emit(ShoferEventName.TaskCreated, instance)

			// Create named listener functions so we can remove them later.
			const onTaskStarted = () => this.emit(ShoferEventName.TaskStarted, instance.taskId)
			const onTaskCompleted = (
				taskId: string,
				tokenUsage: TokenUsage,
				toolUsage: ToolUsage,
				info: import("@shofer/types").TaskCompletedInfo,
			) => this.emit(ShoferEventName.TaskCompleted, taskId, tokenUsage, toolUsage, info)
			const onTaskAborted = async (info: import("@shofer/types").TaskAbortedInfo) => {
				this.emit(ShoferEventName.TaskAborted, instance.taskId, info)

				try {
					// Only rehydrate on genuine streaming failures.
					// User-initiated cancels are handled by cancelTask().
					if (instance.abortReason === "streaming_failed") {
						// Defensive safeguard: if another path already replaced this instance, skip
						const current = this.getCurrentTask()
						if (current && current.instanceId !== instance.instanceId) {
							this.log(
								`[onTaskAborted] Skipping rehydrate: current instance ${current.instanceId} != aborted ${instance.instanceId}`,
							)
							return
						}

						const { historyItem } = await this.getTaskWithId(instance.taskId)
						const rootTask = instance.rootTask
						const parentTask = instance.parentTask
						await this.createTaskWithHistoryItem({ ...historyItem, rootTask, parentTask })
					}
				} catch (error) {
					this.log(
						`[onTaskAborted] Failed to rehydrate after streaming failure: ${
							error instanceof Error ? error.message : String(error)
						}`,
					)
				}
			}
			const onTaskFocused = () => this.emit(ShoferEventName.TaskFocused, instance.taskId)
			const onTaskUnfocused = () => this.emit(ShoferEventName.TaskUnfocused, instance.taskId)
			const onTaskActive = (taskId: string) => this.emit(ShoferEventName.TaskActive, taskId)
			const onTaskInteractive = (taskId: string) => this.emit(ShoferEventName.TaskInteractive, taskId)
			const onTaskResumable = (taskId: string) => this.emit(ShoferEventName.TaskResumable, taskId)
			const onTaskIdle = (taskId: string) => this.emit(ShoferEventName.TaskIdle, taskId)
			const onTaskPaused = (taskId: string) => this.emit(ShoferEventName.TaskPaused, taskId)
			const onTaskUnpaused = (taskId: string) => this.emit(ShoferEventName.TaskUnpaused, taskId)
			const onTaskSpawned = (taskId: string) => this.emit(ShoferEventName.TaskSpawned, taskId)
			const onTaskUserMessage = (taskId: string) => this.emit(ShoferEventName.TaskUserMessage, taskId)
			const onTaskTokenUsageUpdated = (taskId: string, tokenUsage: TokenUsage, toolUsage: ToolUsage) =>
				this.emit(ShoferEventName.TaskTokenUsageUpdated, taskId, tokenUsage, toolUsage)

			// Attach the listeners.
			instance.on(ShoferEventName.TaskStarted, onTaskStarted)
			instance.on(ShoferEventName.TaskCompleted, onTaskCompleted)
			instance.on(ShoferEventName.TaskAborted, onTaskAborted)
			instance.on(ShoferEventName.TaskFocused, onTaskFocused)
			instance.on(ShoferEventName.TaskUnfocused, onTaskUnfocused)
			instance.on(ShoferEventName.TaskActive, onTaskActive)
			instance.on(ShoferEventName.TaskInteractive, onTaskInteractive)
			instance.on(ShoferEventName.TaskResumable, onTaskResumable)
			instance.on(ShoferEventName.TaskIdle, onTaskIdle)
			instance.on(ShoferEventName.TaskPaused, onTaskPaused)
			instance.on(ShoferEventName.TaskUnpaused, onTaskUnpaused)
			instance.on(ShoferEventName.TaskSpawned, onTaskSpawned)
			instance.on(ShoferEventName.TaskUserMessage, onTaskUserMessage)
			instance.on(ShoferEventName.TaskTokenUsageUpdated, onTaskTokenUsageUpdated)

			// Store the cleanup functions for later removal.
			this.taskEventListeners.set(instance, [
				() => instance.off(ShoferEventName.TaskStarted, onTaskStarted),
				() => instance.off(ShoferEventName.TaskCompleted, onTaskCompleted),
				() => instance.off(ShoferEventName.TaskAborted, onTaskAborted),
				() => instance.off(ShoferEventName.TaskFocused, onTaskFocused),
				() => instance.off(ShoferEventName.TaskUnfocused, onTaskUnfocused),
				() => instance.off(ShoferEventName.TaskActive, onTaskActive),
				() => instance.off(ShoferEventName.TaskInteractive, onTaskInteractive),
				() => instance.off(ShoferEventName.TaskResumable, onTaskResumable),
				() => instance.off(ShoferEventName.TaskIdle, onTaskIdle),
				() => instance.off(ShoferEventName.TaskUserMessage, onTaskUserMessage),
				() => instance.off(ShoferEventName.TaskPaused, onTaskPaused),
				() => instance.off(ShoferEventName.TaskUnpaused, onTaskUnpaused),
				() => instance.off(ShoferEventName.TaskSpawned, onTaskSpawned),
				() => instance.off(ShoferEventName.TaskTokenUsageUpdated, onTaskTokenUsageUpdated),
			])
		}
	}

	/**
	 * Initialize the TaskHistoryStore and migrate from globalState if needed.
	 */
	private async initializeTaskHistoryStore(): Promise<void> {
		try {
			await this.taskHistoryStore.initialize()

			// Migration: backfill per-task files from globalState on first run
			const migrationKey = "taskHistoryMigratedToFiles"
			const alreadyMigrated = this.context.globalState.get<boolean>(migrationKey)

			if (!alreadyMigrated) {
				const legacyHistory = this.context.globalState.get<HistoryItem[]>("taskHistory") ?? []

				if (legacyHistory.length > 0) {
					this.debug(
						`[initializeTaskHistoryStore] Migrating ${legacyHistory.length} entries from globalState`,
					)
					await this.taskHistoryStore.migrateFromGlobalState(legacyHistory)
				}

				await this.context.globalState.update(migrationKey, true)
				this.debug("[initializeTaskHistoryStore] Migration complete")
			}

			this.taskHistoryStoreInitialized = true
			setProviderReady()

			// Seed the TaskManager with persisted task states so the TaskSelector
			// shows correct state icons on startup without waiting for a re-focus.
			const historyItems = this.taskHistoryStore.getAll()
			await this.taskManager.restoreManagedTasks(historyItems)

			// Start the periodic cleanup of archived tasks (runs once per day).
			this.scheduleArchivedCleanup()
		} catch (error) {
			this.log(`[initializeTaskHistoryStore] Error: ${error instanceof Error ? error.message : String(error)}`)
		}
	}

	/** Interval ID for the periodic archived-task cleanup timer. */
	private archivedCleanupTimer: ReturnType<typeof setInterval> | null = null

	/**
	 * Auto-delete archived tasks that have been archived for longer than 7 days.
	 * Runs at extension start and then once every 24 hours.
	 */
	private scheduleArchivedCleanup(): void {
		const DAY_MS = 24 * 60 * 60 * 1000
		const ARCHIVE_MAX_AGE_MS = 7 * DAY_MS

		const doCleanup = async () => {
			try {
				const now = Date.now()
				const allTasks = this.taskHistoryStore.getAll()
				const expiredIds = allTasks
					.filter((item) => item.archived && item.archivedAt && now - item.archivedAt >= ARCHIVE_MAX_AGE_MS)
					.map((item) => item.id)

				if (expiredIds.length > 0) {
					this.debug(`Auto-deleting ${expiredIds.length} expired archived tasks`)
					await this.taskHistoryStore.deleteMany(expiredIds)
				}
			} catch (error) {
				this.log(`Archived task cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
			}
		}

		// Run immediately, then every 24 hours.
		doCleanup()

		if (this.archivedCleanupTimer) {
			clearInterval(this.archivedCleanupTimer)
		}
		this.archivedCleanupTimer = setInterval(doCleanup, DAY_MS)
	}

	/**
	 * Override EventEmitter's on method to match TaskProviderLike interface
	 */
	override on<K extends keyof TaskProviderEvents>(
		event: K,
		listener: (...args: TaskProviderEvents[K]) => void | Promise<void>,
	): this {
		return super.on(event, listener as any)
	}

	/**
	 * Override EventEmitter's off method to match TaskProviderLike interface
	 */
	override off<K extends keyof TaskProviderEvents>(
		event: K,
		listener: (...args: TaskProviderEvents[K]) => void | Promise<void>,
	): this {
		return super.off(event, listener as any)
	}

	// Adds a new Task instance to shoferStack, marking the start of a new task.
	// The instance is pushed to the top of the stack (LIFO order).
	// When the task is completed, the top instance is removed, reactivating the
	// previous task.
	async addShoferToStack(task: Task) {
		// Add this shofer instance into the stack that represents the order of
		// all the called tasks.
		this.shoferStack.push(task)
		task.emit(ShoferEventName.TaskFocused)

		// Perform special setup provider specific tasks.
		await this.performPreparationTasks(task)

		// Ensure getState() resolves correctly.
		const state = await this.getState()

		if (!state || typeof state.mode !== "string") {
			throw new Error(t("common:errors.retrieve_current_mode"))
		}
	}

	async performPreparationTasks(shofer: Task) {
		// LMStudio: We need to force model loading in order to read its context
		// size; we do it now since we're starting a task with that model selected.
		if (shofer.apiConfiguration && shofer.apiConfiguration.apiProvider === "lmstudio") {
			try {
				if (!hasLoadedFullDetails(shofer.apiConfiguration.lmStudioModelId!)) {
					await forceFullModelDetailsLoad(
						shofer.apiConfiguration.lmStudioBaseUrl ?? "http://localhost:1234",
						shofer.apiConfiguration.lmStudioModelId!,
					)
				}
			} catch (error) {
				this.log(`Failed to load full model details for LM Studio: ${error}`)
				vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error))
			}
		}
	}

	// Removes and destroys the top Shofer instance (the current finished task),
	// activating the previous one (resuming the parent task).
	async removeShoferFromStack() {
		if (this.shoferStack.length === 0) {
			return
		}

		// Pop the top Shofer instance from the stack.
		let task = this.shoferStack.pop()

		if (task) {
			// Capture delegation metadata before abort/dispose, since abortTask(true)
			// is async and the task reference is cleared afterwards.
			const childTaskId = task.taskId
			const parentTaskId = task.parentTaskId

			task.emit(ShoferEventName.TaskUnfocused)

			try {
				// Abort the running task and set isAbandoned to true so
				// all running promises will exit as well.
				await task.abortTask(true)
			} catch (e) {
				this.log(
					`[ShoferProvider#removeShoferFromStack] abortTask() failed ${task.taskId}.${task.instanceId}: ${e instanceof Error ? e.message : String(e)}`,
				)
			}

			// Remove event listeners before clearing the reference.
			const cleanupFunctions = this.taskEventListeners.get(task)

			if (cleanupFunctions) {
				cleanupFunctions.forEach((cleanup) => cleanup())
				this.taskEventListeners.delete(task)
			}

			// Make sure no reference kept, once promises end it will be
			// garbage collected.
			task = undefined

			// Delegation-aware parent metadata repair:
			// If the popped task was a delegated child, repair the parent's metadata
			// so it transitions from "delegated" back to "active" and becomes resumable
			// from the task history list.
			if (parentTaskId && childTaskId) {
				try {
					const { historyItem: parentHistory } = await this.getTaskWithId(parentTaskId)

					if (parentHistory.delegatedToId !== undefined && parentHistory.awaitingChildId === childTaskId) {
						await this.updateTaskHistory({
							...parentHistory,
							awaitingChildId: undefined,
						})
						this.debug(
							`[ShoferProvider#removeShoferFromStack] Repaired parent ${parentTaskId} metadata: delegated → active (child ${childTaskId} removed)`,
						)
					}
				} catch (err) {
					// Non-fatal: log but do not block the pop operation.
					this.log(
						`[ShoferProvider#removeShoferFromStack] Failed to repair parent metadata for ${parentTaskId} (non-fatal): ${
							err instanceof Error ? err.message : String(err)
						}`,
					)
				}
			}
		}
	}

	/**
	 * Pops the top task from the stack WITHOUT aborting it.
	 * Used for parallel task switching — the task continues running in the background.
	 * Unlike removeShoferFromStack(), this does NOT call abortTask() or remove event listeners.
	 *
	 * @returns The popped task, or undefined if stack was empty
	 */
	popFromStackWithoutAborting(): Task | undefined {
		if (this.shoferStack.length === 0) {
			return undefined
		}

		const task = this.shoferStack.pop()

		if (task) {
			task.emit(ShoferEventName.TaskUnfocused)
			this.debug(
				`[ShoferProvider#popFromStackWithoutAborting] Task ${task.taskId}.${task.instanceId} removed from stack (still running in background)`,
			)
		}

		return task
	}

	getTaskStackSize(): number {
		return this.shoferStack.length
	}

	public getCurrentTaskStack(): string[] {
		return this.shoferStack.map((shofer) => shofer.taskId)
	}

	// Pending Edit Operations Management

	/**
	 * Sets a pending edit operation with automatic timeout cleanup
	 */
	public setPendingEditOperation(
		operationId: string,
		editData: {
			messageTs: number
			editedContent: string
			images?: string[]
			messageIndex: number
			apiConversationHistoryIndex: number
		},
	): void {
		// Clear any existing operation with the same ID
		this.clearPendingEditOperation(operationId)

		// Create timeout for automatic cleanup
		const timeoutId = setTimeout(() => {
			this.clearPendingEditOperation(operationId)
			this.debug(`[setPendingEditOperation] Automatically cleared stale pending operation: ${operationId}`)
		}, ShoferProvider.PENDING_OPERATION_TIMEOUT_MS)

		// Store the operation
		this.pendingOperations.set(operationId, {
			...editData,
			timeoutId,
			createdAt: Date.now(),
		})

		this.debug(`[setPendingEditOperation] Set pending operation: ${operationId}`)
	}

	/**
	 * Gets a pending edit operation by ID
	 */
	private getPendingEditOperation(operationId: string): PendingEditOperation | undefined {
		return this.pendingOperations.get(operationId)
	}

	/**
	 * Clears a specific pending edit operation
	 */
	private clearPendingEditOperation(operationId: string): boolean {
		const operation = this.pendingOperations.get(operationId)
		if (operation) {
			clearTimeout(operation.timeoutId)
			this.pendingOperations.delete(operationId)
			this.debug(`[clearPendingEditOperation] Cleared pending operation: ${operationId}`)
			return true
		}
		return false
	}

	/**
	 * Clears all pending edit operations
	 */
	private clearAllPendingEditOperations(): void {
		for (const [operationId, operation] of this.pendingOperations) {
			clearTimeout(operation.timeoutId)
		}
		this.pendingOperations.clear()
		this.debug(`[clearAllPendingEditOperations] Cleared all pending operations`)
	}

	/*
	VSCode extensions use the disposable pattern to clean up resources when the sidebar/editor tab is closed by the user or system. This applies to event listening, commands, interacting with the UI, etc.
	- https://vscode-docs.readthedocs.io/en/stable/extensions/patterns-and-principles/
	- https://github.com/microsoft/vscode-extension-samples/blob/main/webview-sample/src/extension.ts
	*/
	private clearWebviewResources() {
		while (this.webviewDisposables.length) {
			const x = this.webviewDisposables.pop()
			if (x) {
				x.dispose()
			}
		}
		this._stopHeartbeat()
	}

	// ── Heartbeat / health-check ─────────────────────────────────────────────

	/**
	 * Called by `webviewMessageHandler` when a `pong` is received from the
	 * webview. Records the timestamp so the next heartbeat tick can compute
	 * liveness as `now - _lastPongTs`.
	 */
	public _recordPong(): void {
		this._lastPongTs = Date.now()
	}

	/**
	 * Starts the ping/pong heartbeat loop. Safe to call multiple times — only
	 * one interval is ever active at a time.
	 *
	 * Must NOT be called before the webview has signalled `webviewDidLaunch` —
	 * otherwise pings sent while the bundle is still loading count against the
	 * liveness window and trigger an infinite reset loop.
	 */
	private _startHeartbeat(): void {
		if (this._heartbeatTimer) {
			return // already running
		}

		// Seed `_lastPongTs` with `now` so the first tick has a fresh window —
		// otherwise `now - 0` would immediately exceed LIVENESS_TIMEOUT_MS.
		this._lastPongTs = Date.now()
		this._heartbeatTimer = setInterval(async () => {
			try {
				await this.postMessageToWebview({ type: "ping" })
			} catch {
				// view may be disposed; stop and let dispose clean up
				this._stopHeartbeat()
				return
			}

			const silentFor = Date.now() - this._lastPongTs
			if (silentFor > ShoferProvider.LIVENESS_TIMEOUT_MS) {
				this.log(
					`[heartbeat] No pong received for ${silentFor}ms (> ${ShoferProvider.LIVENESS_TIMEOUT_MS}ms) — resetting webview`,
				)
				await this._resetWebview()
			}
		}, ShoferProvider.HEARTBEAT_INTERVAL_MS)
	}

	private _stopHeartbeat(): void {
		if (this._heartbeatTimer) {
			clearInterval(this._heartbeatTimer)
			this._heartbeatTimer = null
		}
		this._lastPongTs = 0
	}

	/**
	 * Called by `webviewMessageHandler` on each `webviewDidLaunch`. This is the
	 * earliest signal that the renderer's JS has executed and the `message`
	 * event listener (which answers pings with pongs) is installed — only now
	 * is it safe to start the heartbeat loop.
	 */
	public _onWebviewLaunched(): void {
		this._startHeartbeat()
	}

	/**
	 * Re-assigns `webview.html` to force a full reload of the renderer.
	 * Called automatically when the webview misses `PING_MISS_THRESHOLD`
	 * consecutive pings. Also callable manually (e.g. on `fatal_error`).
	 */
	private async _resetWebview(): Promise<void> {
		const view = this.view
		if (!view || this._disposed) {
			return
		}

		this._stopHeartbeat()
		this.clearWebviewResources()
		this.log("[webview-lifecycle] _resetWebview: re-assigning webview.html")

		try {
			const html = await this.getHtmlContent(view.webview)
			view.webview.html = html
			// Re-wire the message listener. The heartbeat is restarted only when
			// the freshly-loaded webview posts `webviewDidLaunch` — see
			// `_onWebviewLaunched`. Restarting it eagerly here would re-enter the
			// infinite reset loop while the new bundle is still loading.
			this.setWebviewMessageListener(view.webview)
		} catch (err) {
			this.log(
				`[webview-lifecycle] _resetWebview FAILED: ${err instanceof Error ? `${err.message}\n${err.stack}` : String(err)}`,
			)
		}
	}

	async dispose() {
		if (this._disposed) {
			return
		}

		this._disposed = true

		// H8: Dispose settings-change subscriptions
		this._onDidChangeSettingsDisposable?.dispose()
		this._settingsGenerationConfigDisposable?.dispose()
		this._onDidChangeSettingsDisposable = undefined
		this._settingsGenerationConfigDisposable = undefined

		// Clear all tasks from the stack.
		while (this.shoferStack.length > 0) {
			await this.removeShoferFromStack()
		}

		// Clear all pending edit operations to prevent memory leaks
		this.clearAllPendingEditOperations()

		if (this.view && "dispose" in this.view) {
			this.view.dispose()
		}

		this.clearWebviewResources()

		while (this.disposables.length) {
			const x = this.disposables.pop()

			if (x) {
				x.dispose()
			}
		}

		this._workspaceTracker?.dispose()
		this._workspaceTracker = undefined
		await this.mcpHub?.unregisterClient()
		this.mcpHub = undefined
		await this.skillsManager?.dispose()
		this.skillsManager = undefined
		this.marketplaceManager?.cleanup()
		this.customModesManager?.dispose()

		if (this.archivedCleanupTimer) {
			clearInterval(this.archivedCleanupTimer)
			this.archivedCleanupTimer = null
		}

		this._stopHeartbeat()

		this.taskHistoryStore.dispose()
		this.flushGlobalStateWriteThrough()
		// Disposed
		ShoferProvider.activeInstances.delete(this)

		// Clean up any event listeners attached to this provider
		this.removeAllListeners()

		McpServerManager.unregisterProvider(this)
	}

	public static getVisibleInstance(): ShoferProvider | undefined {
		return findLast(Array.from(this.activeInstances), (instance) => instance.view?.visible === true)
	}

	public static async getInstance(): Promise<ShoferProvider | undefined> {
		let visibleProvider = ShoferProvider.getVisibleInstance()

		// If no visible provider, try to show the sidebar view
		if (!visibleProvider) {
			await vscode.commands.executeCommand(`${Package.name}.SidebarProvider.focus`)
			// Wait briefly for the view to become visible
			await delay(100)
			visibleProvider = ShoferProvider.getVisibleInstance()
		}

		// If still no visible provider, return
		if (!visibleProvider) {
			return
		}

		return visibleProvider
	}

	public static async isActiveTask(): Promise<boolean> {
		const visibleProvider = await ShoferProvider.getInstance()

		if (!visibleProvider) {
			return false
		}

		// Check if there is a shofer instance in the stack (if this provider has an active task)
		if (visibleProvider.getCurrentTask()) {
			return true
		}

		return false
	}

	public static async handleCodeAction(
		command: CodeActionId,
		promptType: CodeActionName,
		params: Record<string, string | any[]>,
	): Promise<void> {
		// Capture telemetry for code action usage
		TelemetryService.instance.captureCodeActionUsed(promptType)

		const visibleProvider = await ShoferProvider.getInstance()

		if (!visibleProvider) {
			return
		}

		const { customSupportPrompts } = await visibleProvider.getState()

		// TODO: Improve type safety for promptType.
		const prompt = supportPrompt.create(promptType, params, customSupportPrompts)

		if (command === "addToContext") {
			await visibleProvider.postMessageToWebview({
				type: "invoke",
				invoke: "setChatBoxMessage",
				text: `${prompt}\n\n`,
			})
			await visibleProvider.postMessageToWebview({ type: "action", action: "focusInput" })
			return
		}

		await visibleProvider.createTask(prompt)
	}

	public static async handleTerminalAction(
		command: TerminalActionId,
		promptType: TerminalActionPromptType,
		params: Record<string, string | any[]>,
	): Promise<void> {
		TelemetryService.instance.captureCodeActionUsed(promptType)

		const visibleProvider = await ShoferProvider.getInstance()

		if (!visibleProvider) {
			return
		}

		const { customSupportPrompts } = await visibleProvider.getState()
		const prompt = supportPrompt.create(promptType, params, customSupportPrompts)

		if (command === "terminalAddToContext") {
			await visibleProvider.postMessageToWebview({
				type: "invoke",
				invoke: "setChatBoxMessage",
				text: `${prompt}\n\n`,
			})
			await visibleProvider.postMessageToWebview({ type: "action", action: "focusInput" })
			return
		}

		try {
			await visibleProvider.createTask(prompt)
		} catch (error) {
			if (error instanceof OrganizationAllowListViolationError) {
				// Errors from terminal commands seem to get swallowed / ignored.
				vscode.window.showErrorMessage(error.message)
			}

			throw error
		}
	}

	async resolveWebviewView(webviewView: vscode.WebviewView | vscode.WebviewPanel) {
		const inTabMode = "onDidChangeViewState" in webviewView
		const instanceId = ++ShoferProvider.webviewInstanceCounter
		const priorId = this.webviewInstanceId
		// `visible` is available on both WebviewView and WebviewPanel; `active`
		// only on WebviewPanel. Capture both for diagnostics.
		const visible = (webviewView as { visible?: boolean }).visible
		const active = (webviewView as { active?: boolean }).active
		this.log(
			`[webview-lifecycle] resolveWebviewView called (mode: ${inTabMode ? "tab" : "sidebar"}, instanceId: ${instanceId}, priorInstanceId: ${priorId ?? "none"}, sameRef: ${this.view === webviewView}, visible: ${visible}, active: ${active}, disposed: ${this._disposed})`,
		)

		// Idempotency guard: VS Code can invoke resolveWebviewView more than once
		// during activation/restore (e.g. sidebar visibility flips, hot-restart
		// races, or rapid renderer recreation under memory pressure). A second
		// call on the *same* WebviewView would re-set `webview.html` and
		// `webview.options` while the first document is still loading, which
		// triggers Chromium's
		//   "Could not register service worker: InvalidStateError: Failed to
		//    register a ServiceWorker: The document is in an invalid state."
		// because the existing service-worker registration is still in flight
		// against the previous document. Short-circuit when the view is
		// unchanged. If we get a *different* WebviewView instance (proper
		// dispose/recreate cycle), tear down the previous subscriptions before
		// re-initializing so we don't leak listeners.
		if (this.view === webviewView) {
			this.log(
				`[webview-lifecycle] resolveWebviewView#${instanceId} ignored — same WebviewView already resolved (priorInstanceId=${priorId})`,
			)
			return
		}
		if (this.view) {
			this.log(
				`[webview-lifecycle] resolveWebviewView#${instanceId} replacing prior view (priorInstanceId=${priorId}) — clearing webview resources`,
			)
			this.clearWebviewResources()
		}
		this.view = webviewView
		this.webviewInstanceId = instanceId

		if (inTabMode) {
			setPanel(webviewView, "tab")
		} else if ("onDidChangeVisibility" in webviewView) {
			setPanel(webviewView, "sidebar")
		}

		// Initialize out-of-scope variables that need to receive persistent
		// global state values.
		this.getState().then(
			({
				terminalShellIntegrationTimeout = Terminal.defaultShellIntegrationTimeout,
				terminalShellIntegrationDisabled = false,
				terminalCommandDelay = 0,
				terminalZshClearEolMark = true,
				terminalZshOhMy = false,
				terminalZshP10k = false,
				terminalPowershellCounter = false,
				terminalZdotdir = false,
				ttsEnabled,
				ttsSpeed,
			}) => {
				Terminal.setShellIntegrationTimeout(terminalShellIntegrationTimeout)
				Terminal.setShellIntegrationDisabled(terminalShellIntegrationDisabled)
				Terminal.setCommandDelay(terminalCommandDelay)
				Terminal.setTerminalZshClearEolMark(terminalZshClearEolMark)
				Terminal.setTerminalZshOhMy(terminalZshOhMy)
				Terminal.setTerminalZshP10k(terminalZshP10k)
				Terminal.setPowershellCounter(terminalPowershellCounter)
				Terminal.setTerminalZdotdir(terminalZdotdir)
				setTtsEnabled(ttsEnabled ?? false)
				setTtsSpeed(ttsSpeed ?? 1)
			},
		)

		// Set up webview options with proper resource roots
		const resourceRoots = [this.contextProxy.extensionUri]

		// Add workspace folders to allow access to workspace files
		if (vscode.workspace.workspaceFolders) {
			resourceRoots.push(...vscode.workspace.workspaceFolders.map((folder) => folder.uri))
		}

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: resourceRoots,
		}
		this.log(
			`[webview-lifecycle] resolveWebviewView#${instanceId} webview.options set (resourceRoots=${resourceRoots.length})`,
		)

		const isHmr = this.contextProxy.extensionMode === vscode.ExtensionMode.Development
		const htmlStart = Date.now()
		this.log(`[webview-lifecycle] resolveWebviewView#${instanceId} building ${isHmr ? "HMR" : "prod"} HTML…`)
		const html = isHmr
			? await this.getHMRHtmlContent(webviewView.webview)
			: await this.getHtmlContent(webviewView.webview)
		this.log(
			`[webview-lifecycle] resolveWebviewView#${instanceId} HTML built (${html.length} bytes, ${Date.now() - htmlStart}ms). Assigning webview.html…`,
		)
		// If a *newer* resolve has raced past us while we were building HTML,
		// abort: assigning to the stale view's `webview.html` is exactly what
		// triggers the "document is in an invalid state" service-worker error.
		if (this.view !== webviewView) {
			this.log(
				`[webview-lifecycle] resolveWebviewView#${instanceId} ABORTING html assignment — a newer resolve (instanceId=${this.webviewInstanceId}) has superseded this one`,
			)
			return
		}
		try {
			webviewView.webview.html = html
			this.log(`[webview-lifecycle] resolveWebviewView#${instanceId} webview.html assigned`)
		} catch (err) {
			this.log(
				`[webview-lifecycle] resolveWebviewView#${instanceId} FAILED to assign webview.html: ${err instanceof Error ? `${err.message}\n${err.stack}` : String(err)}`,
			)
			throw err
		}

		// Sets up an event listener to listen for messages passed from the webview view context
		// and executes code based on the message that is received.
		this.setWebviewMessageListener(webviewView.webview)

		// NOTE: The ping/pong heartbeat is started from `_onWebviewLaunched`
		// (triggered by the webview's `webviewDidLaunch` message), NOT here.
		// Starting it before the renderer's JS has executed would cause every
		// ping during the (multi-second) bundle load to count against the
		// liveness window and trigger an infinite reset loop.

		// Initialize code index status subscription for the current workspace.
		this.updateCodeIndexStatusSubscription()

		// Initialize git index status subscription for the current workspace.
		this.updateGitIndexStatusSubscription()

		// Initialize assistant agent status subscription.
		this.updateAssistantAgentStatusSubscription()

		// Listen for active editor changes to update code index status for the
		// current workspace.
		const activeEditorSubscription = vscode.window.onDidChangeActiveTextEditor(() => {
			// Update subscription when workspace might have changed.
			this.updateCodeIndexStatusSubscription()
			this.updateGitIndexStatusSubscription()
		})
		this.webviewDisposables.push(activeEditorSubscription)

		// Listen for when the panel becomes visible.
		// https://github.com/microsoft/vscode-discussions/discussions/840
		if ("onDidChangeViewState" in webviewView) {
			// WebviewView and WebviewPanel have all the same properties except
			// for this visibility listener panel.
			const viewStateDisposable = webviewView.onDidChangeViewState(() => {
				if (this.view?.visible) {
					this.log(
						"[webview-lifecycle] Tab panel became visible — posting didBecomeVisible and refreshing state",
					)
					this.postMessageToWebview({ type: "action", action: "didBecomeVisible" })
					// Push full state on re-show so a blank webview (e.g. renderer
					// restarted under memory/CPU pressure) can recover without
					// waiting for the next user interaction.
					this.postStateToWebview()
				} else {
					this.log("[webview-lifecycle] Tab panel became hidden")
				}
			})

			this.webviewDisposables.push(viewStateDisposable)
		} else if ("onDidChangeVisibility" in webviewView) {
			// sidebar
			const visibilityDisposable = webviewView.onDidChangeVisibility(() => {
				if (this.view?.visible) {
					this.log(
						"[webview-lifecycle] Sidebar panel became visible — posting didBecomeVisible and refreshing state",
					)
					this.postMessageToWebview({ type: "action", action: "didBecomeVisible" })
					// Push full state on re-show so a blank webview (e.g. renderer
					// restarted under memory/CPU pressure) can recover without
					// waiting for the next user interaction.
					this.postStateToWebview()
				} else {
					this.log("[webview-lifecycle] Sidebar panel became hidden")
				}
			})

			this.webviewDisposables.push(visibilityDisposable)
		}

		// Listen for when the view is disposed
		// This happens when the user closes the view or when the view is closed programmatically
		webviewView.onDidDispose(
			async () => {
				this.log(
					`[webview-lifecycle] onDidDispose fired (mode: ${inTabMode ? "tab" : "sidebar"}, instanceId: ${instanceId}, currentInstanceId: ${this.webviewInstanceId})`,
				)
				if (inTabMode) {
					this.log("Disposing ShoferProvider instance for tab view")
					await this.dispose()
				} else {
					this.log("Clearing webview resources for sidebar view")
					this.clearWebviewResources()
					// Reset current workspace manager reference when view is disposed
					this.codeIndexManager = undefined
					this.gitIndexManager = undefined
					this.assistantAgentManager = undefined
					if (this.webviewInstanceId === instanceId) {
						this.view = undefined
						this.webviewInstanceId = undefined
					}
				}
			},
			null,
			this.disposables,
		)

		// Listen for when color changes
		const configDisposable = vscode.workspace.onDidChangeConfiguration(async (e) => {
			if (e && e.affectsConfiguration("workbench.colorTheme")) {
				// Sends latest theme name to webview
				await this.postMessageToWebview({ type: "theme", text: JSON.stringify(await getTheme()) })
			}
		})
		this.webviewDisposables.push(configDisposable)

		// If the extension is starting fresh, clear previous task state.
		// But don't clear if there's already an active task (e.g., resumed via IPC/bridge).
		const currentTask = this.getCurrentTask()
		if (!currentTask || currentTask.abandoned || currentTask.abort) {
			await this.removeShoferFromStack()
		}
	}

	public async createTaskWithHistoryItem(
		historyItem: HistoryItem & { rootTask?: Task; parentTask?: Task },
		options?: { startTask?: boolean; keepCurrentTask?: boolean },
	) {
		return time("createTaskWithHistoryItem", () => this._createTaskWithHistoryItemImpl(historyItem, options))
	}

	private async _createTaskWithHistoryItemImpl(
		historyItem: HistoryItem & { rootTask?: Task; parentTask?: Task },
		options?: { startTask?: boolean; keepCurrentTask?: boolean },
	) {
		const isCliRuntime = process.env.SHOFER_CLI_RUNTIME === "1"
		// CLI injects runtime provider settings from command flags/env at startup.
		// Restoring provider profiles from task history can overwrite those
		// runtime settings with stale/incomplete persisted profiles.
		const skipProfileRestoreFromHistory = isCliRuntime

		// Check if we're rehydrating the current task to avoid flicker
		const currentTask = this.getCurrentTask()
		const isRehydratingCurrentTask = currentTask && currentTask.taskId === historyItem.id

		// Live-instance idempotency guard.
		//
		// Parallel-task invariant: at any time there is AT MOST ONE live `Task`
		// instance per `taskId`. If a caller asks us to rehydrate a task that
		// already has a live instance (e.g. it is currently running in the
		// background after a pencil-button pop), creating a second instance
		// would (1) spawn a zombie that races the original on the same task
		// history files and (2) trigger `resumeTaskFromHistory()` → `resume_task`
		// ask, surfacing a spurious "Continue" button in the UI.
		//
		// Instead, swap the existing live instance back into the focused stack
		// position and short-circuit. This makes `createTaskWithHistoryItem`
		// idempotent w.r.t. live instances regardless of which code path
		// (cancelTask, onTaskAborted, showTaskWithId, external API, etc.)
		// invoked it.
		if (!isRehydratingCurrentTask) {
			const liveInstance = this.taskManager.getManagedTaskInstance(historyItem.id)
			if (liveInstance && !liveInstance.abandoned && !liveInstance.abort) {
				this.debug(
					`[createTaskWithHistoryItem] Live instance ${historyItem.id}.${liveInstance.instanceId} ` +
						`already exists; swapping into stack instead of rehydrating ` +
						`(caller stack: ${new Error().stack?.split("\n").slice(2, 6).join(" | ")})`,
				)
				if (options?.keepCurrentTask) {
					this.popFromStackWithoutAborting()
				} else {
					await this.removeShoferFromStack()
				}
				await this.addShoferToStack(liveInstance)
				// Keep TaskManager focus state in sync with the UI stack.
				try {
					await this.taskManager.focusTask(historyItem.id)
				} catch {
					// Task may not be in managedTasks map (e.g. external-API
					// created); non-fatal.
				}
				await liveInstance.messagesReady
				await this.postStateToWebview()
				if (process.env.DEBUG) {
					this.debug(`[task-switch] id=${historyItem.id} (live-instance swap, timing via @perf)`)
				}
				return liveInstance
			}
		}

		if (!isRehydratingCurrentTask) {
			// If keepCurrentTask is true (parallel task switching), pop without aborting
			// Otherwise, use removeShoferFromStack which aborts the current task
			if (options?.keepCurrentTask) {
				this.popFromStackWithoutAborting()
			} else {
				await this.removeShoferFromStack()
			}
		}

		// If the history item has a saved mode, restore it and its associated API configuration.
		if (historyItem.mode) {
			// Validate that the mode still exists
			const customModes = await this.customModesManager.getCustomModes()
			const modeExists = getModeBySlug(historyItem.mode, customModes) !== undefined

			if (!modeExists) {
				// Mode no longer exists, fall back to default mode.
				this.log(
					`Mode '${historyItem.mode}' from history no longer exists. Falling back to default mode '${defaultModeSlug}'.`,
				)
				historyItem.mode = defaultModeSlug
			}

			await this.updateGlobalState("mode", historyItem.mode)

			// Load the saved API config for the restored mode if it exists.
			// Skip mode-based profile activation if historyItem.apiConfigName exists,
			// since the task's specific provider profile will override it anyway.
			const lockApiConfigAcrossModes = this.context.workspaceState.get("lockApiConfigAcrossModes", false)

			if (!historyItem.apiConfigName && !lockApiConfigAcrossModes && !skipProfileRestoreFromHistory) {
				const savedConfigId = await this.providerSettingsManager.getModeConfigId(historyItem.mode)
				const listApiConfig = await this.providerSettingsManager.listConfig()

				// Update listApiConfigMeta first to ensure UI has latest data.
				await this.updateGlobalState("listApiConfigMeta", listApiConfig)

				// If this mode has a saved config, use it.
				if (savedConfigId) {
					const profile = listApiConfig.find(({ id }) => id === savedConfigId)

					if (profile?.name) {
						try {
							// Check if the profile has actual API configuration (not just an id).
							// In CLI mode, the ProviderSettingsManager may return empty default profiles
							// that only contain 'id' and 'name' fields. Activating such a profile would
							// overwrite the CLI's working API configuration with empty settings.
							const fullProfile = await this.providerSettingsManager.getProfile({ name: profile.name })
							const hasActualSettings = !!fullProfile.apiProvider

							if (hasActualSettings) {
								await this.activateProviderProfile({ name: profile.name })
							} else {
								// The task will continue with the current/default configuration.
							}
						} catch (error) {
							// Log the error but continue with task restoration.
							this.log(
								`Failed to restore API configuration for mode '${historyItem.mode}': ${
									error instanceof Error ? error.message : String(error)
								}. Continuing with default configuration.`,
							)
							// The task will continue with the current/default configuration.
						}
					}
				}
			}
		}

		// If the history item has a saved API config name (provider profile), restore it.
		// This overrides any mode-based config restoration above, because the task's
		// specific provider profile takes precedence over mode defaults.
		if (historyItem.apiConfigName && !skipProfileRestoreFromHistory) {
			const listApiConfig = await this.providerSettingsManager.listConfig()
			// Keep global state/UI in sync with latest profiles for parity with mode restoration above.
			await this.updateGlobalState("listApiConfigMeta", listApiConfig)
			const profile = listApiConfig.find(({ name }) => name === historyItem.apiConfigName)

			if (profile?.name) {
				try {
					await this.activateProviderProfile(
						{ name: profile.name },
						{ persistModeConfig: false, persistTaskHistory: false },
					)
				} catch (error) {
					// Log the error but continue with task restoration.
					this.log(
						`Failed to restore API configuration '${historyItem.apiConfigName}' for task: ${
							error instanceof Error ? error.message : String(error)
						}. Continuing with current configuration.`,
					)
				}
			} else {
				// Profile no longer exists, log warning but continue
				this.log(
					`Provider profile '${historyItem.apiConfigName}' from history no longer exists. Using current configuration.`,
				)
			}
		} else if (historyItem.apiConfigName && skipProfileRestoreFromHistory) {
			this.log(
				`Skipping restore of provider profile '${historyItem.apiConfigName}' for task ${historyItem.id} in CLI runtime.`,
			)
		}

		const { apiConfiguration, enableCheckpoints, checkpointTimeout, experiments, cloudUserInfo, taskSyncEnabled } =
			await this.getState()

		// LLM hint: Preload-before-publish fix for the task-switch home-screen
		// flash. We construct the Task with `startTask: false` so the
		// constructor does NOT fire-and-forget `resumeTaskFromHistory()`. We
		// then explicitly preload `shoferMessages` from disk via
		// `preloadShoferMessages()` BEFORE the task is pushed onto
		// `shoferStack` (i.e. before it becomes `getCurrentTask()`), guaranteeing
		// that any concurrent `postStateToWebview()` call landing in the
		// rehydration window (e.g. from a background task's
		// `addToShoferMessages`, or from an unrelated webview round-trip) reads
		// a non-empty messages array and the home screen never wins a render.
		// Finally we trigger the resume turn via `startFromHistory()` AFTER the
		// task is on the stack. See [todos/task-switch-home-screen-flash.md].
		const originalStartTask = options?.startTask ?? true

		const task = new Task({
			provider: this,
			apiConfiguration,
			enableCheckpoints,
			checkpointTimeout,
			consecutiveMistakeLimit: apiConfiguration.consecutiveMistakeLimit,
			historyItem,
			experiments,
			rootTask: historyItem.rootTask,
			parentTask: historyItem.parentTask,
			taskNumber: historyItem.number,
			workspacePath: historyItem.workspace,
			onCreated: this.taskCreationCallback,
			startTask: false,
			// Preserve the status from the history item to avoid overwriting it when the task saves messages
			initialState: historyItem.taskState ?? { lifecycle: "idle" },
		})

		// Populate `shoferMessages` (and `apiConversationHistory`) on the new
		// task BEFORE it is observable as `getCurrentTask()`. This is the
		// critical ordering: addShoferToStack / in-place swap below must see a
		// task whose messages are already non-empty.
		await task.preloadShoferMessages()

		if (isRehydratingCurrentTask) {
			// Replace the current task in-place to avoid UI flicker
			const stackIndex = this.shoferStack.length - 1

			// Properly dispose of the old task to ensure garbage collection
			const oldTask = this.shoferStack[stackIndex]

			// Abort the old task to stop running processes and mark as abandoned
			try {
				await oldTask.abortTask(true)
			} catch (e) {
				this.log(
					`[createTaskWithHistoryItem] abortTask() failed for old task ${oldTask.taskId}.${oldTask.instanceId}: ${e instanceof Error ? e.message : String(e)}`,
				)
			}

			// Remove event listeners from the old task
			const cleanupFunctions = this.taskEventListeners.get(oldTask)
			if (cleanupFunctions) {
				cleanupFunctions.forEach((cleanup) => cleanup())
				this.taskEventListeners.delete(oldTask)
			}

			// Replace the task in the stack
			this.shoferStack[stackIndex] = task
			task.emit(ShoferEventName.TaskFocused)

			// Update TaskManager's task instance so event listeners work on the new instance
			this.taskManager.updateTaskInstance(task.taskId, task)

			// Perform preparation tasks and set up event listeners
			await this.performPreparationTasks(task)

			this.debug(
				`[createTaskWithHistoryItem] rehydrated task ${task.taskId}.${task.instanceId} in-place (flicker-free)`,
			)
		} else {
			await this.addShoferToStack(task)

			this.debug(
				`[createTaskWithHistoryItem] ${task.parentTask ? "child" : "parent"} task ${task.taskId}.${task.instanceId} instantiated`,
			)
		}

		// Check if there's a pending edit after checkpoint restoration
		const operationId = `task-${task.taskId}`
		const pendingEdit = this.getPendingEditOperation(operationId)
		if (pendingEdit) {
			this.clearPendingEditOperation(operationId) // Clear the pending edit

			this.debug(`[createTaskWithHistoryItem] Processing pending edit after checkpoint restoration`)

			// Process the pending edit after a short delay to ensure the task is fully initialized
			setTimeout(async () => {
				try {
					// Find the message index in the restored state
					const { messageIndex, apiConversationHistoryIndex } = (() => {
						const messageIndex = task.shoferMessages.findIndex((msg) => msg.ts === pendingEdit.messageTs)
						const apiConversationHistoryIndex = task.apiConversationHistory.findIndex(
							(msg) => msg.ts === pendingEdit.messageTs,
						)
						return { messageIndex, apiConversationHistoryIndex }
					})()

					if (messageIndex !== -1) {
						// Remove the target message and all subsequent messages
						await task.overwriteShoferMessages(task.shoferMessages.slice(0, messageIndex))

						if (apiConversationHistoryIndex !== -1) {
							await task.overwriteApiConversationHistory(
								task.apiConversationHistory.slice(0, apiConversationHistoryIndex),
							)
						}

						// Process the edited message
						await task.handleWebviewAskResponse(
							"messageResponse",
							pendingEdit.editedContent,
							pendingEdit.images,
						)
					}
				} catch (error) {
					this.log(`[createTaskWithHistoryItem] Error processing pending edit: ${error}`)
				}
			}, 100) // Small delay to ensure task is fully ready
		}

		// `messagesReady` is already resolved here because we preloaded above
		// before publishing the task. Kept as a defensive await in case future
		// code paths reintroduce a load that runs after `addShoferToStack`.
		await task.messagesReady

		// Now that the task is published on the stack with populated
		// `shoferMessages`, drive the resume turn (present the resume_task
		// ask, run the loop on user response). For `Task.create()` callers
		// (CLI / external API) that pass `startTask: false`, leave the task
		// dormant.
		if (originalStartTask) {
			task.startFromHistory()
		}

		if (process.env.DEBUG) {
			const msgCount = task.shoferMessages.length
			const apiTurnCount = task.apiConversationHistory.length
			this.debug(`[task-switch] id=${task.taskId} msgs=${msgCount} apiTurns=${apiTurnCount} (timing via @perf)`)
		}

		return task
	}

	public async postMessageToWebview(message: ExtensionMessage) {
		if (this._disposed) {
			return
		}

		try {
			await this.view?.webview.postMessage(message)
		} catch {
			// View disposed, drop message silently
		}
	}

	// ------------------------------------------------------------------
	// FileChangesPanel push notifications.
	//
	// Every Shofer edit triggers a debounced refresh of the
	// `changedFiles/update` payload to the webview. This is the only push
	// channel; the webview can also pull on demand via `changedFiles/get`.
	// ------------------------------------------------------------------

	private changedFilesPushTimer?: NodeJS.Timeout
	private changedFilesPushPendingTaskId?: string
	private static readonly CHANGED_FILES_PUSH_DEBOUNCE_MS = 500

	// Serialization state for pushChangedFilesUpdate. Concurrent invocations
	// (e.g. rapid Accept clicks each calling pushChangedFilesUpdate after
	// their acceptFile completes) used to race: each push computed its
	// payload independently and the LAST message to arrive at the webview
	// won — which could be a stale snapshot taken before later accepts had
	// finished mutating base/final, leaving "accepted" files visible in the
	// panel. The in-flight + queued flags coalesce overlapping pushes so the
	// final message sent always reflects the post-accept state.
	private changedFilesPushInFlight = false
	private changedFilesPushQueued = false
	private changedFilesPushQueuedTaskId?: string

	/**
	 * Schedules a debounced push of the unified ChangedFiles payload for the
	 * given task. Called by FileContextTracker after each `shofer_edited`. Safe
	 * to call frequently — coalesces into one push per debounce window.
	 */
	public scheduleChangedFilesUpdate(taskId: string): void {
		this.changedFilesPushPendingTaskId = taskId
		if (this.changedFilesPushTimer) clearTimeout(this.changedFilesPushTimer)
		this.changedFilesPushTimer = setTimeout(() => {
			this.changedFilesPushTimer = undefined
			void this.pushChangedFilesUpdate(this.changedFilesPushPendingTaskId)
		}, ShoferProvider.CHANGED_FILES_PUSH_DEBOUNCE_MS)
	}

	/**
	 * Computes and pushes the ChangedFiles payload immediately. Used by the
	 * debounced scheduler and by IPC handlers (e.g. after accept/revert).
	 *
	 * Serialized: if a push is already in flight when this is called, the
	 * request is coalesced and a fresh recomputation is run after the
	 * current one finishes. This guarantees the LAST message sent to the
	 * webview reflects all preceding state mutations, even when the caller
	 * issues many rapid invocations (e.g. clicking Accept on multiple
	 * files in quick succession).
	 */
	public async pushChangedFilesUpdate(taskId?: string): Promise<void> {
		if (this.changedFilesPushInFlight) {
			this.changedFilesPushQueued = true
			// Remember the most recent caller-supplied taskId for the queued run.
			this.changedFilesPushQueuedTaskId = taskId
			return
		}
		this.changedFilesPushInFlight = true
		try {
			let nextTaskId = taskId
			do {
				this.changedFilesPushQueued = false
				const queuedTaskId = this.changedFilesPushQueuedTaskId
				this.changedFilesPushQueuedTaskId = undefined

				const task = this.getCurrentTask()
				if (!task) return
				// If the caller specified a taskId for which the update was queued,
				// drop it when the current foreground task has changed (we don't want
				// to surface a stale background-task panel).
				if (nextTaskId && task.taskId !== nextTaskId) return

				try {
					const { getChangedFiles } = await import("../file-changes/ChangedFilesService")
					const payload = await getChangedFiles(task)
					this.debug(
						`[ShoferProvider#pushChangedFilesUpdate] task=${task.taskId} entries=${payload.entries.length} backend=${payload.backend}`,
					)
					await this.postMessageToWebview({ type: "changedFiles/update", changedFiles: payload })

					// Update the task history with live file-change stats so the
					// TaskSelector can show +N/-N in real time without waiting for
					// task completion.
					let totalInsertions = 0
					let totalDeletions = 0
					for (const entry of payload.entries) {
						totalInsertions += entry.insertions
						totalDeletions += entry.deletions
					}
					const existing = this.taskHistoryStore.get(task.taskId)
					if (
						existing &&
						(existing.insertions !== totalInsertions || existing.deletions !== totalDeletions)
					) {
						await this.updateTaskHistory({
							...existing,
							insertions: totalInsertions,
							deletions: totalDeletions,
						})
					}
				} catch (err) {
					this.log(`[ShoferProvider#pushChangedFilesUpdate] failed: ${err}`)
				}

				// If another push was requested while we were running, loop
				// again so the final message reflects post-mutation state.
				nextTaskId = queuedTaskId
			} while (this.changedFilesPushQueued)
		} finally {
			this.changedFilesPushInFlight = false
		}
	}

	private async getHMRHtmlContent(webview: vscode.Webview): Promise<string> {
		let localPort = "5173"

		try {
			const fs = require("fs")
			const path = require("path")
			const portFilePath = path.resolve(__dirname, "../../.vite-port")

			if (fs.existsSync(portFilePath)) {
				localPort = fs.readFileSync(portFilePath, "utf8").trim()
				outputLog(`[ShoferProvider:Vite] Using Vite server port from ${portFilePath}: ${localPort}`)
			} else {
				outputLog(
					`[ShoferProvider:Vite] Port file not found at ${portFilePath}, using default port: ${localPort}`,
				)
			}
		} catch (err) {
			outputError("[ShoferProvider:Vite] Failed to read Vite port file:", err)
		}

		const localServerUrl = `localhost:${localPort}`

		// Check if local dev server is running.
		try {
			await axios.get(`http://${localServerUrl}`)
		} catch (error) {
			vscode.window.showErrorMessage(t("common:errors.hmr_not_running"))
			return this.getHtmlContent(webview)
		}

		const nonce = getNonce()

		// Get the OpenRouter base URL from configuration
		const { apiConfiguration } = await this.getState()
		const openRouterBaseUrl = apiConfiguration.openRouterBaseUrl || "https://openrouter.ai"
		// Extract the domain for CSP
		const openRouterDomain = openRouterBaseUrl.match(/^(https?:\/\/[^\/]+)/)?.[1] || "https://openrouter.ai"

		const stylesUri = getUri(webview, this.contextProxy.extensionUri, [
			"webview-ui",
			"build",
			"assets",
			"index.css",
		])

		const codiconsUri = getUri(webview, this.contextProxy.extensionUri, ["assets", "codicons", "codicon.css"])
		const materialIconsUri = getUri(webview, this.contextProxy.extensionUri, [
			"assets",
			"vscode-material-icons",
			"icons",
		])
		const imagesUri = getUri(webview, this.contextProxy.extensionUri, ["assets", "images"])
		const audioUri = getUri(webview, this.contextProxy.extensionUri, ["webview-ui", "audio"])

		const file = "src/index.tsx"
		const scriptUri = `http://${localServerUrl}/${file}`

		const reactRefresh = /*html*/ `
			<script nonce="${nonce}" type="module">
				import RefreshRuntime from "http://localhost:${localPort}/@react-refresh"
				RefreshRuntime.injectIntoGlobalHook(window)
				window.$RefreshReg$ = () => {}
				window.$RefreshSig$ = () => (type) => type
				window.__vite_plugin_react_preamble_installed__ = true
			</script>
		`

		const csp = [
			"default-src 'none'",
			`font-src ${webview.cspSource} data:`,
			`style-src ${webview.cspSource} 'unsafe-inline' https://* http://${localServerUrl} http://0.0.0.0:${localPort}`,
			`img-src ${webview.cspSource} https://storage.googleapis.com https://img.clerk.com data:`,
			`media-src ${webview.cspSource}`,
			`script-src 'unsafe-eval' ${webview.cspSource} https://* https://*.posthog.com http://${localServerUrl} http://0.0.0.0:${localPort} 'nonce-${nonce}'`,
			`connect-src ${webview.cspSource} ${openRouterDomain} https://* https://*.posthog.com ws://${localServerUrl} ws://0.0.0.0:${localPort} http://${localServerUrl} http://0.0.0.0:${localPort}`,
		]

		return /*html*/ `
			<!DOCTYPE html>
			<html lang="en">
				<head>
					<meta charset="utf-8">
					<meta name="viewport" content="width=device-width,initial-scale=1,shrink-to-fit=no">
					<meta http-equiv="Content-Security-Policy" content="${csp.join("; ")}">
					<link rel="stylesheet" type="text/css" href="${stylesUri}">
					<link href="${codiconsUri}" rel="stylesheet" />
					<script nonce="${nonce}">
						window.IMAGES_BASE_URI = "${imagesUri}"
						window.AUDIO_BASE_URI = "${audioUri}"
						window.MATERIAL_ICONS_BASE_URI = "${materialIconsUri}"
					</script>
					<title>Shofer</title>
				</head>
				<body>
					<div id="root"></div>
					${reactRefresh}
					<script type="module" src="${scriptUri}"></script>
				</body>
			</html>
		`
	}

	/**
	 * Defines and returns the HTML that should be rendered within the webview panel.
	 *
	 * @remarks This is also the place where references to the React webview build files
	 * are created and inserted into the webview HTML.
	 *
	 * @param webview A reference to the extension webview
	 * @param extensionUri The URI of the directory containing the extension
	 * @returns A template string literal containing the HTML that should be
	 * rendered within the webview panel
	 */
	private async getHtmlContent(webview: vscode.Webview): Promise<string> {
		// Get the local path to main script run in the webview,
		// then convert it to a uri we can use in the webview.

		// The CSS file from the React build output
		const stylesUri = getUri(webview, this.contextProxy.extensionUri, [
			"webview-ui",
			"build",
			"assets",
			"index.css",
		])

		const scriptUri = getUri(webview, this.contextProxy.extensionUri, ["webview-ui", "build", "assets", "index.js"])
		const codiconsUri = getUri(webview, this.contextProxy.extensionUri, ["assets", "codicons", "codicon.css"])
		const materialIconsUri = getUri(webview, this.contextProxy.extensionUri, [
			"assets",
			"vscode-material-icons",
			"icons",
		])
		const imagesUri = getUri(webview, this.contextProxy.extensionUri, ["assets", "images"])
		const audioUri = getUri(webview, this.contextProxy.extensionUri, ["webview-ui", "audio"])

		// Use a nonce to only allow a specific script to be run.
		/*
		content security policy of your webview to only allow scripts that have a specific nonce
		create a content security policy meta tag so that only loading scripts with a nonce is allowed
		As your extension grows you will likely want to add custom styles, fonts, and/or images to your webview. If you do, you will need to update the content security policy meta tag to explicitly allow for these resources. E.g.
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; img-src ${webview.cspSource} https:; script-src 'nonce-${nonce}';">
		- 'unsafe-inline' is required for styles due to vscode-webview-toolkit's dynamic style injection
		- since we pass base64 images to the webview, we need to specify img-src ${webview.cspSource} data:;

		in meta tag we add nonce attribute: A cryptographic nonce (only used once) to allow scripts. The server must generate a unique nonce value each time it transmits a policy. It is critical to provide a nonce that cannot be guessed as bypassing a resource's policy is otherwise trivial.
		*/
		const nonce = getNonce()

		// Get the OpenRouter base URL from configuration
		const { apiConfiguration } = await this.getState()
		const openRouterBaseUrl = apiConfiguration.openRouterBaseUrl || "https://openrouter.ai"
		// Extract the domain for CSP
		const openRouterDomain = openRouterBaseUrl.match(/^(https?:\/\/[^\/]+)/)?.[1] || "https://openrouter.ai"

		// Tip: Install the es6-string-html VS Code extension to enable code highlighting below
		return /*html*/ `
        <!DOCTYPE html>
        <html lang="en">
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width,initial-scale=1,shrink-to-fit=no">
            <meta name="theme-color" content="#000000">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} https://storage.googleapis.com https://img.clerk.com data:; media-src ${webview.cspSource}; script-src ${webview.cspSource} 'wasm-unsafe-eval' 'nonce-${nonce}' https://ph.shofer.dev 'strict-dynamic'; connect-src ${webview.cspSource} ${openRouterDomain} https://api.requesty.ai https://ph.shofer.dev;">
            <link rel="stylesheet" type="text/css" href="${stylesUri}">
			<link href="${codiconsUri}" rel="stylesheet" />
			<script nonce="${nonce}">
				window.IMAGES_BASE_URI = "${imagesUri}"
				window.AUDIO_BASE_URI = "${audioUri}"
				window.MATERIAL_ICONS_BASE_URI = "${materialIconsUri}"
			</script>
            <title>Shofer</title>
          </head>
          <body>
            <noscript>You need to enable JavaScript to run this app.</noscript>
            <div id="root"></div>
            <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
          </body>
        </html>
      `
	}

	/**
	 * Sets up an event listener to listen for messages passed from the webview context and
	 * executes code based on the message that is received.
	 *
	 * @param webview A reference to the extension webview
	 */
	private setWebviewMessageListener(webview: vscode.Webview) {
		const onReceiveMessage = async (message: WebviewMessage) =>
			webviewMessageHandler(this, message, this.marketplaceManager)

		const messageDisposable = webview.onDidReceiveMessage(onReceiveMessage)
		this.webviewDisposables.push(messageDisposable)
	}

	/**
	 * Sticky per-task mode restore. Updates the global `mode` state to match
	 * the focused task's `_taskMode` (set on construction from the history item
	 * or `defaultModeSlug`, and kept in sync by `handleModeSwitch`).
	 *
	 * Called from `focusTask` when swapping a live Task into the stack — without
	 * this, switching focus would leave the mode picker showing whatever the
	 * previously focused task last selected. The history-rehydration path
	 * (`showTaskWithId`) already restores mode itself, so we don't call this
	 * there.
	 */
	private async restoreTaskMode(task: Task): Promise<void> {
		try {
			const taskMode = await task.getTaskMode()
			if (this.getGlobalState("mode") !== taskMode) {
				await this.updateGlobalState("mode", taskMode)
				this.emit(ShoferEventName.ModeChanged, taskMode as Mode)
			}
		} catch (error) {
			this.log(
				`[restoreTaskMode] Failed to restore mode for task ${task.taskId}: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	/**
	 * Handle switching to a new mode, including updating the associated API configuration
	 * @param newMode The mode to switch to
	 * @param sourceTask The task that initiated the mode switch. When provided,
	 * the mode change is scoped to this task instead of the currently focused task.
	 * This prevents a mode switch in background Task A from silently updating the
	 * mode of Task B (which the user is currently viewing).
	 */
	public async handleModeSwitch(newMode: Mode, sourceTask: Task) {
		TelemetryService.instance.captureModeSwitch(sourceTask.taskId, newMode)
		sourceTask.emit(ShoferEventName.TaskModeSwitched, sourceTask.taskId, newMode)

		try {
			const taskHistoryItem =
				this.taskHistoryStore.get(sourceTask.taskId) ??
				(this.getGlobalState("taskHistory") ?? []).find((item) => item.id === sourceTask.taskId)

			if (taskHistoryItem) {
				await this.updateTaskHistory({ ...taskHistoryItem, mode: newMode })
			}

			;(sourceTask as any)._taskMode = newMode
		} catch (error) {
			this.log(
				`Failed to persist mode switch for task ${sourceTask.taskId}: ${error instanceof Error ? error.message : String(error)}`,
			)
			throw error
		}
	}

	public async handleUserModeSwitch(newMode: Mode) {
		const task = this.getCurrentTask()

		if (task) {
			TelemetryService.instance.captureModeSwitch(task.taskId, newMode)
			task.emit(ShoferEventName.TaskModeSwitched, task.taskId, newMode)

			try {
				const taskHistoryItem =
					this.taskHistoryStore.get(task.taskId) ??
					(this.getGlobalState("taskHistory") ?? []).find((item) => item.id === task.taskId)

				if (taskHistoryItem) {
					await this.updateTaskHistory({ ...taskHistoryItem, mode: newMode })
				}

				;(task as any)._taskMode = newMode
			} catch (error) {
				this.log(
					`Failed to persist mode switch for task ${task.taskId}: ${error instanceof Error ? error.message : String(error)}`,
				)
				throw error
			}
		} else {
			await this.updateGlobalState("mode", newMode)
		}

		this.emit(ShoferEventName.ModeChanged, newMode)

		const lockApiConfigAcrossModes = this.context.workspaceState.get("lockApiConfigAcrossModes", false)
		if (lockApiConfigAcrossModes) {
			await this.postStateToWebviewWithoutTaskHistory()
			return
		}

		const savedConfigId = await this.providerSettingsManager.getModeConfigId(newMode)
		const listApiConfig = await this.providerSettingsManager.listConfig()

		await this.updateGlobalState("listApiConfigMeta", listApiConfig)

		const customModes = await this.customModesManager.getCustomModes()
		const modeConfig = getModeBySlug(newMode, customModes)

		let profileName: string | undefined
		if (modeConfig?.provider) {
			profileName = listApiConfig.find((c) => c.name === modeConfig.provider)?.name
		}
		if (!profileName && savedConfigId) {
			profileName = listApiConfig.find(({ id }) => id === savedConfigId)?.name
		}

		if (profileName) {
			const fullProfile = await this.providerSettingsManager.getProfile({ name: profileName })
			const hasActualSettings = !!fullProfile.apiProvider

			if (hasActualSettings) {
				await this.activateProviderProfile({ name: profileName })
			}
		} else if (!modeConfig?.provider) {
			const currentApiConfigNameAfter = this.getGlobalState("currentApiConfigName")

			if (currentApiConfigNameAfter) {
				const config = listApiConfig.find((c) => c.name === currentApiConfigNameAfter)

				if (config?.id) {
					await this.providerSettingsManager.setModeConfig(newMode, config.id)
					await this.syncCustomModeProviderToYaml(newMode, currentApiConfigNameAfter)
				}
			}
		}

		await this.postStateToWebviewWithoutTaskHistory()
	}

	/**
	 * Mirrors the per-mode API config selection back into the custom-mode YAML's
	 * `provider:` field, so the YAML and the saved `modeApiConfigs` mapping stay 1:1.
	 *
	 * Targeting rule: if a workspace is open, the write always goes to the
	 * project-scoped `.shofermodes` file, even when the mode is currently defined only
	 * globally. This keeps per-project API-profile preferences out of the global
	 * `custom_modes.yaml` (which is shared across workspaces) and creates a project
	 * override on demand. With no workspace open, the global file is updated.
	 *
	 * No-op for built-in modes (they have no YAML representation) and when the
	 * existing entry already matches `configName`, to avoid spurious file writes.
	 */
	private async syncCustomModeProviderToYaml(mode: Mode, configName: string | undefined): Promise<void> {
		if (!configName) return

		try {
			const customModes = await this.customModesManager.getCustomModes()
			const modeConfig = getModeBySlug(mode, customModes)

			// Built-in modes have no `source` and no YAML entry; skip.
			if (!modeConfig || (modeConfig.source !== "global" && modeConfig.source !== "project")) {
				return
			}

			// Always prefer writing to the project file when a workspace is open, so
			// per-project provider preferences override (and don't pollute) the global file.
			const hasWorkspace = (vscode.workspace.workspaceFolders?.length ?? 0) > 0
			const targetSource: "global" | "project" = hasWorkspace ? "project" : "global"

			// If the entry that already wins (project overrides global) matches, no-op —
			// even when targeting project and the current entry is global, because the
			// effective provider is identical.
			if (modeConfig.provider === configName && modeConfig.source === targetSource) {
				return
			}
			if (modeConfig.provider === configName && targetSource === "global") {
				return
			}

			await this.customModesManager.updateCustomMode(mode, {
				...modeConfig,
				source: targetSource,
				provider: configName,
			})
		} catch (error) {
			// Don't fail the surrounding operation if YAML sync fails; just log.
			this.log(
				`Failed to sync provider field to custom mode YAML for "${mode}": ${
					error instanceof Error ? error.message : String(error)
				}`,
			)
		}
	}

	// Provider Profile Management

	/**
	 * Updates the current task's API handler.
	 * Rebuilds when:
	 * - provider or model changes, OR
	 * - explicitly forced (e.g., user-initiated profile switch/save to apply changed settings like headers/baseUrl/tier).
	 * Always synchronizes task.apiConfiguration with latest provider settings.
	 * @param providerSettings The new provider settings to apply
	 * @param options.forceRebuild Force rebuilding the API handler regardless of provider/model equality
	 */
	private updateTaskApiHandlerIfNeeded(
		providerSettings: ProviderSettings,
		options: { forceRebuild?: boolean } = {},
	): void {
		const task = this.getCurrentTask()
		if (!task) return

		const { forceRebuild = false } = options

		// Determine if we need to rebuild using the previous configuration snapshot
		const prevConfig = task.apiConfiguration
		const prevProvider = prevConfig?.apiProvider
		const prevModelId = prevConfig ? getModelId(prevConfig) : undefined
		const newProvider = providerSettings.apiProvider
		const newModelId = getModelId(providerSettings)

		const needsRebuild = forceRebuild || prevProvider !== newProvider || prevModelId !== newModelId

		if (needsRebuild) {
			// Use updateApiConfiguration which handles both API handler rebuild and parser sync.
			// Note: updateApiConfiguration is declared async but has no actual async operations,
			// so we can safely call it without awaiting.
			task.updateApiConfiguration(providerSettings)
		} else {
			// No rebuild needed, just sync apiConfiguration
			;(task as any).apiConfiguration = providerSettings
		}
	}

	getProviderProfileEntries(): ProviderSettingsEntry[] {
		return this.contextProxy.getValues().listApiConfigMeta || []
	}

	getProviderProfileEntry(name: string): ProviderSettingsEntry | undefined {
		return this.getProviderProfileEntries().find((profile) => profile.name === name)
	}

	public hasProviderProfileEntry(name: string): boolean {
		return !!this.getProviderProfileEntry(name)
	}

	async upsertProviderProfile(
		name: string,
		providerSettings: ProviderSettings,
		activate: boolean = true,
	): Promise<string | undefined> {
		try {
			// TODO: Do we need to be calling `activateProfile`? It's not
			// clear to me what the source of truth should be; in some cases
			// we rely on the `ContextProxy`'s data store and in other cases
			// we rely on the `ProviderSettingsManager`'s data store. It might
			// be simpler to unify these two.
			const id = await this.providerSettingsManager.saveConfig(name, providerSettings)

			if (activate) {
				const { mode } = await this.getState()

				// These promises do the following:
				// 1. Adds or updates the list of provider profiles.
				// 2. Sets the current provider profile.
				// 3. Sets the current mode's provider profile.
				// 4. Copies the provider settings to the context.
				//
				// Note: 1, 2, and 4 can be done in one `ContextProxy` call:
				// this.contextProxy.setValues({ ...providerSettings, listApiConfigMeta: ..., currentApiConfigName: ... })
				// We should probably switch to that and verify that it works.
				// I left the original implementation in just to be safe.
				await Promise.all([
					this.updateGlobalState("listApiConfigMeta", await this.providerSettingsManager.listConfig()),
					this.updateGlobalState("currentApiConfigName", name),
					this.providerSettingsManager.setModeConfig(mode, id),
					this.contextProxy.setProviderSettings(providerSettings),
				])

				// Mirror the per-mode mapping into the custom-mode YAML so the two stay 1:1.
				await this.syncCustomModeProviderToYaml(mode, name)

				// Change the provider for the current task.
				// TODO: We should rename `buildApiHandler` for clarity (e.g. `getProviderClient`).
				this.updateTaskApiHandlerIfNeeded(providerSettings, { forceRebuild: true })

				// Keep the current task's sticky provider profile in sync with the newly-activated profile.
				await this.persistStickyProviderProfileToCurrentTask(name)
			} else {
				await this.updateGlobalState("listApiConfigMeta", await this.providerSettingsManager.listConfig())
			}

			await this.postStateToWebviewWithoutTaskHistory()
			return id
		} catch (error) {
			this.log(
				`Error create new api configuration: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
			)

			vscode.window.showErrorMessage(t("common:errors.create_api_config"))
			return undefined
		}
	}

	async deleteProviderProfile(profileToDelete: ProviderSettingsEntry) {
		const globalSettings = this.contextProxy.getValues()
		let profileToActivate: string | undefined = globalSettings.currentApiConfigName

		if (profileToDelete.name === profileToActivate) {
			profileToActivate = this.getProviderProfileEntries().find(({ name }) => name !== profileToDelete.name)?.name
		}

		if (!profileToActivate) {
			throw new Error("You cannot delete the last profile")
		}

		const entries = this.getProviderProfileEntries().filter(({ name }) => name !== profileToDelete.name)

		await this.contextProxy.setValues({
			...globalSettings,
			currentApiConfigName: profileToActivate,
			listApiConfigMeta: entries,
		})

		await this.postStateToWebviewWithoutTaskHistory()
	}

	private async persistStickyProviderProfileToCurrentTask(apiConfigName: string): Promise<void> {
		const task = this.getCurrentTask()
		if (!task) {
			return
		}

		try {
			// Update in-memory state immediately so sticky behavior works even before the task has
			// been persisted into taskHistory (it will be captured on the next save).
			task.setTaskApiConfigName(apiConfigName)

			const taskHistoryItem =
				this.taskHistoryStore.get(task.taskId) ??
				(this.getGlobalState("taskHistory") ?? []).find((item) => item.id === task.taskId)

			if (taskHistoryItem) {
				await this.updateTaskHistory({ ...taskHistoryItem, apiConfigName })
			}
		} catch (error) {
			// If persistence fails, log the error but don't fail the profile switch.
			this.log(
				`Failed to persist provider profile switch for task ${task.taskId}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			)
		}
	}

	async activateProviderProfile(
		args: { name: string } | { id: string },
		options?: { persistModeConfig?: boolean; persistTaskHistory?: boolean },
	) {
		const { name, id, ...providerSettings } = await this.providerSettingsManager.activateProfile(args)

		const persistModeConfig = options?.persistModeConfig ?? true
		const persistTaskHistory = options?.persistTaskHistory ?? true

		// See `upsertProviderProfile` for a description of what this is doing.
		await Promise.all([
			this.contextProxy.setValue("listApiConfigMeta", await this.providerSettingsManager.listConfig()),
			this.contextProxy.setValue("currentApiConfigName", name),
			this.contextProxy.setProviderSettings(providerSettings),
		])

		const { mode } = await this.getState()

		if (id && persistModeConfig) {
			await this.providerSettingsManager.setModeConfig(mode, id)
			// Mirror the per-mode mapping into the custom-mode YAML so the two stay 1:1.
			await this.syncCustomModeProviderToYaml(mode, name)
		}

		// Change the provider for the current task.
		this.updateTaskApiHandlerIfNeeded(providerSettings, { forceRebuild: true })

		// Update the current task's sticky provider profile, unless this activation is
		// being used purely as a non-persisting restoration (e.g., reopening a task from history).
		if (persistTaskHistory) {
			await this.persistStickyProviderProfileToCurrentTask(name)
		}

		await this.postStateToWebviewWithoutTaskHistory()

		if (providerSettings.apiProvider) {
			this.emit(ShoferEventName.ProviderProfileChanged, { name, provider: providerSettings.apiProvider })
		}
	}

	async updateCustomInstructions(instructions?: string) {
		// User may be clearing the field.
		await this.updateGlobalState("customInstructions", instructions || undefined)
		await this.postStateToWebviewWithoutTaskHistory()
	}

	// MCP

	async ensureMcpServersDirectoryExists(): Promise<string> {
		// Get platform-specific application data directory
		let mcpServersDir: string
		if (process.platform === "win32") {
			// Windows: %APPDATA%\Shofer\MCP
			mcpServersDir = path.join(os.homedir(), "AppData", "Roaming", "Shofer", "MCP")
		} else if (process.platform === "darwin") {
			// macOS: ~/Documents/Shofer/MCP
			mcpServersDir = path.join(os.homedir(), "Documents", "Shofer", "MCP")
		} else {
			// Linux: ~/.local/share/Shofer/MCP
			mcpServersDir = path.join(os.homedir(), ".local", "share", "Shofer", "MCP")
		}

		try {
			await fs.mkdir(mcpServersDir, { recursive: true })
		} catch (error) {
			// Fallback to a relative path if directory creation fails
			return path.join(os.homedir(), ".shofer-code", "mcp")
		}
		return mcpServersDir
	}

	async ensureSettingsDirectoryExists(): Promise<string> {
		const { getSettingsDirectoryPath } = await import("../../utils/storage")
		const globalStoragePath = this.contextProxy.globalStorageUri.fsPath
		return getSettingsDirectoryPath(globalStoragePath)
	}

	// OpenRouter

	async handleOpenRouterCallback(code: string) {
		let { apiConfiguration, currentApiConfigName = "default" } = await this.getState()

		let apiKey: string

		try {
			const baseUrl = apiConfiguration.openRouterBaseUrl || "https://openrouter.ai/api/v1"
			// Extract the base domain for the auth endpoint.
			const baseUrlDomain = baseUrl.match(/^(https?:\/\/[^\/]+)/)?.[1] || "https://openrouter.ai"
			const response = await axios.post(`${baseUrlDomain}/api/v1/auth/keys`, { code })

			if (response.data && response.data.key) {
				apiKey = response.data.key
			} else {
				throw new Error("Invalid response from OpenRouter API")
			}
		} catch (error) {
			this.log(
				`Error exchanging code for API key: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
			)

			throw error
		}

		const newConfiguration: ProviderSettings = {
			...apiConfiguration,
			apiProvider: "openrouter",
			openRouterApiKey: apiKey,
			openRouterModelId: apiConfiguration?.openRouterModelId || openRouterDefaultModelId,
		}

		await this.upsertProviderProfile(currentApiConfigName, newConfiguration)
	}

	// Requesty

	async handleRequestyCallback(code: string, baseUrl: string | null) {
		let { apiConfiguration } = await this.getState()

		const newConfiguration: ProviderSettings = {
			...apiConfiguration,
			apiProvider: "requesty",
			requestyApiKey: code,
			requestyModelId: apiConfiguration?.requestyModelId || requestyDefaultModelId,
		}

		// set baseUrl as undefined if we don't provide one
		// or if it is the default requesty url
		if (!baseUrl || baseUrl === REQUESTY_BASE_URL) {
			newConfiguration.requestyBaseUrl = undefined
		} else {
			newConfiguration.requestyBaseUrl = baseUrl
		}

		const profileName = `Requesty (${new Date().toLocaleString()})`
		await this.upsertProviderProfile(profileName, newConfiguration)
	}

	// Task history

	async getTaskWithId(id: string): Promise<{
		historyItem: HistoryItem
		taskDirPath: string
		apiConversationHistoryFilePath: string
		uiMessagesFilePath: string
		apiConversationHistory: Anthropic.MessageParam[]
	}> {
		const historyItem =
			this.taskHistoryStore.get(id) ?? (this.getGlobalState("taskHistory") ?? []).find((item) => item.id === id)

		if (!historyItem) {
			throw new Error("Task not found")
		}

		const { getTaskDirectoryPath } = await import("../../utils/storage")
		const globalStoragePath = this.contextProxy.globalStorageUri.fsPath
		const taskDirPath = await getTaskDirectoryPath(globalStoragePath, id)
		const apiConversationHistoryFilePath = path.join(taskDirPath, GlobalFileNames.apiConversationHistory)
		const uiMessagesFilePath = path.join(taskDirPath, GlobalFileNames.uiMessages)
		const fileExists = await fileExistsAtPath(apiConversationHistoryFilePath)

		let apiConversationHistory: Anthropic.MessageParam[] = []

		if (fileExists) {
			try {
				apiConversationHistory = JSON.parse(await fs.readFile(apiConversationHistoryFilePath, "utf8"))
			} catch (error) {
				outputWarn(
					`[getTaskWithId] api_conversation_history.json corrupted for task ${id}, returning empty history: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		} else {
			outputWarn(`[getTaskWithId] api_conversation_history.json missing for task ${id}, returning empty history`)
		}

		return {
			historyItem,
			taskDirPath,
			apiConversationHistoryFilePath,
			uiMessagesFilePath,
			apiConversationHistory,
		}
	}

	async getTaskWithAggregatedCosts(taskId: string): Promise<{
		historyItem: HistoryItem
		aggregatedCosts: AggregatedCosts
	}> {
		const { historyItem } = await this.getTaskWithId(taskId)

		const aggregatedCosts = await aggregateTaskCostsRecursive(taskId, async (id: string) => {
			try {
				const result = await this.getTaskWithId(id)
				return result.historyItem
			} catch {
				// Child task not found in history (e.g. pruned or from a different session).
				// aggregateTaskCostsRecursive handles undefined by returning zero costs.
				return undefined
			}
		})

		return { historyItem, aggregatedCosts }
	}

	async showTaskWithId(id: string, options?: { keepCurrentTask?: boolean }) {
		if (id !== this.getCurrentTask()?.taskId) {
			// Non-current task.
			const { historyItem } = await this.getTaskWithId(id)
			await this.createTaskWithHistoryItem(historyItem, { keepCurrentTask: options?.keepCurrentTask }) // Clears existing task unless keepCurrentTask is true.
		}

		// LLM hint: Push the new task's (already-preloaded) shoferMessages to
		// the webview BEFORE the chatButtonClicked action navigates it to the
		// chat view. Without this, when the user clicks a task from the home
		// screen (where the webview's cached shoferMessages is []), the
		// chatButtonClicked navigation lands on an empty chat → ChatView
		// renders the home screen for a frame until resumeTaskFromHistory's
		// eventual ask() triggers its own postStateToWebview. The
		// preload-before-publish step in createTaskWithHistoryItem guarantees
		// this push carries the populated history.
		await this.postStateToWebview()

		await this.postMessageToWebview({ type: "action", action: "chatButtonClicked" })
	}

	async exportTaskWithId(id: string) {
		const { historyItem, apiConversationHistory } = await this.getTaskWithId(id)
		const fileName = getTaskFileName(historyItem.ts)
		const defaultUri = await resolveDefaultSaveUri(this.contextProxy, "lastTaskExportPath", fileName, {
			useWorkspace: false,
			fallbackDir: path.join(os.homedir(), "Downloads"),
		})
		const saveUri = await downloadTask(historyItem.ts, apiConversationHistory, defaultUri)

		if (saveUri) {
			await saveLastExportPath(this.contextProxy, "lastTaskExportPath", saveUri)
		}
	}

	/**
	 * Export a task as a structured JSON trace enriched with per-call
	 * token usage, cost, and tool call metadata.  Reads
	 * ui_messages.json alongside api_conversation_history.json so the
	 * trace captures the same granularity the chrome-extension exporter
	 * provides.
	 */
	async exportTaskWithIdJson(id: string) {
		const { historyItem, apiConversationHistory, uiMessagesFilePath } = await this.getTaskWithId(id)

		// Read ui_messages.json for per-request metadata.
		let uiMessages: Array<{ type: string; say?: string; ts: number; text?: string }> = []
		try {
			const exists = await fs
				.stat(uiMessagesFilePath)
				.then(() => true)
				.catch(() => false)
			if (exists) {
				uiMessages = JSON.parse(await fs.readFile(uiMessagesFilePath, "utf8"))
			}
		} catch (err) {
			outputWarn(
				`[exportTaskWithIdJson] Could not read ui_messages.json for task ${id}: ${err instanceof Error ? err.message : String(err)}`,
			)
		}

		const trace = buildJsonTrace(
			id,
			historyItem.task || historyItem.ts?.toString() || "",
			historyItem.mode,
			historyItem.ts ? new Date(historyItem.ts).toISOString() : new Date().toISOString(),
			apiConversationHistory,
			uiMessages,
		)

		const fileName = getJsonExportFileName(historyItem.ts)
		const defaultUri = await resolveDefaultSaveUri(this.contextProxy, "lastTaskExportPath", fileName, {
			useWorkspace: false,
			fallbackDir: path.join(os.homedir(), "Downloads"),
		})
		const saveUri = await downloadJsonTask(historyItem.ts, trace, defaultUri)

		if (saveUri) {
			await saveLastExportPath(this.contextProxy, "lastTaskExportPath", saveUri)
		}
	}

	/* Condenses a task's message history to use fewer tokens. */
	async condenseTaskContext(taskId: string) {
		let task: Task | undefined
		for (let i = this.shoferStack.length - 1; i >= 0; i--) {
			if (this.shoferStack[i].taskId === taskId) {
				task = this.shoferStack[i]
				break
			}
		}
		if (!task) {
			throw new Error(`Task with id ${taskId} not found in stack`)
		}
		await task.condenseContext()
		await this.postMessageToWebview({ type: "condenseTaskContextResponse", text: taskId })
	}

	// this function deletes a task from task history, and deletes its checkpoints and delete the task folder
	// If the task has subtasks (childIds), they will also be deleted recursively
	async deleteTaskWithId(id: string, cascadeSubtasks: boolean = true) {
		try {
			// get the task directory full path and history item
			const { taskDirPath, historyItem } = await this.getTaskWithId(id)

			// Collect all task IDs to delete (parent + all subtasks)
			const allIdsToDelete: string[] = [id]

			if (cascadeSubtasks) {
				// Recursively collect all child IDs
				const collectChildIds = async (taskId: string): Promise<void> => {
					try {
						const { historyItem: item } = await this.getTaskWithId(taskId)
						if (item.childIds && item.childIds.length > 0) {
							for (const childId of item.childIds) {
								allIdsToDelete.push(childId)
								await collectChildIds(childId)
							}
						}
					} catch (error) {
						// Child task may already be deleted or not found, continue
						outputLog(`[deleteTaskWithId] child task ${taskId} not found, skipping`)
					}
				}

				await collectChildIds(id)
			}

			// Remove from stack if any of the tasks to delete are in the current task stack
			for (const taskId of allIdsToDelete) {
				if (taskId === this.getCurrentTask()?.taskId) {
					// Close the current task instance; delegation flows will be handled via metadata if applicable.
					await this.removeShoferFromStack()
					break
				}
			}

			// Delete all tasks from state in one batch
			await this.taskHistoryStore.deleteMany(allIdsToDelete)
			this.recentTasksCache = undefined

			// Delete associated shadow repositories or branches and task directories
			const globalStorageDir = this.contextProxy.globalStorageUri.fsPath
			const workspaceDir = this.cwd
			const { getTaskDirectoryPath } = await import("../../utils/storage")
			const globalStoragePath = this.contextProxy.globalStorageUri.fsPath

			for (const taskId of allIdsToDelete) {
				try {
					await ShadowCheckpointService.deleteTask({ taskId, globalStorageDir, workspaceDir })
				} catch (error) {
					outputError(
						`[deleteTaskWithId${taskId}] failed to delete associated shadow repository or branch: ${error instanceof Error ? error.message : String(error)}`,
					)
				}

				// Delete the task directory
				try {
					const dirPath = await getTaskDirectoryPath(globalStoragePath, taskId)
					await fs.rm(dirPath, { recursive: true, force: true })
					outputLog(`[deleteTaskWithId${taskId}] removed task directory`)
				} catch (error) {
					outputError(
						`[deleteTaskWithId${taskId}] failed to remove task directory: ${error instanceof Error ? error.message : String(error)}`,
					)
				}
			}

			await this.postStateToWebviewWithoutTaskHistory()
			// Deletion is not communicated via taskHistoryItemUpdated, so push a
			// lightweight taskHistoryUpdated message so the webview drops the
			// removed tasks from TaskSelector immediately.
			await this.broadcastTaskHistoryUpdate()
		} catch (error) {
			// If task is not found, just remove it from state
			if (error instanceof Error && error.message === "Task not found") {
				await this.deleteTaskFromState(id)
				return
			}
			throw error
		}
	}

	async deleteTaskFromState(id: string) {
		await this.taskHistoryStore.delete(id)
		this.recentTasksCache = undefined

		await this.postStateToWebviewWithoutTaskHistory()
		// See deleteTaskWithId: webview needs an explicit task-history broadcast
		// to drop the deleted item from the TaskSelector list.
		await this.broadcastTaskHistoryUpdate()
	}

	async refreshWorkspace() {
		this.currentWorkspacePath = getWorkspacePath()
		await this.postStateToWebviewWithoutTaskHistory()
	}
	async postStateToWebview() {
		return time("postStateToWebview", async () => {
			const state = await this.getStateToPostToWebview()
			this.shoferMessagesSeq++
			state.shoferMessagesSeq = this.shoferMessagesSeq
			this.postMessageToWebview({ type: "state", state })
		})
	}

	/**
	 * Like postStateToWebview but intentionally omits taskHistory.
	 *
	 * Rationale:
	 * - taskHistory can be large and was being resent on every chat message update.
	 * - The webview maintains taskHistory in-memory and receives updates via
	 *   `taskHistoryUpdated` / `taskHistoryItemUpdated`.
	 */
	async postStateToWebviewWithoutTaskHistory(): Promise<void> {
		return time("postStateToWebviewWithoutTaskHistory", async () => {
			const state = await this.getStateToPostToWebview()
			this.shoferMessagesSeq++
			state.shoferMessagesSeq = this.shoferMessagesSeq
			const { taskHistory: _omit, ...rest } = state
			this.postMessageToWebview({ type: "state", state: rest })
		})
	}

	/**
	 * Like postStateToWebview but intentionally omits both shoferMessages and taskHistory.
	 *
	 * Rationale:
	 * - Cloud event handlers (auth, settings, user-info) and mode changes trigger state pushes
	 *   that have nothing to do with chat messages. Including shoferMessages in these pushes
	 *   creates race conditions where a stale snapshot of shoferMessages (captured during async
	 *   getStateToPostToWebview) overwrites newer messages the task has streamed in the meantime.
	 * - This method ensures cloud/mode events only push the state fields they actually affect
	 *   (cloud auth, org settings, profiles, etc.) without interfering with task message streaming.
	 */
	async postStateToWebviewWithoutShoferMessages(): Promise<void> {
		return time("postStateToWebviewWithoutShoferMessages", async () => {
			const state = await this.getStateToPostToWebview()
			const { shoferMessages: _omitMessages, taskHistory: _omitHistory, ...rest } = state
			this.postMessageToWebview({ type: "state", state: rest })
		})
	}

	/**
	 * Fetches marketplace data on demand to avoid blocking main state updates
	 */
	async fetchMarketplaceData() {
		try {
			const [marketplaceResult, marketplaceInstalledMetadata] = await Promise.all([
				this.marketplaceManager.getMarketplaceItems().catch((error) => {
					outputError("Failed to fetch marketplace items:", error)
					return { organizationMcps: [], marketplaceItems: [], errors: [error.message] }
				}),
				this.marketplaceManager.getInstallationMetadata().catch((error) => {
					outputError("Failed to fetch installation metadata:", error)
					return { project: {}, global: {} } as MarketplaceInstalledMetadata
				}),
			])

			// Send marketplace data separately
			this.postMessageToWebview({
				type: "marketplaceData",
				organizationMcps: marketplaceResult.organizationMcps || [],
				marketplaceItems: marketplaceResult.marketplaceItems || [],
				marketplaceInstalledMetadata: marketplaceInstalledMetadata || { project: {}, global: {} },
				errors: marketplaceResult.errors,
			})
		} catch (error) {
			outputError("Failed to fetch marketplace data:", error)

			// Send empty data on error to prevent UI from hanging
			this.postMessageToWebview({
				type: "marketplaceData",
				organizationMcps: [],
				marketplaceItems: [],
				marketplaceInstalledMetadata: { project: {}, global: {} },
				errors: [error instanceof Error ? error.message : String(error)],
			})

			// Show user-friendly error notification for network issues
			if (error instanceof Error && error.message.includes("timeout")) {
				vscode.window.showWarningMessage(
					"Marketplace data could not be loaded due to network restrictions. Core functionality remains available.",
				)
			}
		}
	}

	/**
	 * Merges allowed commands from global state and workspace configuration
	 * with proper validation and deduplication
	 */
	private mergeAllowedCommands(globalStateCommands?: string[]): string[] {
		return this.mergeCommandLists("allowedCommands", "allowed", globalStateCommands)
	}

	/**
	 * Merges denied commands from global state and workspace configuration
	 * with proper validation and deduplication
	 */
	private mergeDeniedCommands(globalStateCommands?: string[]): string[] {
		return this.mergeCommandLists("deniedCommands", "denied", globalStateCommands)
	}

	/**
	 * Common utility for merging command lists from global state and workspace configuration.
	 * Implements the Command Denylist feature's merging strategy with proper validation.
	 *
	 * @param configKey - VSCode workspace configuration key
	 * @param commandType - Type of commands for error logging
	 * @param globalStateCommands - Commands from global state
	 * @returns Merged and deduplicated command list
	 */
	private mergeCommandLists(
		configKey: "allowedCommands" | "deniedCommands",
		commandType: "allowed" | "denied",
		globalStateCommands?: string[],
	): string[] {
		try {
			// Validate and sanitize global state commands
			const validGlobalCommands = Array.isArray(globalStateCommands)
				? globalStateCommands.filter((cmd) => typeof cmd === "string" && cmd.trim().length > 0)
				: []

			// Get workspace configuration commands
			const workspaceCommands = vscode.workspace.getConfiguration(Package.name).get<string[]>(configKey) || []

			// Validate and sanitize workspace commands
			const validWorkspaceCommands = Array.isArray(workspaceCommands)
				? workspaceCommands.filter((cmd) => typeof cmd === "string" && cmd.trim().length > 0)
				: []

			// Combine and deduplicate commands
			// Global state takes precedence over workspace configuration
			const mergedCommands = [...new Set([...validGlobalCommands, ...validWorkspaceCommands])]

			return mergedCommands
		} catch (error) {
			outputError(`Error merging ${commandType} commands:`, error)
			// Return empty array as fallback to prevent crashes
			return []
		}
	}

	async getStateToPostToWebview(): Promise<ExtensionState> {
		// Ensure the store is initialized before reading task history
		await this.taskHistoryStore.initialized

		const {
			apiConfiguration,
			lastShownAnnouncementId,
			customInstructions,
			alwaysAllowReadOnly,
			alwaysAllowReadOnlyOutsideWorkspace,
			alwaysAllowWrite,
			alwaysAllowWriteOutsideWorkspace,
			alwaysAllowWriteProtected,
			alwaysAllowBrowser,
			alwaysAllowExecute,
			allowedCommands,
			deniedCommands,
			alwaysAllowMcp,
			alwaysAllowModeSwitch,
			alwaysAllowSubtasks,
			allowedMaxRequests,
			allowedMaxCost,
			autoCondenseContext,
			autoCondenseContextPercent,
			soundEnabled,
			ttsEnabled,
			ttsSpeed,
			enableCheckpoints,
			checkpointTimeout,
			taskHistory,
			soundVolume,
			writeDelayMs,
			terminalShellIntegrationTimeout,
			terminalShellIntegrationDisabled,
			terminalCommandDelay,
			terminalPowershellCounter,
			terminalZshClearEolMark,
			terminalZshOhMy,
			terminalZshP10k,
			terminalZdotdir,
			mcpEnabled,
			currentApiConfigName,
			listApiConfigMeta,
			pinnedApiConfigs,
			mode,
			customModePrompts,
			customSupportPrompts,
			enhancementApiConfigId,
			autoApprovalEnabled,
			customModes,
			experiments,
			maxOpenTabsContext,
			maxWorkspaceFiles,
			disabledTools,
			telemetrySetting,
			showShoferIgnoredFiles,
			enableSubfolderRules,
			useAgentRules,
			language,
			maxImageFileSize,
			maxTotalImageSize,
			historyPreviewCollapsed,
			reasoningBlockCollapsed,
			enterBehavior,
			cloudUserInfo,
			cloudIsAuthenticated,
			sharingEnabled,
			publicSharingEnabled,
			organizationAllowList,
			organizationSettingsVersion,
			customCondensingPrompt,
			codebaseIndexConfig,
			codebaseIndexModels,
			profileThresholds,
			alwaysAllowFollowupQuestions,
			followupAutoApproveTimeoutMs,
			includeDiagnosticMessages,
			maxDiagnosticMessages,
			includeTaskHistoryInEnhance,
			includeCurrentTime,
			includeCurrentCost,
			maxGitStatusFiles,
			defaultCostLimit,
			taskSyncEnabled,
			imageGenerationProvider,
			openRouterImageApiKey,
			openRouterImageGenerationSelectedModel,
			lockApiConfigAcrossModes,
			assistantAgentEnabled,
			assistantAgentApiConfigId,
			assistantAgentMaxContextTokens,
			assistantAgentContextFillThreshold,
		} = await this.getState()

		let cloudOrganizations: any[] = []

		const telemetryKey = process.env.POSTHOG_API_KEY
		const machineId = vscode.env.machineId
		// H8: Build merged commands from cache when settings haven't changed.
		// mergeAllowedCommands / mergeDeniedCommands deduplicate and merge
		// global-state + workspace-config arrays — a pure function of the
		// input lists that changes only when the underlying settings change.
		const gen = this._settingsGeneration
		if (this._cachedMergedGen !== gen) {
			this._cachedMergedAllowed = this.mergeAllowedCommands(allowedCommands)
			this._cachedMergedDenied = this.mergeDeniedCommands(deniedCommands)
			this._cachedMergedGen = gen
		}
		const mergedAllowedCommands = this._cachedMergedAllowed
		const mergedDeniedCommands = this._cachedMergedDenied
		const cwd = this.cwd
		const currentTask = this.getCurrentTask()

		return {
			version: this.context.extension?.packageJSON?.version ?? "",
			apiConfiguration,
			customInstructions,
			alwaysAllowReadOnly: alwaysAllowReadOnly ?? false,
			alwaysAllowReadOnlyOutsideWorkspace: alwaysAllowReadOnlyOutsideWorkspace ?? false,
			alwaysAllowWrite: alwaysAllowWrite ?? false,
			alwaysAllowWriteOutsideWorkspace: alwaysAllowWriteOutsideWorkspace ?? false,
			alwaysAllowWriteProtected: alwaysAllowWriteProtected ?? false,
			alwaysAllowBrowser: alwaysAllowBrowser ?? false,
			alwaysAllowExecute: alwaysAllowExecute ?? false,
			alwaysAllowMcp: alwaysAllowMcp ?? false,
			alwaysAllowModeSwitch: alwaysAllowModeSwitch ?? false,
			alwaysAllowSubtasks: alwaysAllowSubtasks ?? false,
			allowedMaxRequests,
			allowedMaxCost,
			autoCondenseContext: autoCondenseContext ?? true,
			autoCondenseContextPercent: autoCondenseContextPercent ?? 90,
			uriScheme: vscode.env.uriScheme,
			currentTaskId: currentTask?.taskId,
			currentTaskItem: (() => {
				if (!currentTask?.taskId) return undefined
				const stored = this.taskHistoryStore.get(currentTask.taskId)
				// Resolve the live cost limit by walking up to the root task,
				// since the limit lives only on the root and the persisted
				// HistoryItem may not reflect a freshly-seeded default until the
				// first save. Fall back to the persisted value otherwise.
				let liveCostLimit = stored?.costLimit
				let cursor: Task | undefined = currentTask
				while (cursor) {
					if (cursor.costLimit) {
						liveCostLimit = cursor.costLimit
						break
					}
					cursor = cursor.parentTask
				}
				return stored ? { ...stored, costLimit: liveCostLimit } : undefined
			})(),
			shoferMessages: (() => {
				const msgs = currentTask?.shoferMessages || []
				// LLM hint: diagnostic for the task-switch home-screen flash.
				// Fires when we are about to broadcast an empty messages array
				// for a task that hasn't completed history preload yet — this
				// is exactly the state that renders the home screen for one
				// frame mid-task-switch. With the preload-before-publish fix
				// in `createTaskWithHistoryItem`, this should never fire under
				// normal task-switch flows. If it does, the stack trace
				// identifies the offending state-push caller. Gated on DEBUG
				// to keep release logs clean.
				if (
					process.env.DEBUG &&
					currentTask &&
					msgs.length === 0 &&
					currentTask.isHistoryPreloaded === false &&
					currentTask.metadata?.task !== undefined
				) {
					this.debug(
						`[home-screen-flash] postStateToWebview about to send shoferMessages=[] for ` +
							`unloaded history task ${currentTask.taskId}.${currentTask.instanceId} ` +
							`(isInitialized=${currentTask.isInitialized}). ` +
							`Caller: ${new Error().stack?.split("\n").slice(2, 6).join(" | ")}`,
					)
				}
				return msgs
			})(),
			currentTaskTodos: currentTask?.todoList || [],
			messageQueue: currentTask?.messageQueueService?.messages ?? [],
			taskHistory: this.taskHistoryStore.getAll().filter((item: HistoryItem) => item.ts && item.task),
			soundEnabled: soundEnabled ?? false,
			ttsEnabled: ttsEnabled ?? false,
			ttsSpeed: ttsSpeed ?? 1.0,
			enableCheckpoints: enableCheckpoints ?? true,
			checkpointTimeout: checkpointTimeout ?? DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
			shouldShowAnnouncement:
				telemetrySetting !== "unset" && lastShownAnnouncementId !== this.latestAnnouncementId,
			allowedCommands: mergedAllowedCommands,
			deniedCommands: mergedDeniedCommands,
			soundVolume: soundVolume ?? 0.5,
			writeDelayMs: writeDelayMs ?? DEFAULT_WRITE_DELAY_MS,
			terminalShellIntegrationTimeout: terminalShellIntegrationTimeout ?? Terminal.defaultShellIntegrationTimeout,
			terminalShellIntegrationDisabled: terminalShellIntegrationDisabled ?? true,
			terminalCommandDelay: terminalCommandDelay ?? 0,
			terminalPowershellCounter: terminalPowershellCounter ?? false,
			terminalZshClearEolMark: terminalZshClearEolMark ?? true,
			terminalZshOhMy: terminalZshOhMy ?? false,
			terminalZshP10k: terminalZshP10k ?? false,
			terminalZdotdir: terminalZdotdir ?? false,
			mcpEnabled: mcpEnabled ?? true,
			currentApiConfigName: currentApiConfigName ?? "default",
			listApiConfigMeta: listApiConfigMeta ?? [],
			pinnedApiConfigs: pinnedApiConfigs ?? {},
			mode: (currentTask as any)?._taskMode || mode || defaultModeSlug,
			customModePrompts: customModePrompts ?? {},
			customSupportPrompts: customSupportPrompts ?? {},
			enhancementApiConfigId,
			autoApprovalEnabled: autoApprovalEnabled ?? false,
			customModes,
			experiments: experiments ?? experimentDefault,
			mcpServers: this.mcpHub?.getAllServers() ?? [],
			maxOpenTabsContext: maxOpenTabsContext ?? 20,
			maxWorkspaceFiles: maxWorkspaceFiles ?? 200,
			cwd,
			disabledTools,
			telemetrySetting,
			telemetryKey,
			machineId,
			showShoferIgnoredFiles: showShoferIgnoredFiles ?? false,
			enableSubfolderRules: enableSubfolderRules ?? false,
			useAgentRules: useAgentRules ?? true,
			language: language ?? formatLanguage(vscode.env.language),
			renderContext: this.renderContext,
			maxImageFileSize: maxImageFileSize ?? 5,
			maxTotalImageSize: maxTotalImageSize ?? 20,
			settingsImportedAt: this.settingsImportedAt,
			historyPreviewCollapsed: historyPreviewCollapsed ?? false,
			reasoningBlockCollapsed: reasoningBlockCollapsed ?? true,
			enterBehavior: enterBehavior ?? "send",
			cloudUserInfo,
			cloudIsAuthenticated: cloudIsAuthenticated ?? false,
			cloudAuthSkipModel: this.context.globalState.get<boolean>("shofer-auth-skip-model") ?? false,
			cloudOrganizations,
			sharingEnabled: sharingEnabled ?? false,
			publicSharingEnabled: publicSharingEnabled ?? false,
			organizationAllowList,
			organizationSettingsVersion,
			customCondensingPrompt,
			codebaseIndexModels: codebaseIndexModels ?? EMBEDDING_MODEL_PROFILES,
			codebaseIndexConfig: {
				codebaseIndexEnabled: codebaseIndexConfig?.codebaseIndexEnabled ?? false,
				codebaseIndexQdrantUrl: codebaseIndexConfig?.codebaseIndexQdrantUrl ?? "http://localhost:6333",
				codebaseIndexEmbedderProvider: codebaseIndexConfig?.codebaseIndexEmbedderProvider ?? "openai",
				codebaseIndexEmbedderBaseUrl: codebaseIndexConfig?.codebaseIndexEmbedderBaseUrl ?? "",
				codebaseIndexEmbedderModelId: codebaseIndexConfig?.codebaseIndexEmbedderModelId ?? "",
				codebaseIndexEmbedderModelDimension: codebaseIndexConfig?.codebaseIndexEmbedderModelDimension ?? 1536,
				codebaseIndexOpenAiCompatibleBaseUrl: codebaseIndexConfig?.codebaseIndexOpenAiCompatibleBaseUrl,
				codebaseIndexSearchMaxResults: codebaseIndexConfig?.codebaseIndexSearchMaxResults,
				codebaseIndexSearchMinScore: codebaseIndexConfig?.codebaseIndexSearchMinScore,
				codebaseIndexBedrockRegion: codebaseIndexConfig?.codebaseIndexBedrockRegion,
				codebaseIndexBedrockProfile: codebaseIndexConfig?.codebaseIndexBedrockProfile,
				codebaseIndexOpenRouterSpecificProvider: codebaseIndexConfig?.codebaseIndexOpenRouterSpecificProvider,
				codebaseIndexGitEnabled: codebaseIndexConfig?.codebaseIndexGitEnabled ?? false,
				codebaseIndexGitMaxHistoryDays: codebaseIndexConfig?.codebaseIndexGitMaxHistoryDays ?? 365,
				codebaseIndexGitMaxCommits: codebaseIndexConfig?.codebaseIndexGitMaxCommits ?? 10000,
				codebaseIndexGitPollIntervalMinutes: codebaseIndexConfig?.codebaseIndexGitPollIntervalMinutes ?? 5,
				codebaseIndexGitSearchMinScore: codebaseIndexConfig?.codebaseIndexGitSearchMinScore ?? 0.4,
				codebaseIndexGitSearchMaxResults: codebaseIndexConfig?.codebaseIndexGitSearchMaxResults ?? 20,
				codebaseIndexGitBranch: codebaseIndexConfig?.codebaseIndexGitBranch ?? "master",
			},
			// Only set mdmCompliant if there's an actual MDM policy
			// undefined means no MDM policy, true means compliant, false means non-compliant
			mdmCompliant: undefined,
			profileThresholds: profileThresholds ?? {},
			cloudApiUrl: "https://app.shofer.dev",
			hasOpenedModeSelector: this.getGlobalState("hasOpenedModeSelector") ?? false,
			lockApiConfigAcrossModes: lockApiConfigAcrossModes ?? false,
			alwaysAllowFollowupQuestions: alwaysAllowFollowupQuestions ?? false,
			followupAutoApproveTimeoutMs: followupAutoApproveTimeoutMs ?? 60000,
			includeDiagnosticMessages: includeDiagnosticMessages ?? true,
			maxDiagnosticMessages: maxDiagnosticMessages ?? 50,
			includeTaskHistoryInEnhance: includeTaskHistoryInEnhance ?? true,
			includeCurrentTime: includeCurrentTime ?? true,
			includeCurrentCost: includeCurrentCost ?? true,
			maxGitStatusFiles: maxGitStatusFiles ?? 0,
			defaultCostLimit,
			taskSyncEnabled,
			imageGenerationProvider,
			openRouterImageApiKey,
			openRouterImageGenerationSelectedModel,
			assistantAgentEnabled: assistantAgentEnabled ?? true,
			assistantAgentApiConfigId,
			assistantAgentMaxContextTokens,
			assistantAgentContextFillThreshold,
			openAiCodexIsAuthenticated: await (async () => {
				try {
					const { openAiCodexOAuthManager } = await import("../../integrations/openai-codex/oauth")
					return await openAiCodexOAuthManager.isAuthenticated()
				} catch {
					return false
				}
			})(),
			debug: vscode.workspace.getConfiguration(Package.name).get<boolean>("debug", false),
		}
	}

	/**
	 * Storage
	 * https://dev.to/kompotkot/how-to-use-secretstorage-in-your-vscode-extensions-2hco
	 * https://www.eliostruyf.com/devhack-code-extension-storage-options/
	 */

	async getState(): Promise<
		Omit<
			ExtensionState,
			"shoferMessages" | "renderContext" | "hasOpenedModeSelector" | "version" | "shouldShowAnnouncement"
		>
	> {
		const stateValues = this.contextProxy.getValues()
		const customModes = await this.customModesManager.getCustomModes()

		// Determine apiProvider with the same logic as before, while filtering retired providers.
		const apiProvider: ProviderName =
			stateValues.apiProvider && !isRetiredProvider(stateValues.apiProvider)
				? stateValues.apiProvider
				: "anthropic"

		// Build the apiConfiguration object combining state values and secrets.
		const providerSettings = this.contextProxy.getProviderSettings()

		// Ensure apiProvider is set properly if not already in state
		if (!providerSettings.apiProvider) {
			providerSettings.apiProvider = apiProvider
		}

		let organizationAllowList = ORGANIZATION_ALLOW_ALL

		try {
			organizationAllowList = await Promise.resolve({ allowAll: true, providers: {} } as any)
		} catch (error) {
			outputError(
				`[getState] failed to get organization allow list: ${error instanceof Error ? error.message : String(error)}`,
			)
		}

		let cloudUserInfo: any = null

		try {
			cloudUserInfo = null
		} catch (error) {
			outputError(
				`[getState] failed to get cloud user info: ${error instanceof Error ? error.message : String(error)}`,
			)
		}

		let cloudIsAuthenticated: boolean = false

		try {
			cloudIsAuthenticated = false
		} catch (error) {
			outputError(
				`[getState] failed to get cloud authentication state: ${error instanceof Error ? error.message : String(error)}`,
			)
		}

		let sharingEnabled: boolean = false

		try {
			sharingEnabled = await Promise.resolve(false)
		} catch (error) {
			outputError(
				`[getState] failed to get sharing enabled state: ${error instanceof Error ? error.message : String(error)}`,
			)
		}

		let publicSharingEnabled: boolean = false

		try {
			publicSharingEnabled = await Promise.resolve(false)
		} catch (error) {
			outputError(
				`[getState] failed to get public sharing enabled state: ${error instanceof Error ? error.message : String(error)}`,
			)
		}

		let organizationSettingsVersion: number = -1

		try {
			organizationSettingsVersion = -1
		} catch (error) {
			outputError(
				`[getState] failed to get organization settings version: ${error instanceof Error ? error.message : String(error)}`,
			)
		}

		let taskSyncEnabled: boolean = false

		try {
			taskSyncEnabled = false
		} catch (error) {
			outputError(
				`[getState] failed to get task sync enabled state: ${error instanceof Error ? error.message : String(error)}`,
			)
		}

		// Return the same structure as before.
		return {
			apiConfiguration: providerSettings,
			lastShownAnnouncementId: stateValues.lastShownAnnouncementId,
			customInstructions: stateValues.customInstructions,
			apiModelId: stateValues.apiModelId,
			alwaysAllowReadOnly: stateValues.alwaysAllowReadOnly ?? false,
			alwaysAllowReadOnlyOutsideWorkspace: stateValues.alwaysAllowReadOnlyOutsideWorkspace ?? false,
			alwaysAllowWrite: stateValues.alwaysAllowWrite ?? false,
			alwaysAllowBrowser: stateValues.alwaysAllowBrowser ?? false,
			alwaysAllowWriteOutsideWorkspace: stateValues.alwaysAllowWriteOutsideWorkspace ?? false,
			alwaysAllowWriteProtected: stateValues.alwaysAllowWriteProtected ?? false,
			alwaysAllowExecute: stateValues.alwaysAllowExecute ?? false,
			alwaysAllowMcp: stateValues.alwaysAllowMcp ?? false,
			alwaysAllowUncategorized: stateValues.alwaysAllowUncategorized ?? false,
			alwaysAllowModeSwitch: stateValues.alwaysAllowModeSwitch ?? false,
			alwaysAllowSubtasks: stateValues.alwaysAllowSubtasks ?? false,
			alwaysAllowFollowupQuestions: stateValues.alwaysAllowFollowupQuestions ?? false,
			followupAutoApproveTimeoutMs: stateValues.followupAutoApproveTimeoutMs ?? 60000,
			diagnosticsEnabled: stateValues.diagnosticsEnabled ?? true,
			allowedMaxRequests: stateValues.allowedMaxRequests,
			allowedMaxCost: stateValues.allowedMaxCost,
			autoCondenseContext: stateValues.autoCondenseContext ?? true,
			autoCondenseContextPercent: stateValues.autoCondenseContextPercent ?? 90,
			taskHistory: this.taskHistoryStore.getAll(),
			allowedCommands: stateValues.allowedCommands,
			deniedCommands: stateValues.deniedCommands,
			soundEnabled: stateValues.soundEnabled ?? false,
			ttsEnabled: stateValues.ttsEnabled ?? false,
			ttsSpeed: stateValues.ttsSpeed ?? 1.0,
			enableCheckpoints: stateValues.enableCheckpoints ?? true,
			checkpointTimeout: stateValues.checkpointTimeout ?? DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
			soundVolume: stateValues.soundVolume,
			writeDelayMs: stateValues.writeDelayMs ?? DEFAULT_WRITE_DELAY_MS,
			terminalShellIntegrationTimeout:
				stateValues.terminalShellIntegrationTimeout ?? Terminal.defaultShellIntegrationTimeout,
			terminalShellIntegrationDisabled: stateValues.terminalShellIntegrationDisabled ?? true,
			terminalCommandDelay: stateValues.terminalCommandDelay ?? 0,
			terminalPowershellCounter: stateValues.terminalPowershellCounter ?? false,
			terminalZshClearEolMark: stateValues.terminalZshClearEolMark ?? true,
			terminalZshOhMy: stateValues.terminalZshOhMy ?? false,
			terminalZshP10k: stateValues.terminalZshP10k ?? false,
			terminalZdotdir: stateValues.terminalZdotdir ?? false,
			mode: (this.getCurrentTask() as any)?._taskMode || stateValues.mode || defaultModeSlug,
			language: stateValues.language ?? formatLanguage(vscode.env.language),
			mcpEnabled: stateValues.mcpEnabled ?? true,
			mcpServers: this.mcpHub?.getAllServers() ?? [],
			currentApiConfigName: stateValues.currentApiConfigName ?? "default",
			listApiConfigMeta: stateValues.listApiConfigMeta ?? [],
			pinnedApiConfigs: stateValues.pinnedApiConfigs ?? {},
			modeApiConfigs: stateValues.modeApiConfigs ?? ({} as Record<Mode, string>),
			customModePrompts: stateValues.customModePrompts ?? {},
			customSupportPrompts: stateValues.customSupportPrompts ?? {},
			enhancementApiConfigId: stateValues.enhancementApiConfigId,
			experiments: stateValues.experiments ?? experimentDefault,
			autoApprovalEnabled: stateValues.autoApprovalEnabled ?? false,
			customModes,
			maxOpenTabsContext: stateValues.maxOpenTabsContext ?? 20,
			maxWorkspaceFiles: stateValues.maxWorkspaceFiles ?? 200,
			disabledTools: stateValues.disabledTools,
			telemetrySetting: stateValues.telemetrySetting || "unset",
			showShoferIgnoredFiles: stateValues.showShoferIgnoredFiles ?? false,
			enableSubfolderRules: stateValues.enableSubfolderRules ?? false,
			useAgentRules: stateValues.useAgentRules ?? true,
			maxImageFileSize: stateValues.maxImageFileSize ?? 5,
			maxTotalImageSize: stateValues.maxTotalImageSize ?? 20,
			historyPreviewCollapsed: stateValues.historyPreviewCollapsed ?? false,
			reasoningBlockCollapsed: stateValues.reasoningBlockCollapsed ?? true,
			enterBehavior: stateValues.enterBehavior ?? "send",
			cloudUserInfo,
			cloudIsAuthenticated,
			sharingEnabled,
			publicSharingEnabled,
			organizationAllowList,
			organizationSettingsVersion,
			customCondensingPrompt: stateValues.customCondensingPrompt,
			codebaseIndexModels: stateValues.codebaseIndexModels ?? EMBEDDING_MODEL_PROFILES,
			codebaseIndexConfig: {
				codebaseIndexEnabled: stateValues.codebaseIndexConfig?.codebaseIndexEnabled ?? false,
				codebaseIndexQdrantUrl:
					stateValues.codebaseIndexConfig?.codebaseIndexQdrantUrl ?? "http://localhost:6333",
				codebaseIndexEmbedderProvider:
					stateValues.codebaseIndexConfig?.codebaseIndexEmbedderProvider ?? "openai",
				codebaseIndexEmbedderBaseUrl: stateValues.codebaseIndexConfig?.codebaseIndexEmbedderBaseUrl ?? "",
				codebaseIndexEmbedderModelId: stateValues.codebaseIndexConfig?.codebaseIndexEmbedderModelId ?? "",
				codebaseIndexEmbedderModelDimension:
					stateValues.codebaseIndexConfig?.codebaseIndexEmbedderModelDimension,
				codebaseIndexOpenAiCompatibleBaseUrl:
					stateValues.codebaseIndexConfig?.codebaseIndexOpenAiCompatibleBaseUrl,
				codebaseIndexSearchMaxResults: stateValues.codebaseIndexConfig?.codebaseIndexSearchMaxResults,
				codebaseIndexSearchMinScore: stateValues.codebaseIndexConfig?.codebaseIndexSearchMinScore,
				codebaseIndexBedrockRegion: stateValues.codebaseIndexConfig?.codebaseIndexBedrockRegion,
				codebaseIndexBedrockProfile: stateValues.codebaseIndexConfig?.codebaseIndexBedrockProfile,
				codebaseIndexOpenRouterSpecificProvider:
					stateValues.codebaseIndexConfig?.codebaseIndexOpenRouterSpecificProvider,
				codebaseIndexGitEnabled: stateValues.codebaseIndexConfig?.codebaseIndexGitEnabled ?? false,
				codebaseIndexGitMaxHistoryDays: stateValues.codebaseIndexConfig?.codebaseIndexGitMaxHistoryDays ?? 365,
				codebaseIndexGitMaxCommits: stateValues.codebaseIndexConfig?.codebaseIndexGitMaxCommits ?? 10000,
				codebaseIndexGitPollIntervalMinutes:
					stateValues.codebaseIndexConfig?.codebaseIndexGitPollIntervalMinutes ?? 5,
				codebaseIndexGitSearchMinScore: stateValues.codebaseIndexConfig?.codebaseIndexGitSearchMinScore ?? 0.4,
				codebaseIndexGitSearchMaxResults:
					stateValues.codebaseIndexConfig?.codebaseIndexGitSearchMaxResults ?? 20,
				codebaseIndexGitBranch: stateValues.codebaseIndexConfig?.codebaseIndexGitBranch ?? "master",
			},
			profileThresholds: stateValues.profileThresholds ?? {},
			lockApiConfigAcrossModes: this.context.workspaceState.get("lockApiConfigAcrossModes", false),
			includeDiagnosticMessages: stateValues.includeDiagnosticMessages ?? true,
			maxDiagnosticMessages: stateValues.maxDiagnosticMessages ?? 50,
			includeTaskHistoryInEnhance: stateValues.includeTaskHistoryInEnhance ?? true,
			includeCurrentTime: stateValues.includeCurrentTime ?? true,
			includeCurrentCost: stateValues.includeCurrentCost ?? true,
			maxGitStatusFiles: stateValues.maxGitStatusFiles ?? 0,
			defaultCostLimit: stateValues.defaultCostLimit,
			taskSyncEnabled,
			imageGenerationProvider: stateValues.imageGenerationProvider,
			openRouterImageApiKey: stateValues.openRouterImageApiKey,
			openRouterImageGenerationSelectedModel: stateValues.openRouterImageGenerationSelectedModel,
			assistantAgentEnabled: stateValues.assistantAgentEnabled,
			assistantAgentApiConfigId: stateValues.assistantAgentApiConfigId,
			assistantAgentMaxContextTokens: stateValues.assistantAgentMaxContextTokens,
			assistantAgentContextFillThreshold: stateValues.assistantAgentContextFillThreshold,
		}
	}

	/**
	 * Updates a task in the task history and optionally broadcasts the updated history to the webview.
	 * Now delegates to TaskHistoryStore for per-task file persistence.
	 *
	 * @param item The history item to update or add
	 * @param options.broadcast Whether to broadcast the updated history to the webview (default: true)
	 * @returns The updated task history array
	 */
	async updateTaskHistory(item: HistoryItem, options: { broadcast?: boolean } = {}): Promise<HistoryItem[]> {
		const { broadcast = true } = options

		const history = await this.taskHistoryStore.upsert(item)
		this.recentTasksCache = undefined

		// Broadcast the updated history to the webview if requested.
		// Prefer per-item updates to avoid repeatedly cloning/sending the full history.
		if (broadcast && this.isViewLaunched) {
			const updatedItem = this.taskHistoryStore.get(item.id) ?? item
			await this.postMessageToWebview({ type: "taskHistoryItemUpdated", taskHistoryItem: updatedItem })
		}

		return history
	}

	/**
	 * Schedule a debounced write-through of task history to globalState.
	 * Only used for backward compatibility during the transition period.
	 * Per-task files are authoritative; globalState is the downgrade fallback.
	 */
	private scheduleGlobalStateWriteThrough(): void {
		if (this.globalStateWriteThroughTimer) {
			clearTimeout(this.globalStateWriteThroughTimer)
		}

		this.globalStateWriteThroughTimer = setTimeout(async () => {
			this.globalStateWriteThroughTimer = null
			try {
				const items = this.taskHistoryStore.getAll()
				await this.updateGlobalState("taskHistory", items)
			} catch (err) {
				this.debug(
					`[scheduleGlobalStateWriteThrough] Failed: ${err instanceof Error ? err.message : String(err)}`,
				)
			}
		}, ShoferProvider.GLOBAL_STATE_WRITE_THROUGH_DEBOUNCE_MS)
	}

	/**
	 * Flush any pending debounced globalState write-through immediately.
	 */
	private flushGlobalStateWriteThrough(): void {
		if (this.globalStateWriteThroughTimer) {
			clearTimeout(this.globalStateWriteThroughTimer)
			this.globalStateWriteThroughTimer = null
		}

		const items = this.taskHistoryStore.getAll()
		this.updateGlobalState("taskHistory", items).catch((err) => {
			this.debug(`[flushGlobalStateWriteThrough] Failed: ${err instanceof Error ? err.message : String(err)}`)
		})
	}

	/**
	 * Broadcasts a task history update to the webview.
	 * This sends a lightweight message with just the task history, rather than the full state.
	 * @param history The task history to broadcast (if not provided, reads from the store)
	 */
	public async broadcastTaskHistoryUpdate(history?: HistoryItem[]): Promise<void> {
		if (!this.isViewLaunched) {
			return
		}

		const taskHistory = history ?? this.taskHistoryStore.getAll()

		// Sort and filter the history the same way as getStateToPostToWebview
		const sortedHistory = taskHistory
			.filter((item: HistoryItem) => item.ts && item.task)
			.sort((a: HistoryItem, b: HistoryItem) => (b.createdAt ?? b.ts) - (a.createdAt ?? a.ts))

		await this.postMessageToWebview({
			type: "taskHistoryUpdated",
			taskHistory: sortedHistory,
		})
	}

	// ContextProxy

	// @deprecated - Use `ContextProxy#setValue` instead.
	private async updateGlobalState<K extends keyof GlobalState>(key: K, value: GlobalState[K]) {
		await this.contextProxy.setValue(key, value)
	}

	// @deprecated - Use `ContextProxy#getValue` instead.
	private getGlobalState<K extends keyof GlobalState>(key: K) {
		return this.contextProxy.getValue(key)
	}

	public async setValue<K extends keyof ShoferSettings>(key: K, value: ShoferSettings[K]) {
		await this.contextProxy.setValue(key, value)
	}

	public getValue<K extends keyof ShoferSettings>(key: K) {
		return this.contextProxy.getValue(key)
	}

	public getValues() {
		return this.contextProxy.getValues()
	}

	public async setValues(values: ShoferSettings) {
		await this.contextProxy.setValues(values)
	}

	// dev

	async resetState() {
		const answer = await vscode.window.showInformationMessage(
			t("common:confirmation.reset_state"),
			{ modal: true },
			t("common:answers.yes"),
		)

		if (answer !== t("common:answers.yes")) {
			return
		}

		await this.contextProxy.resetAllState()
		await this.providerSettingsManager.resetAllConfigs()
		await this.customModesManager.resetCustomModes()
		await this.removeShoferFromStack()
		await this.postStateToWebview()
		await this.postMessageToWebview({ type: "action", action: "chatButtonClicked" })
	}

	// logging

	public log(message: string) {
		// `this.outputChannel` is the same `OutputChannel` instance that
		// activate() registers as the shared global channel via
		// `setExtensionOutputChannel`, so calling both `appendLine` here and
		// `outputLog` would double every line in the "Shofer" output panel.
		// The provider owns the channel directly; `outputLog` is the fallback
		// for utility modules that don't have a provider handle.
		this.outputChannel.appendLine(message)
	}

	/** Debug-level logging: only emitted when process.env.DEBUG is set. */
	public debug(message: string) {
		if (process.env.DEBUG) {
			this.outputChannel.appendLine(message)
		}
	}

	// getters

	public get workspaceTracker(): WorkspaceTracker | undefined {
		return this._workspaceTracker
	}

	get viewLaunched() {
		return this.isViewLaunched
	}

	get messages() {
		return this.getCurrentTask()?.shoferMessages || []
	}

	public getMcpHub(): McpHub | undefined {
		return this.mcpHub
	}

	public getSkillsManager(): SkillsManager | undefined {
		return this.skillsManager
	}

	/**
	 * Check if the current state is compliant with MDM policy.
	 * MDM service has been removed; always returns true.
	 * @returns true
	 */
	public checkMdmCompliance(): boolean {
		return true
	}

	/**
	 * Gets the CodeIndexManager for the current active workspace
	 * @returns CodeIndexManager instance for the current workspace or the default one
	 */
	public getCurrentWorkspaceCodeIndexManager(): CodeIndexManager | undefined {
		return CodeIndexManager.getInstance(this.context)
	}

	/**
	 * Updates the code index status subscription to listen to the current workspace manager
	 */
	private updateCodeIndexStatusSubscription(): void {
		// Get the current workspace manager
		const currentManager = this.getCurrentWorkspaceCodeIndexManager()

		// If the manager hasn't changed, no need to update subscription
		if (currentManager === this.codeIndexManager) {
			return
		}

		// Dispose the old subscription if it exists
		if (this.codeIndexStatusSubscription) {
			this.codeIndexStatusSubscription.dispose()
			this.codeIndexStatusSubscription = undefined
		}

		// Update the current workspace manager reference
		this.codeIndexManager = currentManager

		// Subscribe to the new manager's progress updates if it exists
		if (currentManager) {
			this.codeIndexStatusSubscription = currentManager.onProgressUpdate((update: IndexProgressUpdate) => {
				// Only send updates if this manager is still the current one
				if (currentManager === this.getCurrentWorkspaceCodeIndexManager()) {
					// Get the full status from the manager to ensure we have all fields correctly formatted
					const fullStatus = currentManager.getCurrentStatus()
					this.postMessageToWebview({
						type: "indexingStatusUpdate",
						values: fullStatus,
					})
				}
			})

			if (this.view) {
				this.webviewDisposables.push(this.codeIndexStatusSubscription)
			}

			// Send initial status for the current workspace
			this.postMessageToWebview({
				type: "indexingStatusUpdate",
				values: currentManager.getCurrentStatus(),
			})
		}
	}

	/**
	 * Updates the git index status subscription to listen to the current workspace manager.
	 * Follows the same pattern as updateCodeIndexStatusSubscription.
	 */
	private updateGitIndexStatusSubscription(): void {
		const currentManager = GitIndexManager.getInstance(this.context)

		if (currentManager === this.gitIndexManager) {
			return
		}

		if (this.gitIndexStatusSubscription) {
			this.gitIndexStatusSubscription.dispose()
			this.gitIndexStatusSubscription = undefined
		}

		this.gitIndexManager = currentManager

		if (currentManager) {
			this.gitIndexStatusSubscription = currentManager.onProgressUpdate(
				(update: {
					systemStatus: string
					message?: string
					indexedCommitCount?: number
					latestCommitHash?: string
				}) => {
					if (currentManager !== GitIndexManager.getInstance(this.context)) {
						return
					}
					this.postMessageToWebview({
						type: "gitIndexingStatusUpdate",
						values: {
							systemStatus: update.systemStatus,
							message: update.message ?? "",
							processedItems: 0,
							totalItems: 0,
							currentItemUnit: "commits",
							workspacePath: currentManager.workspacePath,
							indexedCommitCount: update.indexedCommitCount,
							latestCommitHash: update.latestCommitHash,
						},
					})
				},
			)

			if (this.view) {
				this.webviewDisposables.push(this.gitIndexStatusSubscription)
			}

			// Send initial status
			const status = currentManager.getCurrentStatus()
			this.postMessageToWebview({
				type: "gitIndexingStatusUpdate",
				values: {
					systemStatus: status.systemStatus,
					message: status.message ?? "",
					processedItems: 0,
					totalItems: 0,
					currentItemUnit: "commits",
					workspacePath: currentManager.workspacePath,
					indexedCommitCount: status.indexedCommitCount,
					latestCommitHash: status.latestCommitHash,
				},
			})
		}
	}

	/**
	 * Updates the assistant agent status subscription to push status to the webview.
	 * Follows the same pattern as updateCodeIndexStatusSubscription.
	 */
	private updateAssistantAgentStatusSubscription(): void {
		const currentManager = AssistantAgentManager.getInstance(this.context)

		if (currentManager === this.assistantAgentManager) {
			return
		}

		if (this.assistantAgentStatusSubscription) {
			this.assistantAgentStatusSubscription.dispose()
			this.assistantAgentStatusSubscription = undefined
		}

		this.assistantAgentManager = currentManager

		if (currentManager) {
			const sendStatus = () => {
				if (currentManager !== this.assistantAgentManager) return
				this.postMessageToWebview({
					type: "assistantAgentStatusUpdate",
					text: JSON.stringify({
						state: currentManager.state,
						stateMessage: currentManager.stateMessage,
						isAvailable: currentManager.isAssistantAgentAvailable,
						modelId: currentManager.modelId,
						provider: currentManager.provider,
						contextUsage: currentManager.getContextUsage(),
						contextWindowSource: currentManager.contextWindowSource,
						costSnapshot: currentManager.getCostSnapshot(),
						conversationTurnCount: currentManager.conversationTurnCount,
						pendingQuestionCount: currentManager.pendingQuestionCount,
						contextFiles: currentManager.contextFiles,
					}),
				})
			}

			// Combine state-change and conversation-update subscriptions
			// into a single disposable so both are cleaned up on re-subscribe.
			const stateSubscription = currentManager.onStateChange(() => sendStatus())
			const convSubscription = currentManager.onConversationUpdate(() => sendStatus())
			this.assistantAgentStatusSubscription = vscode.Disposable.from(stateSubscription, convSubscription)

			if (this.view) {
				this.webviewDisposables.push(this.assistantAgentStatusSubscription)
			}

			sendStatus()
		}
	}

	/**
	 * Pushes a fresh Assistant Agent status snapshot to the webview. Used by the
	 * webview status badge to populate itself on mount, since the periodic
	 * subscription only fires on state/conversation changes.
	 */
	public sendAssistantAgentStatus(): void {
		const manager = this.assistantAgentManager ?? AssistantAgentManager.getInstance(this.context)
		if (!manager) {
			this.postMessageToWebview({
				type: "assistantAgentStatusUpdate",
				text: JSON.stringify({ state: "Standby", isAvailable: false }),
			})
			return
		}
		this.postMessageToWebview({
			type: "assistantAgentStatusUpdate",
			text: JSON.stringify({
				state: manager.state,
				stateMessage: manager.stateMessage,
				isAvailable: manager.isAssistantAgentAvailable,
				modelId: manager.modelId,
				provider: manager.provider,
				contextUsage: manager.getContextUsage(),
				contextWindowSource: manager.contextWindowSource,
				costSnapshot: manager.getCostSnapshot(),
				conversationTurnCount: manager.conversationTurnCount,
				pendingQuestionCount: manager.pendingQuestionCount,
				contextFiles: manager.contextFiles,
			}),
		})
	}

	/**
	 * TaskProviderLike, TelemetryPropertiesProvider
	 */

	public getCurrentTask(): Task | undefined {
		if (this.shoferStack.length === 0) {
			return undefined
		}

		return this.shoferStack[this.shoferStack.length - 1]
	}

	public getRecentTasks(): string[] {
		if (this.recentTasksCache) {
			return this.recentTasksCache
		}

		const history = this.taskHistoryStore.getAll()
		const workspaceTasks: HistoryItem[] = []

		for (const item of history) {
			if (!item.ts || !item.task || item.workspace !== this.cwd) {
				continue
			}

			workspaceTasks.push(item)
		}

		if (workspaceTasks.length === 0) {
			this.recentTasksCache = []
			return this.recentTasksCache
		}

		workspaceTasks.sort((a, b) => (b.createdAt ?? b.ts) - (a.createdAt ?? a.ts))
		let recentTaskIds: string[] = []

		if (workspaceTasks.length >= 100) {
			// If we have at least 100 tasks, return tasks from the last 7 days.
			const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000

			for (const item of workspaceTasks) {
				// Stop when we hit tasks older than 7 days.
				if (item.ts < sevenDaysAgo) {
					break
				}

				recentTaskIds.push(item.id)
			}
		} else {
			// Otherwise, return the most recent 100 tasks (or all if less than 100).
			recentTaskIds = workspaceTasks.slice(0, Math.min(100, workspaceTasks.length)).map((item) => item.id)
		}

		this.recentTasksCache = recentTaskIds
		return this.recentTasksCache
	}

	// When initializing a new task, (not from history but from a tool command
	// new_task) there is no need to remove the previous task since the new
	// task is a subtask of the previous one, and when it finishes it is removed
	// from the stack and the caller is resumed in this way we can have a chain
	// of tasks, each one being a sub task of the previous one until the main
	// task is finished.
	public async createTask(
		text?: string,
		images?: string[],
		parentTask?: Task,
		options: CreateTaskOptions = {},
		configuration: ShoferSettings = {},
		cwd?: string,
	): Promise<Task> {
		const openInStack = options.openInStack ?? true
		if (configuration) {
			await this.setValues(configuration)

			if (configuration.allowedCommands) {
				await vscode.workspace
					.getConfiguration(Package.name)
					.update("allowedCommands", configuration.allowedCommands, vscode.ConfigurationTarget.Global)
			}

			if (configuration.deniedCommands) {
				await vscode.workspace
					.getConfiguration(Package.name)
					.update("deniedCommands", configuration.deniedCommands, vscode.ConfigurationTarget.Global)
			}

			if (configuration.commandExecutionTimeout !== undefined) {
				await vscode.workspace
					.getConfiguration(Package.name)
					.update(
						"commandExecutionTimeout",
						configuration.commandExecutionTimeout,
						vscode.ConfigurationTarget.Global,
					)
			}

			if (configuration.currentApiConfigName) {
				await this.setProviderProfile(configuration.currentApiConfigName)
			}

			// Register custom modes so the CustomModesManager knows about them.
			// setValues writes to global state, but the manager overwrites that
			// when it merges .shofermodes + global settings on refresh.  Persisting
			// via updateCustomMode ensures modes survive the merge cycle.
			if (configuration.customModes?.length) {
				for (const mode of configuration.customModes) {
					await this.customModesManager.updateCustomMode(mode.slug, mode)
				}
			}
		}

		const { apiConfiguration, organizationAllowList, enableCheckpoints, checkpointTimeout, experiments } =
			await this.getState()

		// Single-open-task invariant: enforce for user-initiated top-level tasks
		// unless keepCurrentTask is specified (for parallel task creation)
		if (!parentTask && !options.keepCurrentTask) {
			try {
				await this.removeShoferFromStack()
			} catch {
				// Non-fatal
			}
		}

		if (!ProfileValidator.isProfileAllowed(apiConfiguration, organizationAllowList)) {
			throw new OrganizationAllowListViolationError(t("common:errors.violated_organization_allowlist"))
		}

		const task = new Task({
			provider: this,
			apiConfiguration,
			enableCheckpoints,
			checkpointTimeout,
			consecutiveMistakeLimit: apiConfiguration.consecutiveMistakeLimit,
			task: text,
			images,
			experiments,
			rootTask: parentTask
				? (parentTask.rootTask ?? parentTask)
				: this.shoferStack.length > 0
					? this.shoferStack[0]
					: undefined,
			parentTask,
			taskNumber: this.shoferStack.length + 1,
			onCreated: this.taskCreationCallback,
			initialTodos: options.initialTodos,
			// Ensure this task is present in shoferStack before startTask() emits
			// its initial state update, so state.currentTaskId is available ASAP.
			startTask: false,
			// Per-task CWD: for embedded worktree tasks, this is the worktree
			// subdirectory. Merged from options first, then overridden by the
			// explicit cwd parameter if provided.
			cwd: cwd ?? options.cwd,
			...options,
		})

		// For root tasks (no parent), seed the cost cap from the global default
		// when the task itself didn't bring one from history. Subtasks inherit
		// the cap implicitly via Task.resolveCostLimit() walking up to the root.
		if (!parentTask && !task.costLimit) {
			const defaultLimit = this.contextProxy.getValue("defaultCostLimit")
			if (defaultLimit && defaultLimit.maxUsd > 0) {
				task.costLimit = { maxUsd: defaultLimit.maxUsd, action: defaultLimit.action }
			}
		}

		if (openInStack) {
			await this.addShoferToStack(task)
		} else {
			task.emit(ShoferEventName.TaskUnfocused)
		}
		task.start()

		this.debug(
			`[createTask] ${task.parentTask ? "child" : "parent"} task ${task.taskId}.${task.instanceId} instantiated`,
		)

		return task
	}

	public async cancelTask(): Promise<void> {
		const task = this.getCurrentTask()

		if (!task) {
			return
		}

		outputLog(`[cancelTask] cancelling task ${task.taskId}.${task.instanceId}`)

		// Capture any queued messages from the old task BEFORE aborting
		// These will be transferred to the new task after rehydration
		// When the user explicitly clicks Stop, we should NOT transfer
		// queued messages to the rehydrated task. The "Send Now" flow
		// (cancelAndProcessQueuedMessages) already handles the case where
		// the user genuinely wants to send queued messages.
		// const queuedMessages = [...task.messageQueueService.messages]

		let historyItem: HistoryItem | undefined
		try {
			const history = await this.getTaskWithId(task.taskId)
			historyItem = history.historyItem
		} catch (error) {
			// During task startup there is a short window where currentTask exists
			// but task history has not been persisted yet. Cancelling should still
			// abort safely; we just skip post-cancel rehydration in that case.
			if (error instanceof Error && error.message === "Task not found") {
				this.debug(`[cancelTask] task history missing for ${task.taskId}; skipping rehydrate`)
			} else {
				throw error
			}
		}

		// Preserve parent and root task information for history item.
		const rootTask = task.rootTask
		const parentTask = task.parentTask

		// Mark this as a user-initiated cancellation so provider-only rehydration can occur
		task.abortReason = "user_cancelled"

		// Capture the current instance to detect if rehydrate already occurred elsewhere
		const originalInstanceId = task.instanceId

		// Immediately cancel the underlying HTTP request if one is in progress
		// This ensures the stream fails quickly rather than waiting for network timeout
		task.cancelCurrentRequest()

		// Begin abort (non-blocking)
		task.abortTask()

		// Immediately mark the original instance as abandoned to prevent any residual activity
		task.abandoned = true

		await pWaitFor(
			() =>
				this.getCurrentTask()! === undefined ||
				this.getCurrentTask()!.isStreaming === false ||
				this.getCurrentTask()!.didFinishAbortingStream ||
				// If only the first chunk is processed, then there's no
				// need to wait for graceful abort (closes edits, browser,
				// etc).
				this.getCurrentTask()!.isWaitingForFirstChunk,
			{
				timeout: 3_000,
			},
		).catch(() => {
			outputError("Failed to abort task")
		})

		// Defensive safeguard: if current instance already changed, skip rehydrate
		const current = this.getCurrentTask()
		if (current && current.instanceId !== originalInstanceId) {
			this.debug(
				`[cancelTask] Skipping rehydrate: current instance ${current.instanceId} != original ${originalInstanceId}`,
			)
			return
		}

		// Final race check before rehydrate to avoid duplicate rehydration
		{
			const currentAfterCheck = this.getCurrentTask()
			if (currentAfterCheck && currentAfterCheck.instanceId !== originalInstanceId) {
				this.debug(
					`[cancelTask] Skipping rehydrate after final check: current instance ${currentAfterCheck.instanceId} != original ${originalInstanceId}`,
				)
				return
			}
		}

		if (!historyItem) {
			return
		}

		// Clears task again, so we need to abortTask manually above.
		await this.createTaskWithHistoryItem({ ...historyItem, rootTask, parentTask })

		const newTask = this.getCurrentTask()
	}

	// Clear the current task without treating it as a subtask.
	// This is used when the user cancels a task that is not a subtask.
	public async clearTask(): Promise<void> {
		if (this.shoferStack.length > 0) {
			const task = this.shoferStack[this.shoferStack.length - 1]
			outputLog(`[clearTask] clearing task ${task.taskId}.${task.instanceId}`)
			await this.removeShoferFromStack()
		}
	}

	public resumeTask(taskId: string): void {
		// Use the existing showTaskWithId method which handles both current and
		// historical tasks.
		this.showTaskWithId(taskId).catch((error) => {
			this.log(`Failed to resume task ${taskId}: ${error.message}`)
		})
	}

	// Modes

	public async getModes(): Promise<{ slug: string; name: string }[]> {
		try {
			const customModes = await this.customModesManager.getCustomModes()
			return [...DEFAULT_MODES, ...customModes].map(({ slug, name }) => ({ slug, name }))
		} catch (error) {
			return DEFAULT_MODES.map(({ slug, name }) => ({ slug, name }))
		}
	}

	public async getMode(): Promise<string> {
		const { mode } = await this.getState()
		return mode
	}

	public async setMode(mode: string): Promise<void> {
		await this.setValues({ mode })
	}

	// Provider Profiles

	public async getProviderProfiles(): Promise<{ name: string; provider?: string }[]> {
		const { listApiConfigMeta = [] } = await this.getState()
		return listApiConfigMeta.map((profile) => ({ name: profile.name, provider: profile.apiProvider }))
	}

	public async getProviderProfile(): Promise<string> {
		const { currentApiConfigName = "default" } = await this.getState()
		return currentApiConfigName
	}

	public async setProviderProfile(name: string): Promise<void> {
		await this.activateProviderProfile({ name })
	}

	// Telemetry

	private _appProperties?: StaticAppProperties
	private _gitProperties?: GitProperties

	private getAppProperties(): StaticAppProperties {
		if (!this._appProperties) {
			const packageJSON = this.context.extension?.packageJSON

			this._appProperties = {
				appName: packageJSON?.name ?? Package.name,
				appVersion: packageJSON?.version ?? Package.version,
				vscodeVersion: vscode.version,
				platform: process.platform,
				editorName: vscode.env.appName,
			}
		}

		return this._appProperties
	}

	public get appProperties(): StaticAppProperties {
		return this._appProperties ?? this.getAppProperties()
	}

	private getCloudProperties(): { cloudIsAuthenticated?: boolean } {
		return {
			cloudIsAuthenticated: false,
		}
	}

	private async getTaskProperties(): Promise<DynamicAppProperties & TaskProperties> {
		const { language = "en", mode, apiConfiguration } = await this.getState()

		const task = this.getCurrentTask()
		const todoList = task?.todoList
		let todos: { total: number; completed: number; inProgress: number; pending: number } | undefined

		if (todoList && todoList.length > 0) {
			todos = {
				total: todoList.length,
				completed: todoList.filter((todo) => todo.status === "completed").length,
				inProgress: todoList.filter((todo) => todo.status === "in_progress").length,
				pending: todoList.filter((todo) => todo.status === "pending").length,
			}
		}

		const apiProvider = apiConfiguration?.apiProvider

		return {
			language,
			mode,
			taskId: task?.taskId,
			parentTaskId: task?.parentTaskId,
			apiProvider: apiProvider && !isRetiredProvider(apiProvider) ? apiProvider : undefined,
			modelId: task?.api?.getModel().id,
			diffStrategy: task?.diffStrategy?.getName(),
			isSubtask: task ? !!task.parentTaskId : undefined,
			...(todos && { todos }),
		}
	}

	private async getGitProperties(): Promise<GitProperties> {
		if (!this._gitProperties) {
			this._gitProperties = await getWorkspaceGitInfo()
		}

		return this._gitProperties
	}

	public get gitProperties(): GitProperties | undefined {
		return this._gitProperties
	}

	public async getTelemetryProperties(): Promise<TelemetryProperties> {
		return {
			...this.getAppProperties(),
			...this.getCloudProperties(),
			...(await this.getTaskProperties()),
			...(await this.getGitProperties()),
		}
	}

	public get cwd() {
		return this.currentWorkspacePath || getWorkspacePath()
	}

	/**
	 * Resume a parent task that was suspended waiting for a blocking foreground subtask.
	 *
	 * The parent task instance is still alive in the shoferStack (below the child), so we
	 * only need to:
	 *   1. Update history for both tasks.
	 *   2. Pop the child from the stack to reveal the parent.
	 *   3. Refresh the webview so the user sees the parent's chat.
	 *   4. Fire the resolver that unblocks NewTaskTool's awaiting Promise.
	 *
	 * @returns true if a blocking resolver was found and fired; false otherwise.
	 */
	public async resumeBlockingParent(params: {
		parentTaskId: string
		childTaskId: string
		completionResult: string
	}): Promise<boolean> {
		const { parentTaskId, childTaskId, completionResult } = params

		const resolver = this.blockingChildResolvers.get(childTaskId)
		if (!resolver) {
			return false
		}
		this.blockingChildResolvers.delete(childTaskId)

		this.debug(`[resumeBlockingParent] childTaskId=${childTaskId} completed, resuming parentTaskId=${parentTaskId}`)

		// 1) Update child history to "completed".
		try {
			const { historyItem: childHistory } = await this.getTaskWithId(childTaskId)
			await this.updateTaskHistory({
				...childHistory,
				taskState: { lifecycle: "completed", rating: "poor" },
				completionResultSummary: completionResult,
			})
		} catch (err) {
			this.debug(`[resumeBlockingParent] Failed to update child history (non-fatal): ${err}`)
		}

		// 2) Update parent history: clear delegation fields, mark active.
		try {
			const { historyItem: parentHistory } = await this.getTaskWithId(parentTaskId)
			const childIds = Array.from(new Set([...(parentHistory.childIds ?? []), childTaskId]))
			await this.updateTaskHistory({
				...parentHistory,
				awaitingChildId: undefined,
				completedByChildId: childTaskId,
				completionResultSummary: completionResult,
				childIds,
			})
		} catch (err) {
			this.debug(`[resumeBlockingParent] Failed to update parent history (non-fatal): ${err}`)
		}

		// 3) Pop child from the stack (the parent is revealed below it).
		const current = this.getCurrentTask()
		if (current?.taskId === childTaskId) {
			this.popFromStackWithoutAborting()
		}

		// 4) Refresh the webview so the user sees the parent's chat again.
		await this.postStateToWebview()

		// 5) Emit provider-level event.
		try {
			this.emit(ShoferEventName.TaskDelegationCompleted, parentTaskId, childTaskId, completionResult)
		} catch {
			// non-fatal
		}

		// 6) Fire the resolver to unblock the parent's NewTaskTool.execute() await.
		resolver(completionResult)

		this.debug(`[resumeBlockingParent] DONE parentTaskId=${parentTaskId}, childTaskId=${childTaskId}`)
		return true
	}

	/**
	 * Register a blocking resolver for a foreground subtask child.
	 * Called by NewTaskTool before starting the child so the resolver is ready
	 * before attempt_completion could fire.
	 */
	public registerBlockingChildResolver(childTaskId: string, resolver: (result: string) => void): void {
		this.blockingChildResolvers.set(childTaskId, resolver)
	}

	/**
	 * Convert a file path to a webview-accessible URI
	 * This method safely converts file paths to URIs that can be loaded in the webview
	 *
	 * @param filePath - The absolute file path to convert
	 * @returns The webview URI string, or the original file URI if conversion fails
	 * @throws {Error} When webview is not available
	 * @throws {TypeError} When file path is invalid
	 */
	public convertToWebviewUri(filePath: string): string {
		try {
			const fileUri = vscode.Uri.file(filePath)

			// Check if we have a webview available
			if (this.view?.webview) {
				const webviewUri = this.view.webview.asWebviewUri(fileUri)
				return webviewUri.toString()
			}

			// Specific error for no webview available
			const error = new Error("No webview available for URI conversion")
			outputError(error.message)
			// Fallback to file URI if no webview available
			return fileUri.toString()
		} catch (error) {
			// More specific error handling
			if (error instanceof TypeError) {
				outputError("Invalid file path provided for URI conversion:", error)
			} else {
				outputError("Failed to convert to webview URI:", error)
			}
			// Return file URI as fallback
			return vscode.Uri.file(filePath).toString()
		}
	}

	// ────────────────────────────── Parallel Task Management ──────────────────────────────

	/**
	 * Create a new managed task with the given name.
	 * The new task is pushed to the stack and focused; any existing task is removed from the
	 * stack WITHOUT aborting it, so it continues processing in the background.
	 *
	 * @param name Optional task name (auto-generated from text if not provided)
	 * @param text Initial task text
	 * @param images Optional images
	 */
	public async createManagedTask(
		name?: string,
		text?: string,
		images?: string[],
		worktreeDir?: string,
	): Promise<void> {
		// Pop the current task from the stack WITHOUT aborting it — it continues in background
		// Save reference so we can restore it if task creation fails
		const poppedTask = this.popFromStackWithoutAborting()

		try {
			// Register the popped task as a background task (if it's not already registered)
			// so it shows correct state indicators in the dropdown
			if (poppedTask) {
				this.taskManager.registerBackgroundTask(poppedTask)
			}

			// Auto-generate task name from first message if provided, otherwise use fallback
			const taskName = name || (text ? this.generateTaskNameFromText(text) : "New Task")

			// Create a new task with keepCurrentTask=true so createTask won't abort any remaining tasks.
			// Pass worktreeDir as the task's cwd for embedded worktree tasks.
			const task = await this.createTask(text, images, undefined, { keepCurrentTask: true }, {}, worktreeDir)

			if (!task) {
				throw new Error("Failed to create task")
			}

			// Register the task with the TaskManager
			const managedTask = await this.taskManager.createManagedTask(taskName, task)

			// Create initial history item for the task
			// The task may not have history yet if no text was provided
			const historyItem: HistoryItem = {
				id: task.taskId,
				number: this.taskHistoryStore.getAll().length + 1,
				ts: Date.now(),
				task: text || "",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
				// workspace is the VS Code workspace root (for history filtering);
				// cwd is the per-task working directory (for worktree badge display).
				workspace: task.workspacePath || "",
				cwd: task.cwd !== task.workspacePath ? task.cwd : undefined,
				name: managedTask.name,

				lastActiveTs: managedTask.lastActiveAt,
				taskState: managedTask.state,
			}

			await this.updateTaskHistory(historyItem)

			// Notify the webview of the new current task and switch to the chat tab.
			await this.postStateToWebview()
			await this.postMessageToWebview({ type: "action", action: "chatButtonClicked" })

			this.debug(`Created managed task: ${managedTask.id} (${managedTask.name})`)
		} catch (error) {
			// Restore the old task to the stack if creation failed
			if (poppedTask) {
				await this.addShoferToStack(poppedTask)
				this.log(`[createManagedTask] Restored previous task ${poppedTask.taskId} after creation failure`)
			}
			this.log(`Failed to create managed task: ${error}`)
			vscode.window.showErrorMessage(
				`Failed to create managed task: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	/**
	 * Focus on a task (switch UI to it without stopping background processing).
	 * Works for both managed tasks (with live instances) and history-only tasks.
	 * The currently focused task is removed from the UI stack but continues running in background.
	 */
	public async focusTask(taskId: string): Promise<void> {
		try {
			// Check if we already have this task focused
			const currentTask = this.getCurrentTask()
			if (currentTask?.taskId === taskId) {
				this.debug(`[focusTask] Task ${taskId} is already focused`)
				return
			}

			// Check if we have a live Task instance for this task
			const liveTask = this.taskManager.getManagedTaskInstance(taskId)
			const isTaskAlive = liveTask && !liveTask.abandoned && !liveTask.abort

			if (isTaskAlive) {
				// Task has a live instance — swap it into the stack without stopping it
				// Update TaskManager focus state
				try {
					await this.taskManager.focusTask(taskId)
					// Clear any pending notifications for this task so the
					// webview dismisses toast banners for the now-focused task.
					this.clearTaskNotification(taskId)
				} catch {
					// Task might not be in managedTasks map, that's OK
				}

				const stackIndex = this.shoferStack.length - 1
				if (stackIndex >= 0) {
					const oldTask = this.shoferStack[stackIndex]
					// Emit unfocused event for old task (it continues running in background)
					oldTask.emit(ShoferEventName.TaskUnfocused)
					// Replace in stack
					this.shoferStack[stackIndex] = liveTask
					liveTask.emit(ShoferEventName.TaskFocused)
					// Sticky-mode: restore the focused task's mode as the active provider
					// mode so the mode picker in the UI reflects what this task was last
					// using. The mode is stored per-task on `_taskMode`; new tasks
					// initialize it from `defaultModeSlug`, switches via
					// `handleModeSwitch` keep it in sync.
					await this.restoreTaskMode(liveTask)
					// Post state update
					await this.postStateToWebview()
				} else {
					// Stack is empty — just push the task
					await this.addShoferToStack(liveTask)
					await this.restoreTaskMode(liveTask)
					await this.postStateToWebview()
				}
			} else {
				// No live instance or instance is dead/aborted — load from history
				if (liveTask) {
					// Clean up the dead instance from activeTasks
					this.taskManager.removeManagedTaskInstance(taskId)
					this.debug(`[focusTask] Removed stale task instance ${taskId} from activeTasks`)
				}
				// Dismiss any stale notifications for the task being focused
				this.clearTaskNotification(taskId)
				// Load task from history (without killing the currently running task)
				await this.showTaskWithId(taskId, { keepCurrentTask: true })
				// Register the freshly rehydrated task instance with TaskManager
				// so that it can be found by getManagedTaskInstance on subsequent
				// focus switches (LIVE path in focusTask), avoiding the need to
				// re-rehydrate and re-present the resume_task ask every time.
				// Use registerBackgroundTask (not updateTaskInstance) because the
				// task may not yet exist in TaskManager's managedTasks map, and
				// updateTaskInstance early-returns in that case.
				const resumedTask = this.getCurrentTask()
				if (resumedTask && resumedTask.taskId === taskId) {
					this.taskManager.registerBackgroundTask(resumedTask)
				}
			}
		} catch (error) {
			this.log(`Failed to focus task: ${error}`)
		}
	}

	/**
	 * Start/resume a managed task.
	 */
	public async startManagedTask(taskId: string): Promise<void> {
		try {
			await this.taskManager.startManagedTask(taskId)
		} catch (error) {
			this.log(`Failed to start managed task: ${error}`)
			vscode.window.showErrorMessage(
				`Failed to start managed task: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	/**
	 * Pause a managed task.
	 */
	public async pauseManagedTask(taskId: string): Promise<void> {
		try {
			await this.taskManager.pauseManagedTask(taskId)
		} catch (error) {
			this.log(`Failed to pause managed task: ${error}`)
		}
	}

	/**
	 * Resume a managed task that was paused.
	 *
	 * Loads the task from history into the chat panel and auto-approves the
	 * `resume_task` ask that `resumeTaskFromHistory()` presents, so the task
	 * continues without requiring the user to click "Continue" manually.
	 *
	 * The `TaskResumable` event fires via `setTimeout(0)` for background tasks
	 * (i.e. tasks that are not the current `focusedTaskId` in TaskManager).
	 * Since the dead-task path in `focusTask` does not update `focusedTaskId`,
	 * the rehydrated task is treated as a background task and the event fires
	 * immediately, avoiding the 2-second focused-task delay.
	 */
	public async resumeManagedTask(taskId: string): Promise<void> {
		try {
			// Load the task from history into the chat panel without killing the
			// currently focused task. This creates a new Task instance that starts
			// resumeTaskFromHistory() asynchronously.
			await this.focusTask(taskId)

			// After focusTask, the freshly rehydrated task instance is registered
			// in TaskManager via updateTaskInstance.
			const task = this.taskManager.getManagedTaskInstance(taskId)
			if (!task) {
				this.debug(`[resumeManagedTask] No task instance found for ${taskId}`)
				return
			}

			// If the task already reached the resume_task ask before our listener
			// was registered, approve it immediately.
			if (task.resumableAsk) {
				task.approveAsk()
				return
			}

			// Otherwise, wait for TaskResumable which fires when ask("resume_task")
			// begins waiting for user input (setTimeout(0) for background tasks).
			const onResumable = (resumedTaskId: string) => {
				if (resumedTaskId === taskId) {
					task.approveAsk()
				}
			}
			task.once(ShoferEventName.TaskResumable, onResumable)

			// Safety cleanup: remove the listener if the task never becomes resumable
			// (e.g. already completed or aborted before we could attach).
			const cleanupTimeout = setTimeout(() => {
				task.off(ShoferEventName.TaskResumable, onResumable)
				this.debug(`[resumeManagedTask] Timed out waiting for resume_task for ${taskId}`)
			}, 30_000)

			const clearCleanup = () => clearTimeout(cleanupTimeout)
			task.once(ShoferEventName.TaskActive, clearCleanup)
			task.once(ShoferEventName.TaskCompleted, clearCleanup)
			task.once(ShoferEventName.TaskAborted, clearCleanup)
		} catch (error) {
			this.log(`[resumeManagedTask] Failed to resume managed task: ${error}`)
		}
	}

	/**
	 * Stop a managed task.
	 */
	public async stopManagedTask(taskId: string): Promise<void> {
		try {
			await this.taskManager.stopManagedTask(taskId)
		} catch (error) {
			this.log(`Failed to stop managed task: ${error}`)
		}
	}

	/**
	 * Rename a managed task.
	 */
	public renameManagedTask(taskId: string, name: string): void {
		this.taskManager.renameManagedTask(taskId, name)

		// Persist the rename
		this.getTaskWithId(taskId)
			.then(({ historyItem }) => {
				this.updateTaskHistory({ ...historyItem, name })
			})
			.catch((error) => {
				this.log(`Failed to persist task rename: ${error}`)
			})
	}

	/**
	 * Archive a managed task — soft-remove it from the main task listing.
	 */
	public async archiveManagedTask(taskId: string): Promise<void> {
		const { historyItem } = await this.getTaskWithId(taskId)
		if (historyItem.archived) {
			return // already archived
		}
		await this.updateTaskHistory({ ...historyItem, archived: true, archivedAt: Date.now() })
	}

	/**
	 * Unarchive a managed task — move it back into the main task listing.
	 */
	public async unarchiveManagedTask(taskId: string): Promise<void> {
		const { historyItem } = await this.getTaskWithId(taskId)
		if (!historyItem.archived) {
			return // already not archived
		}
		// Explicitly set archived: false so the upsert merge in TaskHistoryStore
		// overwrites the existing true value (destructuring out the property
		// would leave it absent and the spread would preserve the old value).
		await this.updateTaskHistory({ ...historyItem, archived: false })
	}

	/**
	 * Pin a task — show it at the top of the task listing.
	 */
	public async pinManagedTask(taskId: string): Promise<void> {
		const { historyItem } = await this.getTaskWithId(taskId)
		if (historyItem.pinned) {
			return // already pinned
		}
		await this.updateTaskHistory({ ...historyItem, pinned: true })
	}

	/**
	 * Unpin a task — remove it from the "Pinned" group.
	 */
	public async unpinManagedTask(taskId: string): Promise<void> {
		const { historyItem } = await this.getTaskWithId(taskId)
		if (!historyItem.pinned) {
			return // already not pinned
		}
		// Explicitly set pinned: false so the upsert merge in TaskHistoryStore
		// overwrites the existing true value (destructuring out the property
		// would leave it absent and the spread would preserve the old value).
		await this.updateTaskHistory({ ...historyItem, pinned: false })
	}

	/**
	 * Delete a managed task.
	 */
	public async deleteManagedTask(taskId: string): Promise<void> {
		try {
			await this.taskManager.deleteManagedTask(taskId)
			// Also delete from task history (files + index), same as clicking delete in HistoryView.
			await this.deleteTaskWithId(taskId)
		} catch (error) {
			this.log(`Failed to delete managed task: ${error}`)
		}
	}

	/**
	 * Get all managed tasks.
	 */
	public getManagedTasks() {
		return this.taskManager.getManagedTasks()
	}

	/**
	 * Get the currently focused managed task.
	 */
	public getFocusedTask() {
		return this.taskManager.getFocusedTask()
	}

	/**
	 * Get task notifications.
	 */
	public getTaskNotifications() {
		return this.taskManager.getNotifications()
	}

	/**
	 * Clear a task notification.
	 */
	public clearTaskNotification(taskId: string): void {
		this.taskManager.clearTaskNotification(taskId)
		this.postMessageToWebview({
			type: "taskNotificationCleared",
			taskId,
			parallelTasks: this.taskManager.getManagedTasks().map((s) => ({
				id: s.id,
				name: s.name,
				taskId: s.taskId,
				workspace: s.workspace,
				createdAt: s.createdAt,
				lastActiveAt: s.lastActiveAt,
				state: s.state,
			})),
		})
	}

	/**
	 * Generate a task name from the first message text.
	 * Extracts the first meaningful sentence/phrase (up to 50 chars).
	 */
	private generateTaskNameFromText(text: string): string {
		// Remove markdown formatting
		let cleaned = text
			.replace(/^#+\s*/gm, "") // Remove headers
			.replace(/\*\*?|__?/g, "") // Remove bold/italic
			.replace(/`{1,3}[^`]*`{1,3}/g, "") // Remove inline/block code
			.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // Extract link text
			.replace(/^\s*[-*+]\s*/gm, "") // Remove list markers
			.replace(/\n+/g, " ") // Replace newlines with spaces
			.trim()

		// Get first sentence or phrase
		const firstSentence = cleaned.split(/[.!?]\s/)[0] || cleaned

		// Truncate to reasonable length
		if (firstSentence.length <= 50) {
			return firstSentence || "New Task"
		}

		// Find a good break point (word boundary)
		const truncated = firstSentence.substring(0, 50)
		const lastSpace = truncated.lastIndexOf(" ")
		if (lastSpace > 30) {
			return truncated.substring(0, lastSpace) + "..."
		}
		return truncated + "..."
	}
}
