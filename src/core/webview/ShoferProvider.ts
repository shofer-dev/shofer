import os from "os"
import * as path from "path"
import fs from "fs/promises"
import EventEmitter from "events"

import { Anthropic } from "@anthropic-ai/sdk"
import delay from "delay"
import axios from "axios"
import pWaitFor from "p-wait-for"
import * as vscode from "vscode"
import { getHost, isPluginUiRequest } from "@shofer/types"

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
	type TaskInteractionPayload,
	// CloudUserInfo removed
	// CloudOrganizationMembership removed
	type CreateTaskOptions,
	type TokenUsage,
	type ToolUsage,
	type ExtensionMessage,
	type ExtensionState,
	type OrgLockedResources,
	type ShoferExtensionApi,
	ShoferEventName,
	requestyDefaultModelId,
	openRouterDefaultModelId,
	DEFAULT_WRITE_DELAY_MS,
	ORGANIZATION_ALLOW_ALL,
	getModelId,
	isRetiredProvider,
} from "@shofer/types"
import { aggregateTaskCostsRecursive, type AggregatedCosts } from "@shofer/core"
import { TelemetryService } from "@shofer/telemetry"

import { Package } from "@shofer/core"
import { findLast } from "@shofer/core"
import { supportPrompt } from "@shofer/types"
import { GlobalFileNames } from "@shofer/core"
import { Mode, defaultModeSlug, getModeBySlug } from "@shofer/core"
import { governanceDisabledPlugins, governanceEnabledPlugins, governancePluginDirs } from "@shofer/core"
import { experimentDefault, EXPERIMENT_IDS, experiments } from "@shofer/types"
import { formatLanguage } from "@shofer/types"
import { WebviewMessage } from "@shofer/core"
import { ProfileValidator } from "../../shared/ProfileValidator"

import { Terminal } from "../../integrations/terminal/Terminal"
import {
	buildTaskMarkdown,
	formatWorkflowEventsToMarkdown,
	getTaskFileName,
	saveMarkdownFile,
} from "../../integrations/misc/export-markdown"
import {
	buildJsonTrace,
	buildJsonTraceTree,
	downloadJsonTask,
	getJsonExportFileName,
	type JsonExportTrace,
} from "../../integrations/misc/export-json"
import { pickExportDestination } from "../../integrations/misc/export-destination"
import { stringifyJsonToFile } from "../../utils/exportJsonWorker"
import { resolveDefaultSaveUri, saveLastExportPath } from "../../utils/export"
import { getTheme } from "../../integrations/theme/getTheme"
import WorkspaceTracker from "../../integrations/workspace/WorkspaceTracker"

import { McpHub } from "@shofer/core"
import { resolveScopeRoots } from "../config/layeredSettingsLoader"
import { loadPluginDeclarations, computePluginDeclarationWiring } from "../config/pluginDeclarationLoader"
import type { PluginDir } from "@shofer/core"
import {
	PluginManager,
	createNodePluginFs,
	createNodePluginCodeLoader,
	setSharedPluginManager,
	adoptSharedPluginManager,
	releaseSharedPluginManager,
	getGlobalShoferDirectory,
	pluginRegistry,
	unpackPlugin,
	installPluginFromUrl as installPluginArchiveFromUrl,
	PluginPackError,
} from "@shofer/core"
import { pluginConfigSecretKeys } from "@shofer/types"
import type {
	PluginConfigSchema,
	PluginRequest,
	PluginView,
	PluginsState,
	PluginUiMessageEnvelope,
	PluginUiRegion,
	PluginMarker,
	PluginTaskHandle,
	PluginTaskResult,
	PluginRewoundResult,
	PluginEvent,
	ShoferApiReqInfo,
} from "@shofer/types"
import type {
	ApiHandler,
	PluginAiProvider,
	PluginAgentProvider,
	PluginMcpProvider,
	PluginSearchProvider,
	PluginTaskProvider,
} from "@shofer/core"
import { getApiMetrics } from "@shofer/core"
import { applyPluginSecretEdits, redactPluginSecretConfig, splitPluginConfigBySecrets } from "@shofer/core"
import { McpServerManager } from "../../services/mcp/McpServerManager"
import { SkillsManager } from "../../services/skills/SkillsManager"
import { TaskManager } from "../../services/task-manager/TaskManager"

import { fileExistsAtPath } from "../../utils/fs"
import { setTtsEnabled, setTtsSpeed } from "../../utils/tts"
import { getWorkspaceGitInfo } from "@shofer/core"
import { getWorkspacePath } from "@shofer/core"
import { OrganizationAllowListViolationError } from "@shofer/core"

import { setPanel } from "../../activate/registerCommands"

import { t } from "@shofer/core"

import { buildApiHandler } from "@shofer/core"
import { forceFullModelDetailsLoad, hasLoadedFullDetails } from "@shofer/core"

import { ContextProxy } from "../config/ContextProxy"
import { ProviderSettingsManager } from "../config/ProviderSettingsManager"
import { CustomModesManager } from "../config/CustomModesManager"
import { Task } from "@shofer/core"
import type { WorkflowTask } from "../workflow/WorkflowTask"

import { webviewMessageHandler } from "./webviewMessageHandler"
import type { ShoferMessage, TodoItem, TaskLogLine } from "@shofer/types"
import { TaskHistoryStore } from "../task-persistence"
import { getNonce } from "./getNonce"
import { getUri } from "./getUri"
import { buildPluginHostImportMap } from "./pluginHostImportMap"
import { lastCompletionResult, unknownModeError } from "./pluginAgentResult"
import { PluginPanelManager } from "./PluginPanelManager"
import { REQUESTY_BASE_URL } from "@shofer/core"
import { ipcLog, webviewLog, scrollLog } from "@shofer/core"
import { addTaskLogListener } from "@shofer/core"
import type { TaskProviderLike as CoreTaskProviderLike } from "@shofer/core"
import { time } from "@shofer/core"

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
	implements vscode.WebviewViewProvider, TelemetryPropertiesProvider, TaskProviderLike, CoreTaskProviderLike<Task>
{
	// Used in package.json as the view's id. This value cannot be changed due
	// to how VSCode caches views based on their id, and updating the id would
	// break existing instances of the extension.
	public static readonly sideBarId = `${Package.name}.SidebarProvider`
	public static readonly tabPanelId = `${Package.name}.TabPanelProvider`
	private static activeInstances: Set<ShoferProvider> = new Set()
	private disposables: vscode.Disposable[] = []
	private webviewDisposables: vscode.Disposable[] = []
	/** Task id whose "Logs" tab the webview is currently watching (set on requestTaskLogs). */
	private _logsWatchTaskId?: string
	/** Coalesced log lines awaiting the next flush to the webview "Logs" tab. */
	private _pendingLogLines: TaskLogLine[] = []
	/** Debounce timer for flushing _pendingLogLines. */
	private _logFlushTimer?: ReturnType<typeof setTimeout>
	private view?: vscode.WebviewView | vscode.WebviewPanel
	private shoferStack: Task[] = []
	private _workspaceTracker?: WorkspaceTracker // workSpaceTracker read-only for access outside this class
	protected mcpHub?: McpHub // Change from private to protected
	protected skillsManager?: SkillsManager
	/** Declarative plugin manager (design §7). Lazily built via {@link getPluginManager}. */
	private pluginManager?: PluginManager
	/** In-flight {@link getPluginManager} build, memoized so concurrent callers share one manager. */
	private pluginManagerBuild?: Promise<PluginManager>
	/**
	 * The `pluginConfigs` map as it was last observed, so an external `.shofer/` edit can
	 * be narrowed to the plugins whose own entry actually changed
	 * ({@link reloadPluginsForConfigChange}).
	 */
	private lastSeenPluginConfigs?: Record<string, Record<string, unknown>>
	/**
	 * Opens plugin UI bundles as standalone `WebviewPanel` editor tabs (design §6.8 —
	 * `ctx.ui.showPanel`). Lazily created; owns its panels' lifecycle.
	 */
	private readonly pluginPanelManager = new PluginPanelManager(this)
	private taskCreationCallback: (task: Task) => void
	/**
	 * Public accessor for the task-creation event-forwarding callback. Tasks
	 * constructed out-of-band (e.g. {@link WorkflowTask}, which is built via
	 * `new WorkflowTask(...)` rather than {@link createTask}) must pass this as
	 * their `onCreated` option so they receive the same provider-level event
	 * forwarding (`TaskCreated` announcement + per-task lifecycle listeners that
	 * the public ShoferExtensionApi re-emits). Without it, a WorkflowTask's own
	 * `TaskCompleted` emission is never forwarded to the API and consumers that
	 * await completion (integration harness, eval runner) hang forever.
	 */
	public get onTaskCreated(): (task: Task) => void {
		return this.taskCreationCallback
	}
	private taskEventListeners: WeakMap<Task, Array<() => void>> = new WeakMap()
	private currentWorkspacePath: string | undefined
	private _disposed = false
	private _cancelling = false

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
	 * Peer sync resolvers: maps recipient task ID → pending sync request metadata.
	 * Keyed by the RECIPIENT (the task that must call attempt_completion to answer),
	 * and storing the initiator (the task that is blocked awaiting the answer) and
	 * the resolve function. Used by both peer (sync send_message_to_task) and parent
	 * (new_task) initiators; the AttemptCompletionTool routes by recipient taskId
	 * and branches on whether the initiator is a peer or the structural parent.
	 *
	 * Exactly one sync prompt is in flight per recipient at a time; a second
	 * concurrent sync request is rejected at registration time.
	 */
	private pendingSyncResolvers: Map<string, { initiatorTaskId: string; resolve: (result: string) => void }> =
		new Map()

	public isViewLaunched = false
	public settingsImportedAt?: number
	public readonly latestAnnouncementId = "apr-2026-v3.52.0-poe-xai-minimax" // v3.52.0 Poe provider, xAI improvements, and MiniMax fixes
	public readonly providerSettingsManager: ProviderSettingsManager
	public readonly customModesManager: CustomModesManager

	// Phase 3: H8 static-state cache removed — allowed/denied commands are
	// recomputed fresh in getStateToPostToWebview(). The cache was only worth it
	// when postInitState was called >1/sec; with incremental messaging it won't be.
	/**
	 * The `TaskHistoryStore` mutation version carried by the last init snapshot
	 * that included the full `taskHistory` array. When the store is unchanged
	 * since then, `postInitState` omits the array — the webview already has an
	 * identical copy (kept current by the `taskHistoryItemUpdated` /
	 * `taskHistoryUpdated` delta channels). `-1` forces a re-seed; it is reset on
	 * every `webviewDidLaunch` because the renderer's React state starts empty
	 * after a (re)load. [perf H26]
	 */
	private _lastSentTaskHistoryVersion = -1
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
	/**
	 * Timestamp (epoch ms) set immediately before each `postMessage({type:"ping"})`.
	 * Used to compute per-heartbeat round-trip time (RTT) when the corresponding
	 * pong arrives. Without this we'd only know silence duration, not actual
	 * webview responsiveness.
	 */
	private _pingSentTs = 0
	/**
	 * Ring buffer of the last `RTT_HISTORY_SIZE` heartbeat round-trip times
	 * (ms). Each entry is recorded in `_recordPong()` as `now - _pingSentTs`.
	 * Dumped to the output channel when a webview reset is triggered so we can
	 * distinguish gradual slowdown (rising RTT → memory pressure) from abrupt
	 * death (normal RTT → sudden silence → OOM kill / GPU crash).
	 */
	private _heartbeatRttHistory: number[] = []
	private static readonly RTT_HISTORY_SIZE = 40
	/** Total heartbeat ticks completed in the current webview session. */
	private _heartbeatTickCount = 0
	/** Number of webview resets (automatic + manual) in the current host session. */
	private _webviewResetCount = 0

	/** Interval between `ping` messages sent to the webview (ms). */
	private static readonly HEARTBEAT_INTERVAL_MS = 5_000
	/**
	 * Maximum time the webview may go without responding to a ping before we
	 * declare it dead and reset it. Must be comfortably larger than
	 * `HEARTBEAT_INTERVAL_MS` plus expected main-thread stalls (large file
	 * opens, GC pauses, source-map enhancement, …) so transient hiccups don't
	 * trip the killer.
	 *
	 * Relaxed from 10 s to 30 s (2026-05-24) since this is now gated behind
	 * an experiment flag (default off). The wider window avoids false-positive
	 * resets from transient main-thread stalls.
	 */
	private static readonly LIVENESS_TIMEOUT_MS = 30_000

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

		// Ordering guarantee: `initializeTaskHistoryStore` is fire-and-forget
		// in the constructor and may not settle before a WorkflowTask spawns
		// its first agent child (which calls registerBackgroundTask). Mark the
		// manager as restored now so the early-bird register doesn't throw.
		// `restoreManagedTasks` is idempotent — when initializeTaskHistoryStore
		// eventually calls it with real history, the `seeded` guard ensures it
		// seeds exactly once.
		this.taskManager.ensureRestored()

		// Phase 3: H8 static-state cache removed — allowed/denied commands are
		// recomputed fresh in getStateToPostToWebview(). The cache was only worth it
		// when postInitState was called >1/sec; with incremental messaging it won't be.

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
					activeTimeMs: s.activeTimeMs,
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

		// Stream task-attributed log lines to the webview "Logs" tab. We stream
		// only the task the Logs tab is actively watching (set via requestTaskLogs)
		// — this is the precise signal of what the user is looking at, and unlike
		// the focused/current heuristic it works for background/orchestrator tasks
		// too. Lines are coalesced and flushed on a short timer so high-frequency
		// debug logging can't flood the IPC channel (which would make logs appear
		// to arrive in one clump at the end instead of live). Other tasks' lines
		// are still buffered and fetched on demand when the user switches to them.
		this.disposables.push({
			dispose: addTaskLogListener((taskId, line) => {
				if (taskId !== this._logsWatchTaskId) return
				this._pendingLogLines.push(line)
				if (!this._logFlushTimer) {
					this._logFlushTimer = setTimeout(() => this.flushPendingLogLines(), 100)
				}
			}),
		})
		this.disposables.push({
			dispose: () => {
				if (this._logFlushTimer) {
					clearTimeout(this._logFlushTimer)
					this._logFlushTimer = undefined
				}
			},
		})

		// A `.shofer/` settings file changed underneath this host (another pod on the
		// shared volume, a ConfigMap rewrite, a hand edit). The overlay is already
		// refreshed by the time this fires; re-push state so the UI shows the effective
		// values rather than what they were at load.
		//
		// A full init rather than per-key `postConfigUpdate`s: one file rewrite can move
		// any number of keys, and several of them (a locked key taking over, a provider
		// profile name) change derived state the webview computes from the whole
		// snapshot. External edits are rare, so the escape-hatch cost is not paid often.
		// A providers.json edit in any scope (org bundle re-materialized, hand edit)
		// changes the composed profile set. The manager reads files per call so no
		// cache invalidation is needed — but the active profile's non-secret fields
		// are hydrated into globalState, so re-activate it and re-push state.
		this.disposables.push(
			this.contextProxy.onDidChangeScopeFiles(({ files }) => {
				if (!files.includes("providers.json")) {
					return
				}
				void (async () => {
					try {
						const name = await this.providerSettingsManager.getProfile({
							name: this.contextProxy.getValue("currentApiConfigName") ?? "default",
						})
						await this.activateProviderProfile({ name: name.name })
					} catch {
						// Profile gone or renamed on disk — the state push below still
						// refreshes the list; the user picks a profile from it.
					}
					await this.postInitState()
				})()
			}),
		)

		this.disposables.push(
			this.contextProxy.onDidRefreshOverlay(({ keys }) => {
				void this.postInitState()
				// A plugin holds the `config` it was handed at load, so a `pluginConfigs`
				// change on disk (a hand-edited `.shofer/settings.json`, another host
				// sharing the volume, or a re-materialized org bundle) would otherwise
				// never reach a running plugin — the overlay would report the new value
				// while the plugin kept acting on the old one. Reload so `ctx.config` is
				// rebuilt, which is what `docs/configuration.md` promises when it says an
				// edit takes effect without a restart.
				if (keys.includes("pluginConfigs")) {
					void this.reloadPluginsForConfigChange()
				}
			}),
		)

		// Start configuration loading (which might trigger indexing) in the background.
		// Don't await, allowing activation to continue immediately.

		// Register this provider with the telemetry service to enable it to add
		// properties like mode and provider.
		TelemetryService.instance.setProvider(this)

		this._workspaceTracker = new WorkspaceTracker(this)

		this.providerSettingsManager = new ProviderSettingsManager(this.context)

		// Part B: hand the SINGLE PSM to ContextProxy so it can source the current
		// profile's per-profile LLM secrets from the profiles blob (ContextProxy.
		// initialize ran before any PSM existed). Fire-and-forget — the load is a
		// single blob read that completes well before the webview resolves and the
		// first getState() runs; failures are logged, not fatal.
		void this.contextProxy
			.attachProviderSettingsManager(this.providerSettingsManager)
			.catch((e) =>
				this.log(
					`Failed to attach ProviderSettingsManager to ContextProxy: ${e instanceof Error ? e.message : String(e)}`,
				),
			)

		this.customModesManager = new CustomModesManager(this.context, async () => {
			const modes = await this.customModesManager.getCustomModes()
			// Same private-mode filter as getStateToPostToWebview(): this incremental
			// push feeds the mode picker too, and an unfiltered push would leak
			// private plugin modes into it whenever a modes file changes.
			this.postConfigUpdate(
				"customModes",
				modes.filter((m) => !m.private),
			)
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

	/** Default archived-task retention when the user hasn't configured one. */
	private static readonly DEFAULT_ARCHIVE_RETENTION_DAYS = 7

	/**
	 * Auto-delete archived tasks older than the configured retention window
	 * (`archivedTaskRetentionDays`, Settings → Advanced; default 7 days, `0`
	 * disables deletion). Runs at extension start and then once every 24 hours.
	 * The retention value is read fresh on every run so a settings change takes
	 * effect on the next tick without a restart.
	 */
	private scheduleArchivedCleanup(): void {
		const DAY_MS = 24 * 60 * 60 * 1000

		const doCleanup = async () => {
			try {
				const configured = this.contextProxy.getValue("archivedTaskRetentionDays")
				const retentionDays = configured ?? ShoferProvider.DEFAULT_ARCHIVE_RETENTION_DAYS
				// 0 (or any non-positive value) means "keep archived tasks forever".
				if (!(retentionDays > 0)) {
					return
				}
				const maxAgeMs = retentionDays * DAY_MS
				const now = Date.now()
				const allTasks = this.taskHistoryStore.getAll()
				const expiredIds = allTasks
					.filter((item) => item.archived && item.archivedAt && now - item.archivedAt >= maxAgeMs)
					.map((item) => item.id)

				if (expiredIds.length > 0) {
					this.debug(
						`Auto-deleting ${expiredIds.length} expired archived tasks (retention ${retentionDays}d)`,
					)
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
				getHost().notifier.error(error instanceof Error ? error.message : String(error))
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
							taskState: { lifecycle: "idle" },
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
			// The popped task is no longer the user-visible task. Clear it
			// from TaskManager's focus so its streaming chunks stop emitting
			// `shoferMessageAppended` deltas to the webview (see Task.ts
			// addToShoferMessages dual focused/current check).
			this.taskManager.clearFocusIfMatches(task.taskId)
			task.emit(ShoferEventName.TaskUnfocused)
			this.debug(
				`[ShoferProvider#popFromStackWithoutAborting] Task ${task.taskId}.${task.instanceId} removed from stack (still running in background)`,
			)
		}

		return task
	}

	/**
	 * Moves the current task off the stack and into the background, KEEPING it
	 * alive and addressable: popped without aborting, then registered with the
	 * `TaskManager` so `sendMessage`/`resumeTask` can still find its live
	 * instance by id.
	 *
	 * This is the correct way for a caller that is starting or focusing ANOTHER
	 * task to make room for it. `removeShoferFromStack()` is not: it aborts the
	 * popped task as abandoned, which is right when the task being cleared is
	 * the one the user just finished with, and catastrophic when it belongs to
	 * somebody else — on a `shofer serve` node every controller-driven
	 * conversation is created through the same provider, so clearing the stack
	 * destroyed an unrelated conversation mid-turn.
	 *
	 * Registration is best-effort: a host whose `TaskManager` has not finished
	 * restoring still gets the task backgrounded rather than killed.
	 */
	backgroundCurrentTask(): Task | undefined {
		const task = this.popFromStackWithoutAborting()
		if (task) {
			try {
				this.taskManager.registerBackgroundTask(task)
			} catch (e) {
				this.log(
					`[ShoferProvider#backgroundCurrentTask] could not register ${task.taskId} as a background task: ${e instanceof Error ? e.message : String(e)}`,
				)
			}
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
	 * Returns `true` when the webview liveness monitor experiment is enabled.
	 * All heartbeat, crash-guard, and webview-recovery functionality is gated
	 * behind this flag (default: false — Settings → Experimental).
	 */
	private _isWebviewLivenessEnabled(): boolean {
		const exps = this.contextProxy.getValue("experiments") ?? {}
		return experiments.isEnabled(exps, EXPERIMENT_IDS.WEBVIEW_LIVENESS_MONITOR)
	}

	/**
	 * Called by `webviewMessageHandler` when a `pong` is received from the
	 * webview. Records the timestamp so the next heartbeat tick can compute
	 * liveness as `now - _lastPongTs`.
	 *
	 * Gated: no-op when the webview liveness monitor experiment is disabled.
	 */
	public _recordPong(): void {
		if (!this._isWebviewLivenessEnabled()) {
			return
		}
		const now = Date.now()
		this._lastPongTs = now

		// Compute round-trip time for the in-flight ping and push to ring buffer.
		// `_pingSentTs` is set immediately before `postMessage({type:"ping"})` in
		// `_startHeartbeat`. On the first tick (before any ping was sent) this
		// delta is large; we discard deltas > 2× HEARTBEAT_INTERVAL_MS as noise.
		const rtt = now - this._pingSentTs
		if (rtt > 0 && rtt < ShoferProvider.HEARTBEAT_INTERVAL_MS * 3) {
			if (this._heartbeatRttHistory.length >= ShoferProvider.RTT_HISTORY_SIZE) {
				this._heartbeatRttHistory.shift()
			}
			this._heartbeatRttHistory.push(rtt)
		}
	}

	/**
	 * Starts the ping/pong heartbeat loop. Safe to call multiple times — only
	 * one interval is ever active at a time.
	 *
	 * Must NOT be called before the webview has signalled `webviewDidLaunch` —
	 * otherwise pings sent while the bundle is still loading count against the
	 * liveness window and trigger an infinite reset loop.
	 *
	 * Gated: no-op when the webview liveness monitor experiment is disabled.
	 */
	private _startHeartbeat(): void {
		if (!this._isWebviewLivenessEnabled()) {
			return
		}
		if (this._heartbeatTimer) {
			return // already running
		}

		// Seed `_lastPongTs` with `now` so the first tick has a fresh window —
		// otherwise `now - 0` would immediately exceed LIVENESS_TIMEOUT_MS.
		this._lastPongTs = Date.now()
		this._heartbeatTickCount = 0
		this._heartbeatRttHistory = []
		this._heartbeatTimer = setInterval(async () => {
			try {
				this._pingSentTs = Date.now()
				await this.postMessageToWebview({ type: "ping" })
			} catch {
				// view may be disposed; stop and let dispose clean up
				this._stopHeartbeat()
				return
			}

			this._heartbeatTickCount++
			const silentFor = Date.now() - this._lastPongTs
			if (silentFor > ShoferProvider.LIVENESS_TIMEOUT_MS) {
				this.log(
					`[heartbeat] No pong received for ${silentFor}ms (> ${ShoferProvider.LIVENESS_TIMEOUT_MS}ms) — resetting webview`,
				)
				await this._resetWebview("heartbeat_timeout")
			}
		}, ShoferProvider.HEARTBEAT_INTERVAL_MS)
	}

	private _stopHeartbeat(): void {
		if (this._heartbeatTimer) {
			clearInterval(this._heartbeatTimer)
			this._heartbeatTimer = null
		}
		this._lastPongTs = 0
		this._pingSentTs = 0
	}

	/**
	 * Called by `webviewMessageHandler` on each `webviewDidLaunch`. This is the
	 * earliest signal that the renderer's JS has executed and the `message`
	 * event listener (which answers pings with pongs) is installed — only now
	 * is it safe to start the heartbeat loop.
	 */
	public _onWebviewLaunched(): void {
		// A freshly (re)loaded renderer starts with an empty taskHistory, so the
		// next init snapshot must carry the full array again. [perf H26]
		this._lastSentTaskHistoryVersion = -1
		this._startHeartbeat()
	}

	/**
	 * Called by `webviewMessageHandler` when a `fatal_error` message arrives
	 * from the webview (forwarded by `installWebviewCrashGuard` in `index.tsx`
	 * or by `ErrorBoundary.componentDidCatch`).
	 *
	 * The heartbeat alone cannot detect React-level crashes: the raw
	 * `window.addEventListener("message", …)` pong handler in the IIFE survives
	 * React errors, so pongs keep arriving even though the app is broken. We
	 * therefore trigger an unconditional reset on every fatal-error report to
	 * ensure the renderer is restored without waiting for the liveness window.
	 *
	 * Gated: logs only (no reset) when the webview liveness monitor experiment
	 * is disabled.
	 */
	public async _onFatalError(text: string): Promise<void> {
		this.log(`[fatal_error] ${text.slice(0, 200)}`)
		if (!this._isWebviewLivenessEnabled()) {
			return
		}
		this.log(`[fatal_error] Triggering webview reset due to fatal error: ${text.slice(0, 200)}`)
		await this._resetWebview("fatal_error")
	}

	/**
	 * Forces a full reload of the webview renderer. Exposed as the
	 * `shofer.refreshWebview` command so users can recover from a blank /
	 * frozen webview without restarting VS Code.
	 *
	 * More aggressive than the automatic `_resetWebview` path:
	 *
	 * 1. Explicit `webview.html = ""` clear — signals VS Code to tear down the
	 *    current frame content before we push the new page.
	 * 2. Focus the panel — `workbench.action.webview.reloadWebviewAction`
	 *    targets the *focused* webview, so we must ensure ours is active.
	 * 3. Push the new HTML (with HMR support in dev mode).
	 * 4. Execute `workbench.action.webview.reloadWebviewAction` — this is the
	 *    VS Code workbench's native "Developer: Reload Webviews" trigger. Unlike
	 *    `webview.html` assignment (which is an IPC message that can be silently
	 *    dropped when the renderer process is in a zombie/stuck state), this
	 *    command navigates the browser frame itself, bypassing the broken channel.
	 *
	 * The heartbeat is restarted automatically when the freshly-loaded page
	 * emits `webviewDidLaunch`.
	 *
	 * Gated: no-op (with log) when the webview liveness monitor experiment is
	 * disabled.
	 */
	public async refreshWebview(): Promise<void> {
		if (!this._isWebviewLivenessEnabled()) {
			this.log("[webview-lifecycle] refreshWebview: skipped (webview liveness monitor experiment disabled)")
			return
		}
		const view = this.view
		if (!view || this._disposed) {
			return
		}
		this._webviewResetCount++
		this.log(
			`[webview-lifecycle] refreshWebview: user-initiated forceful reset (session reset #${this._webviewResetCount})`,
		)
		this._stopHeartbeat()
		this.clearWebviewResources()

		// Step 1: explicit clear so the browser unloads the old frame before
		// we start building the new HTML (avoids flash of old content during
		// the async getHtmlContent call).
		view.webview.html = ""

		// Step 2: build new HTML (HMR in dev, production bundle otherwise).
		const html =
			this.contextProxy.extensionMode === vscode.ExtensionMode.Development
				? await this.getHMRHtmlContent(view.webview)
				: await this.getHtmlContent(view.webview)

		// Step 3: focus the webview AND steal focus into it (the `true` arg).
		// We need true here, not false, because:
		//   (a) the workbench reload command (step 5) targets the *focused*
		//       webview, and the overflow-menu click that triggered us moved
		//       focus into the menu, not into the webview;
		//   (b) when the iframe has been re-parented into VS Code's
		//       position-anchor overlay layer (the post-crash symptom we
		//       captured), forcing focus dislodges it back into its normal
		//       view slot.
		// Trade-off: the sidebar briefly steals focus from the editor. That's
		// acceptable for a manual recovery action.
		if ("show" in view) {
			;(view as vscode.WebviewView).show(true)
		} else {
			;(view as vscode.WebviewPanel).reveal(undefined, false)
		}

		// Step 4: assign the new HTML content.
		view.webview.html = html
		this.setWebviewMessageListener(view.webview)

		// Step 5: belt-and-suspenders — ask the VS Code workbench to navigate
		// the webview frame at the browser level. This is what "Developer:
		// Reload Webviews" does and is more forceful than a plain html
		// assignment when the renderer is stuck / IPC channel is dead. Wrapped
		// in a try/catch because the command may not be available in all
		// VS Code versions or code-server builds.
		//
		// We yield to the event loop first (50 ms) so the focus shift from
		// step 3 has time to settle — `workbench.action.webview.reloadWebviewAction`
		// resolves its target by looking up the *currently focused* webview at
		// command-execution time, and without the delay it can still see the
		// overflow menu (or whatever had focus before our `show(true)`).
		await new Promise((resolve) => setTimeout(resolve, 50))
		try {
			await vscode.commands.executeCommand("workbench.action.webview.reloadWebviewAction")
		} catch {
			this.log(
				"[webview-lifecycle] refreshWebview: workbench reload command unavailable, relying on html reassignment only",
			)
		}
	}

	/**
	 * Re-assigns `webview.html` to force a full reload of the renderer.
	 *
	 * @param trigger What caused this reset — `"heartbeat_timeout"` (automatic),
	 * `"fatal_error"` (webview crash report), or `"manual"` (user clicked
	 * Refresh Webview). Used for diagnostic logging only.
	 *
	 * Gated: no-op when the webview liveness monitor experiment is disabled.
	 */
	private async _resetWebview(
		trigger: "heartbeat_timeout" | "fatal_error" | "manual" = "heartbeat_timeout",
	): Promise<void> {
		if (!this._isWebviewLivenessEnabled()) {
			return
		}
		const view = this.view
		if (!view || this._disposed) {
			return
		}

		// ── Dump heartbeat diagnostics before resetting ──────────────────────
		this._webviewResetCount++
		const rttHistory = [...this._heartbeatRttHistory]
		const rttSummary =
			rttHistory.length > 0
				? `min=${Math.min(...rttHistory)}ms avg=${Math.round(rttHistory.reduce((a, b) => a + b, 0) / rttHistory.length)}ms max=${Math.max(...rttHistory)}ms n=${rttHistory.length}`
				: "no RTT samples"
		const silentFor = this._lastPongTs > 0 ? Date.now() - this._lastPongTs : -1
		this.log(
			`[webview-lifecycle] _resetWebview: trigger=${trigger} resetCount=${this._webviewResetCount} heartbeatTicks=${this._heartbeatTickCount} silentFor=${silentFor}ms rtt=[${rttSummary}]`,
		)

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

		// Phase 3: H8 disposables removed

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
		if (this.pluginManager) {
			// Hand the shared slot to a surviving provider rather than emptying it. A
			// "Shofer in a new tab" provider is a SECOND provider over the same window and
			// installs ITS manager as the shared one; closing that tab disposes it (the tab
			// branch of `onDidDispose`) while the sidebar provider and its manager are
			// still alive and correct. `activeInstances` still contains `this` here — it is
			// removed at the end of dispose — hence the self-exclusion.
			releaseSharedPluginManager(
				this.pluginManager,
				findLast(
					Array.from(ShoferProvider.activeInstances),
					(instance) => instance !== this && !!instance.pluginManager,
				)?.pluginManager,
			)
			// Unregister this provider's code plugins from the process-wide registry so a
			// freshly built manager (e.g. after a reload) re-registers without colliding.
			await this.pluginManager.dispose()
			this.pluginManager = undefined
		}
		this.pluginManagerBuild = undefined
		this.pluginPanelManager.dispose()
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
				getHost().notifier.error(error.message)
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

		// Serve plugin UI bundles (design §6.8, P4): register the global + project
		// plugin base dirs so any enabled plugin's built UI module under them is
		// reachable as a `vscode-webview://` resource (converted via `asWebviewUri`).
		// Registering the parents (not per-plugin dirs) keeps enable/disable/install
		// working without recreating the webview. Non-existent dirs are simply inert.
		resourceRoots.push(vscode.Uri.file(path.join(getGlobalShoferDirectory(), "plugins")))
		if (this.cwd) {
			resourceRoots.push(vscode.Uri.file(path.join(this.cwd, ".shofer", "plugins")))
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

		// Initialize git index status subscription for the current workspace.

		// Listen for active editor changes to update code index status for the
		// current workspace.
		const activeEditorSubscription = vscode.window.onDidChangeActiveTextEditor(() => {
			// Update subscription when workspace might have changed.
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
					this.postInitState()
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
					this.postInitState()
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
		options?: { startTask?: boolean; keepCurrentTask?: boolean; maxMessages?: number },
	) {
		return time("createTaskWithHistoryItem", () => this._createTaskWithHistoryItemImpl(historyItem, options))
	}

	private async _createTaskWithHistoryItemImpl(
		historyItem: HistoryItem & { rootTask?: Task; parentTask?: Task },
		options?: { startTask?: boolean; keepCurrentTask?: boolean; maxMessages?: number },
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
					this.backgroundCurrentTask()
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
				await this.postInitState()
				if (process.env.DEBUG) {
					this.debug(`[task-switch] id=${historyItem.id} (live-instance swap, timing via @perf)`)
				}
				return liveInstance
			}
		}

		if (!isRehydratingCurrentTask) {
			// If keepCurrentTask is true (parallel task switching), background the
			// current task — off the stack, still running, still addressable by id.
			// Otherwise, use removeShoferFromStack which aborts the current task.
			if (options?.keepCurrentTask) {
				this.backgroundCurrentTask()
			} else {
				await this.removeShoferFromStack()
			}
		}

		// Workflow tasks are driven by a slang loop, not an LLM loop. Reconstruct
		// the WorkflowTask subclass (recompiling the agent programs from the
		// persisted slang source and rehydrating FlowState) rather than a plain
		// Task. This is gated on the persisted `isWorkflow` flag so ordinary task
		// restoration is completely unaffected. We branch here — before the mode
		// / provider-profile restoration below — because a workflow's `mode` is a
		// synthetic flow name that does not exist in customModes and would
		// otherwise trip the "mode no longer exists" fallback.
		if (historyItem.isWorkflow && historyItem.slangSource) {
			const workflowTask = await this._restoreWorkflowTask(historyItem, isRehydratingCurrentTask, options)
			if (workflowTask) return workflowTask
			// Fall through to plain-Task restoration on reconstruction failure
			// (already logged) so the task history entry is at least viewable.
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

		const { apiConfiguration, experiments, cloudUserInfo, taskSyncEnabled } = await this.getState()

		// LLM hint: Preload-before-publish fix for the task-switch home-screen
		// flash. We construct the Task with `startTask: false` so the
		// constructor does NOT fire-and-forget `resumeTaskFromHistory()`. We
		// then explicitly preload `shoferMessages` from disk via
		// `preloadShoferMessages()` BEFORE the task is pushed onto
		// `shoferStack` (i.e. before it becomes `getCurrentTask()`), guaranteeing
		// that any concurrent `postInitState()` call landing in the
		// rehydration window (e.g. from a background task's
		// `addToShoferMessages`, or from an unrelated webview round-trip) reads
		// a non-empty messages array and the home screen never wins a render.
		// Finally we trigger the resume turn via `startFromHistory()` AFTER the
		// task is on the stack. See [todos/task-switch-home-screen-flash.md].
		const originalStartTask = options?.startTask ?? true

		const task = new Task({
			provider: this,
			apiConfiguration,
			consecutiveMistakeLimit: apiConfiguration.consecutiveMistakeLimit,
			historyItem,
			experiments,
			rootTask: historyItem.rootTask,
			parentTask: historyItem.parentTask,
			taskNumber: historyItem.number,
			workspacePath: historyItem.workspace,
			onCreated: this.taskCreationCallback,
			startTask: false,
			// Drives the task's own resume bookkeeping (a `completed` lifecycle
			// surfaces a `resume_completed_task` ask). The persisted `taskState`
			// is owned solely by TaskManager — this is NOT used to seed it.
			initialState: historyItem.taskState ?? { lifecycle: "idle" },
		})

		// Populate `shoferMessages` (and `apiConversationHistory`) on the new
		// task BEFORE it is observable as `getCurrentTask()`. This is the
		// critical ordering: addShoferToStack / in-place swap below must see a
		// task whose messages are already non-empty.
		//
		// T1.B: When `maxMessages` is set, read only the tail of the JSONL
		// logs. This avoids reading + parsing the full history for long tasks
		// on cold switch.
		await task.preloadShoferMessages(options?.maxMessages)

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

		// Check if there's a pending edit left by a timeline rewind
		const operationId = `task-${task.taskId}`
		const pendingEdit = this.getPendingEditOperation(operationId)
		if (pendingEdit) {
			this.clearPendingEditOperation(operationId) // Clear the pending edit

			this.debug(`[createTaskWithHistoryItem] Processing pending edit after a timeline rewind`)

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

	/**
	 * Reconstruct and publish a {@link WorkflowTask} from a persisted workflow
	 * HistoryItem, mirroring the stack/publish handling of plain-task
	 * restoration. Returns the live WorkflowTask, or `undefined` if
	 * reconstruction failed (the caller then falls back to plain-Task
	 * restoration so the history entry remains viewable).
	 *
	 * The slang loop is only (re)started when the persisted flow status is
	 * non-terminal; terminal flows (converged / deadlock / budget_exceeded /
	 * error) are restored read-only.
	 */
	private async _restoreWorkflowTask(
		historyItem: HistoryItem & { rootTask?: Task; parentTask?: Task },
		isRehydratingCurrentTask: boolean | undefined,
		options?: { startTask?: boolean; keepCurrentTask?: boolean },
	): Promise<WorkflowTask | undefined> {
		const { createWorkflowTaskFromHistory, TERMINAL_FLOW_STATUSES } = await import("../workflow/WorkflowTask")

		let workflowTask: WorkflowTask
		try {
			workflowTask = await createWorkflowTaskFromHistory(this, historyItem)
		} catch (error) {
			this.log(
				`[createTaskWithHistoryItem] Failed to reconstruct workflow task ${historyItem.id}: ` +
					`${error instanceof Error ? error.message : String(error)}. Falling back to plain task.`,
			)
			return undefined
		}

		// Preload-Before-Publish invariant: populate shoferMessages (and
		// apiConversationHistory) from disk BEFORE the task goes onto the
		// stack, just like the plain-task path does at line ~1688. Without
		// this, WorkflowView renders the empty-stream "Starting workflow…"
		// spinner on restore because the task's shoferMessages is [] at the
		// moment showTaskWithId pushes its postInitState.
		await workflowTask.preloadShoferMessages()

		if (isRehydratingCurrentTask) {
			const stackIndex = this.shoferStack.length - 1
			const oldTask = this.shoferStack[stackIndex]
			try {
				await oldTask.abortTask(true)
			} catch (e) {
				this.log(
					`[createTaskWithHistoryItem] abortTask() failed for old task ${oldTask.taskId}.${oldTask.instanceId}: ${e instanceof Error ? e.message : String(e)}`,
				)
			}
			const cleanupFunctions = this.taskEventListeners.get(oldTask)
			if (cleanupFunctions) {
				cleanupFunctions.forEach((cleanup) => cleanup())
				this.taskEventListeners.delete(oldTask)
			}
			this.shoferStack[stackIndex] = workflowTask
			workflowTask.emit(ShoferEventName.TaskFocused)
			this.taskManager.updateTaskInstance(workflowTask.taskId, workflowTask)
			await this.performPreparationTasks(workflowTask)
		} else {
			await this.addShoferToStack(workflowTask)
		}

		const shouldStart = options?.startTask ?? true
		if (shouldStart && !TERMINAL_FLOW_STATUSES.has(workflowTask.flowState.status)) {
			// Escalation waits are persisted as "escalated"; on resume the human is
			// re-engaging, so return the flow to "running" and re-drive the loop.
			if (workflowTask.flowState.status === "escalated") {
				workflowTask.flowState.status = "running"
			}
			void workflowTask.start()
		}

		this.debug(
			`[createTaskWithHistoryItem] workflow task ${workflowTask.taskId}.${workflowTask.instanceId} ` +
				`restored (status=${workflowTask.flowState.status})`,
		)
		return workflowTask
	}

	/**
	 * Record which task's logs the webview "Logs" tab is currently watching.
	 * Called from the `requestTaskLogs` handler. Switching tasks drops any
	 * pending lines for the previous task — the new task's snapshot (sent
	 * immediately after) is authoritative, and live lines resume from there.
	 */
	public setLogsWatchTaskId(taskId: string | undefined): void {
		// Always drop pending lines: every call is paired with a fresh snapshot
		// sent right after, so any buffered line would otherwise be delivered
		// twice (once in the snapshot, once in the next live batch).
		this._pendingLogLines = []
		this._logsWatchTaskId = taskId
	}

	/** Flush coalesced log lines to the watched task's "Logs" tab. */
	private flushPendingLogLines(): void {
		this._logFlushTimer = undefined
		const lines = this._pendingLogLines
		const taskId = this._logsWatchTaskId
		this._pendingLogLines = []
		if (lines.length === 0 || !taskId) return
		void this.postMessageToWebview({
			type: "taskLogAppended",
			taskLogTaskId: taskId,
			taskLogLines: lines,
		})
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

	/**
	 * Lazily construct the declarative {@link PluginManager} (design §7) and install
	 * it as the process-wide shared instance so core subsystems (McpHub, command
	 * service) and src subsystems (SkillsManager, CustomModesManager) pick up plugin
	 * contributions. Scans `<extensionPath>/dist/plugins` (bundled first-party),
	 * `~/.shofer/plugins` (global) and `<cwd>/.shofer/plugins` (project); enabled
	 * state is persisted in globalState.
	 */
	public getPluginManager(): Promise<PluginManager> {
		if (this.pluginManager) {
			// Re-assert the shared slot instead of assuming it still points somewhere: a
			// second provider over this window may have installed its own manager and then
			// released it on dispose with no successor to hand it to.
			adoptSharedPluginManager(this.pluginManager)
			return Promise.resolve(this.pluginManager)
		}
		// Memoize the in-flight build so concurrent callers share ONE manager. Building
		// is async (discovery), and `this.pluginManager` is only assigned at the end;
		// without this, two concurrent callers each build a manager and both register the
		// same code plugins into the process-wide registry → "already registered". Cleared
		// on dispose so a reloaded provider rebuilds.
		if (!this.pluginManagerBuild) this.pluginManagerBuild = this.buildPluginManager()
		return this.pluginManagerBuild
	}

	private async buildPluginManager(): Promise<PluginManager> {
		const stateKey = "shofer.plugins.enabledPlugins"
		// Explicit "off" decisions. Needed because a bundled plugin declaring
		// `defaultEnabled` is on when it appears in NEITHER list, so "not enabled" alone
		// cannot express "the user turned this off".
		const disabledKey = "shofer.plugins.disabledPlugins"
		const aiConsentKey = "shofer.plugins.aiConsentedPlugins"
		// Explicit consent revocations — see the aiConsentStore comment below.
		const aiConsentRevokedKey = "shofer.plugins.aiConsentRevokedPlugins"
		const cwd = this.cwd
		const pluginDirs: PluginDir[] = [
			// First-party bundled plugins shipped inside the extension (design §7 —
			// bundled scope). Copied by esbuild into `<extensionPath>/dist/plugins`
			// (mirroring the tree-sitter-wasm copy). Scanned first ⇒ lowest precedence,
			// so a same-named global/project plugin can shadow a bundled one. Missing dir
			// (e.g. an unbundled dev run) discovers nothing — the manager tolerates it.
			{ dir: path.join(this.context.extensionPath, "dist", "plugins"), scope: "bundled" as const },
			{ dir: path.join(getGlobalShoferDirectory(), "plugins"), scope: "global" as const },
			...(cwd ? [{ dir: path.join(cwd, ".shofer", "plugins"), scope: "project" as const }] : []),
			// Host-provisioned plugin code (`SHOFER_PLUGIN_DIRS`) — read-only mounts a
			// deployment points at. LAST on purpose: discovery is last-wins per name, so
			// scanning these after the user and project roots is what stops either from
			// shadowing a name the host provisioned. Tagged `global` rather than given a
			// fourth PluginScope for the reason in computePluginDeclarationWiring — a new
			// scope member ripples into the webview type and the i18n keys for no gain;
			// what the panel actually needs to know is `readOnly`, which it gets.
			...governancePluginDirs().map((dir) => ({ dir, scope: "global" as const, readOnly: true })),
		]

		// Part F — `.shofer/plugins.json` declarations. Read the three scopes' plugin
		// declarations (+ the global scope's lock manifest), merge, resolve each declared
		// `source@version` into the content-addressed plugin cache, and fold the results
		// into discovery: append each resolved cache dir (so the manager discovers it),
		// seed its declared config, and enable it. Purely additive — with no plugins.json
		// anywhere this resolves nothing and behavior is byte-for-byte as before. Isolated
		// in try/catch so a declaration failure never blocks manager construction.
		try {
			const roots = resolveScopeRoots({
				globalStorageFsPath: this.contextProxy.globalStorageUri.fsPath,
				homeDir: os.homedir(),
				workspaceFolder: cwd,
			})
			// Distinct from the per-plugin STORAGE dir (`<globalStorage>/plugins`) — this
			// holds the resolver's materialized `<name>@<version>` plugin trees.
			const cacheBaseDir = path.join(this.contextProxy.globalStorageUri.fsPath, "plugins-cache")
			const { resolved, manifest, errors } = await loadPluginDeclarations(roots, cacheBaseDir)
			for (const message of errors) {
				this.log(`[plugins] declaration resolve error: ${message}`)
			}
			if (resolved.length > 0) {
				const existingConfigs =
					(this.contextProxy.getValue("pluginConfigs") as
						| Record<string, Record<string, unknown>>
						| undefined) ?? {}
				const existingEnabled = this.context.globalState.get<string[]>(stateKey) ?? []
				const wiring = computePluginDeclarationWiring(resolved, manifest, existingConfigs, existingEnabled)
				pluginDirs.push(...wiring.pluginDirs)
				// Persist BEFORE constructing the manager so `discover()` reads the enabled
				// set and `getPluginConfigs()` reads the seeded config on this same build.
				if (wiring.pluginConfigsChanged) {
					await this.contextProxy.setValue("pluginConfigs", wiring.pluginConfigs)
				}
				if (wiring.enabledChanged) {
					await this.context.globalState.update(stateKey, wiring.enabledPlugins)
				}
			}
		} catch (error) {
			this.log(`[plugins] failed to load .shofer/plugins.json declarations: ${String(error)}`)
		}

		const manager = new PluginManager({
			fs: createNodePluginFs(),
			pluginDirs,
			stateStore: {
				getEnabledPlugins: () => this.context.globalState.get<string[]>(stateKey) ?? [],
				setEnabledPlugins: async (names) => {
					await this.context.globalState.update(stateKey, names)
				},
				getDisabledPlugins: () => this.context.globalState.get<string[]>(disabledKey) ?? [],
				setDisabledPlugins: async (names) => {
					await this.context.globalState.update(disabledKey, names)
				},
			},
			// Phase 2: load enabled code plugins (`main`) and register their hooks.
			// The esbuild binary lives in the extension's dist/bin in production.
			// nodePaths points at the shipped self-contained plugin SDK so a plugin's
			// bare `@shofer/types` import resolves in the installed extension (where no
			// workspace node_modules exists); process.cwd() covers dev/test.
			// Module-resolution roots are derived from `extensionPath` by the loader
			// (`hostNodePaths`), which probes both host shapes: VS Code passes the
			// extension ROOT, a headless node passes the bundle directory itself. Hard-coding
			// `<extensionPath>/dist/plugin-sdk` here silently resolved to nothing on a
			// headless node, so no plugin importing `@shofer/types` could load there.
			codeLoader: createNodePluginCodeLoader({ extensionPath: this.context.extensionPath }),
			// Base host for each code plugin's restricted, permission-checked sandbox (§8).
			host: getHost(),
			// Per-plugin config (merged with manifest defaults) from ContextProxy.
			getPluginConfigs: () =>
				this.contextProxy.getValue("pluginConfigs") as Record<string, Record<string, unknown>> | undefined,
			// …and the `secret: true` half of it, which lives in the secret store instead.
			getPluginSecrets: () => this.readPluginSecrets(),
			workspacePath: cwd,
			// A repository-shaped plugin (worktrees) must be able to tell a multi-root
			// window apart from a single-root one; the webview cannot.
			workspaceFolders: vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath),
			// P6.G1 — host LLM/embeddings seam for `ctx.ai` (never leaks keys). Wired here
			// (not in @shofer/core) because it needs the extension's ProviderSettingsManager
			// + code-index embedder to reach buildApiHandler.
			aiProvider: this.buildPluginAiProvider(),
			// P7 — host seam for `ctx.agent.notify` (proactive agent-steering). Wired here
			// (not in @shofer/core) because it needs the provider's task stack + message
			// queue; gated on `permissions.agent` inside the manager.
			agentProvider: this.buildPluginAgentProvider(),
			// §5.6 — host seam for `ctx.mcp` (invoke a tool on a connected MCP server).
			// Wired here because the `McpHub` is the provider's, which is what makes a
			// plugin's call ride the SAME server processes and per-call header machinery
			// the agent's own `use_mcp_tool` does; gated on `permissions.mcpInvoke` inside
			// the manager.
			mcpProvider: this.buildPluginMcpProvider(),
			// §6.11 G9 — host seam for `ctx.task` (timeline markers + rewind). Wired here
			// because it needs the task stack, the message manager, and task persistence;
			// gated on `permissions.task` inside the manager.
			taskProvider: this.buildPluginTaskProvider(),
			// §6.11 — host seam for `ctx.host.search` (read-only index/symbol/diagnostics
			// queries). Wired here (not in @shofer/core) because it needs the extension's
			// CodeIndexManager / GitIndexManager / vscode symbol+diagnostics providers; gated
			// on `permissions.search` inside the manager.
			searchProvider: this.buildPluginSearchProvider(),
			// §6.8 — host seam for `ctx.ui` (extension→UI push). Delivers a plugin's UI
			// message to its mounted component(s) via the scoped, namespaced channel
			// (`postPluginUiMessage`); gated on a granted `permissions.ui` region inside the
			// manager. Wired here (not in @shofer/core) because it needs the webview provider.
			uiProvider: {
				post: (pluginName, message) => void this.postPluginUiMessage(pluginName, message),
				// §6.8 — open the plugin's UI bundle in a standalone WebviewPanel editor tab.
				// Region defaults to "sidebar-panel" (the drawer's former region); title to the
				// plugin name. The region is a granted PluginUiRegion by construction (ctx.ui only
				// exists for a permissions.ui plugin).
				showPanel: (pluginName, opts) =>
					void this.pluginPanelManager.openPluginUiPanel({
						pluginName,
						region: (opts?.region as PluginUiRegion) ?? "sidebar-panel",
						title: opts?.title ?? pluginName,
					}),
				// §6.8 — reveal Settings → Plugins, where the plugin's own toggle, config
				// form and billed-AI consent live. This is how a plugin that cannot act
				// until the user approves something takes them to the approval instead of
				// merely describing where it is.
				openSettings: () =>
					void this.postMessageToWebview({
						type: "action",
						action: "settingsButtonClicked",
						values: { section: "plugins" },
					}),
			},
			// Org governance (env-delivered): plugins an organization has suppressed —
			// including the bundled built-ins, which is how "disable the built-in
			// workflows/modes" works now that they ARE plugins. Not a user preference:
			// a listed plugin cannot be enabled from the Plugins panel.
			forceDisabledPlugins: governanceDisabledPlugins(),
			// The mirror: plugins THIS host was provisioned to run (`SHOFER_ENABLED_PLUGINS`).
			// A headless runner pod drops a plugin into the global scope and comes up running
			// it — no Plugins panel, and no per-host enable state to seed.
			forceEnabledPlugins: governanceEnabledPlugins(),
			// P6.G2 — per-plugin private storage base (`<globalStorage>/plugins/<name>`).
			storageBaseDir: path.join(this.contextProxy.globalStorageUri.fsPath, "plugins"),
			// P6.G1 — billed-AI consent (design §8), persisted independently of enable.
			// The revoked list records an explicit "no": a bundled `defaultEnabled`
			// plugin is consented by default, so absence from the consented list alone
			// cannot express a revocation.
			aiConsentStore: {
				getAiConsentedPlugins: () => this.context.globalState.get<string[]>(aiConsentKey) ?? [],
				setAiConsentedPlugins: async (names) => {
					await this.context.globalState.update(aiConsentKey, names)
				},
				getAiConsentRevokedPlugins: () => this.context.globalState.get<string[]>(aiConsentRevokedKey) ?? [],
				setAiConsentRevokedPlugins: async (names) => {
					await this.context.globalState.update(aiConsentRevokedKey, names)
				},
			},
		})
		await manager.discover()
		// Baseline for the on-disk config diff: without it the first external edit looks
		// like "every plugin changed" and would reload plugins whose config did not move.
		this.lastSeenPluginConfigs =
			(this.contextProxy.getValue("pluginConfigs") as Record<string, Record<string, unknown>> | undefined) ?? {}
		this.pluginManager = manager
		setSharedPluginManager(manager)
		// Load code plugins asynchronously — must NOT block task start (owner decision
		// #8). Discovery (declarative) is done; code-plugin hooks begin firing once
		// each finishes loading. Failures are warned + isolated inside activateCodePlugins.
		//
		// The MCP hub's plugin-contributed servers are connected on the far side of
		// that activation, and BOTH halves of the ordering are load-bearing:
		//
		//   - The hub reads contributions ONCE, in its constructor, from the shared
		//     plugin manager — which this method installs lazily, usually after the hub
		//     was built. A host with a Plugins panel papers over that on the next
		//     enable/disable (`resyncAfterPluginChange`); a HEADLESS host has no panel,
		//     no `.shofer/mcp.json` edit and no workspace-folder change, so without a
		//     re-sync here a plugin's `contributes.mcpServers` child is simply never
		//     spawned while the plugin itself looks perfectly loaded.
		//   - Waiting for ACTIVATION, rather than re-syncing the moment the manager
		//     exists, is what makes a contributed server's `${env:…}` interpolation
		//     resolve. `activateCodePlugins` awaits each plugin's `initialize` AND its
		//     registered services' `start`, which is where a plugin publishes the
		//     process env its own server is declared against. Spawning first won that
		//     race often enough to be observed both ways on one image, and losing it is
		//     silent: the child receives the literal `${env:NAME}` string.
		//
		// A server declared in a config FILE against a plugin's runtime env still races,
		// and cannot be fixed here — config is read before any plugin runs. The plugin's
		// own `contributes.mcpServers` is the route with an ordering guarantee.
		void manager
			.activateCodePlugins()
			.then(() => McpServerManager.getInstance(this.context, this))
			.then(async (hub) => {
				// The hub's own initial connect must finish first, or the re-sync races it.
				await hub.waitUntilReady()
				await hub.refreshProjectMcpServers()
			})
			.catch((error) =>
				this.log(
					`Failed to re-sync plugin-contributed MCP servers: ${error instanceof Error ? error.message : String(error)}`,
				),
			)
		return manager
	}

	/**
	 * Build the host {@link PluginAiProvider} seam that backs a consented plugin's `ctx.ai`
	 * (P6.G1). `buildHandler` resolves a provider profile — a named/id `profileRef`, or the
	 * active `apiConfiguration` when omitted — and returns the same `ApiHandler`
	 * `buildApiHandler` gives the main agent (the plugin never sees the settings or keys).
	 * `embed` reuses the **configured Code Index embedder** (the thinnest useful embedding
	 * seam; `profileRef` is accepted for symmetry but embeddings follow the Code Index
	 * config). Any resolution/embedding failure surfaces as a rejected promise to the plugin.
	 */
	private buildPluginAiProvider(): PluginAiProvider {
		const PLUGIN_TASK_ID = "shofer-plugin"
		return {
			buildHandler: async (profileRef?: string): Promise<ApiHandler> => {
				if (profileRef) {
					// Try by name, then by id (a profileRef may be either).
					let profile
					try {
						profile = await this.providerSettingsManager.getProfile({ name: profileRef })
					} catch {
						profile = await this.providerSettingsManager.getProfile({ id: profileRef })
					}
					return buildApiHandler(profile, { taskId: PLUGIN_TASK_ID })
				}
				const { apiConfiguration } = await this.getState()
				return buildApiHandler(apiConfiguration, { taskId: PLUGIN_TASK_ID })
			},
			embed: async (texts: string[]): Promise<number[][]> => {
				// The embedder — its provider, its model, its key — belongs to the plugin
				// that owns the index; core keeps no second copy of that configuration. A
				// plugin asking for embeddings gets whichever plugin provides them, or a
				// clear error saying to configure one.
				const embeddings = (await pluginRegistry
					.request("rag-indexing", "embed", { texts }, { workspacePath: this.cwd, cwd: this.cwd })
					.catch((error: unknown) => {
						throw new Error(
							`ctx.ai.embed: no embedder available — enable and configure the RAG Indexing plugin (${String(error)})`,
						)
					})) as number[][] | undefined
				if (!embeddings) {
					throw new Error(
						"ctx.ai.embed: no embedder available — enable and configure the RAG Indexing plugin.",
					)
				}
				return embeddings
			},
		}
	}

	/**
	 * Build the host {@link PluginAgentProvider} seam that backs a granted plugin's
	 * `ctx.agent.notify` (P7). Lets a plugin proactively steer the running agent:
	 *
	 * - `mode: "spawn"` ⇒ start a **new** task seeded with the message ({@link createTask}).
	 * - `mode: "queue"` (default) ⇒ enqueue into the target task's message queue (the same
	 *   {@link MessageQueueService} the webview "Send" uses), so the agent picks it up on its
	 *   next `ask()`. If the loop has already terminated (e.g. `attempt_completion` set
	 *   `abort`), the tested {@link Task.cancelAndProcessQueuedMessages} path is kicked so the
	 *   message isn't stranded.
	 * - `mode: "interrupt"` ⇒ **reduced** to the same queued-ASAP behavior (no fragile
	 *   mid-turn injection; see PLUGINS.md).
	 *
	 * The target is an explicit `opts.taskId` (resolved against the live task stack) or the
	 * current task. With no task to steer, it falls back to spawning so a proactive notify is
	 * never silently dropped.
	 */
	/**
	 * Continue an existing agent session for a plugin `spawn` that carries a
	 * `sessionId`, delivering `prompt` as the next message.
	 *
	 * This is what makes an output-contract re-prompt a CONTINUATION rather than
	 * a cold retry: the model still holds everything it derived on the first
	 * attempt, so it can fix the specific thing that failed instead of redoing
	 * the work and reproducing the same mistake.
	 *
	 * THROWS when the session is unknown. A silent fall-back to a fresh task
	 * would be the worst outcome available: the caller believes it is refining an
	 * answer, the model has no idea what is being referred to, and the "feedback"
	 * arrives as an opening message with no context. Failing here is loud, and
	 * the caller can decide to start over deliberately.
	 */
	private async resumePluginSession(sessionId: string, prompt: string, mode?: string): Promise<Task> {
		// A task is only "warm" while its LOOP is still running. Being on the
		// stack is not that test: `attempt_completion` sets `abort` and leaves the
		// instance in place, so a finished stake is found here and would be handed
		// a queued message nothing will ever drain — the caller then waits on a
		// task that has already stopped, forever. This is exactly the shape a
		// contract re-prompt takes (the answer failed, so the task HAS completed),
		// which is why the guard is the loop's liveness and not the lookup.
		const live = this.shoferStack.find((t) => t.taskId === sessionId)
		if (live && !live.abort && !live.abandoned) {
			live.messageQueueService.addMessage(prompt)
			return live
		}

		// Cold: the session finished (a completed stake being re-asked). Rehydrate
		// DORMANT, queue, then start — the same deterministic ordering
		// `API.resumeAndDeliver` uses for the AgentApi entry point. Rehydrating
		// with the default fire-and-forget start raced the queue: when the resume
		// ask won, it was published to the message stream and dispatched (a
		// headless node's ask handler spends the `--retry` budget declining it)
		// before the drain could answer it. With the queue populated before
		// `startFromHistory()`, `resumeTaskFromHistory` takes the queued message
		// AS the resumption and raises no ask at all.
		const { historyItem } = await this.getTaskWithId(sessionId)
		const task = await this.createTaskWithHistoryItem(historyItem, { startTask: false })
		// Re-apply the MODE's provider profile. Rehydration restores the mode (and
		// so the tool set) but not necessarily the profile — a headless host
		// deliberately skips restoring provider settings from history, because a
		// stale persisted profile must not override the node's runtime flags. The
		// consequence for a resumed session is that it silently drops onto the
		// node's DEFAULT model: verified live, a contract re-prompt continued the
		// right conversation with the right tools on the wrong model. So the same
		// resolution `createTask` performs for a fresh task is performed again
		// here — one rule, both entry points. Applied while the task is still
		// dormant, so the loop never runs a request on the wrong profile.
		await this.applyModeApiConfig(task, mode)
		task.messageQueueService.addMessage(prompt)
		task.startFromHistory()
		return task
	}

	/**
	 * Point `task` at the provider profile `mode` is associated with, if any.
	 *
	 * Per-task only — the global active profile is untouched, exactly as
	 * `createTask`'s `initialApiConfigName` seeding is. A mode with no
	 * association, or a profile that will not load, leaves the task on whatever
	 * it already had rather than failing the run: the association is a
	 * refinement of the node's default, not a precondition for running at all.
	 */
	private async applyModeApiConfig(task: Task, mode: string | undefined): Promise<void> {
		if (!mode) {
			return
		}
		const name = await this.resolveModeApiConfigName(mode)
		if (!name) {
			return
		}
		try {
			const profile = await this.providerSettingsManager.getProfile({ name })
			if (profile?.apiProvider) {
				task.updateApiConfiguration(profile)
			}
		} catch (error) {
			this.log(
				`[applyModeApiConfig] Failed to load API profile "${name}" for mode "${mode}"; ` +
					`keeping the task's current configuration: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	/**
	 * Build the host {@link PluginMcpProvider} seam that backs a granted plugin's
	 * `ctx.mcp.callTool` (§5.6).
	 *
	 * The hub is resolved PER CALL rather than captured: it is constructed
	 * asynchronously (and re-created when the MCP configuration changes), while the
	 * plugin manager — and therefore this seam — is built once. A captured hub would
	 * be either absent forever on a host whose plugins loaded first, or stale.
	 *
	 * The call goes through `McpHub.callTool`, deliberately, and not through a
	 * connection's client: that method is the layer that resolves the per-call header
	 * seam and stamps `_meta`, so a plugin's call reaches the same server process with
	 * the same run credential the agent's own `use_mcp_tool` would carry. It does NOT
	 * go through `runMcpToolCall`, which needs a `Task` to narrate into — a plugin call
	 * has no task, no chat row and no approval; the manifest grant is its gate.
	 */
	private buildPluginMcpProvider(): PluginMcpProvider {
		return {
			callTool: async (serverName, toolName, args, opts) => {
				const mcpHub = this.getMcpHub()
				if (!mcpHub) {
					throw new Error(
						`ctx.mcp.callTool ${serverName}/${toolName}: this host has no MCP hub, so no server is reachable.`,
					)
				}
				// `source` is undefined: a plugin names a server, and the hub resolves
				// whichever scope defined it. `toolCallId` is absent by construction — a
				// plugin call is not one of the model's tool calls, so there is no
				// provider id to join it to.
				return await mcpHub.callTool(
					serverName,
					toolName,
					args,
					undefined,
					opts?.taskId,
					undefined,
					opts?.signal,
				)
			},
		}
	}

	private buildPluginAgentProvider(): PluginAgentProvider {
		return {
			notify: async (message: string, opts): Promise<void> => {
				const mode = opts?.mode ?? "notify"
				// spawn: a self-contained new task seeded with the message.
				if (mode === "spawn") {
					await this.createTask(message)
					return
				}
				const target =
					(opts?.taskId ? this.shoferStack.find((t) => t.taskId === opts.taskId) : undefined) ??
					this.getCurrentTask()

				// notify: one-way event → the target's notification queue, drained into the
				// system prompt on its next real agent request. Delivered ONLY to a task whose
				// loop is running (drains on the next request); if there is no live target we
				// drop it by design — notifications are for in-flight steering, not cold start.
				if (mode === "notify") {
					if (!target) return
					target.peerNotificationQueue.push({
						senderTaskId: "",
						senderTitle: opts?.source ?? "notification",
						message,
						timestamp: Date.now(),
						kind: "notification",
						source: opts?.source,
					})
					return
				}

				// queue / interrupt: use the user-message queue.
				if (!target) {
					// Nothing to steer — don't drop the message; start a task with it instead.
					await this.createTask(message)
					return
				}
				target.messageQueueService.addMessage(message)
				// interrupt: Send-Now semantics — abort the current turn (same instance) and
				// resume with the queued message. queue: leave it for the next turn's drain.
				if (mode === "interrupt") {
					await target.cancelAndProcessQueuedMessages()
				}
			},
			// §14: awaitable, cancellable job control. Starts a task and returns a handle whose
			// result() settles on the task's completion/abort, with task-scoped events + cancel.
			spawn: async (prompt, opts): Promise<PluginTaskHandle> => {
				// An unknown mode is REFUSED, never demoted. `createTask` would
				// happily seed a slug nothing defines, and the task would then run
				// with the fallback mode's tool set and the fallback mode's API
				// profile — a different agent, on a different model, reporting
				// success. The caller asked for a specific one; say so instead.
				if (opts?.mode) {
					await this.assertModeExists(opts.mode)
				}
				// `completionSchema` reshapes the task's `attempt_completion` tool so a
				// provider with constrained decoding enforces the caller's output
				// contract at decode time. `mode` picks the tool set the task starts
				// with — and, through `resolveModeApiConfigName`, the provider profile
				// its LLM calls go to. Both must be threaded here: a plugin passing
				// them into a host that dropped them would see a task that ignores its
				// contract and reports success, which is the failure the contract
				// exists to catch.
				const task = opts?.sessionId
					? await this.resumePluginSession(opts.sessionId, prompt, opts?.mode)
					: await this.createTask(prompt, opts?.images, undefined, {
							...(opts?.completionSchema ? { completionSchema: opts.completionSchema } : {}),
							...(opts?.mode ? { initialMode: opts.mode } : {}),
						})
				const taskId = task.taskId
				const metadata = opts?.metadata
				let settle: ((r: PluginTaskResult) => void) | undefined
				const resultPromise = new Promise<PluginTaskResult>((res) => {
					settle = res
				})
				const cleanup = () => {
					task.off(ShoferEventName.TaskCompleted, onCompleted)
					task.off(ShoferEventName.TaskAborted, onAborted)
				}
				const onCompleted = () => {
					cleanup()
					// The ANSWER, not just the fact of an answer. `attempt_completion`
					// renders its result as the task's last `completion_result` say
					// before it emits TaskCompleted, so the message is already on the
					// task when this runs — read in memory rather than from history,
					// which would race the persist. Without this a caller that awaits
					// `result()` learns only that the agent finished, and anything
					// downstream binding the answer (a Slang `-> @out`, an output
					// contract) sees `undefined` and can only ever fail.
					settle?.({ taskId, status: "completed", output: lastCompletionResult(task), metadata })
				}
				const onAborted = () => {
					cleanup()
					settle?.({ taskId, status: "aborted", metadata })
				}
				task.on(ShoferEventName.TaskCompleted, onCompleted)
				task.on(ShoferEventName.TaskAborted, onAborted)
				return {
					taskId,
					result: () => resultPromise,
					onEvent: (cb: (event: PluginEvent) => void) => {
						const handler = (data: { action: "created" | "updated" }) =>
							cb({
								name: ShoferEventName.Message,
								taskId,
								properties: { action: data.action },
								timestamp: Date.now(),
							})
						task.on(ShoferEventName.Message, handler)
						return () => task.off(ShoferEventName.Message, handler)
					},
					cancel: async () => {
						await task.abortTask(true)
					},
				}
			},
			cancel: async (taskId: string): Promise<void> => {
				const target = this.shoferStack.find((t) => t.taskId === taskId)
				if (target) await target.abortTask(true)
			},
		}
	}

	/**
	 * Build the host {@link PluginTaskProvider} seam backing a granted plugin's `ctx.task`
	 * — the chat **timeline**: marker rows and rewind.
	 *
	 * - `marker` ⇒ a persisted `say: "plugin_marker"` row on the target task, tagged with
	 *   the owning plugin so only that plugin's UI component renders it. Non-interactive,
	 *   so appending one never disturbs a pending ask.
	 * - `listMarkers` ⇒ that plugin's markers, read from the live task when it is on the
	 *   stack and from persisted messages otherwise (a plugin must be able to recover its
	 *   anchors for a task the user has not reopened).
	 * - `rewind` ⇒ truncate the chat to `ts`, report the discarded API cost, and restart
	 *   the task loop against the shortened history. This is the chat half of a restore;
	 *   rolling back anything outside the conversation is the plugin's own job, done
	 *   before it calls this.
	 */
	private buildPluginTaskProvider(): PluginTaskProvider {
		const resolveTask = (taskId?: string): Task | undefined =>
			(taskId ? this.shoferStack.find((t) => t.taskId === taskId) : undefined) ?? this.getCurrentTask()

		const toMarkers = (messages: ShoferMessage[], pluginName: string): PluginMarker[] =>
			messages
				.filter((m) => m.say === "plugin_marker" && m.marker?.pluginName === pluginName)
				.map((m) => ({
					ts: m.ts,
					pluginName,
					kind: m.marker!.kind,
					text: m.text ?? "",
					data: m.marker!.data,
					restorable: m.marker!.restorable,
					suppress: m.marker!.suppress,
				}))

		return {
			marker: async (pluginName, input): Promise<void> => {
				const task = resolveTask(input.taskId)
				if (!task) {
					throw new Error(`[plugin:${pluginName}] ctx.task.marker: no task to append to`)
				}
				await task.say(
					"plugin_marker",
					input.text,
					undefined /* images */,
					undefined /* partial */,
					undefined /* progressStatus */,
					{
						isNonInteractive: true,
						marker: {
							pluginName,
							kind: input.kind,
							data: input.data,
							restorable: input.restorable,
							suppress: input.suppress,
						},
					},
				)
			},

			listMarkers: async (pluginName, taskId): Promise<PluginMarker[]> => {
				const live = resolveTask(taskId)
				if (live && (!taskId || live.taskId === taskId)) {
					return toMarkers(live.shoferMessages, pluginName)
				}
				if (!taskId) return []
				const { readTaskMessages } = await import("@shofer/core")
				const messages = (await readTaskMessages({
					taskId,
					globalStoragePath: this.contextProxy.globalStorageUri.fsPath,
				})) as ShoferMessage[]
				return toMarkers(messages, pluginName)
			},

			openTask: async (pluginName, opts): Promise<string> => {
				// The same path the chat input takes for a parallel task: the current task
				// keeps running in the background and the new one is focused. With no text
				// it lands idle, waiting for the user — a plugin opening a task has prepared
				// a place to work, not a prompt.
				const taskId = await this.createManagedTask(opts?.name, opts?.text, opts?.images, opts?.cwd, {
					mode: opts?.mode,
				})
				if (!taskId) {
					throw new Error(`[plugin:${pluginName}] ctx.task.openTask: the host could not create a task`)
				}
				this.log(`[plugin:${pluginName}] opened task ${taskId} in ${opts?.cwd ?? "the workspace"}`)
				return taskId
			},

			setCwd: async (pluginName, cwd, taskId): Promise<void> => {
				const task = resolveTask(taskId)
				if (!task) {
					throw new Error(`[plugin:${pluginName}] ctx.task.setCwd: no task to re-point`)
				}

				// A workflow that has already started has agents with work on disk in the
				// old directory; moving it now would desync the two. Refuse loudly — the
				// caller is a UI action the user just took.
				const { WorkflowTask } = await import("../workflow/index")
				if (task instanceof WorkflowTask && task.flowState.started) {
					throw new Error(
						`[plugin:${pluginName}] ctx.task.setCwd: workflow ${task.taskId} has already started its agents`,
					)
				}

				task.reassignCwd(cwd)
				// Persist so the task rehydrates into the same directory later.
				try {
					const { historyItem } = await this.getTaskWithId(task.taskId)
					await this.updateTaskHistory({ ...historyItem, cwd })
				} catch {
					// Not in history yet — the task's next metadata save carries the cwd.
				}
				await this.postInitState()
				this.log(`[plugin:${pluginName}] task ${task.taskId} re-pointed to ${cwd}`)
			},

			rewind: async (pluginName, ts, opts): Promise<void> => {
				const task = this.getCurrentTask()
				if (!task) {
					throw new Error(`[plugin:${pluginName}] ctx.task.rewind: no current task`)
				}
				const index = task.shoferMessages.findIndex((m) => m.ts === ts)
				if (index === -1) {
					throw new Error(`[plugin:${pluginName}] ctx.task.rewind: no message at ts ${ts}`)
				}

				// Account for the requests about to be discarded BEFORE truncating — the
				// messages carrying that usage are what the rewind removes.
				const discarded = task.combineMessages(task.shoferMessages.slice(index + 1))
				const { totalTokensIn, totalTokensOut, totalCacheWrites, totalCacheReads, totalCost } =
					getApiMetrics(discarded)

				// MessageManager (not a raw splice) so orphaned condense/truncation markers
				// are cleaned up with the messages they refer to.
				await task.messageManager.rewindToTimestamp(ts, {
					includeTargetMessage: opts?.includeTargetMessage ?? false,
				})

				await task.say(
					"api_req_deleted",
					JSON.stringify({
						tokensIn: totalTokensIn,
						tokensOut: totalTokensOut,
						cacheWrites: totalCacheWrites,
						cacheReads: totalCacheReads,
						cost: totalCost,
					} satisfies ShoferApiReqInfo),
				)

				// Restart the loop so it runs against the truncated history.
				await this.cancelTask()
			},
		}
	}

	/**
	 * Build the host {@link PluginSearchProvider} seam that backs a granted plugin's
	 * `ctx.host.search` (§6.11). Read-only index/symbol/diagnostics queries, the same
	 * providers the built-in Live Memory reaches, mapped to plain DTOs (no `vscode` types
	 * cross the boundary):
	 *
	 * - `ragSearch` / `gitSearch` ⇒ the bundled `rag-indexing` plugin, asked over the
	 *   plugin registry. Core has no index of its own any more, but the seam stays: a
	 *   plugin that wants semantic search (Live Memory) should not have to know which
	 *   other plugin provides it, or whether one is installed at all.
	 * - `codeUsages` ⇒ `vscode.executeWorkspaceSymbolProvider`.
	 * - `diagnostics` ⇒ `vscode.languages.getDiagnostics`.
	 *
	 * Fail-soft (never throws): when a backing service is absent/unconfigured (e.g. the code
	 * index is off, or a headless workspace) the method returns an empty result, so a plugin
	 * can probe capabilities without special-casing. `permissions.search` gating happens in
	 * the manager; this seam is unconditionally read-only.
	 */
	private buildPluginSearchProvider(): PluginSearchProvider {
		return {
			ragSearch: async (query, opts) => {
				// Absent plugin, disabled index, nothing configured: all the same answer —
				// no results. `ctx.host.search` is documented fail-soft so a plugin can probe
				// for a capability without special-casing its absence.
				const results = (await pluginRegistry
					.request(
						"rag-indexing",
						"search",
						{ query, directoryPrefix: opts?.directoryPrefix, maxResults: opts?.maxResults },
						{ workspacePath: this.cwd, cwd: this.cwd },
					)
					.catch(() => [])) as
					| {
							score?: number
							payload?: { filePath?: string; startLine?: number; endLine?: number; codeChunk?: string }
					  }[]
					| undefined
				return (results ?? []).map((r) => ({
					filePath: r.payload?.filePath ?? "",
					startLine: r.payload?.startLine ?? 0,
					endLine: r.payload?.endLine ?? 0,
					score: r.score ?? 0,
					snippet: (r.payload?.codeChunk ?? "").slice(0, 800),
				}))
			},
			gitSearch: async (query, opts) => {
				const results = (await pluginRegistry
					.request(
						"rag-indexing",
						"git-search",
						{ query, maxResults: opts?.maxResults },
						{ workspacePath: this.cwd, cwd: this.cwd },
					)
					.catch(() => [])) as
					| {
							score: number
							payload: {
								commit_hash: string
								short_hash: string
								author: string
								author_date: string
								subject: string
								body?: string
							}
					  }[]
					| undefined
				return (results ?? []).map((r) => ({
					commitHash: r.payload.commit_hash,
					shortHash: r.payload.short_hash,
					author: r.payload.author,
					authorDate: r.payload.author_date,
					subject: r.payload.subject,
					body: r.payload.body ?? "",
					score: r.score,
				}))
			},
			codeUsages: async (symbol, opts) => {
				const cwd = this.cwd
				const symbols =
					(await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
						"vscode.executeWorkspaceSymbolProvider",
						symbol,
					)) ?? []
				const filtered = opts?.filePath
					? symbols.filter((s) => {
							const rel = cwd ? path.relative(cwd, s.location.uri.fsPath) : s.location.uri.fsPath
							return (
								rel === opts.filePath ||
								rel.startsWith(opts.filePath!) ||
								s.location.uri.fsPath === opts.filePath
							)
						})
					: symbols
				const limited = opts?.maxResults ? filtered.slice(0, opts.maxResults) : filtered
				return limited.map((s) => ({
					name: s.name,
					kind: vscode.SymbolKind[s.kind],
					filePath: cwd ? path.relative(cwd, s.location.uri.fsPath) : s.location.uri.fsPath,
					line: s.location.range.start.line + 1,
				}))
			},
			diagnostics: async (filterPath) => {
				const cwd = this.cwd
				const out: {
					filePath: string
					line: number
					column: number
					severity: "error" | "warning" | "info" | "hint"
					message: string
					source?: string
				}[] = []
				const sevMap = {
					[vscode.DiagnosticSeverity.Error]: "error" as const,
					[vscode.DiagnosticSeverity.Warning]: "warning" as const,
					[vscode.DiagnosticSeverity.Information]: "info" as const,
					[vscode.DiagnosticSeverity.Hint]: "hint" as const,
				}
				for (const [uri, diags] of vscode.languages.getDiagnostics()) {
					const rel = cwd ? path.relative(cwd, uri.fsPath) : uri.fsPath
					if (filterPath && rel !== filterPath && !rel.startsWith(filterPath)) continue
					for (const d of diags) {
						out.push({
							filePath: rel,
							line: d.range.start.line + 1,
							column: d.range.start.character + 1,
							severity: sevMap[d.severity],
							message: d.message,
							source: d.source,
						})
					}
				}
				return out
			},
		}
	}

	/**
	 * Reload every loaded plugin whose effective config changed on disk, so an external
	 * `.shofer/settings.json` edit reaches a running plugin's `ctx.config`.
	 *
	 * Reloads only the plugins whose own entry actually moved: `pluginConfigs` merges
	 * whole-value across scopes, so a change to ONE plugin's entry re-reports the whole
	 * map, and reloading every plugin would tear down unrelated services and watchers
	 * for nothing.
	 */
	private async reloadPluginsForConfigChange(): Promise<void> {
		try {
			const manager = await this.getPluginManager()
			const next =
				(this.contextProxy.getValue("pluginConfigs") as Record<string, Record<string, unknown>> | undefined) ??
				{}
			const previous = this.lastSeenPluginConfigs
			this.lastSeenPluginConfigs = next
			const names = manager
				.listPlugins()
				.map((p) => p.name)
				.filter((name) => JSON.stringify(previous?.[name]) !== JSON.stringify(next[name]))
			if (names.length === 0) {
				return
			}
			this.log(`[plugins] config changed on disk, reloading: ${names.join(", ")}`)
			await this.reloadPlugins(names)
			await this.pushPluginsState()
		} catch (error) {
			this.log(`[plugins] config-change reload failed: ${error instanceof Error ? error.message : String(error)}`)
		}
	}

	public async reloadPlugins(names: string[]): Promise<void> {
		if (names.length === 0) return
		const manager = await this.getPluginManager()
		for (const name of names) {
			await manager.reloadPlugin(name).catch((error: unknown) => {
				this.log(`[plugins] reload after config sync failed for ${name}: ${String(error)}`)
			})
		}
		await this.resyncAfterPluginChange()
	}

	/**
	 * Every plugin's stored secret config values, as `{ [plugin]: { [key]: value } }`.
	 *
	 * One `pluginSecrets` entry in the secret store rather than one per property:
	 * `SecretState` is a fixed, typed key set, and a plugin must not be able to mint new
	 * keys in it. A corrupt/absent blob reads as "no secrets", which degrades a plugin to
	 * unconfigured rather than breaking the whole panel.
	 */
	private readPluginSecrets(): Record<string, Record<string, string>> {
		const raw = this.contextProxy.getSecret("pluginSecrets")
		if (!raw) return {}
		try {
			const parsed = JSON.parse(raw) as unknown
			return parsed && typeof parsed === "object" ? (parsed as Record<string, Record<string, string>>) : {}
		} catch {
			return {}
		}
	}

	private async writePluginSecrets(all: Record<string, Record<string, string>>): Promise<void> {
		const populated = Object.fromEntries(Object.entries(all).filter(([, values]) => Object.keys(values).length > 0))
		await this.contextProxy.storeSecret(
			"pluginSecrets",
			Object.keys(populated).length > 0 ? JSON.stringify(populated) : undefined,
		)
	}

	/** Push the discovered-plugins snapshot to the webview (design §12). */
	public async pushPluginsState(): Promise<void> {
		const manager = await this.getPluginManager()
		const storedConfigs =
			(this.contextProxy.getValue("pluginConfigs") as Record<string, Record<string, unknown>> | undefined) ?? {}
		// `pluginConfigs` merges whole-value across the `.shofer/` scopes, so once ANY
		// scope supplies it every plugin's config is served from the file layer and a
		// panel edit would be shadowed. The panel is told so it can say that plainly.
		const configFromFileLayer = this.contextProxy.isManagedByFileLayer("pluginConfigs")
		const storedSecrets = this.readPluginSecrets()
		const secretKeysOf = (p: { manifest: { config?: unknown } }) =>
			pluginConfigSecretKeys(p.manifest.config as PluginConfigSchema | undefined)
		const plugins: PluginView[] = manager.listPlugins().map((p) => ({
			name: p.name,
			version: p.version,
			description: p.description,
			scope: p.scope,
			// First-party (bundled) plugins are non-uninstallable — the panel hides the
			// uninstall affordance for them (they ship with the extension).
			firstParty: p.firstParty,
			// Host-provisioned into a read-only mount — likewise non-uninstallable.
			readOnly: p.readOnly,
			enabled: p.enabled,
			// Surface *why* an enabled plugin is inactive (unmet dependency / cycle,
			// design §14.3) so the Plugins panel can show it (fail-closed).
			disabledReason: p.disabledReason,
			hasCode: p.hasCode,
			contributionCounts: p.contributionCounts,
			// P6.G1 — surface the billed-AI grant + consent so the panel can render the
			// "uses AI (billed)" badge and the separate consent affordance (design §8).
			usesAi: p.manifest.permissions?.ai === true,
			aiConsented: manager.isAiConsented(p.name),
			// Config schema (manifest `config`) + the user's stored overrides so the panel
			// can render an editable form. Absent schema ⇒ the panel shows no config section.
			configManagedBy: configFromFileLayer ? ("file-layer" as const) : undefined,
			configSchema: p.manifest.config as PluginView["configSchema"],
			// A `secret` property's VALUE never crosses to the webview — only whether one
			// is stored, so the panel can say "set" instead of showing a key.
			config: redactPluginSecretConfig(storedConfigs[p.name] ?? {}, secretKeysOf(p)),
			configSecretsSet: secretKeysOf(p).filter((key) => Boolean(storedSecrets[p.name]?.[key])),
		}))
		const state: PluginsState = { plugins }
		await this.postMessageToWebview({ type: "plugins", plugins: state })
	}

	/**
	 * Handle a Plugins-tab request (list / enable-disable / uninstall / install-from-file /
	 * install-from-url), then re-push state. Uninstall and both installs re-run discovery so
	 * the change is reflected immediately; install-from-file opens a native file picker for a
	 * local `.shofer-plugin` archive, install-from-url downloads a `.shofer-plugin` from a
	 * direct http(s) URL (registry lookup stays deferred, design §14 Q5).
	 */
	public async handlePluginRequest(request: PluginRequest): Promise<void> {
		const manager = await this.getPluginManager()
		switch (request.action) {
			case "setEnabled":
				await manager.setEnabled(request.name, request.enabled)
				await this.resyncAfterPluginChange()
				break
			case "setAiConsent":
				// P6.G1 — separate consent gate for billed AI calls (design §8). Reloads the
				// affected code plugin so its `ctx.ai` flips live/denied immediately.
				await manager.setAiConsent(request.name, request.consented)
				break
			case "setConfig": {
				// Persist the plugin's config overrides, then reload it so `ctx.config`
				// reflects the new values immediately (design §5/§6.2).
				//
				// The incoming object carries both halves; the split by `secret: true` is the
				// host's job, so a plugin author declares a credential once and never has to
				// route it. An empty string clears a secret (the panel's way of saying
				// "forget this key"); an ABSENT one leaves the stored value alone, so the
				// panel need not round-trip a value it is never shown.
				const declared = manager.listPlugins().find((p) => p.name === request.name)
				const secretKeys = pluginConfigSecretKeys(declared?.manifest.config as PluginConfigSchema | undefined)
				const { plain, secrets: incomingSecrets } = splitPluginConfigBySecrets(request.config, secretKeys)

				const all = {
					...((this.contextProxy.getValue("pluginConfigs") as
						| Record<string, Record<string, unknown>>
						| undefined) ?? {}),
				}
				all[request.name] = plain
				await this.contextProxy.setValue("pluginConfigs", all)

				if (Object.keys(incomingSecrets).length > 0) {
					const secrets = this.readPluginSecrets()
					secrets[request.name] = applyPluginSecretEdits(secrets[request.name], incomingSecrets)
					await this.writePluginSecrets(secrets)
				}

				await manager.reloadPlugin(request.name)
				await this.resyncAfterPluginChange()
				break
			}
			case "uninstall":
				await manager.uninstall(request.name)
				await this.resyncAfterPluginChange()
				break
			case "installFromFile":
				await this.installPluginFromFile(manager)
				break
			case "installFromUrl":
				await this.installPluginFromUrl(manager, request.url, request.enable)
				break
			case "list":
				break
		}
		await this.pushPluginsState()
	}

	/**
	 * Re-sync every discovery-dependent subsystem after a plugin's contributions change
	 * (enable/disable/install/uninstall) so the change takes effect without a reload.
	 */
	private async resyncAfterPluginChange(): Promise<void> {
		await this.skillsManager?.discoverSkills().catch(() => {})
		await this.mcpHub?.refreshProjectMcpServers().catch(() => {})
		this.customModesManager.invalidateCache()
		await this.postInitState().catch(() => {})
		// A change can add/remove UI contributions — re-push so slots update live.
		await this.pushPluginUiContributions().catch(() => {})
	}

	/**
	 * Open a native file picker for a local `.shofer-plugin` archive and install it into
	 * the global plugins dir (design §9, Phase 5.3). Unpacking is validated + zip-slip-safe
	 * (Phase 5.1); a bad archive surfaces as an error notification rather than a crash.
	 * A cancelled picker is a no-op.
	 */
	private async installPluginFromFile(manager: PluginManager): Promise<void> {
		const picked = await vscode.window.showOpenDialog({
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			filters: { "Shofer plugin": ["shofer-plugin"] },
			title: "Select a .shofer-plugin archive to install",
		})
		if (!picked || !picked[0]) {
			return
		}
		const globalPluginsDir = path.join(getGlobalShoferDirectory(), "plugins")
		try {
			const installed = await unpackPlugin(picked[0].fsPath, globalPluginsDir)
			// Rebuild discovery so the freshly written plugin dir is picked up.
			await manager.discover()
			await this.resyncAfterPluginChange()
			vscode.window.showInformationMessage(
				`Installed plugin "${installed.name}" v${installed.version}. Enable it in the Plugins tab.`,
			)
		} catch (error) {
			const message = error instanceof PluginPackError ? error.message : String(error)
			vscode.window.showErrorMessage(`Failed to install plugin: ${message}`)
		}
	}

	/**
	 * Install a plugin from a direct http(s) URL to a `.shofer-plugin` archive (design §9,
	 * Phase 5.3). Delegates the download + unpack to the core `installPluginFromUrl` helper
	 * (https-only + size-capped + zip-slip / manifest validated) — no download logic is
	 * duplicated here — then re-discovers so the freshly written plugin appears immediately.
	 * With `enable`, the plugin is turned on after install; otherwise it lands disabled like
	 * install-from-file. A bad URL / archive surfaces the helper's `PluginPackError` message
	 * as an error notification rather than a crash.
	 */
	private async installPluginFromUrl(manager: PluginManager, url: string, enable?: boolean): Promise<void> {
		const trimmed = url.trim()
		if (!trimmed) {
			vscode.window.showErrorMessage("Enter a plugin URL to install.")
			return
		}
		const globalPluginsDir = path.join(getGlobalShoferDirectory(), "plugins")
		try {
			const installed = await installPluginArchiveFromUrl(trimmed, globalPluginsDir, { overwrite: false })
			// Rebuild discovery so the freshly downloaded plugin dir is picked up.
			await manager.discover()
			if (enable) {
				await manager.setEnabled(installed.name, true)
			}
			await this.resyncAfterPluginChange()
			vscode.window.showInformationMessage(
				enable
					? `Installed and enabled plugin "${installed.name}" v${installed.version}.`
					: `Installed plugin "${installed.name}" v${installed.version}. Enable it in the Plugins tab.`,
			)
		} catch (error) {
			const message = error instanceof PluginPackError ? error.message : String(error)
			vscode.window.showErrorMessage(`Failed to install plugin: ${message}`)
		}
	}

	/**
	 * Push the enabled plugins' UI contributions per region to the webview (design
	 * §6.8, Phase 4). `PluginSlot` renders these; with zero UI-contributing plugins the
	 * snapshot is empty and every slot renders nothing (non-breaking).
	 */
	public async pushPluginUiContributions(): Promise<void> {
		const manager = await this.getPluginManager()
		// Resolve each external UI bundle's absolute module path to a served
		// `vscode-webview://` URI so the webview can dynamic-import it under the CSP
		// (`strict-dynamic` permits importing same-origin `cspSource` resources). When
		// no webview is attached yet, omit the resolver ⇒ contributions carry no
		// `source` and fall back to the co-bundled registry (non-breaking).
		const webview = this.view?.webview
		const resolveSource = webview
			? (absolutePath: string) => String(webview.asWebviewUri(vscode.Uri.file(absolutePath)))
			: undefined
		const contributions = manager.getContributedUiContributions(resolveSource)
		// Diagnostics (output channel) — the webview-side load result is a console.warn in
		// the webview devtools, invisible here; this shows whether the extension produced
		// and pushed contributions with a resolvable source at all.
		if (contributions.length === 0) {
			const uiPlugins = manager
				.listPlugins()
				.filter((p) => (p.manifest.permissions?.ui?.length ?? 0) > 0)
				.map((p) => `${p.name}(enabled=${p.enabled},inactive=${p.disabledReason ?? "no"})`)
			this.log(
				`[plugin-ui] pushing 0 UI contributions (webview ${webview ? "attached" : "DETACHED"}). ` +
					`Plugins declaring permissions.ui: ${uiPlugins.length ? uiPlugins.join(", ") : "(none)"}`,
			)
		} else {
			this.log(
				`[plugin-ui] pushing ${contributions.length} UI contribution(s) (webview ${webview ? "attached" : "DETACHED"}): ` +
					contributions
						.map(
							(c) =>
								`${c.pluginName}:${c.region}[${c.componentId}] ${c.source ? "src=" + c.source : "NO-SOURCE(co-bundled fallback)"}`,
						)
						.join(" | "),
			)
		}
		// The plugins' own translations travel with the contributions: a bundle cannot
		// reach the host's catalogue, and shipping them together means a mounted plugin
		// component always has its strings by the time it renders.
		const locales = await manager.getContributedLocales()
		await this.postMessageToWebview({
			type: "pluginUiContributions",
			pluginUiContributions: { contributions, locales },
		})
	}

	/**
	 * Route a scoped plugin-UI channel message (webview → extension) to its plugin's
	 * `onUiMessage` (design §6.8). Namespaced by `pluginName`: only that plugin's
	 * receiver fires. Delivery is error-isolated inside the registry.
	 */
	public async handlePluginUiMessage(envelope: PluginUiMessageEnvelope): Promise<void> {
		// A request expects an answer, so it goes to `handleRequest` (awaited, errors
		// reported back) rather than the fire-and-forget `onUiMessage` observer.
		if (isPluginUiRequest(envelope.message)) {
			await this.resolvePluginUiRequest(envelope.pluginName, envelope.message.__pluginRequest)
			return
		}
		await pluginRegistry.dispatchUiMessage(envelope.pluginName, envelope.message)
	}

	/**
	 * Resolve a plugin UI request against the in-process plugin instance and post
	 * the result back over the plugin's scoped channel.
	 */
	private async resolvePluginUiRequest(
		pluginName: string,
		request: { id: string; method: string; params?: unknown; mutates?: boolean },
	): Promise<void> {
		const respond = (payload: { result?: unknown; error?: string }) =>
			this.postPluginUiMessage(pluginName, { __pluginResponse: { id: request.id, ...payload } })

		try {
			const result = await pluginRegistry.request(pluginName, request.method, request.params, {
				taskId: this.getCurrentTask()?.taskId,
				cwd: this.getCurrentTask()?.cwd ?? this.cwd,
			})
			await respond({ result })
		} catch (error) {
			await respond({ error: error instanceof Error ? error.message : String(error) })
		}
	}

	/**
	 * Send a scoped plugin-UI channel message (extension → the plugin's UI). Namespaced
	 * by `pluginName` so only that plugin's mounted component(s) receive it. This is the
	 * host-side sender a plugin's extension code uses to push to its UI.
	 */
	public async postPluginUiMessage(pluginName: string, message: unknown): Promise<void> {
		await this.postMessageToWebview({
			type: "pluginUiMessage",
			pluginUiMessage: { pluginName, message },
		})
		// Fan out to any open standalone plugin panels for this plugin (design §6.8), so a
		// plugin's `ctx.ui` state pushes reach its editor-tab panel, not just the sidebar.
		this.pluginPanelManager.broadcast(pluginName, message)
	}

	private async getHMRHtmlContent(webview: vscode.Webview): Promise<string> {
		let localPort = "5173"

		try {
			const fs = require("fs")
			const path = require("path")
			const portFilePath = path.resolve(__dirname, "../../.vite-port")

			if (fs.existsSync(portFilePath)) {
				localPort = fs.readFileSync(portFilePath, "utf8").trim()
				webviewLog.info(`[ShoferProvider:Vite] Using Vite server port from ${portFilePath}: ${localPort}`)
			} else {
				webviewLog.info(
					`[ShoferProvider:Vite] Port file not found at ${portFilePath}, using default port: ${localPort}`,
				)
			}
		} catch (err) {
			webviewLog.error("[ShoferProvider:Vite] Failed to read Vite port file:", err)
		}

		const localServerUrl = `localhost:${localPort}`

		// Check if local dev server is running.
		try {
			await axios.get(`http://${localServerUrl}`)
		} catch (error) {
			getHost().notifier.error(t("common:errors.hmr_not_running"))
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

		// Shared-React import map for external plugin UI bundles (design §6.8, P4). In
		// HMR the shim modules are served from the Vite dev server's public dir. Mirrors
		// the prod map in getHtmlContent; unused when no plugin contributes UI.
		const pluginImportMap = JSON.stringify({
			imports: {
				react: `http://${localServerUrl}/plugin-host/react.js`,
				"react-dom": `http://${localServerUrl}/plugin-host/react-dom.js`,
				"react-dom/client": `http://${localServerUrl}/plugin-host/react-dom-client.js`,
				"react/jsx-runtime": `http://${localServerUrl}/plugin-host/jsx-runtime.js`,
				"react/jsx-dev-runtime": `http://${localServerUrl}/plugin-host/jsx-dev-runtime.js`,
				"@shofer/plugin-ui": `http://${localServerUrl}/plugin-host/plugin-ui.js`,
			},
		})

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
			// frame-src is required so the SlangViz srcdoc iframe (workflow
			// visualization) is permitted under default-src 'none'.
			"frame-src 'self'",
			"clipboard-read 'self'",
			"clipboard-write 'self'",
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
					<!-- Shared-React import map (design §6.8, P4) — must precede the module scripts below. -->
					<script type="importmap" nonce="${nonce}">${pluginImportMap}</script>
					<script nonce="${nonce}">
						window.IMAGES_BASE_URI = "${imagesUri}"
						window.AUDIO_BASE_URI = "${audioUri}"
						window.MATERIAL_ICONS_BASE_URI = "${materialIconsUri}"
						// Exposed so SlangViz can stamp the CSP nonce onto the
						// script tags inside its srcdoc iframe (which inherits
						// this document's policy).
						window.__shofer_csp_nonce__ = "${nonce}"
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

		// Shared-React import map for external plugin UI bundles (design §6.8, P4). A
		// plugin bundle externalizes react/react-dom/react/jsx-runtime; these bare
		// specifiers resolve to host-shim modules (served from webview-ui/build) that
		// re-export the host's running React instance (published on the global by
		// index.tsx). Importing same-origin `cspSource` modules is allowed under the
		// CSP's `strict-dynamic`. Absent any UI plugin the map is simply unused.
		const pluginImportMap = buildPluginHostImportMap(webview, this.contextProxy.extensionUri)
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
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} https://storage.googleapis.com https://img.clerk.com data:; media-src ${webview.cspSource}; script-src ${webview.cspSource} 'wasm-unsafe-eval' 'nonce-${nonce}' https://ph.shofer.dev 'strict-dynamic'; connect-src ${webview.cspSource} ${openRouterDomain} https://api.requesty.ai https://ph.shofer.dev; frame-src 'self'; clipboard-read 'self'; clipboard-write 'self';">
            <link rel="stylesheet" type="text/css" href="${stylesUri}">
			<link href="${codiconsUri}" rel="stylesheet" />
			<!-- Shared-React import map for external plugin UI bundles (design §6.8, P4).
			     MUST precede the app module script so bare react specifiers in a
			     dynamically-imported plugin bundle resolve to the host-shim modules. -->
			<script type="importmap" nonce="${nonce}">${pluginImportMap}</script>
			<script nonce="${nonce}">
				window.IMAGES_BASE_URI = "${imagesUri}"
				window.AUDIO_BASE_URI = "${audioUri}"
				window.MATERIAL_ICONS_BASE_URI = "${materialIconsUri}"
				// Exposed so SlangViz can stamp the CSP nonce onto the script
				// tags inside its srcdoc iframe (which inherits this policy).
				window.__shofer_csp_nonce__ = "${nonce}"
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
		const onReceiveMessage = async (message: WebviewMessage) => webviewMessageHandler(this, message)

		const messageDisposable = webview.onDidReceiveMessage(onReceiveMessage)
		this.webviewDisposables.push(messageDisposable)
	}

	/**
	 * Handle deletion of a custom mode. Resets the global default mode if it
	 * referenced the deleted mode, and resets the focused task to the default
	 * mode if it was running the deleted one, then refreshes the webview.
	 */
	public async handleModeDeleted(deletedSlug: Mode): Promise<void> {
		if (this.getGlobalState("mode") === deletedSlug) {
			await this.updateGlobalState("mode", defaultModeSlug)
		}

		const currentTask = this.getCurrentTask()
		if (currentTask) {
			try {
				const taskMode = await currentTask.getTaskMode()
				if (taskMode === deletedSlug) {
					await this.handleUserModeSwitch(defaultModeSlug)
				}
			} catch (error) {
				this.log(
					`[handleModeDeleted] Failed to resolve focused task mode: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		}

		await this.postInitState()
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

		// Update `_taskMode` synchronously BEFORE any async work so that any
		// state push the running task triggers during the await window below
		// carries the new mode. Setting it only after the await left a window
		// where getStateToPostToWebview() read the stale old mode and
		// overwrote the webview's optimistic ModeSelector update. Mirrors the
		// Abort-Ordering Invariant: the observable flag must flip first.
		;(sourceTask as any)._taskMode = newMode

		try {
			const taskHistoryItem =
				this.taskHistoryStore.get(sourceTask.taskId) ??
				(this.getGlobalState("taskHistory") ?? []).find((item) => item.id === sourceTask.taskId)

			if (taskHistoryItem) {
				await this.updateTaskHistory({ ...taskHistoryItem, mode: newMode })
			}
		} catch (error) {
			this.log(
				`Failed to persist mode switch for task ${sourceTask.taskId}: ${error instanceof Error ? error.message : String(error)}`,
			)
			throw error
		}

		// Push the new mode to the webview so the ModeSelector reflects the
		// agent-driven switch (switch_mode tool, run_slash_command, Task.ts
		// internal calls). Without this, the UI keeps showing the last
		// stateInit's mode until some unrelated event triggers the next push.
		// Mirrors handleUserModeSwitch()'s trailing postInitState().
		await this.postInitState()
	}

	public async handleUserModeSwitch(newMode: Mode) {
		const task = this.getCurrentTask()

		if (task) {
			TelemetryService.instance.captureModeSwitch(task.taskId, newMode)
			task.emit(ShoferEventName.TaskModeSwitched, task.taskId, newMode)

			// Update `_taskMode` synchronously BEFORE any async work so that any
			// state push the running task triggers during the await window below
			// carries the new mode. Setting it only after the await left a window
			// where getStateToPostToWebview() read the stale old mode and
			// overwrote the webview's optimistic ModeSelector update. Mirrors the
			// Abort-Ordering Invariant: the observable flag must flip first.
			;(task as any)._taskMode = newMode

			try {
				const taskHistoryItem =
					this.taskHistoryStore.get(task.taskId) ??
					(this.getGlobalState("taskHistory") ?? []).find((item) => item.id === task.taskId)

				if (taskHistoryItem) {
					await this.updateTaskHistory({ ...taskHistoryItem, mode: newMode })
				}
			} catch (error) {
				this.log(
					`Failed to persist mode switch for task ${task.taskId}: ${error instanceof Error ? error.message : String(error)}`,
				)
				throw error
			}
		} else {
			// No focused task: the pre-task mode selection is owned by the webview
			// dropdown (tier-1 draft) and forwarded with `newTask`. There is no
			// backend state to mutate here, so this branch only drives the
			// per-mode API-config side effects below.
		}

		this.emit(ShoferEventName.ModeChanged, newMode)

		const lockApiConfigAcrossModes = this.context.workspaceState.get("lockApiConfigAcrossModes", false)
		if (lockApiConfigAcrossModes) {
			await this.postInitState()
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

		await this.postInitState()
	}

	/**
	 * Throw unless `mode` names a mode this node actually defines.
	 *
	 * The mode list is the EFFECTIVE one — plugin-contributed, org-bundle and
	 * user modes all arrive through `customModes` — so on a headless node this
	 * is exactly what the mounted config bundle declares. See
	 * `pluginAgentResult.ts` for why a spawn is refused rather than demoted.
	 */
	private async assertModeExists(mode: Mode): Promise<void> {
		const customModes = await this.customModesManager.getCustomModes()
		if (!getModeBySlug(mode, customModes)) {
			throw unknownModeError(
				mode,
				customModes.map((m) => m.slug),
			)
		}
	}

	/**
	 * Resolve the API-config profile NAME associated with `mode`, mirroring the
	 * per-mode resolution in {@link handleUserModeSwitch} (the mode's YAML
	 * `provider:` field first, then the saved `modeApiConfigs` id). Returns
	 * `undefined` when no mode-specific profile applies — either because API
	 * config is locked across modes, or the mode has no association — so callers
	 * fall back to the global/parent default.
	 *
	 * Used to seed subtasks (and other mode-seeded tasks) with their OWN mode's
	 * API config instead of silently inheriting the parent's active profile.
	 */
	public async resolveModeApiConfigName(mode: Mode): Promise<string | undefined> {
		const lockApiConfigAcrossModes = this.context.workspaceState.get("lockApiConfigAcrossModes", false)
		if (lockApiConfigAcrossModes) {
			return undefined
		}

		const savedConfigId = await this.providerSettingsManager.getModeConfigId(mode)
		const listApiConfig = await this.providerSettingsManager.listConfig()
		const customModes = await this.customModesManager.getCustomModes()
		const modeConfig = getModeBySlug(mode, customModes)

		let profileName: string | undefined
		if (modeConfig?.provider) {
			profileName = listApiConfig.find((c) => c.name === modeConfig.provider)?.name
		}
		if (!profileName && savedConfigId) {
			profileName = listApiConfig.find(({ id }) => id === savedConfigId)?.name
		}
		return profileName
	}

	/**
	 * Set the PER-MODE API-config association for `mode` (Settings → Modes),
	 * WITHOUT activating the profile or changing the global default (that is
	 * Settings → Providers). Keeps the two sources of truth 1:1:
	 *  - `modeApiConfigs[mode]` in the providerProfiles store — the single
	 *    persisted mapping, read by `getModeConfigId` for mode switch / task
	 *    creation and projected to the webview by `getStateToPostToWebview`,
	 *  - the custom-mode YAML `provider:` field (read FIRST in
	 *    `handleUserModeSwitch` — without syncing it a stale value would win).
	 * Then pushes the new state.
	 */
	public async setModeApiConfig(mode: Mode, configId: string): Promise<void> {
		await this.providerSettingsManager.setModeConfig(mode, configId)
		const listApiConfig = await this.providerSettingsManager.listConfig()
		const configName = listApiConfig.find((c) => c.id === configId)?.name
		await this.syncCustomModeProviderToYaml(mode, configName)
		await this.postInitState()
	}

	/**
	 * Mirrors the per-mode API config selection back into the custom-mode YAML's
	 * `provider:` field, so the YAML and the saved `modeApiConfigs` mapping stay 1:1.
	 *
	 * Targeting rule: if a workspace is open, the write always goes to the
	 * project-scoped `.shofer/shofermodes` file, even when the mode is currently defined only
	 * globally. This keeps per-project API-profile preferences out of the user
	 * scope's `~/.shofer/shofermodes` (which is shared across workspaces) and creates
	 * a project override on demand. With no workspace open, the user file is updated.
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

			// An org-locked mode's YAML is org-owned: the mutation guard would
			// refuse the write with a user-visible error — and this sync runs on
			// profile RESTORE during webview init, so a user who touched nothing
			// would get spammed with "locked by org policy" toasts on every load.
			// Skip silently; the association still lives in modeApiConfigs, which
			// is what task startup resolves.
			const lockedSlugs = await this.customModesManager.getLockedModeSlugs()
			if (lockedSlugs.includes(mode)) {
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
		options: { forceRebuild?: boolean; profileName?: string } = {},
	): void {
		const { forceRebuild = false, profileName } = options
		const newProvider = providerSettings.apiProvider
		const newModelId = getModelId(providerSettings)

		// Collect all live task instances: the full foreground stack plus any background tasks.
		const allTasks: Task[] = [
			...this.shoferStack,
			...this.taskManager
				.getActiveManagedTasks()
				.map((m) => this.taskManager.getManagedTaskInstance(m.id))
				.filter((t): t is Task => t !== undefined),
		]

		for (const task of allTasks) {
			// Respect sticky provider profiles: only update tasks whose sticky profile
			// matches the profile being activated/saved. Tasks with a different
			// taskApiConfigName must keep their own provider. Tasks without a
			// taskApiConfigName (undefined) haven't been assigned yet and should
			// receive the update.
			if (
				profileName !== undefined &&
				task.taskApiConfigName !== undefined &&
				task.taskApiConfigName !== profileName
			) {
				continue
			}

			const prevConfig = task.apiConfiguration
			const prevProvider = prevConfig?.apiProvider
			const prevModelId = prevConfig ? getModelId(prevConfig) : undefined

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
				// currentApiConfigName is NOT written here — setDefaultApiConfiguration
				// is the single writer of the global default. The activate=true branch
				// refreshes live provider settings + task API handlers only.
				await Promise.all([
					this.updateGlobalState("listApiConfigMeta", await this.providerSettingsManager.listConfig()),
					this.providerSettingsManager.setModeConfig(mode, id),
					this.contextProxy.setProviderSettings(providerSettings, name),
				])

				// Mirror the per-mode mapping into the custom-mode YAML so the two stay 1:1.
				await this.syncCustomModeProviderToYaml(mode, name)

				// Keep the current task's sticky provider profile in sync with the newly-activated profile.
				// Must be called BEFORE updateTaskApiHandlerIfNeeded so the task's taskApiConfigName
				// is set when the per-task sticky-profile filter runs.
				await this.persistStickyProviderProfileToCurrentTask(name)

				// Change the provider for tasks whose sticky profile matches.
				// TODO: We should rename `buildApiHandler` for clarity (e.g. `getProviderClient`).
				this.updateTaskApiHandlerIfNeeded(providerSettings, { forceRebuild: true, profileName: name })
			} else {
				await this.updateGlobalState("listApiConfigMeta", await this.providerSettingsManager.listConfig())
				// When editing the currently-active profile with activate=false,
				// still refresh live contextProxy settings and running task API
				// handlers so edits take effect immediately without re-selection.
				const { currentApiConfigName } = await this.getState()
				if (currentApiConfigName === name) {
					await this.contextProxy.setProviderSettings(providerSettings, name)
					this.updateTaskApiHandlerIfNeeded(providerSettings, { forceRebuild: true, profileName: name })
				}
			}

			await this.postInitState()
			return id
		} catch (error) {
			this.log(
				`Error create new api configuration: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
			)

			getHost().notifier.error(t("common:errors.create_api_config"))
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

		await this.postInitState()
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
		options?: { persistModeConfig?: boolean; persistTaskHistory?: boolean; setGlobalDefault?: boolean },
	) {
		const { name, id, ...providerSettings } = await this.providerSettingsManager.activateProfile(args)

		const persistModeConfig = options?.persistModeConfig ?? true
		const persistTaskHistory = options?.persistTaskHistory ?? true
		const setGlobalDefault = options?.setGlobalDefault ?? true

		// See `upsertProviderProfile` for a description of what this is doing.
		const updates: Promise<any>[] = [
			this.contextProxy.setValue("listApiConfigMeta", await this.providerSettingsManager.listConfig()),
			this.contextProxy.setProviderSettings(providerSettings, name),
		]
		// Only change the global default when explicitly requested.
		// The chat dropdown (loadApiConfigurationById) should NOT change it.
		if (setGlobalDefault) {
			updates.push(this.contextProxy.setValue("currentApiConfigName", name))
		}
		await Promise.all(updates)

		const { mode } = await this.getState()

		if (id && persistModeConfig) {
			await this.providerSettingsManager.setModeConfig(mode, id)
			// Mirror the per-mode mapping into the custom-mode YAML so the two stay 1:1.
			await this.syncCustomModeProviderToYaml(mode, name)
		}

		// Update the current task's sticky provider profile, unless this activation is
		// being used purely as a non-persisting restoration (e.g., reopening a task from history).
		// Must be called BEFORE updateTaskApiHandlerIfNeeded so the task's taskApiConfigName
		// is set when the per-task sticky-profile filter runs.
		if (persistTaskHistory) {
			await this.persistStickyProviderProfileToCurrentTask(name)
		}

		// Change the provider for tasks whose sticky profile matches.
		this.updateTaskApiHandlerIfNeeded(providerSettings, { forceRebuild: true, profileName: name })

		await this.postInitState()

		if (providerSettings.apiProvider) {
			this.emit(ShoferEventName.ProviderProfileChanged, { name, provider: providerSettings.apiProvider })
		}
	}

	/**
	 * Load an API configuration for editing only — does NOT change the global
	 * default profile. Used by the edit dropdown in Settings → Providers to
	 * let the user inspect and modify any config without switching the default.
	 *
	 * The edit target's settings are pushed via a targeted
	 * {@code editingApiConfiguration} configUpdate so the Settings form renders
	 * them. The global apiConfiguration (which running tasks and the chat UI
	 * depend on) is NEVER touched — only the Save button (which fires
	 * upsertApiConfiguration) persists edits and refreshes the task handlers.
	 */
	async loadApiConfigurationForEdit(name: string) {
		const { id, ...providerSettings } = await this.providerSettingsManager.getProfile({ name })

		// Push the config's settings to the webview via a targeted key so the
		// Settings form can render them WITHOUT polluting the global
		// apiConfiguration that running tasks and the chat UI read.
		this.postConfigUpdate("editingApiConfiguration", providerSettings)
	}

	/**
	 * Set the global default API configuration by name WITHOUT loading its
	 * settings into the edit form. Used by the Default Configuration dropdown
	 * in Settings → Providers. The dropdown's job is to declare which config
	 * is the default — it should NOT repopulate the form the user is editing.
	 *
	 * Only the global-default name is persisted; no side-effect touches
	 * apiConfiguration (the currently-edited profile's provider settings),
	 * so the Save button tracks the change as dirty and the form values are
	 * left alone.
	 */
	async setDefaultApiConfiguration(name: string) {
		await this.contextProxy.setValue("currentApiConfigName", name)
		this.postConfigUpdate("currentApiConfigName", name)
	}

	async updateCustomInstructions(instructions?: string) {
		// User may be clearing the field.
		await this.updateGlobalState("customInstructions", instructions || undefined)
		this.postConfigUpdate("customInstructions", instructions || undefined)
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
		const { getSettingsDirectoryPath } = await import("@shofer/core")
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
		// Pass activate=false — upsertProviderProfile just saves the config;
		// activateProviderProfile below does the single live refresh + sets
		// the global default. Avoids double setProviderSettings + double postInitState.
		await this.upsertProviderProfile(profileName, newConfiguration, false)
		await this.activateProviderProfile({ name: profileName })
	}

	// Task history

	async getTaskWithId(
		id: string,
		opts?: { skipApiHistory?: boolean },
	): Promise<{
		historyItem: HistoryItem
		taskDirPath: string
		apiConversationHistoryFilePath: string
		uiMessagesFilePath: string
		apiConversationHistory: Anthropic.MessageParam[]
	}> {
		// getOrLoad rather than get: on a shared task store (executor replicas
		// mounting one volume) the addressed task may have been written by
		// another replica after this process loaded its index — the miss falls
		// back to reading the per-task file from disk.
		const historyItem =
			(await this.taskHistoryStore.getOrLoad(id)) ??
			(this.getGlobalState("taskHistory") ?? []).find((item) => item.id === id)

		if (!historyItem) {
			throw new Error("Task not found")
		}

		const { getTaskDirectoryPath } = await import("@shofer/core")
		const globalStoragePath = this.contextProxy.globalStorageUri.fsPath
		const taskDirPath = await getTaskDirectoryPath(globalStoragePath, id)
		const apiConversationHistoryFilePath = path.join(taskDirPath, GlobalFileNames.apiConversationHistory)
		const uiMessagesFilePath = path.join(taskDirPath, GlobalFileNames.uiMessages)

		let apiConversationHistory: Anthropic.MessageParam[] = []

		// T1.A: Skip the full api_conversation_history.jsonl read when the caller
		// only needs the historyItem (e.g. showTaskWithId, which immediately
		// re-reads the same file in preloadShoferMessages). This avoids a
		// 100%-wasted read + parse + dedupe on every cold task switch.
		if (!opts?.skipApiHistory) {
			const { readApiMessages } = await import("@shofer/core")
			try {
				apiConversationHistory = await readApiMessages({ taskId: id, globalStoragePath })
			} catch (error) {
				webviewLog.warn(
					`[getTaskWithId] api_conversation_history.jsonl corrupted for task ${id}, returning empty history: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
			// An empty API history is only anomalous for LLM-backed tasks. A workflow
			// orchestrator (`isWorkflow`) drives no LLM of its own — its observable
			// history lives entirely in `ui_messages.jsonl` as the say/ask stream — so
			// an empty `api_conversation_history.jsonl` is expected, not a fault. Only
			// warn for tasks that should have API turns.
			if (apiConversationHistory.length === 0 && !historyItem.isWorkflow) {
				webviewLog.warn(`[getTaskWithId] api_conversation_history.jsonl missing or empty for task ${id}`)
			}
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

	/**
	 * Collect every `task_interaction` event recorded by any task sharing the
	 * given root, sorted by their root-relative offset. Powers the Sequence
	 * view, which draws inter-task arrows (spawn/message/await/answer/cancel)
	 * across all tasks under one root on a shared timeline.
	 */
	async getTaskInteractions(rootTaskId: string): Promise<TaskInteractionPayload[]> {
		const history = this.getGlobalState("taskHistory") ?? []
		const taskIds = history.filter((i) => (i.rootTaskId ?? i.id) === rootTaskId).map((i) => i.id)

		const { readTaskMessages } = await import("@shofer/core")
		const globalStoragePath = this.contextProxy.globalStorageUri.fsPath

		const interactions: TaskInteractionPayload[] = []
		for (const id of taskIds) {
			try {
				const messages = await readTaskMessages({ taskId: id, globalStoragePath })
				for (const m of messages) {
					if (m.say === "task_interaction" && m.text) {
						try {
							interactions.push(JSON.parse(m.text) as TaskInteractionPayload)
						} catch {
							// Skip malformed payloads.
						}
					}
				}
			} catch {
				// Task messages unreadable (pruned / different session) — skip.
			}
		}

		interactions.sort((a, b) => a.rootOffsetMs - b.rootOffsetMs)
		return interactions
	}

	/**
	 * Number of tail messages to read on cold task-switch (T1.B).
	 * Capped at this value to bound read+parse+dedupe cost on rehydrate.
	 * When exceeded, `hasMoreShoferMessages` is set on the Task and a
	 * "Load older messages" sentinel is rendered in the webview.
	 */
	private static readonly COLD_LOAD_TAIL_WINDOW = 200

	async showTaskWithId(id: string, options?: { keepCurrentTask?: boolean }) {
		if (id !== this.getCurrentTask()?.taskId) {
			// Non-current task.
			// T1.A: skipApiHistory avoids a 100%-wasted read+parse+dedupe of
			// api_conversation_history.jsonl — preloadShoferMessages re-reads it
			// moments later in createTaskWithHistoryItem.
			// T1.B: maxMessages limits the cold-load read to the tail of
			// the JSONL logs so we don't parse thousands of messages on switch.
			const { historyItem } = await this.getTaskWithId(id, { skipApiHistory: true })
			await this.createTaskWithHistoryItem(historyItem, {
				keepCurrentTask: options?.keepCurrentTask,
				maxMessages: ShoferProvider.COLD_LOAD_TAIL_WINDOW,
			})
		}

		// LLM hint: Push the new task's (already-preloaded) shoferMessages to
		// the webview BEFORE the chatButtonClicked action navigates it to the
		// chat view. Without this, when the user clicks a task from the home
		// screen (where the webview's cached shoferMessages is []), the
		// chatButtonClicked navigation lands on an empty chat → ChatView
		// renders the home screen for a frame until resumeTaskFromHistory's
		// eventual ask() triggers its own postInitState. The
		// preload-before-publish step in createTaskWithHistoryItem guarantees
		// this push carries the populated history.
		await this.postInitState()

		await this.postMessageToWebview({ type: "action", action: "chatButtonClicked" })
	}

	/**
	 * T1.B: Load the full message log from disk and merge the older
	 * (pre-window) messages into the in-memory array. Batches the older
	 * page into a single IPC delta so the webview gets one setState and
	 * the message order is preserved.
	 *
	 * After loading, `hasMoreShoferMessages` is set to `false` since
	 * the full history is now resident.
	 */
	async loadOlderShoferMessages(): Promise<void> {
		const task = this.getCurrentTask()
		if (!task || !task.hasMoreShoferMessages) {
			return
		}
		const taskId = task.taskId

		// Load the full deduped message log.
		const allMessages = await task.getSavedShoferMessages()

		// The in-memory window is the tail of the full array.
		// The prefix (olderMessages) and the in-memory tail are
		// disjoint by construction: getSavedShoferMessages dedupes by
		// ts and the slice boundary aligns to the window start.
		// No host-side dedup against the tail is needed.
		const loadedCount = task.shoferMessages.length
		const olderMessages = allMessages.slice(0, Math.max(0, allMessages.length - loadedCount))

		// Merge: keep any messages that landed in-memory since the
		// read started (appends during load are rare but possible).
		// Union by ts, preserving on-disk order, then appending any
		// newly-seen messages at the tail.
		const tailSet = new Set(task.shoferMessages.map((m) => m.ts))
		const newTail = allMessages
			.slice(Math.max(0, allMessages.length - loadedCount))
			.filter((m) => !tailSet.has(m.ts))
		task.shoferMessages = [
			...allMessages.slice(0, Math.max(0, allMessages.length - loadedCount)),
			...task.shoferMessages,
			...newTail,
		]
		task.hasMoreShoferMessages = false

		// Batch the older page in one IPC round-trip — the webview
		// does one setState with [...olderMessages, ...prev].
		if (olderMessages.length > 0) {
			await this.postMessageToWebview({
				type: "shoferMessagesPrepended",
				shoferMessages: olderMessages,
				taskId,
			})
		}

		// Hide the sentinel.
		await this.postTaskStateUpdate({ hasMoreShoferMessages: false })
	}

	async exportTaskWithId(id: string) {
		const { historyItem, apiConversationHistory } = await this.getTaskWithId(id)
		const fileName = getTaskFileName(historyItem.ts)

		// On a web host (code-server / vscode.dev) `showSaveDialog` writes to the
		// remote server, not the user's machine, so offer a browser download too.
		const destination = await pickExportDestination()
		if (!destination) {
			return // user dismissed the destination picker
		}

		// A workflow makes no direct LLM calls, so `apiConversationHistory` is empty
		// — its transcript is the "Events" tab: the say/ask state-transition messages
		// (peer-to-peer `peer_message` excluded, to match the JSON export's `events`
		// field). Resolve the markdown content for whichever task kind this is.
		let markdown: string
		if (historyItem.isWorkflow) {
			let uiMessages: Array<{ type: string; say?: string; ask?: string; ts: number; text?: string }> = []
			try {
				const { readTaskMessages } = await import("@shofer/core")
				const globalStoragePath = this.contextProxy.globalStorageUri.fsPath
				uiMessages = (await readTaskMessages({ taskId: id, globalStoragePath })) as typeof uiMessages
			} catch (err) {
				webviewLog.warn(
					`[exportTaskWithId] Could not read ui_messages.jsonl for workflow ${id}: ${err instanceof Error ? err.message : String(err)}`,
				)
			}
			const events = uiMessages
				.filter((m) => !(m.type === "say" && m.say === "peer_message"))
				.map((m) => ({ ts: m.ts, type: m.type, say: m.say, ask: m.ask, text: m.text }))
			const flowName =
				((historyItem.flowState as Record<string, unknown> | undefined)?.flowName as string) ||
				historyItem.task ||
				""
			markdown = formatWorkflowEventsToMarkdown(flowName, events)
		} else {
			markdown = buildTaskMarkdown(apiConversationHistory)
		}

		if (destination === "browser") {
			await this.postMessageToWebview({
				type: "browserDownload",
				browserDownload: { fileName, content: markdown, mime: "text/markdown" },
			})
			return
		}

		const defaultUri = await resolveDefaultSaveUri(this.contextProxy, "lastTaskExportPath", fileName, {
			useWorkspace: false,
			fallbackDir: path.join(os.homedir(), "Downloads"),
		})
		const saveUri = await saveMarkdownFile(markdown, defaultUri)

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
		const { historyItem } = await this.getTaskWithId(id)

		// Build the trace for this task plus the full descendant tree of any
		// sub-tasks it spawned (for a workflow, its per-agent tasks). Large trees
		// mean many sequential reads, so run the walk inside a cancellable progress
		// notification and report a running count; the pure walker handles
		// recursion / cycle-guarding and skips any unreadable child.
		let cancelled = false
		const trace = await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: t("common:info.exporting_task_json_title"),
				cancellable: true,
			},
			async (progress, token) => {
				token.onCancellationRequested(() => {
					cancelled = true
				})
				return buildJsonTraceTree(id, (taskId) => this.loadJsonTraceNode(taskId), {
					onSkip: (childId, error) =>
						webviewLog.warn(
							`[exportTaskWithIdJson] Skipping unreadable sub-task ${childId}: ${error instanceof Error ? error.message : String(error)}`,
						),
					onProgress: (_taskId, count) =>
						progress.report({ message: t("common:info.exporting_task_json_progress", { count }) }),
					isCancelled: () => token.isCancellationRequested,
				})
			},
		)

		// The user cancelled mid-walk: `trace` is a partial tree — abandon it
		// rather than prompting to save an incomplete export.
		if (cancelled) {
			getHost().notifier.info(t("common:info.export_task_json_cancelled"))
			return
		}

		const fileName = getJsonExportFileName(historyItem.ts)

		// On a web host (code-server / vscode.dev) `showSaveDialog` writes to the
		// remote server, not the user's machine, so offer a browser download too.
		const destination = await pickExportDestination()
		if (!destination) {
			return // user dismissed the destination picker
		}

		if (destination === "browser") {
			// Serialize to an OS temp file via the worker (a workflow trace is the
			// whole descendant task tree, so stringifying it on the main thread would
			// freeze the webview), read the bytes back, and stream them to the webview
			// for a client-side download. The temp file is removed afterwards.
			const tmpFile = path.join(os.tmpdir(), fileName)
			const content = await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: t("common:info.exporting_task_json_writing"),
				},
				async () => {
					await stringifyJsonToFile(trace, tmpFile)
					return fs.readFile(tmpFile, "utf8")
				},
			)
			await fs.unlink(tmpFile).catch(() => {})
			await this.postMessageToWebview({
				type: "browserDownload",
				browserDownload: { fileName, content, mime: "application/json" },
			})
			return
		}

		const defaultUri = await resolveDefaultSaveUri(this.contextProxy, "lastTaskExportPath", fileName, {
			useWorkspace: false,
			fallbackDir: path.join(os.homedir(), "Downloads"),
		})
		const saveUri = await downloadJsonTask(historyItem.ts, trace, defaultUri)

		if (saveUri) {
			await saveLastExportPath(this.contextProxy, "lastTaskExportPath", saveUri)
		}
	}

	/**
	 * Load one task's JSON trace and its direct `childIds` for the export walker
	 * ({@link buildJsonTraceTree}). Reads the persisted api-conversation + ui
	 * messages and assembles the single-task trace (LLM calls, or — for a workflow
	 * — flowState + event log + slang source). Recursion/cycle-guarding is the
	 * walker's job; this just returns the node plus its children.
	 */
	private async loadJsonTraceNode(id: string): Promise<{ trace: JsonExportTrace; childIds: string[] }> {
		const { historyItem, apiConversationHistory } = await this.getTaskWithId(id)

		// Read ui_messages for per-request metadata via the JSONL reader.
		let uiMessages: Array<{ type: string; say?: string; ask?: string; ts: number; text?: string }> = []
		try {
			const { readTaskMessages } = await import("@shofer/core")
			const globalStoragePath = this.contextProxy.globalStorageUri.fsPath
			uiMessages = (await readTaskMessages({ taskId: id, globalStoragePath })) as typeof uiMessages
		} catch (err) {
			webviewLog.warn(
				`[loadJsonTraceNode] Could not read ui_messages.jsonl for task ${id}: ${err instanceof Error ? err.message : String(err)}`,
			)
		}

		const trace = buildJsonTrace(
			id,
			historyItem.task || historyItem.ts?.toString() || "",
			historyItem.mode,
			historyItem.ts ? new Date(historyItem.ts).toISOString() : new Date().toISOString(),
			apiConversationHistory,
			uiMessages,
			// A workflow makes no direct LLM calls, so its trace is the slang state
			// machine + data (flowState) plus the UI event log (state transitions).
			// slangSource + flowState.mailboxHistory are exactly what's needed to
			// reproduce the sequence/swimlane/topology diagrams post-mortem.
			{
				title: historyItem.name,
				isWorkflow: historyItem.isWorkflow ?? false,
				flowState: historyItem.flowState,
				slangSource: historyItem.slangSource,
			},
		)

		return { trace, childIds: historyItem.childIds ?? [] }
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

	// this function deletes a task from task history, tells plugins holding per-task
	// state to drop it, and removes the task folder
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
						webviewLog.info(`[deleteTaskWithId] child task ${taskId} not found, skipping`)
					}
				}

				await collectChildIds(id)
			}

			// Tear down any live (in-memory) instances managed by TaskManager.
			// Without this, children of a deleted parent survive as zombies in the
			// parallel-task map — still consuming resources, still listed in
			// TaskSelector, but with no persisted history to back them.
			for (const taskId of allIdsToDelete) {
				if (taskId !== id) {
					try {
						await this.taskManager.deleteManagedTask(taskId)
					} catch {
						// Not registered as a managed task — fine.
					}
				}
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

			// Notify plugins, then delete the task directories.
			const workspaceDir = this.cwd
			const { getTaskDirectoryPath } = await import("@shofer/core")
			const globalStoragePath = this.contextProxy.globalStorageUri.fsPath

			for (const taskId of allIdsToDelete) {
				// Let plugins drop per-task state they keep OUTSIDE the task directory
				// (design §6.9 `onTaskDeleted`) — deleting the directory below would
				// otherwise leave it orphaned with nothing left to name it.
				await pluginRegistry.notifyTaskDeleted({ taskId, workspacePath: workspaceDir })

				// Delete the task directory
				try {
					const dirPath = await getTaskDirectoryPath(globalStoragePath, taskId)
					await fs.rm(dirPath, { recursive: true, force: true })
					webviewLog.info(`[deleteTaskWithId${taskId}] removed task directory`)
				} catch (error) {
					webviewLog.error(
						`[deleteTaskWithId${taskId}] failed to remove task directory: ${error instanceof Error ? error.message : String(error)}`,
					)
				}
			}

			await this.postInitState()
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

		await this.postInitState()
		// See deleteTaskWithId: webview needs an explicit task-history broadcast
		// to drop the deleted item from the TaskSelector list.
		await this.broadcastTaskHistoryUpdate()
	}

	async refreshWorkspace() {
		this.currentWorkspacePath = getWorkspacePath()
		await this.postInitState()
	}

	/**
	 * **Full state init** — one-shot snapshot of the complete ExtensionState.
	 * Replaces the old `postStateToWebview()`. Sent on:
	 * - Webview launch / visibility return (after didBecomeVisible)
	 * - Task-creation / completion reset (newTask, clearTask, resetState)
	 * - Task focus / switch (focusTask, managedTask launch)
	 * - Delegate finished (delegateFinishTask)
	 * - Settings import, profile change, MCP server lifecycle
	 *
	 * Everything else should use incremental `configUpdate` / `taskStateUpdate`.
	 *
	 * **Diagnostics**: this is the escape-hatch path. If you see this firing more
	 * than O(1) times per task lifetime (excluding visibility resets), a call site
	 * should be migrated to `postConfigUpdate()` or `postTaskStateUpdate()`.
	 * Enable log category `IPC` + `Webview` to monitor.
	 */
	async postInitState(): Promise<void> {
		ipcLog.info("postInitState — full state push", {
			taskCount: this.shoferStack.length,
			focusedTaskId: this.taskManager.getFocusedTaskId(),
		})
		return time("postInitState", async () => {
			// Capture the store version BEFORE building the snapshot. Read after the
			// await and a mutation landing during getStateToPostToWebview() could be
			// silently omitted next time; read before and the worst case is a
			// harmless redundant re-send. [perf H26]
			const version = this.taskHistoryStore.getMutationVersion()
			const state = await this.getStateToPostToWebview()
			// H26: omit the full taskHistory array when the store hasn't changed
			// since the last init that carried it. mergeExtensionState in the webview
			// preserves the existing array when the field is absent (JSON strips
			// undefined), so the webview keeps its identical copy — dropping a
			// full-array serialize + structuredClone from every unchanged init (e.g.
			// settings / profile / MCP-lifecycle pushes, and task switches with no
			// intervening history mutation). Any mutation (add/update/delete,
			// archived-task cleanup, cross-instance reconcile) bumps the version, so
			// the next init re-sends the array — no reliance on delta-channel coverage.
			if (this._lastSentTaskHistoryVersion === version) {
				delete (state as { taskHistory?: HistoryItem[] }).taskHistory
			} else {
				this._lastSentTaskHistoryVersion = version
			}
			this.postMessageToWebview({ type: "stateInit", state })
		})
	}

	/**
	 * **Config update** — a single key/value pair. The webview merges `{ [key]: value }`
	 * into its local `ExtensionState`. Replaces `postInitState()` at settings
	 * toggle, custom-mode CRUD, profile-switch sites where only one setting changed.
	 *
	 * **Diagnostics**: these should be the most common state pushes after message
	 * streaming. Enable `IPC` to verify the key granularity.
	 */
	postConfigUpdate(key: string, value: unknown): void {
		ipcLog.info(`postConfigUpdate key="${key}"`, {
			key,
			valueType: typeof value,
			isArray: Array.isArray(value),
		})
		this.postMessageToWebview({ type: "configUpdate", key, value })
	}

	/**
	 * **Task state update** — task lifecycle fields only (currentTaskId, currentTaskItem,
	 * messageQueue, parallelTasks, focusedTaskId). Replaces `postInitState()` at
	 * task-switch and task-focus call sites where the only thing that changed is which
	 * task is active. The webview merges these fields into its local state.
	 *
	 * **Diagnostics**: these should fire every time the active task changes.
	 * Enable `IPC` to verify the delta is targeted (not a full state push).
	 */
	postTaskStateUpdate(
		updates: Partial<
			Pick<
				ExtensionState,
				| "currentTaskId"
				| "currentTaskItem"
				| "messageQueue"
				| "parallelTasks"
				| "focusedTaskId"
				| "hasMoreShoferMessages"
			>
		>,
	): void {
		ipcLog.info("postTaskStateUpdate", {
			keys: Object.keys(updates),
			hasCurrentTaskId: "currentTaskId" in updates,
			hasCurrentTaskItem: "currentTaskItem" in updates,
		})
		this.postMessageToWebview({ type: "taskStateUpdate", taskStateUpdates: updates })
	}

	/**
	 * Merges allowed commands from global state and workspace configuration
	 * with proper validation and deduplication
	 */
	private mergeAllowedCommands(globalStateCommands?: string[]): string[] {
		return this.mergeCommandLists("allowed", globalStateCommands)
	}

	/**
	 * Merges denied commands from global state and workspace configuration
	 * with proper validation and deduplication
	 */
	private mergeDeniedCommands(globalStateCommands?: string[]): string[] {
		return this.mergeCommandLists("denied", globalStateCommands)
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
	private mergeCommandLists(commandType: "allowed" | "denied", globalStateCommands?: string[]): string[] {
		try {
			// globalState (ContextProxy) is now the single source of truth for command
			// lists — the VS Code config side was removed with the config migration
			// (todos/config-cleanup.md Part A/D). Validate, sanitize, dedupe.
			const validGlobalCommands = Array.isArray(globalStateCommands)
				? globalStateCommands.filter((cmd) => typeof cmd === "string" && cmd.trim().length > 0)
				: []
			return [...new Set(validGlobalCommands)]
		} catch (error) {
			webviewLog.error(`Error merging ${commandType} commands:`, error)
			// Return empty array as fallback to prevent crashes
			return []
		}
	}

	/**
	 * Assemble the org-locked entity sets (mode slugs, MCP server names,
	 * provider profile names, skill names) from the four managers, for the
	 * Settings UI to mark those entities read-only. Never throws — a manager
	 * failure degrades to an empty set rather than blocking the state push.
	 */
	private async getOrgLockedResources(): Promise<OrgLockedResources> {
		// Optional calls throughout: test doubles (and older mocks) may not
		// implement the lock accessors — degrade to "nothing locked".
		const [modes, providers] = await Promise.all([
			Promise.resolve(this.customModesManager.getLockedModeSlugs?.()).catch(() => []),
			Promise.resolve(this.providerSettingsManager.getLockedProfileNames?.()).catch(() => []),
		])
		return {
			modes: modes ?? [],
			mcp: this.mcpHub?.getLockedServerNames?.() ?? [],
			providers: providers ?? [],
			skills: this.skillsManager?.getLockedSkillNames?.() ?? [],
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
			allowedReadPaths,
			allowedWritePaths,
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
			mode,
			currentApiConfigName,
			listApiConfigMeta,
			pinnedApiConfigs,
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
			archivedTaskRetentionDays,
			maxParallelTasks,
			taskSyncEnabled,
			imageGenerationProvider,
			openRouterImageApiKey,
			openRouterImageGenerationSelectedModel,
			lockApiConfigAcrossModes,
			logLevel,
			logCategories,
		} = await this.getState()

		let cloudOrganizations: any[] = []

		const telemetryKey = process.env.POSTHOG_API_KEY
		const machineId = vscode.env.machineId
		// H8: Build merged commands from cache when settings haven't changed.
		// Phase 3: cache removed — recomputed fresh every time. With
		// incremental messaging, postInitState runs O(1) times per task lifetime
		// (start + focus), not per streaming token.
		const mergedAllowedCommands = this.mergeAllowedCommands(allowedCommands)
		const mergedDeniedCommands = this.mergeDeniedCommands(deniedCommands)
		const cwd = this.cwd
		const currentTask = this.getCurrentTask()

		// Re-seed the workflow visualization from the *focused* task. The viz
		// fields below are normally pushed as deltas by WorkflowTask via
		// postConfigUpdate, but those are global keys any live workflow writes to.
		// Reseeding from the current task on every full state push (which fires on
		// task switch) guarantees that switching to a workflow restores its own
		// diagrams rather than whichever workflow last pushed. Duck-typed so we
		// don't depend on a runtime WorkflowTask import here.
		const _wfVizSnap = (() => {
			const t = currentTask as unknown as {
				getWorkflowVizSnapshot?: () =>
					| { html: string; meta?: unknown; runState?: Record<string, unknown> }
					| undefined
			}
			return typeof t?.getWorkflowVizSnapshot === "function" ? t.getWorkflowVizSnapshot() : undefined
		})()

		// [header:content] Does the PERSISTED HistoryItem.task (the value the webview
		// turns into the synthetic TaskHeader via currentTaskItem.task) hold the
		// canonical first prompt, or a corrupted api_req_started wireRequest blob?
		// This distinguishes on-disk corruption (pre-f2a7d5196 history) from a
		// webview-side rendering choice. Logged only when a task is focused.
		if (currentTask?.taskId) {
			const storedTask = this.taskHistoryStore.get(currentTask.taskId)?.task ?? ""
			const histWireBlob =
				/^\s*\{/.test(storedTask) && /"(messages|model|stream|max_tokens|api_req|request)"/.test(storedTask)
			scrollLog.info(
				`[header:content] persisted HistoryItem taskId=${currentTask.taskId} ` +
					`windowed=${currentTask.hasMoreShoferMessages ?? false} histWireBlob=${histWireBlob} ` +
					`histTask="${storedTask.slice(0, 60).replace(/\s+/g, " ")}"`,
			)
		}

		return {
			version: this.context.extension?.packageJSON?.version ?? "",
			orgLockedResources: await this.getOrgLockedResources(),
			apiConfiguration,
			// editingApiConfiguration is intentionally NOT seeded here: it's a
			// webview-only edit buffer set via a targeted configUpdate when the
			// Settings edit dropdown loads a config, and cleared by SettingsView on
			// unmount. Seeding `undefined` on every full push is a no-op anyway
			// (JSON strips it and mergeExtensionState preserves the prior value).
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
						`[home-screen-flash] postInitState about to send shoferMessages=[] for ` +
							`unloaded history task ${currentTask.taskId}.${currentTask.instanceId} ` +
							`(isInitialized=${currentTask.isInitialized}). ` +
							`Caller: ${new Error().stack?.split("\n").slice(2, 6).join(" | ")}`,
					)
				}
				return msgs
			})(),
			// T1.B: signal the webview that older messages exist on disk
			// and a "Load older messages" sentinel should be shown.
			hasMoreShoferMessages: currentTask?.hasMoreShoferMessages ?? false,
			//
			// never surface this host's local task's here.
			currentTaskTodos: currentTask?.todoList || [],
			messageQueue: currentTask?.messageQueueService?.messages ?? [],
			taskHistory: this.taskHistoryStore.getAll().filter((item: HistoryItem) => item.ts && item.task),
			soundEnabled: soundEnabled ?? false,
			ttsEnabled: ttsEnabled ?? false,
			ttsSpeed: ttsSpeed ?? 1.0,
			shouldShowAnnouncement:
				telemetrySetting !== "unset" && lastShownAnnouncementId !== this.latestAnnouncementId,
			allowedCommands: mergedAllowedCommands,
			deniedCommands: mergedDeniedCommands,
			allowedReadPaths: allowedReadPaths ?? [],
			allowedWritePaths: allowedWritePaths ?? [],
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
			currentApiConfigName: currentTask?.taskApiConfigName || currentApiConfigName || "default",
			listApiConfigMeta: listApiConfigMeta ?? [],
			// Per-mode API-config associations, so the chat dropdown and
			// Settings → Modes can reflect modeApiConfigs[mode]. Read from the
			// providerProfiles store — the single source of truth — NOT from a
			// globalState copy (a copy drifts: profile activation and mode-switch
			// backfills write the store without any webview-side mirror).
			modeApiConfigs: await this.providerSettingsManager.getModeConfigs(),
			pinnedApiConfigs: pinnedApiConfigs ?? {},
			mode: (currentTask as any)?._taskMode || mode || defaultModeSlug,
			customModePrompts: customModePrompts ?? {},
			customSupportPrompts: customSupportPrompts ?? {},
			enhancementApiConfigId,
			autoApprovalEnabled: autoApprovalEnabled ?? false,
			// User-facing state → hide **private** modes from the mode selector/picker
			// (owner directive #4). Private plugin modes stay switch-able by their
			// qualified slug (getCustomModes still returns them for resolution).
			customModes: (customModes ?? []).filter((m) => !m.private),
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
			enableSubfolderRules: enableSubfolderRules ?? true,
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
			archivedTaskRetentionDays,
			maxParallelTasks,
			taskSyncEnabled,
			imageGenerationProvider,
			openRouterImageApiKey,
			openRouterImageGenerationSelectedModel,
			logLevel: logLevel ?? "info",
			logCategories: logCategories ?? undefined,
			logCategoriesKnown: (() => {
				try {
					const { getLogKnownCategories } = require("@shofer/core")
					const cats = getLogKnownCategories()
					return cats.length > 0 ? cats : undefined
				} catch {
					return undefined
				}
			})(),
			openAiCodexIsAuthenticated: await (async () => {
				try {
					const { openAiCodexOAuthManager } = await import("../../integrations/openai-codex/oauth")
					return await openAiCodexOAuthManager.isAuthenticated()
				} catch {
					return false
				}
			})(),
			debug: this.contextProxy.getValue("debug") ?? false,
			// Seeded from the focused workflow task (if any); thereafter refreshed
			// as deltas via postConfigUpdate from WorkflowTask.notifySlangEditor().
			workflowVizHtml: _wfVizSnap?.html,
			workflowVizRunState: _wfVizSnap?.runState,
			workflowVizMeta: _wfVizSnap?.meta as ExtensionState["workflowVizMeta"],
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
			webviewLog.error(
				`[getState] failed to get organization allow list: ${error instanceof Error ? error.message : String(error)}`,
			)
		}

		let cloudUserInfo: any = null

		try {
			cloudUserInfo = null
		} catch (error) {
			webviewLog.error(
				`[getState] failed to get cloud user info: ${error instanceof Error ? error.message : String(error)}`,
			)
		}

		let cloudIsAuthenticated: boolean = false

		try {
			cloudIsAuthenticated = false
		} catch (error) {
			webviewLog.error(
				`[getState] failed to get cloud authentication state: ${error instanceof Error ? error.message : String(error)}`,
			)
		}

		let sharingEnabled: boolean = false

		try {
			sharingEnabled = await Promise.resolve(false)
		} catch (error) {
			webviewLog.error(
				`[getState] failed to get sharing enabled state: ${error instanceof Error ? error.message : String(error)}`,
			)
		}

		let publicSharingEnabled: boolean = false

		try {
			publicSharingEnabled = await Promise.resolve(false)
		} catch (error) {
			webviewLog.error(
				`[getState] failed to get public sharing enabled state: ${error instanceof Error ? error.message : String(error)}`,
			)
		}

		let organizationSettingsVersion: number = -1

		try {
			organizationSettingsVersion = -1
		} catch (error) {
			webviewLog.error(
				`[getState] failed to get organization settings version: ${error instanceof Error ? error.message : String(error)}`,
			)
		}

		let taskSyncEnabled: boolean = false

		try {
			taskSyncEnabled = false
		} catch (error) {
			webviewLog.error(
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
			allowedReadPaths: stateValues.allowedReadPaths,
			allowedWritePaths: stateValues.allowedWritePaths,
			soundEnabled: stateValues.soundEnabled ?? false,
			ttsEnabled: stateValues.ttsEnabled ?? false,
			ttsSpeed: stateValues.ttsSpeed ?? 1.0,
			soundVolume: stateValues.soundVolume,
			writeDelayMs: stateValues.writeDelayMs ?? DEFAULT_WRITE_DELAY_MS,
			// Retry policy. Both are read by `Task` off this state — a value the
			// user configured and this object omits is a setting that silently
			// does nothing (`requestDelaySeconds` was exactly that).
			requestDelaySeconds: stateValues.requestDelaySeconds,
			maxConsecutiveApiFailures: stateValues.maxConsecutiveApiFailures,
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
			currentApiConfigName:
				this.getCurrentTask()?.taskApiConfigName || stateValues.currentApiConfigName || "default",
			listApiConfigMeta: stateValues.listApiConfigMeta ?? [],
			pinnedApiConfigs: stateValues.pinnedApiConfigs ?? {},
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
			enableSubfolderRules: stateValues.enableSubfolderRules ?? true,
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
			profileThresholds: stateValues.profileThresholds ?? {},
			lockApiConfigAcrossModes: this.context.workspaceState.get("lockApiConfigAcrossModes", false),
			includeDiagnosticMessages: stateValues.includeDiagnosticMessages ?? true,
			maxDiagnosticMessages: stateValues.maxDiagnosticMessages ?? 50,
			includeTaskHistoryInEnhance: stateValues.includeTaskHistoryInEnhance ?? true,
			includeCurrentTime: stateValues.includeCurrentTime ?? true,
			includeCurrentCost: stateValues.includeCurrentCost ?? true,
			maxGitStatusFiles: stateValues.maxGitStatusFiles ?? 0,
			defaultCostLimit: stateValues.defaultCostLimit,
			archivedTaskRetentionDays: stateValues.archivedTaskRetentionDays,
			maxParallelTasks: stateValues.maxParallelTasks,
			taskSyncEnabled,
			imageGenerationProvider: stateValues.imageGenerationProvider,
			openRouterImageApiKey: stateValues.openRouterImageApiKey,
			openRouterImageGenerationSelectedModel: stateValues.openRouterImageGenerationSelectedModel,
			logLevel: stateValues.logLevel,
			logCategories: stateValues.logCategories,
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
		const answer = await getHost().notifier.showChoice(
			t("common:confirmation.reset_state"),
			[t("common:answers.yes")],
			{ modal: true },
		)

		if (answer !== t("common:answers.yes")) {
			return
		}

		await this.contextProxy.resetAllState()
		await this.providerSettingsManager.resetAllConfigs()
		await this.customModesManager.resetCustomModes()
		await this.removeShoferFromStack()
		await this.postInitState()
		await this.postMessageToWebview({ type: "action", action: "chatButtonClicked" })
	}

	// logging

	/**
	 * Log an informational message through the Webview subsystem logger.
	 *
	 * Routes through the shared CompactTransport so the message respects
	 * the user's level and category filter settings (Settings → Logging).
	 * The message appears with the `[Webview]` ctx tag in the Output Channel
	 * and is gated by the "Webview" category checkbox.
	 */
	public log(message: string) {
		webviewLog.info(message)
	}

	/**
	 * Debug-level logging: only emitted when {@link process.env.DEBUG} is set
	 * AND the transport level is `"debug"`.
	 *
	 * Routes through the shared CompactTransport so the message respects the
	 * user's level and category filter settings.  The guard on
	 * `process.env.DEBUG` is preserved as a developer-only gate in addition to
	 * the transport-level filter.
	 */
	public debug(message: string) {
		if (process.env.DEBUG) {
			webviewLog.debug(message)
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
			// setValues covers every globalSettings key (allowedCommands,
			// deniedCommands, commandExecutionTimeout included) — none of them are
			// VS Code settings anymore, so there is no second store to update.
			await this.setValues(configuration)

			if (configuration.currentApiConfigName) {
				await this.setProviderProfile(configuration.currentApiConfigName)
			}

			// Register custom modes so the CustomModesManager knows about them.
			// setValues writes to global state, but the manager overwrites that
			// when it merges .shofer/shofermodes + global settings on refresh.  Persisting
			// via updateCustomMode ensures modes survive the merge cycle.
			// Org-locked slugs are skipped: their definitions come from the org
			// mount already, and persisting them would trip the mutation guard's
			// user-visible refusal for a write no user asked for.
			if (configuration.customModes?.length) {
				const lockedSlugs = await this.customModesManager.getLockedModeSlugs()
				for (const mode of configuration.customModes) {
					if (lockedSlugs.includes(mode.slug)) {
						continue
					}
					await this.customModesManager.updateCustomMode(mode.slug, mode)
				}
			}
		}

		const { apiConfiguration, organizationAllowList, experiments } = await this.getState()

		// Subtasks (and other mode-seeded tasks) arrive with `initialMode` but no
		// explicit `initialApiConfigName` — e.g. new_task only knows the child's
		// mode. Without this, the child would silently inherit the parent/global
		// active profile instead of its OWN mode's API config. Resolve the mode's
		// associated profile name here so both the API handler built below AND the
		// task's displayed config name (via the Task constructor seeding) reflect
		// the new mode.
		if (!options.initialApiConfigName && options.initialMode) {
			options.initialApiConfigName = await this.resolveModeApiConfigName(options.initialMode)
		}

		// Per-task API profile seed: when the caller passed an explicit
		// `initialApiConfigName`, load that profile's full settings and use them to
		// build this task's API handler WITHOUT activating the profile globally
		// (the global active profile remains the tier-3 default). Falls back to the
		// global `apiConfiguration` on any lookup failure.
		let taskApiConfiguration = apiConfiguration
		if (options.initialApiConfigName) {
			try {
				const profile = await this.providerSettingsManager.getProfile({
					name: options.initialApiConfigName,
				})
				if (profile?.apiProvider) {
					taskApiConfiguration = profile
				}
			} catch (error) {
				this.log(
					`[createTask] Failed to load API profile "${options.initialApiConfigName}"; ` +
						`using global default: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		}

		// Single-open-task invariant: at most one task is open on the stack, so
		// `getCurrentTask()` is unambiguous. Enforced here for USER-INITIATED
		// top-level tasks, where clearing means replacing — the person asking for
		// the new chat is the one who was watching the old one, so aborting it
		// costs nobody anything.
		//
		// `keepCurrentTask` says the caller has already made room without killing
		// (`backgroundCurrentTask`), which is how every non-webview entry point
		// works: on a headless node the task being displaced belongs to a
		// different conversation and a different controller. The invariant still
		// holds there — one task on the stack — it is only the abort that is
		// wrong. Do not "restore" an unconditional abort here.
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
			apiConfiguration: taskApiConfiguration,
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
			// Per-task CWD: wherever placement put this task (a plugin may give it its
			// own checkout). Merged from options first, then overridden by the explicit
			// cwd parameter if provided.
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
		// Guard against concurrent Stop clicks — the first one wins, subsequent
		// ones bail early. Without this, two rapid clicks produce two concurrent
		// abortTask() → dispose() chains which race on cleanup and log errors.
		if (this._cancelling) {
			webviewLog.info(`[cancelTask] cancellation already in progress; ignoring duplicate`)
			return
		}
		this._cancelling = true

		try {
			await this._cancelTaskInner()
		} finally {
			this._cancelling = false
		}
	}

	private async _cancelTaskInner(): Promise<void> {
		const task = this.getCurrentTask()

		if (!task) {
			return
		}

		// Skip cancellation if the task is already in a terminal state. Cancelling
		// a finished task is a no-op, but `task.abortTask()` below can HANG on it —
		// it awaits stream/dispose state that has already settled — which leaves
		// `_cancelling` stuck true and stalls every caller awaiting `cancelTask()`
		// (e.g. the external control API's `cancelCurrentTask()`).
		if (task.abort || task.abandoned || task.didExecuteAttemptCompletion) {
			webviewLog.info(
				`[cancelTask] task ${task.taskId}.${task.instanceId} already terminal ` +
					`(abort=${task.abort}, abandoned=${task.abandoned}, completed=${task.didExecuteAttemptCompletion}); skipping`,
			)
			return
		}

		webviewLog.info(`[cancelTask] cancelling task ${task.taskId}.${task.instanceId}`)

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

		// Mark the original instance as abandoned to prevent any residual activity
		task.abandoned = true

		// Await abortTask so dispose runs to completion before we proceed.
		// The streaming loop's catch block may also call abortTask() when it
		// sees this.abort === true — that second call is idempotent (all
		// dispose steps are wrapped in try/catch) so the double-dispose is
		// harmless. The important thing is that one full cleanup completes
		// here before we try to rehydrate.
		await task.abortTask()

		// After abortTask, the stream loop's finally block will set
		// isStreaming = false. Wait briefly for that to propagate — the
		// timeout here is short because abortTask already did the heavy
		// lifting (dispose, save messages, revert diffs).
		await pWaitFor(
			() =>
				this.getCurrentTask()! === undefined ||
				this.getCurrentTask()!.isStreaming === false ||
				this.getCurrentTask()!.didFinishAbortingStream ||
				this.getCurrentTask()!.isWaitingForFirstChunk,
			{
				timeout: 3_000,
			},
		).catch(() => {
			const current = this.getCurrentTask()
			webviewLog.error(
				`Failed to abort task ${task.taskId}.${task.instanceId} within 3s timeout` +
					(current
						? ` (isStreaming=${current.isStreaming}, didFinishAbortingStream=${current.didFinishAbortingStream}, isWaitingForFirstChunk=${current.isWaitingForFirstChunk})`
						: ` (task already removed from stack)`),
			)
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

		// When a WorkflowTask was stopped before the slang loop started
		// (e.g. during param collection), there is no work to resume —
		// the task was just asking the user a question. The live
		// WorkflowTask's .catch() handler already set flowState.status
		// to "aborted" and persisted it during abortTask(). Skip
		// rehydrate so the task stays stopped instead of re-asking the
		// same question.
		if (historyItem.isWorkflow) {
			// Re-read history from disk — abortTask() may have updated
			// the persisted flowState.status to "aborted".
			let freshStatus: string | undefined
			try {
				const fresh = await this.getTaskWithId(historyItem.id)
				freshStatus = (fresh.historyItem.flowState as Record<string, unknown>)?.status as string | undefined
			} catch {
				// Fall back to the in-memory snapshot
				freshStatus = (historyItem.flowState as Record<string, unknown>)?.status as string | undefined
			}
			if (freshStatus && freshStatus !== "running") {
				webviewLog.info(
					`[cancelTask] Skipping rehydrate: WorkflowTask ${task.taskId} was stopped (status=${freshStatus})`,
				)
				return
			}
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
			webviewLog.info(`[clearTask] clearing task ${task.taskId}.${task.instanceId}`)
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
			const modes = await this.customModesManager.getCustomModes()
			// Feeds the CLI's /mode autocomplete and the GetModes API — user-facing
			// enumerations, so private modes are hidden here like everywhere else.
			// They remain switch-able by slug (mode resolution uses the full list).
			return modes.filter((m) => !m.private).map(({ slug, name }) => ({ slug, name }))
		} catch (error) {
			this.log(`Failed to list modes: ${error instanceof Error ? error.message : String(error)}`)
			return []
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
		await this.postInitState()

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
	 * Register a peer sync resolver for a recipient task. Returns a Promise that
	 * resolves with the recipient's attempt_completion result when answered.
	 *
	 * Rejects if a sync resolver is already registered for this recipient
	 * (exactly one sync prompt per recipient at a time).
	 */
	public registerPendingSyncResolver(recipientTaskId: string, initiatorTaskId: string): Promise<string> {
		if (this.pendingSyncResolvers.has(recipientTaskId)) {
			return Promise.reject(
				new Error(
					`Task ${recipientTaskId} is already serving a sync request and cannot accept another until it completes.`,
				),
			)
		}
		return new Promise<string>((resolve) => {
			this.pendingSyncResolvers.set(recipientTaskId, { initiatorTaskId, resolve })
		})
	}

	/**
	 * Check if a pending sync resolver exists for the given recipient task ID.
	 */
	public hasPendingSyncResolver(recipientTaskId: string): boolean {
		return this.pendingSyncResolvers.has(recipientTaskId)
	}

	/**
	 * Clear a pending sync resolver without firing it (timeout/abort path).
	 */
	public clearPendingSyncResolver(recipientTaskId: string): void {
		this.pendingSyncResolvers.delete(recipientTaskId)
	}

	/**
	 * Resolve a pending sync request for a recipient and deliver the result to the initiator.
	 * Returns true if a sync (peer) resolver was found and fired; false if only a blocking-child
	 * resolver (parent/child) was handled, or if no resolver was found.
	 *
	 * This is the generalized routing point called by AttemptCompletionTool — it checks
	 * peer sync resolvers first, then falls through to the existing parent/child path.
	 */
	public async resolvePendingSyncForRecipient(params: {
		recipientTaskId: string
		completionResult: string
	}): Promise<boolean> {
		const { recipientTaskId, completionResult } = params

		const peerEntry = this.pendingSyncResolvers.get(recipientTaskId)
		if (peerEntry) {
			this.pendingSyncResolvers.delete(recipientTaskId)
			this.debug(
				`[resolvePendingSyncForRecipient] peer path: recipientTaskId=${recipientTaskId} → initiator=${peerEntry.initiatorTaskId}`,
			)
			peerEntry.resolve(completionResult)
			return true
		}

		return false
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
			webviewLog.error(error.message)
			// Fallback to file URI if no webview available
			return fileUri.toString()
		} catch (error) {
			// More specific error handling
			if (error instanceof TypeError) {
				webviewLog.error("Invalid file path provided for URI conversion:", error)
			} else {
				webviewLog.error("Failed to convert to webview URI:", error)
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
	 * @param cwd Directory the task runs in; defaults to the workspace. A plugin may
	 *   place a task elsewhere (the bundled `worktrees` plugin gives each its own checkout).
	 * @param seeds Optional per-task mode / API-config profile seeds (from the
	 *   pre-task chat dropdown). Absent values fall back to the global defaults.
	 */
	public async createManagedTask(
		name?: string,
		text?: string,
		images?: string[],
		cwd?: string,
		seeds?: { mode?: string; apiConfigName?: string },
	): Promise<string | undefined> {
		this.log(
			`[createManagedTask] Called — name=${name || "(auto)"} ` +
				`textLen=${text?.length ?? 0} images=${images?.length ?? 0} ` +
				`cwd=${cwd ?? "(workspace)"} ` +
				`mode=${seeds?.mode ?? "(global)"} apiConfig=${seeds?.apiConfigName ?? "(global)"} ` +
				`stackDepth=${this.shoferStack.length}`,
		)

		// Pop the current task from the stack WITHOUT aborting it — it continues in background
		// Save reference so we can restore it if task creation fails
		const poppedTask = this.popFromStackWithoutAborting()
		this.log(
			`[createManagedTask] Popped task: ${poppedTask ? `${poppedTask.taskId} [${poppedTask.constructor.name}]` : "(none — stack was empty)"}`,
		)

		try {
			// Register the popped task as a background task (if it's not already registered)
			// so it shows correct state indicators in the dropdown
			if (poppedTask) {
				this.taskManager.registerBackgroundTask(poppedTask)
			}

			// Auto-generate task name from first message if provided, otherwise use fallback
			const taskName = name || (text ? this.generateTaskNameFromText(text) : "New Task")

			// Create a new task with keepCurrentTask=true so createTask won't abort any remaining tasks.
			// `cwd` is where the task runs (a plugin may have placed it), and the seeds are
			// the per-task mode / API-config from the pre-task chat dropdown.
			const task = await this.createTask(
				text,
				images,
				undefined,
				{
					keepCurrentTask: true,
					initialMode: seeds?.mode,
					initialApiConfigName: seeds?.apiConfigName,
				},
				{},
				cwd,
			)

			if (!task) {
				throw new Error("Failed to create task")
			}
			this.log(`[createManagedTask] createTask returned task ${task.taskId}`)

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
				// cwd is the per-task working directory (shown in the task list when it
				// differs).
				workspace: task.workspacePath || "",
				cwd: task.cwd !== task.workspacePath ? task.cwd : undefined,
				name: managedTask.name,

				lastActiveTs: managedTask.lastActiveAt,
				taskState: managedTask.state,
			}

			await this.updateTaskHistory(historyItem)

			// Notify the webview of the new current task and switch to the chat tab.
			await this.postInitState()
			await this.postMessageToWebview({ type: "action", action: "chatButtonClicked" })

			this.debug(`Created managed task: ${managedTask.id} (${managedTask.name})`)
			return task.taskId
		} catch (error) {
			// Restore the old task to the stack if creation failed
			if (poppedTask) {
				await this.addShoferToStack(poppedTask)
				this.log(`[createManagedTask] Restored previous task ${poppedTask.taskId} after creation failure`)
			}
			this.log(`Failed to create managed task: ${error}`)
			getHost().notifier.error(
				`Failed to create managed task: ${error instanceof Error ? error.message : String(error)}`,
			)
			return undefined
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
					// Sticky-mode is per-task: the mode picker reads the focused
					// task's `_taskMode` directly in the state push below, so no
					// global mirror write is needed on focus.
					await this.postInitState()
				} else {
					// Stack is empty — just push the task
					await this.addShoferToStack(liveTask)
					await this.postInitState()
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
			getHost().notifier.error(
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
	public renameManagedTask(taskId: string, name: string, source: "user" | "agent" = "user"): void {
		this.taskManager.renameManagedTask(taskId, name)

		// Persist the rename, recording who set it. A webview/user rename defaults
		// to 'user' (sticky against set_task_title); the agent's set_task_title
		// passes 'agent'.
		this.getTaskWithId(taskId)
			.then(({ historyItem }) => {
				this.updateTaskHistory({ ...historyItem, name, titleSource: source })
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
	 * Delete a managed task and all its descendants.
	 *
	 * The persisted cascade is handled by `deleteTaskWithId` which recursively
	 * collects child IDs (via `childIds` in persisted history) and deletes them
	 * from the task-history store and on-disk task directories (and notifies plugins).
	 *
	 * Live (in-memory) child tasks running in `TaskManager` are also aborted and
	 * removed here so they don't become zombie instances — `deleteTaskWithId`
	 * only touches persisted state.
	 */
	public async deleteManagedTask(taskId: string): Promise<void> {
		try {
			// Collect the full set of descendant IDs from persisted history before
			// deleting anything, so we know which live tasks to tear down.
			const allIdsToDelete = await this.collectCascadedTaskIds(taskId)

			// Tear down live instances managed by TaskManager (abort + unregister).
			for (const id of allIdsToDelete) {
				try {
					await this.taskManager.deleteManagedTask(id)
				} catch (error) {
					this.log(`Failed to tear down managed task ${id}: ${error}`)
				}
			}

			// Persisted cascade: delete from the task-history store and on-disk task
			// directories for all descendants.
			await this.deleteTaskWithId(taskId)
		} catch (error) {
			this.log(`Failed to delete managed task: ${error}`)
		}
	}

	/**
	 * Walk the `childIds` chain through persisted history to build the complete
	 * set of task IDs to delete (the requested task + all descendants).
	 *
	 * This reads the same persisted history that `deleteTaskWithId` operates on,
	 * so the two views are guaranteed consistent.
	 */
	private async collectCascadedTaskIds(rootId: string): Promise<string[]> {
		const result: string[] = [rootId]

		const walk = async (taskId: string): Promise<void> => {
			try {
				const { historyItem } = await this.getTaskWithId(taskId)
				if (historyItem.childIds && historyItem.childIds.length > 0) {
					for (const childId of historyItem.childIds) {
						result.push(childId)
						await walk(childId)
					}
				}
			} catch {
				// Task not found in persisted history — may be a freshly created
				// background child that hasn't been persisted yet. Still included
				// in the result so TaskManager can clean it up.
			}
		}

		await walk(rootId)

		// Deduplicate in case of cycles (shouldn't happen, but defensive).
		return [...new Set(result)]
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
				activeTimeMs: s.activeTimeMs,
			})),
		})
	}

	/**
	 * Generate a task name from the first message text.
	 * Extracts the first meaningful sentence/phrase (up to 50 chars).
	 */
	private generateTaskNameFromText(text: string): string {
		// The task title is LITERAL text, not markdown — do NOT strip `_`/`*`/backticks,
		// which would mangle identifiers/paths (e.g. `ask_live_memory` → `asklivememory`).
		// Just collapse whitespace, take the first sentence/phrase, and truncate.
		const cleaned = text.replace(/\s+/g, " ").trim()

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
