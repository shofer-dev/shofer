import * as path from "path"
import * as vscode from "vscode"
import os from "os"
import crypto from "crypto"
import { v7 as uuidv7 } from "uuid"
import EventEmitter from "events"

import { AskIgnoredError } from "./AskIgnoredError"

import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"
import debounce from "lodash.debounce"
import delay from "delay"
import pWaitFor from "p-wait-for"
import { serializeError } from "serialize-error"
import { Package } from "../../shared/package"
import { formatToolInvocation } from "../tools/helpers/toolResultFormatting"

import {
	type TaskLike,
	type TaskMetadata,
	type TaskEvents,
	type ProviderSettings,
	type TokenUsage,
	type ToolUsage,
	type ToolName,
	type ContextCondense,
	type ContextTruncation,
	type ClineMessage,
	type ClineSay,
	type ClineAsk,
	type ToolProgressStatus,
	type HistoryItem,
	type CreateTaskOptions,
	type ModelInfo,
	type ClineApiReqCancelReason,
	type ClineApiReqInfo,
	type TaskHandle,
	type CostLimit,
	RooCodeEventName,
	TelemetryEventName,
	TaskStatus,
	TodoItem,
	getApiProtocol,
	getModelId,
	isRetiredProvider,
	isIdleAsk,
	isInteractiveAsk,
	isResumableAsk,
	QueuedMessage,
	DEFAULT_CONSECUTIVE_MISTAKE_LIMIT,
	DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
	MAX_CHECKPOINT_TIMEOUT_SECONDS,
	MIN_CHECKPOINT_TIMEOUT_SECONDS,
	ConsecutiveMistakeError,
	MAX_MCP_TOOLS_THRESHOLD,
	countEnabledMcpTools,
} from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"
import { CloudService } from "@roo-code/cloud"

// api
import { ApiHandler, ApiHandlerCreateMessageMetadata, buildApiHandler } from "../../api"
import { ApiStream, GroundingSource } from "../../api/transform/stream"
import { maybeRemoveImageBlocks } from "../../api/transform/image-cleaning"

// shared
import { findLastIndex } from "../../shared/array"
import { combineApiRequests } from "../../shared/combineApiRequests"
import { combineCommandSequences } from "../../shared/combineCommandSequences"
import { t } from "../../i18n"
import { getApiMetrics, hasTokenUsageChanged, hasToolUsageChanged } from "../../shared/getApiMetrics"
import { ClineAskResponse } from "../../shared/WebviewMessage"
import { defaultModeSlug, getModeBySlug } from "../../shared/modes"
import { DiffStrategy, type ToolUse, type ToolParamName, toolParamNames } from "../../shared/tools"
import { getModelMaxOutputTokens } from "../../shared/api"

// services
import { McpHub } from "../../services/mcp/McpHub"
import { McpServerManager } from "../../services/mcp/McpServerManager"
import { RepoPerTaskCheckpointService } from "../../services/checkpoints"

// integrations
import { DiffViewProvider } from "../../integrations/editor/DiffViewProvider"
import { findToolName } from "../../integrations/misc/export-markdown"
import { RooTerminalProcess } from "../../integrations/terminal/types"
import { TerminalRegistry } from "../../integrations/terminal/TerminalRegistry"
import { OutputInterceptor } from "../../integrations/terminal/OutputInterceptor"

// utils
import { calculateApiCostAnthropic, calculateApiCostOpenAI } from "../../shared/cost"
import { getWorkspacePath } from "../../utils/path"
import { sanitizeToolUseId } from "../../utils/tool-id"
import { getTaskDirectoryPath } from "../../utils/storage"

// prompts
import { formatResponse } from "../prompts/responses"
import { SYSTEM_PROMPT } from "../prompts/system"
import { buildNativeToolsArrayWithRestrictions } from "./build-tools"

// core modules
import { ToolRepetitionDetector } from "../tools/ToolRepetitionDetector"
import { restoreTodoListForTask } from "../tools/UpdateTodoListTool"
import { FileContextTracker } from "../context-tracking/FileContextTracker"
import { RooIgnoreController } from "../ignore/RooIgnoreController"
import { RooProtectedController } from "../protect/RooProtectedController"
import { type AssistantMessageContent, presentAssistantMessage } from "../assistant-message"
import { NativeToolCallParser } from "../assistant-message/NativeToolCallParser"
import { manageContext, willManageContext } from "../context-management"
import { aggregateTaskCostsRecursive } from "../webview/aggregateTaskCosts"
import { ClineProvider } from "../webview/ClineProvider"
import { MultiSearchReplaceDiffStrategy } from "../diff/strategies/multi-search-replace"
import {
	type ApiMessage,
	readApiMessages,
	saveApiMessages,
	readTaskMessages,
	saveTaskMessages,
	taskMetadata,
} from "../task-persistence"
import { getEnvironmentDetails } from "../environment/getEnvironmentDetails"
import { checkContextWindowExceededError } from "../context/context-management/context-error-handling"
import {
	type CheckpointDiffOptions,
	type CheckpointRestoreOptions,
	getCheckpointService,
	checkpointSave,
	checkpointRestore,
	checkpointDiff,
} from "../checkpoints"
import { processUserContentMentions } from "../mentions/processUserContentMentions"
import { getMessagesSinceLastSummary, summarizeConversation, getEffectiveApiHistory } from "../condense"
import { MessageQueueService } from "../message-queue/MessageQueueService"
import { AutoApprovalHandler, checkAutoApproval } from "../auto-approval"
import { MessageManager } from "../message-manager"
import { validateAndFixToolResultIds } from "./validateToolResultIds"
import { mergeConsecutiveApiMessages } from "./mergeConsecutiveApiMessages"

const MAX_EXPONENTIAL_BACKOFF_SECONDS = 600 // 10 minutes
const DEFAULT_USAGE_COLLECTION_TIMEOUT_MS = 5000 // 5 seconds
const FORCED_CONTEXT_REDUCTION_PERCENT = 75 // Keep 75% of context (remove 25%) on context window errors
const MAX_CONTEXT_WINDOW_RETRIES = 3 // Maximum retries for context window errors

export interface TaskOptions extends CreateTaskOptions {
	provider: ClineProvider
	apiConfiguration: ProviderSettings
	enableCheckpoints?: boolean
	checkpointTimeout?: number
	consecutiveMistakeLimit?: number
	task?: string
	images?: string[]
	historyItem?: HistoryItem
	experiments?: Record<string, boolean>
	startTask?: boolean
	rootTask?: Task
	parentTask?: Task
	taskNumber?: number
	onCreated?: (task: Task) => void
	initialTodos?: TodoItem[]
	workspacePath?: string
	/** Initial status for the task's history item (e.g., "active" for child tasks) */
	initialStatus?: "active" | "delegated" | "completed"
}

export class Task extends EventEmitter<TaskEvents> implements TaskLike {
	readonly taskId: string
	readonly rootTaskId?: string
	readonly parentTaskId?: string
	childTaskId?: string
	pendingNewTaskToolCallId?: string

	// NEW: Track background children
	backgroundChildren: Map<string, TaskHandle> = new Map()

	/**
	 * Per-root-task USD budget cap. Stored only on root tasks; subtasks
	 * resolve the limit by walking up the parentTask chain via
	 * `resolveCostLimit()`. Unset or maxUsd <= 0 disables enforcement.
	 */
	costLimit?: CostLimit

	/**
	 * Cached aggregated cost for the current API request, keyed by the
	 * `clineMessages` index of the request. Avoids re-scanning history
	 * on every chunk of a single streaming response.
	 */
	private _costLimitCheckCache?: { spent: number; requestIndex: number }

	/**
	 * Snapshot of the aggregated cost across the root task's history
	 * captured at the start of the current API request, BEFORE this
	 * request's own usage is added. Used by the in-stream check
	 * (`checkInFlightCostLimit`) to compute live spend as
	 * `_priorAggregateUsd + thisRequestCostUsd` on every `usage` chunk
	 * without re-scanning history each time. Reset per request boundary.
	 */
	private _priorAggregateUsd?: number

	/**
	 * Per-request guard so the in-stream cost check fires its
	 * abort/pause/kill action AT MOST ONCE for the current API call.
	 * Without this, multiple `usage` chunks crossing the cap would each
	 * try to enforce — re-aborting an already-aborting task or stacking
	 * pause prompts. Reset per request boundary alongside the snapshot.
	 */
	private _costLimitEnforcementFiredForRequest = false

	/**
	 * Set to `true` when the user has chosen to continue past the cost
	 * cap for the remainder of this task. Reset only by abort/dispose.
	 * Implements the "Continue without limit" branch of the pause dialog.
	 */
	private _costLimitBypassed = false

	// Helper to check if child is alive
	isBackgroundChildAlive(childId: string): boolean {
		if (
			this.providerRef.deref() &&
			typeof (this.providerRef.deref() as any).getManagedTaskInstance === "function"
		) {
			return (this.providerRef.deref() as any).getManagedTaskInstance(childId) !== undefined
		}
		return false
	}

	// Cleanup dead children on parent resume/load
	async cleanupBackgroundChildren(): Promise<void> {
		for (const [childId, handle] of this.backgroundChildren) {
			if (!this.isBackgroundChildAlive(childId)) {
				try {
					// Check final status from history
					const provider = this.providerRef.deref()
					if (provider) {
						const historyItem = await (provider as any).getTaskWithId(childId)
						handle.status = historyItem.status === "completed" ? "completed" : "error"
					}
				} catch (_) {
					handle.status = "error"
				}
			}
		}
	}

	readonly instanceId: string
	readonly metadata: TaskMetadata

	todoList?: TodoItem[]

	readonly rootTask: Task | undefined = undefined
	readonly parentTask: Task | undefined = undefined
	readonly taskNumber: number
	readonly workspacePath: string

	/**
	 * The mode associated with this task. Persisted across sessions
	 * to maintain user context when reopening tasks from history.
	 *
	 * ## Lifecycle
	 *
	 * ### For new tasks:
	 * 1. Initially `undefined` during construction
	 * 2. Asynchronously initialized from provider state via `initializeTaskMode()`
	 * 3. Falls back to `defaultModeSlug` if provider state is unavailable
	 *
	 * ### For history items:
	 * 1. Immediately set from `historyItem.mode` during construction
	 * 2. Falls back to `defaultModeSlug` if mode is not stored in history
	 *
	 * ## Important
	 * This property should NOT be accessed directly until `taskModeReady` promise resolves.
	 * Use `getTaskMode()` for async access or `taskMode` getter for sync access after initialization.
	 *
	 * @private
	 * @see {@link getTaskMode} - For safe async access
	 * @see {@link taskMode} - For sync access after initialization
	 * @see {@link waitForModeInitialization} - To ensure initialization is complete
	 */
	private _taskMode: string | undefined

	/**
	 * Promise that resolves when the task mode has been initialized.
	 * This ensures async mode initialization completes before the task is used.
	 *
	 * ## Purpose
	 * - Prevents race conditions when accessing task mode
	 * - Ensures provider state is properly loaded before mode-dependent operations
	 * - Provides a synchronization point for async initialization
	 *
	 * ## Resolution timing
	 * - For history items: Resolves immediately (sync initialization)
	 * - For new tasks: Resolves after provider state is fetched (async initialization)
	 *
	 * @private
	 * @see {@link waitForModeInitialization} - Public method to await this promise
	 */
	private taskModeReady: Promise<void>

	/**
	 * The API configuration name (provider profile) associated with this task.
	 * Persisted across sessions to maintain the provider profile when reopening tasks from history.
	 *
	 * ## Lifecycle
	 *
	 * ### For new tasks:
	 * 1. Initially `undefined` during construction
	 * 2. Asynchronously initialized from provider state via `initializeTaskApiConfigName()`
	 * 3. Falls back to "default" if provider state is unavailable
	 *
	 * ### For history items:
	 * 1. Immediately set from `historyItem.apiConfigName` during construction
	 * 2. Falls back to undefined if not stored in history (for backward compatibility)
	 *
	 * ## Important
	 * If you need a non-`undefined` provider profile (e.g., for profile-dependent operations),
	 * wait for `taskApiConfigReady` first (or use `getTaskApiConfigName()`).
	 * The sync `taskApiConfigName` getter may return `undefined` for backward compatibility.
	 *
	 * @private
	 * @see {@link getTaskApiConfigName} - For safe async access
	 * @see {@link taskApiConfigName} - For sync access after initialization
	 */
	private _taskApiConfigName: string | undefined

	/**
	 * Promise that resolves when the task API config name has been initialized.
	 * This ensures async API config name initialization completes before the task is used.
	 *
	 * ## Purpose
	 * - Prevents race conditions when accessing task API config name
	 * - Ensures provider state is properly loaded before profile-dependent operations
	 * - Provides a synchronization point for async initialization
	 *
	 * ## Resolution timing
	 * - For history items: Resolves immediately (sync initialization)
	 * - For new tasks: Resolves after provider state is fetched (async initialization)
	 *
	 * @private
	 */
	private taskApiConfigReady: Promise<void>

	providerRef: WeakRef<ClineProvider>
	private readonly globalStoragePath: string
	abort: boolean = false
	currentRequestAbortController?: AbortController
	skipPrevResponseIdOnce: boolean = false

	// TaskStatus
	idleAsk?: ClineMessage
	resumableAsk?: ClineMessage
	interactiveAsk?: ClineMessage

	didFinishAbortingStream = false
	abandoned = false
	abortReason?: ClineApiReqCancelReason
	isInitialized = false
	isPaused: boolean = false

	// API
	apiConfiguration: ProviderSettings
	api: ApiHandler
	private static lastGlobalApiRequestTime?: number
	private autoApprovalHandler: AutoApprovalHandler

	/**
	 * Reset the global API request timestamp. This should only be used for testing.
	 * @internal
	 */
	static resetGlobalApiRequestTime(): void {
		Task.lastGlobalApiRequestTime = undefined
	}

	toolRepetitionDetector: ToolRepetitionDetector
	rooIgnoreController?: RooIgnoreController
	rooProtectedController?: RooProtectedController
	fileContextTracker: FileContextTracker
	terminalProcess?: RooTerminalProcess

	// Editing
	diffViewProvider: DiffViewProvider
	diffStrategy?: DiffStrategy
	didEditFile: boolean = false

	// LLM Messages & Chat Messages
	apiConversationHistory: ApiMessage[] = []
	clineMessages: ClineMessage[] = []

	// Ask
	private askResponse?: ClineAskResponse
	private askResponseText?: string
	private askResponseImages?: string[]
	public lastMessageTs?: number
	private autoApprovalTimeoutRef?: NodeJS.Timeout
	// True while ask() is actively waiting for a response from the user/webview.
	// Used by handleWebviewAskResponse() to detect stray messageResponse arrivals
	// (e.g. user typing during a tool execution window when no ask is pending) and
	// route them to the message queue instead of silently overwriting unread
	// askResponse* slots that the next ask() call would clear.
	private isAwaitingAskResponse: boolean = false

	// Tool Use
	consecutiveMistakeCount: number = 0
	consecutiveMistakeLimit: number
	consecutiveMistakeCountForApplyDiff: Map<string, number> = new Map()
	consecutiveMistakeCountForEditFile: Map<string, number> = new Map()
	consecutiveNoToolUseCount: number = 0
	consecutiveNoAssistantMessagesCount: number = 0
	toolUsage: ToolUsage = {}

	// Checkpoints
	enableCheckpoints: boolean
	checkpointTimeout: number
	checkpointService?: RepoPerTaskCheckpointService
	checkpointServiceInitializing = false

	// Message Queue Service
	public readonly messageQueueService: MessageQueueService
	private messageQueueStateChangedHandler: (() => void) | undefined

	// Streaming
	isWaitingForFirstChunk = false
	isStreaming = false
	currentStreamingContentIndex = 0
	currentStreamingDidCheckpoint = false
	assistantMessageContent: AssistantMessageContent[] = []
	presentAssistantMessageLocked = false
	presentAssistantMessageHasPendingUpdates = false
	userMessageContent: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam | Anthropic.ToolResultBlockParam)[] = []
	userMessageContentReady = false

	/**
	 * Flag indicating whether the assistant message for the current streaming session
	 * has been saved to API conversation history.
	 *
	 * This is critical for parallel tool calling: tools should NOT execute until
	 * the assistant message is saved. Otherwise, if a tool like `new_task` triggers
	 * `flushPendingToolResultsToHistory()`, the user message with tool_results would
	 * appear BEFORE the assistant message with tool_uses, causing API errors.
	 *
	 * Reset to `false` at the start of each API request.
	 * Set to `true` after the assistant message is saved in `recursivelyMakeClineRequests`.
	 */
	assistantMessageSavedToHistory = false

	/**
	 * Push a tool_result block to userMessageContent, preventing duplicates.
	 * Duplicate tool_use_ids cause API errors.
	 *
	 * @param toolResult - The tool_result block to add
	 * @returns true if added, false if duplicate was skipped
	 */
	public pushToolResultToUserContent(toolResult: Anthropic.ToolResultBlockParam): boolean {
		const existingResult = this.userMessageContent.find(
			(block): block is Anthropic.ToolResultBlockParam =>
				block.type === "tool_result" && block.tool_use_id === toolResult.tool_use_id,
		)
		if (existingResult) {
			console.warn(
				`[Task#pushToolResultToUserContent] Skipping duplicate tool_result for tool_use_id: ${toolResult.tool_use_id}`,
			)
			return false
		}
		this.userMessageContent.push(toolResult)
		return true
	}
	didRejectTool = false
	didAlreadyUseTool = false
	didToolFailInCurrentTurn = false
	didExecuteAttemptCompletion = false
	didCompleteReadingStream = false
	private _started = false
	// No streaming parser is required.
	assistantMessageParser?: undefined
	private providerProfileChangeListener?: (config: { name: string; provider?: string }) => void

	// Native tool call streaming state (track which index each tool is at)
	private streamingToolCallIndices: Map<string, number> = new Map()

	// Cached model info for current streaming session (set at start of each API request)
	// This prevents excessive getModel() calls during tool execution
	cachedStreamingModel?: { id: string; info: ModelInfo }

	// Token Usage Cache
	private tokenUsageSnapshot?: TokenUsage
	private tokenUsageSnapshotAt?: number

	// Tool Usage Cache
	private toolUsageSnapshot?: ToolUsage

	// Token Usage Throttling - Debounced emit function
	private readonly TOKEN_USAGE_EMIT_INTERVAL_MS = 2000 // 2 seconds
	private debouncedEmitTokenUsage: ReturnType<typeof debounce>

	// Cloud Sync Tracking
	private cloudSyncedMessageTimestamps: Set<number> = new Set()

	// Initial status for the task's history item (set at creation time to avoid race conditions)
	private readonly initialStatus?: "active" | "delegated" | "completed"

	// When true, this task is a background child of another task. Persisted onto
	// the task's HistoryItem.isBackground from the first save and used by
	// AttemptCompletionTool to skip the synchronous delegation flow.
	private readonly isBackground: boolean

	// MessageManager for high-level message operations (lazy initialized)
	private _messageManager?: MessageManager

	constructor({
		provider,
		apiConfiguration,
		enableCheckpoints = true,
		checkpointTimeout = DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
		consecutiveMistakeLimit = DEFAULT_CONSECUTIVE_MISTAKE_LIMIT,
		taskId,
		task,
		images,
		historyItem,
		experiments: experimentsConfig,
		startTask = true,
		rootTask,
		parentTask,
		taskNumber = -1,
		onCreated,
		initialTodos,
		workspacePath,
		initialStatus,
		initialMode,
		isBackground,
	}: TaskOptions) {
		super()

		if (startTask && !task && !images && !historyItem) {
			throw new Error("Either historyItem or task/images must be provided")
		}

		if (
			!checkpointTimeout ||
			checkpointTimeout > MAX_CHECKPOINT_TIMEOUT_SECONDS ||
			checkpointTimeout < MIN_CHECKPOINT_TIMEOUT_SECONDS
		) {
			throw new Error(
				"checkpointTimeout must be between " +
					MIN_CHECKPOINT_TIMEOUT_SECONDS +
					" and " +
					MAX_CHECKPOINT_TIMEOUT_SECONDS +
					" seconds",
			)
		}

		this.taskId = historyItem ? historyItem.id : (taskId ?? uuidv7())
		this.rootTaskId = historyItem ? historyItem.rootTaskId : rootTask?.taskId
		this.parentTaskId = historyItem ? historyItem.parentTaskId : parentTask?.taskId
		this.childTaskId = undefined

		this.metadata = {
			task: historyItem ? historyItem.task : task,
			images: historyItem ? [] : images,
		}

		// Normal use-case is usually retry similar history task with new workspace.
		this.workspacePath = parentTask
			? parentTask.workspacePath
			: (workspacePath ?? getWorkspacePath(path.join(os.homedir(), "Desktop")))

		this.instanceId = crypto.randomUUID().slice(0, 8)
		this.taskNumber = -1

		this.rooIgnoreController = new RooIgnoreController(this.cwd)
		this.rooProtectedController = new RooProtectedController(this.cwd)
		this.fileContextTracker = new FileContextTracker(provider, this.taskId)

		this.rooIgnoreController.initialize().catch((error) => {
			console.error("Failed to initialize RooIgnoreController:", error)
		})

		this.apiConfiguration = apiConfiguration
		this.api = buildApiHandler(this.apiConfiguration, {
			taskId: this.taskId,
			parentTaskId: this.parentTaskId,
			rootTaskId: this.rootTaskId,
		})
		this.autoApprovalHandler = new AutoApprovalHandler()

		this.consecutiveMistakeLimit = consecutiveMistakeLimit ?? DEFAULT_CONSECUTIVE_MISTAKE_LIMIT
		this.providerRef = new WeakRef(provider)
		this.globalStoragePath = provider.context.globalStorageUri.fsPath
		this.diffViewProvider = new DiffViewProvider(this.cwd, this)
		this.enableCheckpoints = enableCheckpoints
		this.checkpointTimeout = checkpointTimeout

		this.parentTask = parentTask
		this.rootTask = rootTask
		this.taskNumber = taskNumber
		// Restore the cost limit from history ONLY for root tasks. Subtasks
		// resolve their effective limit via resolveCostLimit() and never carry
		// their own — keeping a single source of truth on the root.
		if (!parentTask) {
			this.costLimit = historyItem?.costLimit
		}
		this.initialStatus = initialStatus
		// Prefer explicit constructor flag; otherwise inherit from history item on rehydration.
		this.isBackground = isBackground ?? historyItem?.isBackground ?? false

		// Store the task's mode and API config name when it's created.
		// For history items, use the stored values; for new tasks, we'll set them
		// after getting state.
		if (historyItem) {
			this._taskMode = historyItem.mode || defaultModeSlug
			this._taskApiConfigName = historyItem.apiConfigName
			this.taskModeReady = Promise.resolve()
			this.taskApiConfigReady = Promise.resolve()
			TelemetryService.instance.captureTaskRestarted(this.taskId)
		} else if (initialMode) {
			// Allow callers to set task mode without mutating provider global mode.
			this._taskMode = initialMode
			this._taskApiConfigName = undefined
			this.taskModeReady = Promise.resolve()
			this.taskApiConfigReady = this.initializeTaskApiConfigName(provider)
			TelemetryService.instance.captureTaskCreated(this.taskId)
		} else {
			// For new tasks, don't set the mode/apiConfigName yet - wait for async initialization.
			this._taskMode = undefined
			this._taskApiConfigName = undefined
			this.taskModeReady = this.initializeTaskMode(provider)
			this.taskApiConfigReady = this.initializeTaskApiConfigName(provider)
			TelemetryService.instance.captureTaskCreated(this.taskId)
		}

		this.assistantMessageParser = undefined

		this.messageQueueService = new MessageQueueService()

		this.messageQueueStateChangedHandler = () => {
			this.emit(RooCodeEventName.TaskUserMessage, this.taskId)
			this.emit(RooCodeEventName.QueuedMessagesUpdated, this.taskId, this.messageQueueService.messages)
			this.providerRef.deref()?.postStateToWebviewWithoutTaskHistory()
		}

		this.messageQueueService.on("stateChanged", this.messageQueueStateChangedHandler)

		// Listen for provider profile changes to update parser state
		this.setupProviderProfileChangeListener(provider)

		// Set up diff strategy
		this.diffStrategy = new MultiSearchReplaceDiffStrategy()

		this.toolRepetitionDetector = new ToolRepetitionDetector(this.consecutiveMistakeLimit)

		// Initialize todo list if provided
		if (initialTodos && initialTodos.length > 0) {
			this.todoList = initialTodos
		}

		// Initialize debounced token usage emit function
		// Uses debounce with maxWait to achieve throttle-like behavior:
		// - leading: true  - Emit immediately on first call
		// - trailing: true - Emit final state when updates stop
		// - maxWait        - Ensures at most one emit per interval during rapid updates (throttle behavior)
		this.debouncedEmitTokenUsage = debounce(
			(tokenUsage: TokenUsage, toolUsage: ToolUsage) => {
				const tokenChanged = hasTokenUsageChanged(tokenUsage, this.tokenUsageSnapshot)
				const toolChanged = hasToolUsageChanged(toolUsage, this.toolUsageSnapshot)

				if (tokenChanged || toolChanged) {
					this.emit(RooCodeEventName.TaskTokenUsageUpdated, this.taskId, tokenUsage, toolUsage)
					this.tokenUsageSnapshot = tokenUsage
					this.tokenUsageSnapshotAt = this.clineMessages.at(-1)?.ts
					// Deep copy tool usage for snapshot
					this.toolUsageSnapshot = JSON.parse(JSON.stringify(toolUsage))
				}
			},
			this.TOKEN_USAGE_EMIT_INTERVAL_MS,
			{ leading: true, trailing: true, maxWait: this.TOKEN_USAGE_EMIT_INTERVAL_MS },
		)

		onCreated?.(this)

		if (startTask) {
			this._started = true
			if (task || images) {
				this.startTask(task, images)
			} else if (historyItem) {
				this.resumeTaskFromHistory()
			} else {
				throw new Error("Either historyItem or task/images must be provided")
			}
		}
	}

	/**
	 * Initialize the task mode from the provider state.
	 * This method handles async initialization with proper error handling.
	 *
	 * ## Flow
	 * 1. Attempts to fetch the current mode from provider state
	 * 2. Sets `_taskMode` to the fetched mode or `defaultModeSlug` if unavailable
	 * 3. Handles errors gracefully by falling back to default mode
	 * 4. Logs any initialization errors for debugging
	 *
	 * ## Error handling
	 * - Network failures when fetching provider state
	 * - Provider not yet initialized
	 * - Invalid state structure
	 *
	 * All errors result in fallback to `defaultModeSlug` to ensure task can proceed.
	 *
	 * @private
	 * @param provider - The ClineProvider instance to fetch state from
	 * @returns Promise that resolves when initialization is complete
	 */
	private async initializeTaskMode(provider: ClineProvider): Promise<void> {
		try {
			const state = await provider.getState()
			this._taskMode = state?.mode || defaultModeSlug
		} catch (error) {
			// If there's an error getting state, use the default mode
			this._taskMode = defaultModeSlug
			// Use the provider's log method for better error visibility
			const errorMessage = `Failed to initialize task mode: ${error instanceof Error ? error.message : String(error)}`
			provider.log(errorMessage)
		}
	}

	/**
	 * Initialize the task API config name from the provider state.
	 * This method handles async initialization with proper error handling.
	 *
	 * ## Flow
	 * 1. Attempts to fetch the current API config name from provider state
	 * 2. Sets `_taskApiConfigName` to the fetched name or "default" if unavailable
	 * 3. Handles errors gracefully by falling back to "default"
	 * 4. Logs any initialization errors for debugging
	 *
	 * ## Error handling
	 * - Network failures when fetching provider state
	 * - Provider not yet initialized
	 * - Invalid state structure
	 *
	 * All errors result in fallback to "default" to ensure task can proceed.
	 *
	 * @private
	 * @param provider - The ClineProvider instance to fetch state from
	 * @returns Promise that resolves when initialization is complete
	 */
	private async initializeTaskApiConfigName(provider: ClineProvider): Promise<void> {
		try {
			const state = await provider.getState()

			// Avoid clobbering a newer value that may have been set while awaiting provider state
			// (e.g., user switches provider profile immediately after task creation).
			if (this._taskApiConfigName === undefined) {
				this._taskApiConfigName = state?.currentApiConfigName ?? "default"
			}
		} catch (error) {
			// If there's an error getting state, use the default profile (unless a newer value was set).
			if (this._taskApiConfigName === undefined) {
				this._taskApiConfigName = "default"
			}
			// Use the provider's log method for better error visibility
			const errorMessage = `Failed to initialize task API config name: ${error instanceof Error ? error.message : String(error)}`
			provider.log(errorMessage)
		}
	}

	/**
	 * Sets up a listener for provider profile changes.
	 *
	 * @private
	 * @param provider - The ClineProvider instance to listen to
	 */
	private setupProviderProfileChangeListener(provider: ClineProvider): void {
		// Only set up listener if provider has the on method (may not exist in test mocks)
		if (typeof provider.on !== "function") {
			return
		}

		this.providerProfileChangeListener = async () => {
			try {
				const newState = await provider.getState()
				if (newState?.apiConfiguration) {
					this.updateApiConfiguration(newState.apiConfiguration)
				}
			} catch (error) {
				console.error(
					`[Task#${this.taskId}.${this.instanceId}] Failed to update API configuration on profile change:`,
					error,
				)
			}
		}

		provider.on(RooCodeEventName.ProviderProfileChanged, this.providerProfileChangeListener)
	}

	/**
	 * Wait for the task mode to be initialized before proceeding.
	 * This method ensures that any operations depending on the task mode
	 * will have access to the correct mode value.
	 *
	 * ## When to use
	 * - Before accessing mode-specific configurations
	 * - When switching between tasks with different modes
	 * - Before operations that depend on mode-based permissions
	 *
	 * ## Example usage
	 * ```typescript
	 * // Wait for mode initialization before mode-dependent operations
	 * await task.waitForModeInitialization();
	 * const mode = task.taskMode; // Now safe to access synchronously
	 *
	 * // Or use with getTaskMode() for a one-liner
	 * const mode = await task.getTaskMode(); // Internally waits for initialization
	 * ```
	 *
	 * @returns Promise that resolves when the task mode is initialized
	 * @public
	 */
	public async waitForModeInitialization(): Promise<void> {
		return this.taskModeReady
	}

	/**
	 * Get the task mode asynchronously, ensuring it's properly initialized.
	 * This is the recommended way to access the task mode as it guarantees
	 * the mode is available before returning.
	 *
	 * ## Async behavior
	 * - Internally waits for `taskModeReady` promise to resolve
	 * - Returns the initialized mode or `defaultModeSlug` as fallback
	 * - Safe to call multiple times - subsequent calls return immediately if already initialized
	 *
	 * ## Example usage
	 * ```typescript
	 * // Safe async access
	 * const mode = await task.getTaskMode();
	 * console.log(`Task is running in ${mode} mode`);
	 *
	 * // Use in conditional logic
	 * if (await task.getTaskMode() === 'architect') {
	 *   // Perform architect-specific operations
	 * }
	 * ```
	 *
	 * @returns Promise resolving to the task mode string
	 * @public
	 */
	public async getTaskMode(): Promise<string> {
		await this.taskModeReady
		return this._taskMode || defaultModeSlug
	}

	/**
	 * Get the task mode synchronously. This should only be used when you're certain
	 * that the mode has already been initialized (e.g., after waitForModeInitialization).
	 *
	 * ## When to use
	 * - In synchronous contexts where async/await is not available
	 * - After explicitly waiting for initialization via `waitForModeInitialization()`
	 * - In event handlers or callbacks where mode is guaranteed to be initialized
	 *
	 * ## Example usage
	 * ```typescript
	 * // After ensuring initialization
	 * await task.waitForModeInitialization();
	 * const mode = task.taskMode; // Safe synchronous access
	 *
	 * // In an event handler after task is started
	 * task.on('taskStarted', () => {
	 *   console.log(`Task started in ${task.taskMode} mode`); // Safe here
	 * });
	 * ```
	 *
	 * @throws {Error} If the mode hasn't been initialized yet
	 * @returns The task mode string
	 * @public
	 */
	public get taskMode(): string {
		if (this._taskMode === undefined) {
			throw new Error("Task mode accessed before initialization. Use getTaskMode() or wait for taskModeReady.")
		}

		return this._taskMode
	}

	/**
	 * Wait for the task API config name to be initialized before proceeding.
	 * This method ensures that any operations depending on the task's provider profile
	 * will have access to the correct value.
	 *
	 * ## When to use
	 * - Before accessing provider profile-specific configurations
	 * - When switching between tasks with different provider profiles
	 * - Before operations that depend on the provider profile
	 *
	 * @returns Promise that resolves when the task API config name is initialized
	 * @public
	 */
	public async waitForApiConfigInitialization(): Promise<void> {
		return this.taskApiConfigReady
	}

	/**
	 * Get the task API config name asynchronously, ensuring it's properly initialized.
	 * This is the recommended way to access the task's provider profile as it guarantees
	 * the value is available before returning.
	 *
	 * ## Async behavior
	 * - Internally waits for `taskApiConfigReady` promise to resolve
	 * - Returns the initialized API config name or undefined as fallback
	 * - Safe to call multiple times - subsequent calls return immediately if already initialized
	 *
	 * @returns Promise resolving to the task API config name string or undefined
	 * @public
	 */
	public async getTaskApiConfigName(): Promise<string | undefined> {
		await this.taskApiConfigReady
		return this._taskApiConfigName
	}

	/**
	 * Get the task API config name synchronously. This should only be used when you're certain
	 * that the value has already been initialized (e.g., after waitForApiConfigInitialization).
	 *
	 * ## When to use
	 * - In synchronous contexts where async/await is not available
	 * - After explicitly waiting for initialization via `waitForApiConfigInitialization()`
	 * - In event handlers or callbacks where API config name is guaranteed to be initialized
	 *
	 * Note: Unlike taskMode, this getter does not throw if uninitialized since the API config
	 * name can legitimately be undefined (backward compatibility with tasks created before
	 * this feature was added).
	 *
	 * @returns The task API config name string or undefined
	 * @public
	 */
	public get taskApiConfigName(): string | undefined {
		return this._taskApiConfigName
	}

	/**
	 * Update the task's API config name. This is called when the user switches
	 * provider profiles while a task is active, allowing the task to remember
	 * its new provider profile.
	 *
	 * @param apiConfigName - The new API config name to set
	 * @internal
	 */
	public setTaskApiConfigName(apiConfigName: string | undefined): void {
		this._taskApiConfigName = apiConfigName
	}

	static create(options: TaskOptions): [Task, Promise<void>] {
		const instance = new Task({ ...options, startTask: false })
		const { images, task, historyItem } = options
		let promise

		if (images || task) {
			promise = instance.startTask(task, images)
		} else if (historyItem) {
			promise = instance.resumeTaskFromHistory()
		} else {
			throw new Error("Either historyItem or task/images must be provided")
		}

		return [instance, promise]
	}

	/** Route diagnostic logs through the provider's OutputChannel so they appear in the OUTPUT panel. */
	private diagLog(message: string) {
		const provider = this.providerRef.deref()
		if (provider) {
			provider.log(message)
		} else {
			console.log(message)
		}
	}

	// API Messages

	private async getSavedApiConversationHistory(): Promise<ApiMessage[]> {
		return readApiMessages({ taskId: this.taskId, globalStoragePath: this.globalStoragePath })
	}

	private async addToApiConversationHistory(message: Anthropic.MessageParam, reasoning?: string) {
		// Capture the encrypted_content / thought signatures from the provider (e.g., OpenAI Responses API, Google GenAI) if present.
		// We only persist data reported by the current response body.
		const handler = this.api as ApiHandler & {
			getResponseId?: () => string | undefined
			getEncryptedContent?: () => { encrypted_content: string; id?: string } | undefined
			getThoughtSignature?: () => string | undefined
			getSummary?: () => any[] | undefined
			getReasoningDetails?: () => any[] | undefined
		}

		if (message.role === "assistant") {
			const responseId = handler.getResponseId?.()
			const reasoningData = handler.getEncryptedContent?.()
			const thoughtSignature = handler.getThoughtSignature?.()
			const reasoningSummary = handler.getSummary?.()
			const reasoningDetails = handler.getReasoningDetails?.()

			// Only Anthropic's API expects/validates the special `thinking` content block signature.
			// Other providers (notably Gemini 3) use different signature semantics (e.g. `thoughtSignature`)
			// and require round-tripping the signature in their own format.
			const modelId = getModelId(this.apiConfiguration)
			const apiProvider = this.apiConfiguration.apiProvider
			const apiProtocol = getApiProtocol(
				apiProvider && !isRetiredProvider(apiProvider) ? apiProvider : undefined,
				modelId,
			)
			const isAnthropicProtocol = apiProtocol === "anthropic"

			// Start from the original assistant message
			const messageWithTs: any = {
				...message,
				...(responseId ? { id: responseId } : {}),
				ts: Date.now(),
			}

			// Store reasoning_details array if present (for models like Gemini 3)
			if (reasoningDetails) {
				messageWithTs.reasoning_details = reasoningDetails
			}

			// Store reasoning: Anthropic thinking (with signature), plain text (most providers), or encrypted (OpenAI Native)
			// Skip if reasoning_details already contains the reasoning (to avoid duplication)
			if (isAnthropicProtocol && reasoning && thoughtSignature && !reasoningDetails) {
				// Anthropic provider with extended thinking: Store as proper `thinking` block
				// This format passes through anthropic-filter.ts and is properly round-tripped
				// for interleaved thinking with tool use (required by Anthropic API)
				const thinkingBlock = {
					type: "thinking",
					thinking: reasoning,
					signature: thoughtSignature,
				}

				if (typeof messageWithTs.content === "string") {
					messageWithTs.content = [
						thinkingBlock,
						{ type: "text", text: messageWithTs.content } satisfies Anthropic.Messages.TextBlockParam,
					]
				} else if (Array.isArray(messageWithTs.content)) {
					messageWithTs.content = [thinkingBlock, ...messageWithTs.content]
				} else if (!messageWithTs.content) {
					messageWithTs.content = [thinkingBlock]
				}
			} else if (reasoning && !reasoningDetails) {
				// Other providers (non-Anthropic): Store as generic reasoning block
				const reasoningBlock = {
					type: "reasoning",
					text: reasoning,
					summary: reasoningSummary ?? ([] as any[]),
				}

				if (typeof messageWithTs.content === "string") {
					messageWithTs.content = [
						reasoningBlock,
						{ type: "text", text: messageWithTs.content } satisfies Anthropic.Messages.TextBlockParam,
					]
				} else if (Array.isArray(messageWithTs.content)) {
					messageWithTs.content = [reasoningBlock, ...messageWithTs.content]
				} else if (!messageWithTs.content) {
					messageWithTs.content = [reasoningBlock]
				}
			} else if (reasoningData?.encrypted_content) {
				// OpenAI Native encrypted reasoning
				const reasoningBlock = {
					type: "reasoning",
					summary: [] as any[],
					encrypted_content: reasoningData.encrypted_content,
					...(reasoningData.id ? { id: reasoningData.id } : {}),
				}

				if (typeof messageWithTs.content === "string") {
					messageWithTs.content = [
						reasoningBlock,
						{ type: "text", text: messageWithTs.content } satisfies Anthropic.Messages.TextBlockParam,
					]
				} else if (Array.isArray(messageWithTs.content)) {
					messageWithTs.content = [reasoningBlock, ...messageWithTs.content]
				} else if (!messageWithTs.content) {
					messageWithTs.content = [reasoningBlock]
				}
			}

			// For non-Anthropic providers (e.g., Gemini 3), persist the thought signature as its own
			// content block so converters can attach it back to the correct provider-specific fields.
			// Note: For Anthropic extended thinking, the signature is already included in the thinking block above.
			if (thoughtSignature && !isAnthropicProtocol) {
				const thoughtSignatureBlock = {
					type: "thoughtSignature",
					thoughtSignature,
				}

				if (typeof messageWithTs.content === "string") {
					messageWithTs.content = [
						{ type: "text", text: messageWithTs.content } satisfies Anthropic.Messages.TextBlockParam,
						thoughtSignatureBlock,
					]
				} else if (Array.isArray(messageWithTs.content)) {
					messageWithTs.content = [...messageWithTs.content, thoughtSignatureBlock]
				} else if (!messageWithTs.content) {
					messageWithTs.content = [thoughtSignatureBlock]
				}
			}

			this.apiConversationHistory.push(messageWithTs)
		} else {
			// For user messages, validate tool_result IDs ONLY when the immediately previous *effective* message
			// is an assistant message.
			//
			// If the previous effective message is also a user message (e.g., summary + a new user message),
			// validating against any earlier assistant message can incorrectly inject placeholder tool_results.
			const effectiveHistoryForValidation = getEffectiveApiHistory(this.apiConversationHistory)
			const lastEffective = effectiveHistoryForValidation[effectiveHistoryForValidation.length - 1]
			const historyForValidation = lastEffective?.role === "assistant" ? effectiveHistoryForValidation : []

			// If the previous effective message is NOT an assistant, convert tool_result blocks to text blocks.
			// This prevents orphaned tool_results from being filtered out by getEffectiveApiHistory.
			// This can happen when condensing occurs after the assistant sends tool_uses but before
			// the user responds - the tool_use blocks get condensed away, leaving orphaned tool_results.
			let messageToAdd = message
			if (lastEffective?.role !== "assistant" && Array.isArray(message.content)) {
				messageToAdd = {
					...message,
					content: message.content.map((block) =>
						block.type === "tool_result"
							? {
									type: "text" as const,
									text: `Tool result:\n${typeof block.content === "string" ? block.content : JSON.stringify(block.content)}`,
								}
							: block,
					),
				}
			}

			const validatedMessage = validateAndFixToolResultIds(messageToAdd, historyForValidation)
			const messageWithTs = { ...validatedMessage, ts: Date.now() }
			this.apiConversationHistory.push(messageWithTs)
		}

		await this.saveApiConversationHistory()
	}

	// NOTE: We intentionally do NOT mutate stored messages to merge consecutive user turns.
	// For API requests, consecutive same-role messages are merged via mergeConsecutiveApiMessages()
	// so rewind/edit behavior can still reference original message boundaries.

	async overwriteApiConversationHistory(newHistory: ApiMessage[]) {
		this.apiConversationHistory = newHistory
		await this.saveApiConversationHistory()
	}

	/**
	 * Flush any pending tool results to the API conversation history.
	 *
	 * This is critical when the task is about to be
	 * delegated (e.g., via new_task). Before delegation, if other tools were
	 * called in the same turn before new_task, their tool_result blocks are
	 * accumulated in `userMessageContent` but haven't been saved to the API
	 * history yet. If we don't flush them before the parent is disposed,
	 * the API conversation will be incomplete and cause 400 errors when
	 * the parent resumes (missing tool_result for tool_use blocks).
	 *
	 * NOTE: The assistant message is typically already in history by the time
	 * tools execute (added in recursivelyMakeClineRequests after streaming completes).
	 * So we usually only need to flush the pending user message with tool_results.
	 */
	public async flushPendingToolResultsToHistory(): Promise<boolean> {
		// Only flush if there's actually pending content to save
		if (this.userMessageContent.length === 0) {
			return true
		}

		// CRITICAL: Wait for the assistant message to be saved to API history first.
		// Without this, tool_result blocks would appear BEFORE tool_use blocks in the
		// conversation history, causing API errors like:
		// "unexpected `tool_use_id` found in `tool_result` blocks"
		//
		// This can happen when parallel tools are called (e.g., update_todo_list + new_task).
		// Tools execute during streaming via presentAssistantMessage, BEFORE the assistant
		// message is saved. When new_task triggers delegation, it calls this method to
		// flush pending results - but the assistant message hasn't been saved yet.
		//
		// The assistantMessageSavedToHistory flag is:
		// - Reset to false at the start of each API request
		// - Set to true after the assistant message is saved in recursivelyMakeClineRequests
		if (!this.assistantMessageSavedToHistory) {
			await pWaitFor(() => this.assistantMessageSavedToHistory || this.abort, {
				interval: 50,
				timeout: 30_000, // 30 second timeout as safety net
			}).catch(() => {
				// If timeout or abort, log and proceed anyway to avoid hanging
				console.warn(
					`[Task#${this.taskId}] flushPendingToolResultsToHistory: timed out waiting for assistant message to be saved`,
				)
			})
		}

		// If task was aborted while waiting, don't flush
		if (this.abort) {
			return false
		}

		// Save the user message with tool_result blocks
		const userMessage: Anthropic.MessageParam = {
			role: "user",
			content: this.userMessageContent,
		}

		// Validate and fix tool_result IDs when the previous *effective* message is an assistant message.
		const effectiveHistoryForValidation = getEffectiveApiHistory(this.apiConversationHistory)
		const lastEffective = effectiveHistoryForValidation[effectiveHistoryForValidation.length - 1]
		const historyForValidation = lastEffective?.role === "assistant" ? effectiveHistoryForValidation : []
		const validatedMessage = validateAndFixToolResultIds(userMessage, historyForValidation)
		const userMessageWithTs = { ...validatedMessage, ts: Date.now() }
		this.apiConversationHistory.push(userMessageWithTs as ApiMessage)

		const saved = await this.saveApiConversationHistory()

		if (saved) {
			// Clear the pending content since it's now saved
			this.userMessageContent = []
		} else {
			console.warn(
				`[Task#${this.taskId}] flushPendingToolResultsToHistory: save failed, retaining pending tool results in memory`,
			)
		}

		return saved
	}

	private async saveApiConversationHistory(): Promise<boolean> {
		try {
			await saveApiMessages({
				messages: structuredClone(this.apiConversationHistory),
				taskId: this.taskId,
				globalStoragePath: this.globalStoragePath,
			})
			return true
		} catch (error) {
			console.error("Failed to save API conversation history:", error)
			return false
		}
	}

	/**
	 * Public wrapper to retry saving the API conversation history.
	 * Uses exponential backoff: up to 3 attempts with delays of 100 ms, 500 ms, 1500 ms.
	 * Used by delegation flow when flushPendingToolResultsToHistory reports failure.
	 */
	public async retrySaveApiConversationHistory(): Promise<boolean> {
		const delays = [100, 500, 1500]

		for (let attempt = 0; attempt < delays.length; attempt++) {
			await new Promise<void>((resolve) => setTimeout(resolve, delays[attempt]))
			console.warn(
				`[Task#${this.taskId}] retrySaveApiConversationHistory: retry attempt ${attempt + 1}/${delays.length}`,
			)

			const success = await this.saveApiConversationHistory()

			if (success) {
				return true
			}
		}

		return false
	}

	// Cline Messages

	private async getSavedClineMessages(): Promise<ClineMessage[]> {
		return readTaskMessages({ taskId: this.taskId, globalStoragePath: this.globalStoragePath })
	}

	private async addToClineMessages(message: ClineMessage) {
		this.clineMessages.push(message)
		const provider = this.providerRef.deref()
		// Avoid resending large, mostly-static fields (notably taskHistory) on every chat message update.
		// taskHistory is maintained in-memory in the webview and updated via taskHistoryItemUpdated.
		await provider?.postStateToWebviewWithoutTaskHistory()
		this.emit(RooCodeEventName.Message, { action: "created", message })
		await this.saveClineMessages()

		const shouldCaptureMessage = message.partial !== true && CloudService.isEnabled()

		if (shouldCaptureMessage) {
			CloudService.instance.captureEvent({
				event: TelemetryEventName.TASK_MESSAGE,
				properties: { taskId: this.taskId, message },
			})
			// Track that this message has been synced to cloud
			this.cloudSyncedMessageTimestamps.add(message.ts)
		}
	}

	public async overwriteClineMessages(newMessages: ClineMessage[]) {
		this.clineMessages = newMessages
		restoreTodoListForTask(this)
		await this.saveClineMessages()

		// When overwriting messages (e.g., during task resume), repopulate the cloud sync tracking Set
		// with timestamps from all non-partial messages to prevent re-syncing previously synced messages
		this.cloudSyncedMessageTimestamps.clear()
		for (const msg of newMessages) {
			if (msg.partial !== true) {
				this.cloudSyncedMessageTimestamps.add(msg.ts)
			}
		}
	}

	private async updateClineMessage(message: ClineMessage) {
		const provider = this.providerRef.deref()
		await provider?.postMessageToWebview({ type: "messageUpdated", clineMessage: message })
		this.emit(RooCodeEventName.Message, { action: "updated", message })

		// Check if we should sync to cloud and haven't already synced this message
		const shouldCaptureMessage = message.partial !== true && CloudService.isEnabled()
		const hasNotBeenSynced = !this.cloudSyncedMessageTimestamps.has(message.ts)

		if (shouldCaptureMessage && hasNotBeenSynced) {
			CloudService.instance.captureEvent({
				event: TelemetryEventName.TASK_MESSAGE,
				properties: { taskId: this.taskId, message },
			})
			// Track that this message has been synced to cloud
			this.cloudSyncedMessageTimestamps.add(message.ts)
		}
	}

	private async saveClineMessages(): Promise<boolean> {
		try {
			await saveTaskMessages({
				messages: structuredClone(this.clineMessages),
				taskId: this.taskId,
				globalStoragePath: this.globalStoragePath,
			})

			if (this._taskApiConfigName === undefined) {
				await this.taskApiConfigReady
			}

			const { historyItem, tokenUsage } = await taskMetadata({
				taskId: this.taskId,
				rootTaskId: this.rootTaskId,
				parentTaskId: this.parentTaskId,
				taskNumber: this.taskNumber,
				messages: this.clineMessages,
				globalStoragePath: this.globalStoragePath,
				workspace: this.cwd,
				mode: this._taskMode || defaultModeSlug, // Use the task's own mode, not the current provider mode.
				apiConfigName: this._taskApiConfigName, // Use the task's own provider profile, not the current provider profile.
				initialStatus: this.initialStatus,
				isBackground: this.isBackground,
				costLimit: this.costLimit,
			})

			// Emit token/tool usage updates using debounced function
			// The debounce with maxWait ensures:
			// - Immediate first emit (leading: true)
			// - At most one emit per interval during rapid updates (maxWait)
			// - Final state is emitted when updates stop (trailing: true)
			this.debouncedEmitTokenUsage(tokenUsage, this.toolUsage)

			await this.providerRef.deref()?.updateTaskHistory(historyItem)
			return true
		} catch (error) {
			console.error("Failed to save Roo messages:", error)
			return false
		}
	}

	private findMessageByTimestamp(ts: number): ClineMessage | undefined {
		for (let i = this.clineMessages.length - 1; i >= 0; i--) {
			if (this.clineMessages[i].ts === ts) {
				return this.clineMessages[i]
			}
		}

		return undefined
	}

	// Note that `partial` has three valid states true (partial message),
	// false (completion of partial message), undefined (individual complete
	// message).
	async ask(
		type: ClineAsk,
		text?: string,
		partial?: boolean,
		progressStatus?: ToolProgressStatus,
		isProtected?: boolean,
	): Promise<{ response: ClineAskResponse; text?: string; images?: string[] }> {
		// If this Cline instance was aborted by the provider, then the only
		// thing keeping us alive is a promise still running in the background,
		// in which case we don't want to send its result to the webview as it
		// is attached to a new instance of Cline now. So we can safely ignore
		// the result of any active promises, and this class will be
		// deallocated. (Although we set Cline = undefined in provider, that
		// simply removes the reference to this instance, but the instance is
		// still alive until this promise resolves or rejects.)
		if (this.abort) {
			throw new Error(`[RooCode#ask] task ${this.taskId}.${this.instanceId} aborted`)
		}

		let askTs: number

		if (partial !== undefined) {
			const lastMessage = this.clineMessages.at(-1)

			const isUpdatingPreviousPartial =
				lastMessage && lastMessage.partial && lastMessage.type === "ask" && lastMessage.ask === type

			if (partial) {
				if (isUpdatingPreviousPartial) {
					// Existing partial message, so update it.
					lastMessage.text = text
					lastMessage.partial = partial
					lastMessage.progressStatus = progressStatus
					lastMessage.isProtected = isProtected
					// TODO: Be more efficient about saving and posting only new
					// data or one whole message at a time so ignore partial for
					// saves, and only post parts of partial message instead of
					// whole array in new listener.
					this.updateClineMessage(lastMessage)
					// console.log("Task#ask: current ask promise was ignored (#1)")
					throw new AskIgnoredError("updating existing partial")
				} else {
					// This is a new partial message, so add it with partial
					// state.
					askTs = Date.now()
					this.lastMessageTs = askTs
					await this.addToClineMessages({ ts: askTs, type: "ask", ask: type, text, partial, isProtected })
					// console.log("Task#ask: current ask promise was ignored (#2)")
					throw new AskIgnoredError("new partial")
				}
			} else {
				if (isUpdatingPreviousPartial) {
					// This is the complete version of a previously partial
					// message, so replace the partial with the complete version.
					this.askResponse = undefined
					this.askResponseText = undefined
					this.askResponseImages = undefined

					// Bug for the history books:
					// In the webview we use the ts as the chatrow key for the
					// virtuoso list. Since we would update this ts right at the
					// end of streaming, it would cause the view to flicker. The
					// key prop has to be stable otherwise react has trouble
					// reconciling items between renders, causing unmounting and
					// remounting of components (flickering).
					// The lesson here is if you see flickering when rendering
					// lists, it's likely because the key prop is not stable.
					// So in this case we must make sure that the message ts is
					// never altered after first setting it.
					askTs = lastMessage.ts
					this.lastMessageTs = askTs
					lastMessage.text = text
					lastMessage.partial = false
					lastMessage.progressStatus = progressStatus
					lastMessage.isProtected = isProtected
					await this.saveClineMessages()
					this.updateClineMessage(lastMessage)
				} else {
					// This is a new and complete message, so add it like normal.
					this.askResponse = undefined
					this.askResponseText = undefined
					this.askResponseImages = undefined
					askTs = Date.now()
					this.lastMessageTs = askTs
					await this.addToClineMessages({ ts: askTs, type: "ask", ask: type, text, isProtected })
				}
			}
		} else {
			// This is a new non-partial message, so add it like normal.
			this.askResponse = undefined
			this.askResponseText = undefined
			this.askResponseImages = undefined
			askTs = Date.now()
			this.lastMessageTs = askTs
			await this.addToClineMessages({ ts: askTs, type: "ask", ask: type, text, isProtected })
		}

		let timeouts: NodeJS.Timeout[] = []

		// Automatically approve if the ask according to the user's settings.
		const provider = this.providerRef.deref()
		const state = provider ? await provider.getState() : undefined
		const approval = await checkAutoApproval({ state, ask: type, text, isProtected })

		// Fast-path for auto-approved / auto-denied asks: short-circuit the
		// entire wait-for-webview flow.
		//
		// Why this exists: previously we wrote the ask, then called
		// `approveAsk()` (which forwards to `handleWebviewAskResponse`), then
		// entered `pWaitFor` to observe the resulting `askResponse` slot.
		// `handleWebviewAskResponse` is gated by `isAwaitingAskResponse`,
		// which only flips to true *after* `pWaitFor` starts — so the
		// synthetic auto-approval response was being silently dropped and the
		// task would hang.
		//
		// Beyond fixing that race, presenting Approve/Deny buttons for an ask
		// the user can't actually act on is bad UX. Marking the message
		// `autoApproved` lets the webview suppress those buttons entirely.
		if (approval.decision === "approve" || approval.decision === "deny") {
			const askMessage = this.findMessageByTimestamp(askTs)
			if (askMessage) {
				askMessage.autoApproved = true
				await this.saveClineMessages()
				this.updateClineMessage(askMessage)
			}
			this.emit(RooCodeEventName.TaskAskResponded)
			const synthesized: ClineAskResponse =
				approval.decision === "approve" ? "yesButtonClicked" : "noButtonClicked"
			return { response: synthesized, text: undefined, images: undefined }
		}

		if (approval.decision === "timeout") {
			// Store the auto-approval timeout so it can be cancelled if user interacts
			this.autoApprovalTimeoutRef = setTimeout(() => {
				const { askResponse, text, images } = approval.fn()
				this.handleWebviewAskResponse(askResponse, text, images)
				this.autoApprovalTimeoutRef = undefined
			}, approval.timeout)
			timeouts.push(this.autoApprovalTimeoutRef)
		}

		// The state is mutable if the message is complete and the task will
		// block (via the `pWaitFor`).
		const isBlocking = !(this.askResponse !== undefined || this.lastMessageTs !== askTs)
		const isMessageQueued = !this.messageQueueService.isEmpty()
		// Keep queued user messages intact during command_output asks. Those asks
		// are terminal flow-control, not conversational turns.
		const shouldDrainQueuedMessageForAsk = type !== "command_output"
		// State is mutable when the task will actually wait for user input.
		// Both "ask" and "timeout" decisions block waiting for input (timeout may auto-approve after delay).
		const isWaitingForInput = approval.decision === "ask" || approval.decision === "timeout"
		const isStatusMutable = !partial && isBlocking && !isMessageQueued && isWaitingForInput

		if (isStatusMutable) {
			// For background tasks (not the focused task), emit state changes immediately
			// so the task selector shows the correct indicator without delay.
			// For focused tasks, use a 2s delay to prevent UI flickering during quick interactions
			// (e.g., tool approvals that might be quickly auto-approved).
			// Exception: "followup" asks should show yellow immediately since the LLM is
			// genuinely waiting for user input.
			const isBackgroundTask = provider?.taskManager?.getFocusedTaskId() !== this.taskId
			const isFollowupAsk = type === "followup"
			const statusMutationTimeout = isBackgroundTask || isFollowupAsk ? 0 : 2_000

			if (isInteractiveAsk(type)) {
				timeouts.push(
					setTimeout(() => {
						const message = this.findMessageByTimestamp(askTs)

						if (message) {
							this.interactiveAsk = message
							this.emit(RooCodeEventName.TaskInteractive, this.taskId)
							provider?.postMessageToWebview({ type: "interactionRequired" })
						}
					}, statusMutationTimeout),
				)
			} else if (isResumableAsk(type)) {
				timeouts.push(
					setTimeout(() => {
						const message = this.findMessageByTimestamp(askTs)

						if (message) {
							this.resumableAsk = message
							this.emit(RooCodeEventName.TaskResumable, this.taskId)
						}
					}, statusMutationTimeout),
				)
			} else if (isIdleAsk(type)) {
				timeouts.push(
					setTimeout(() => {
						const message = this.findMessageByTimestamp(askTs)

						if (message) {
							this.idleAsk = message
							this.emit(RooCodeEventName.TaskIdle, this.taskId)

							// Emit TaskError for error conditions so TaskManager can set error state
							const errorAskTypes = [
								"api_req_failed",
								"mistake_limit_reached",
								"auto_approval_max_req_reached",
							]
							if (errorAskTypes.includes(type)) {
								this.emit(RooCodeEventName.TaskError, this.taskId, type)
							}
						}
					}, statusMutationTimeout),
				)
			}
		} else if (isMessageQueued && shouldDrainQueuedMessageForAsk) {
			const message = this.messageQueueService.dequeueMessage()

			if (message) {
				this.diagLog(
					`[DIAG ask] draining queued message for ask type=${type}: text=${message.text?.substring(0, 100)}`,
				)
				// Check if this is a tool approval ask that needs to be handled.
				if (type === "tool" || type === "command" || type === "use_mcp_server") {
					// For tool approvals, we need to approve first, then send
					// the message if there's text/images.
					this.handleWebviewAskResponse("yesButtonClicked", message.text, message.images)
				} else {
					// For other ask types (like followup or command_output), fulfill the ask
					// directly.
					this.handleWebviewAskResponse("messageResponse", message.text, message.images)
				}
			}
		}

		// Wait for askResponse to be set. Mark that we are awaiting a response so that
		// handleWebviewAskResponse() knows the askResponse* slots are being consumed by
		// this invocation. The flag is cleared in finally to handle abort/throw paths.
		this.isAwaitingAskResponse = true
		try {
			await pWaitFor(
				() => {
					if (this.askResponse !== undefined || this.lastMessageTs !== askTs) {
						return true
					}

					// If a queued message arrives while we're blocked on an ask (e.g. a follow-up
					// suggestion click that was incorrectly queued due to UI state), consume it
					// immediately so the task doesn't hang.
					if (shouldDrainQueuedMessageForAsk && !this.messageQueueService.isEmpty()) {
						const message = this.messageQueueService.dequeueMessage()
						if (message) {
							this.diagLog(
								`[DIAG ask/pWaitFor] draining queued message during wait for ask type=${type}: text=${message.text?.substring(0, 100)}`,
							)
							// If this is a tool approval ask, we need to approve first (yesButtonClicked)
							// and include any queued text/images.
							if (type === "tool" || type === "command" || type === "use_mcp_server") {
								this.handleWebviewAskResponse("yesButtonClicked", message.text, message.images)
							} else {
								this.handleWebviewAskResponse("messageResponse", message.text, message.images)
							}
						}
					}

					return false
				},
				{ interval: 100 },
			)
		} finally {
			this.isAwaitingAskResponse = false
		}

		if (this.lastMessageTs !== askTs) {
			// Could happen if we send multiple asks in a row i.e. with
			// command_output. It's important that when we know an ask could
			// fail, it is handled gracefully.
			throw new AskIgnoredError("superseded")
		}

		const result = { response: this.askResponse!, text: this.askResponseText, images: this.askResponseImages }
		this.askResponse = undefined
		this.askResponseText = undefined
		this.askResponseImages = undefined

		// Cancel the timeouts if they are still running.
		timeouts.forEach((timeout) => clearTimeout(timeout))

		// Switch back to an active state.
		if (this.idleAsk || this.resumableAsk || this.interactiveAsk) {
			this.idleAsk = undefined
			this.resumableAsk = undefined
			this.interactiveAsk = undefined
			this.emit(RooCodeEventName.TaskActive, this.taskId)
		}

		this.emit(RooCodeEventName.TaskAskResponded)
		return result
	}

	handleWebviewAskResponse(askResponse: ClineAskResponse, text?: string, images?: string[]) {
		this.diagLog(
			`[DIAG handleWebviewAskResponse] taskId=${this.taskId}.${this.instanceId}, askResponse=${askResponse}, text=${text?.substring(0, 100)}, abort=${this.abort}, abandoned=${this.abandoned}, isAwaitingAskResponse=${this.isAwaitingAskResponse}`,
		)

		// Defensive: if no ask() is currently waiting, the askResponse* slots are not
		// being consumed and would be cleared by the next ask() call, silently dropping
		// the user's input. This happens when the webview's UI state is briefly stale
		// (e.g. user types during the window between api_req_started finishing and the
		// next ask appearing, or while a tool runs between asks) and falls into the
		// bare `messageResponse` branch in ChatView.handleSendMessage.
		//
		// For messageResponse carrying text/images, route into the message queue so the
		// next ask() (or cancelAndProcessQueuedMessages) drains it. Other response kinds
		// (yes/no/objectResponse) are meaningless without a pending ask and are dropped.
		if (!this.isAwaitingAskResponse && !this.abort && !this.abandoned) {
			if (askResponse === "messageResponse" && (text || (images && images.length > 0))) {
				this.diagLog(
					`[DIAG handleWebviewAskResponse] no ask awaiting; enqueuing messageResponse: text=${text?.substring(0, 100)}`,
				)
				this.messageQueueService.addMessage(text ?? "", images)
			} else {
				this.diagLog(`[DIAG handleWebviewAskResponse] no ask awaiting; ignoring askResponse=${askResponse}`)
			}
			return
		}

		// Clear any pending auto-approval timeout when user responds
		this.cancelAutoApprovalTimeout()

		this.askResponse = askResponse
		this.askResponseText = text
		this.askResponseImages = images

		// Create a checkpoint whenever the user sends a message.
		// Use allowEmpty=true to ensure a checkpoint is recorded even if there are no file changes.
		// Suppress the checkpoint_saved chat row for this particular checkpoint to keep the timeline clean.
		if (askResponse === "messageResponse") {
			void this.checkpointSave(false, true)
		}

		// Mark the last follow-up question as answered
		if (askResponse === "messageResponse" || askResponse === "yesButtonClicked") {
			// Find the last unanswered follow-up message using findLastIndex
			const lastFollowUpIndex = findLastIndex(
				this.clineMessages,
				(msg) => msg.type === "ask" && msg.ask === "followup" && !msg.isAnswered,
			)

			if (lastFollowUpIndex !== -1) {
				// Mark this follow-up as answered
				this.clineMessages[lastFollowUpIndex].isAnswered = true
				// Save the updated messages
				this.saveClineMessages().catch((error) => {
					console.error("Failed to save answered follow-up state:", error)
				})
			}
		}

		// Mark the last tool-approval ask as answered when user approves (or auto-approval)
		if (askResponse === "yesButtonClicked") {
			const lastToolAskIndex = findLastIndex(
				this.clineMessages,
				(msg) => msg.type === "ask" && msg.ask === "tool" && !msg.isAnswered,
			)
			if (lastToolAskIndex !== -1) {
				this.clineMessages[lastToolAskIndex].isAnswered = true
				void this.updateClineMessage(this.clineMessages[lastToolAskIndex])
				this.saveClineMessages().catch((error) => {
					console.error("Failed to save answered tool-ask state:", error)
				})
			}
		}
	}

	/**
	 * Cancel any pending auto-approval timeout.
	 * Called when user interacts (types, clicks buttons, etc.) to prevent the timeout from firing.
	 */
	public cancelAutoApprovalTimeout(): void {
		if (this.autoApprovalTimeoutRef) {
			clearTimeout(this.autoApprovalTimeoutRef)
			this.autoApprovalTimeoutRef = undefined
		}
	}

	public approveAsk({ text, images }: { text?: string; images?: string[] } = {}) {
		this.handleWebviewAskResponse("yesButtonClicked", text, images)
	}

	public denyAsk({ text, images }: { text?: string; images?: string[] } = {}) {
		this.handleWebviewAskResponse("noButtonClicked", text, images)
	}

	public supersedePendingAsk(): void {
		this.lastMessageTs = Date.now()
	}

	/**
	 * Updates the API configuration and rebuilds the API handler.
	 * There is no tool-protocol switching or tool parser swapping.
	 *
	 * @param newApiConfiguration - The new API configuration to use
	 */
	public updateApiConfiguration(newApiConfiguration: ProviderSettings): void {
		// Update the configuration and rebuild the API handler
		this.apiConfiguration = newApiConfiguration
		this.api = buildApiHandler(this.apiConfiguration, {
			taskId: this.taskId,
			parentTaskId: this.parentTaskId,
			rootTaskId: this.rootTaskId,
		})
	}

	public async submitUserMessage(
		text: string,
		images?: string[],
		mode?: string,
		providerProfile?: string,
	): Promise<void> {
		try {
			text = (text ?? "").trim()
			images = images ?? []

			if (text.length === 0 && images.length === 0) {
				return
			}

			const provider = this.providerRef.deref()

			if (provider) {
				if (mode) {
					await provider.setMode(mode)
				}

				if (providerProfile) {
					await provider.setProviderProfile(providerProfile)

					// Update this task's API configuration to match the new profile
					// This ensures the parser state is synchronized with the selected model
					const newState = await provider.getState()
					if (newState?.apiConfiguration) {
						this.updateApiConfiguration(newState.apiConfiguration)
					}
				}

				this.emit(RooCodeEventName.TaskUserMessage, this.taskId)

				// Handle the message directly instead of routing through the webview.
				// This avoids a race condition where the webview's message state hasn't
				// hydrated yet, causing it to interpret the message as a new task request.
				this.handleWebviewAskResponse("messageResponse", text, images)
			} else {
				console.error("[Task#submitUserMessage] Provider reference lost")
			}
		} catch (error) {
			console.error("[Task#submitUserMessage] Failed to submit user message:", error)
		}
	}

	async handleTerminalOperation(terminalOperation: "continue" | "abort") {
		if (terminalOperation === "continue") {
			this.terminalProcess?.continue()
		} else if (terminalOperation === "abort") {
			this.terminalProcess?.abort()
		}
	}

	private async getFilesReadByRooSafely(context: string): Promise<string[] | undefined> {
		try {
			return await this.fileContextTracker.getFilesReadByRoo()
		} catch (error) {
			console.error(`[Task#${context}] Failed to get files read by Roo:`, error)
			return undefined
		}
	}

	public async condenseContext(): Promise<void> {
		// CRITICAL: Flush any pending tool results before condensing
		// to ensure tool_use/tool_result pairs are complete in history
		await this.flushPendingToolResultsToHistory()

		const systemPrompt = await this.getSystemPrompt()

		// Get condensing configuration
		const state = await this.providerRef.deref()?.getState()
		const customCondensingPrompt = state?.customSupportPrompts?.CONDENSE
		const { mode, apiConfiguration } = state ?? {}

		const { contextTokens: prevContextTokens } = this.getTokenUsage()

		// Build tools for condensing metadata (same tools used for normal API calls)
		const provider = this.providerRef.deref()
		let allTools: import("openai").default.Chat.ChatCompletionTool[] = []
		if (provider) {
			const modelInfo = this.api.getModel().info
			const toolsResult = await buildNativeToolsArrayWithRestrictions({
				provider,
				cwd: this.cwd,
				mode,
				customModes: state?.customModes,
				experiments: state?.experiments,
				apiConfiguration,
				disabledTools: state?.disabledTools,
				modelInfo,
				includeAllToolsWithRestrictions: false,
			})
			allTools = toolsResult.tools
		}

		// Build metadata with tools and taskId for the condensing API call
		const metadata: ApiHandlerCreateMessageMetadata = {
			mode,
			taskId: this.taskId,
			...(allTools.length > 0
				? {
						tools: allTools,
						tool_choice: "auto",
						parallelToolCalls: true,
					}
				: {}),
		}
		// Generate environment details to include in the condensed summary
		const environmentDetails = await getEnvironmentDetails(this, true)

		const filesReadByRoo = await this.getFilesReadByRooSafely("condenseContext")

		const {
			messages,
			summary,
			cost,
			newContextTokens = 0,
			error,
			errorDetails,
			condenseId,
		} = await summarizeConversation({
			messages: this.apiConversationHistory,
			apiHandler: this.api,
			systemPrompt,
			taskId: this.taskId,
			isAutomaticTrigger: false,
			customCondensingPrompt,
			metadata,
			environmentDetails,
			filesReadByRoo,
			cwd: this.cwd,
			rooIgnoreController: this.rooIgnoreController,
		})
		if (error) {
			await this.say(
				"condense_context_error",
				error,
				undefined /* images */,
				false /* partial */,
				undefined /* checkpoint */,
				undefined /* progressStatus */,
				{ isNonInteractive: true } /* options */,
			)
			return
		}
		await this.overwriteApiConversationHistory(messages)

		const contextCondense: ContextCondense = {
			summary,
			cost,
			newContextTokens,
			prevContextTokens,
			condenseId: condenseId!,
		}
		await this.say(
			"condense_context",
			undefined /* text */,
			undefined /* images */,
			false /* partial */,
			undefined /* checkpoint */,
			undefined /* progressStatus */,
			{ isNonInteractive: true } /* options */,
			contextCondense,
		)

		// Process any queued messages after condensing completes
		this.processQueuedMessages()
	}

	async say(
		type: ClineSay,
		text?: string,
		images?: string[],
		partial?: boolean,
		checkpoint?: Record<string, unknown>,
		progressStatus?: ToolProgressStatus,
		options: {
			isNonInteractive?: boolean
		} = {},
		contextCondense?: ContextCondense,
		contextTruncation?: ContextTruncation,
	): Promise<undefined> {
		if (this.abort) {
			throw new Error(`[RooCode#say] task ${this.taskId}.${this.instanceId} aborted`)
		}

		if (partial !== undefined) {
			const lastMessage = this.clineMessages.at(-1)

			const isUpdatingPreviousPartial =
				lastMessage && lastMessage.partial && lastMessage.type === "say" && lastMessage.say === type

			if (partial) {
				if (isUpdatingPreviousPartial) {
					// Existing partial message, so update it.
					lastMessage.text = text
					lastMessage.images = images
					lastMessage.partial = partial
					lastMessage.progressStatus = progressStatus
					this.updateClineMessage(lastMessage)
				} else {
					// This is a new partial message, so add it with partial state.
					const sayTs = Date.now()

					if (!options.isNonInteractive) {
						this.lastMessageTs = sayTs
					}

					await this.addToClineMessages({
						ts: sayTs,
						type: "say",
						say: type,
						text,
						images,
						partial,
						contextCondense,
						contextTruncation,
					})
				}
			} else {
				// New now have a complete version of a previously partial message.
				// This is the complete version of a previously partial
				// message, so replace the partial with the complete version.
				if (isUpdatingPreviousPartial) {
					if (!options.isNonInteractive) {
						this.lastMessageTs = lastMessage.ts
					}

					lastMessage.text = text
					lastMessage.images = images
					lastMessage.partial = false
					lastMessage.progressStatus = progressStatus

					// Instead of streaming partialMessage events, we do a save
					// and post like normal to persist to disk.
					await this.saveClineMessages()

					// More performant than an entire `postStateToWebview`.
					this.updateClineMessage(lastMessage)
				} else {
					// This is a new and complete message, so add it like normal.
					const sayTs = Date.now()

					if (!options.isNonInteractive) {
						this.lastMessageTs = sayTs
					}

					await this.addToClineMessages({
						ts: sayTs,
						type: "say",
						say: type,
						text,
						images,
						contextCondense,
						contextTruncation,
					})
				}
			}
		} else {
			// This is a new non-partial message, so add it like normal.
			const sayTs = Date.now()

			// A "non-interactive" message is a message is one that the user
			// does not need to respond to. We don't want these message types
			// to trigger an update to `lastMessageTs` since they can be created
			// asynchronously and could interrupt a pending ask.
			if (!options.isNonInteractive) {
				this.lastMessageTs = sayTs
			}

			await this.addToClineMessages({
				ts: sayTs,
				type: "say",
				say: type,
				text,
				images,
				checkpoint,
				contextCondense,
				contextTruncation,
			})
		}
	}

	async sayAndCreateMissingParamError(toolName: ToolName, paramName: string, relPath?: string) {
		await this.say(
			"error",
			`Roo tried to use ${toolName}${
				relPath ? ` for '${relPath.toPosix()}'` : ""
			} without value for required parameter '${paramName}'. Retrying...`,
		)
		return formatResponse.toolError(formatResponse.missingToolParameterError(paramName))
	}

	// Lifecycle
	// Start / Resume / Abort / Dispose

	/**
	 * Get enabled MCP tools count for this task.
	 * Returns the count along with the number of servers contributing.
	 *
	 * @returns Object with enabledToolCount and enabledServerCount
	 */
	private async getEnabledMcpToolsCount(): Promise<{ enabledToolCount: number; enabledServerCount: number }> {
		try {
			const provider = this.providerRef.deref()
			if (!provider) {
				return { enabledToolCount: 0, enabledServerCount: 0 }
			}

			const { mcpEnabled } = (await provider.getState()) ?? {}
			if (!(mcpEnabled ?? true)) {
				return { enabledToolCount: 0, enabledServerCount: 0 }
			}

			// Defensive deadline: McpServerManager.getInstance() awaits hub.waitUntilReady(),
			// which in turn awaits every server's connectToServer(). The MCP SDK does not
			// always honour a connect-time deadline (e.g. a TCP-accepting but
			// non-responsive HTTP/SSE endpoint), so a misbehaving server could otherwise
			// hang task startup indefinitely. The MCP-tool-count warning is informational
			// only, so we cap the wait and skip the warning if the hub isn't ready in time.
			const MCP_READY_DEADLINE_MS = 12_000
			const mcpHub = await Promise.race([
				McpServerManager.getInstance(provider.context, provider),
				new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), MCP_READY_DEADLINE_MS)),
			])
			if (!mcpHub) {
				console.warn(
					`[Task#getEnabledMcpToolsCount] MCP hub not ready within ${MCP_READY_DEADLINE_MS}ms; skipping tool-count warning`,
				)
				return { enabledToolCount: 0, enabledServerCount: 0 }
			}

			const servers = mcpHub.getServers()
			return countEnabledMcpTools(servers)
		} catch (error) {
			console.error("[Task#getEnabledMcpToolsCount] Error counting MCP tools:", error)
			return { enabledToolCount: 0, enabledServerCount: 0 }
		}
	}

	/**
	 * Manually start a **new** task when it was created with `startTask: false`.
	 *
	 * This fires `startTask` as a background async operation for the
	 * `task/images` code-path only.  It does **not** handle the
	 * `historyItem` resume path (use the constructor with `startTask: true`
	 * for that).  The primary use-case is in the delegation flow where the
	 * parent's metadata must be persisted to globalState **before** the
	 * child task begins writing its own history (avoiding a read-modify-write
	 * race on globalState).
	 */
	public start(): void {
		if (this._started) {
			return
		}
		this._started = true

		const { task, images } = this.metadata

		if (task || images) {
			this.startTask(task ?? undefined, images ?? undefined)
		}
	}

	private async startTask(task?: string, images?: string[]): Promise<void> {
		try {
			// `conversationHistory` (for API) and `clineMessages` (for webview)
			// need to be in sync.
			// If the extension process were killed, then on restart the
			// `clineMessages` might not be empty, so we need to set it to [] when
			// we create a new Cline client (otherwise webview would show stale
			// messages from previous session).
			this.clineMessages = []
			this.apiConversationHistory = []

			// The todo list is already set in the constructor if initialTodos were provided
			// No need to add any messages - the todoList property is already set

			await this.providerRef.deref()?.postStateToWebviewWithoutTaskHistory()

			await this.say("text", task, images)

			// Check for too many MCP tools and warn the user
			const { enabledToolCount, enabledServerCount } = await this.getEnabledMcpToolsCount()
			if (enabledToolCount > MAX_MCP_TOOLS_THRESHOLD) {
				await this.say(
					"too_many_tools_warning",
					JSON.stringify({
						toolCount: enabledToolCount,
						serverCount: enabledServerCount,
						threshold: MAX_MCP_TOOLS_THRESHOLD,
					}),
					undefined,
					undefined,
					undefined,
					undefined,
					{ isNonInteractive: true },
				)
			}
			this.isInitialized = true

			const imageBlocks: Anthropic.ImageBlockParam[] = formatResponse.imageBlocks(images)

			// Task starting
			await this.initiateTaskLoop([
				{
					type: "text",
					text: `<user_message>\n${task}\n</user_message>`,
				},
				...imageBlocks,
			]).catch((error) => {
				// Swallow loop rejection when the task was intentionally abandoned/aborted
				// during delegation or user cancellation to prevent unhandled rejections.
				if (this.abandoned === true || this.abortReason === "user_cancelled") {
					return
				}
				throw error
			})
		} catch (error) {
			// In tests and some UX flows, tasks can be aborted while `startTask` is still
			// initializing. Treat abort/abandon as expected and avoid unhandled rejections.
			if (this.abandoned === true || this.abort === true || this.abortReason === "user_cancelled") {
				return
			}
			throw error
		}
	}

	private async resumeTaskFromHistory() {
		try {
			const modifiedClineMessages = await this.getSavedClineMessages()

			// Remove any resume messages that may have been added before.
			const lastRelevantMessageIndex = findLastIndex(
				modifiedClineMessages,
				(m) => !(m.ask === "resume_task" || m.ask === "resume_completed_task"),
			)

			if (lastRelevantMessageIndex !== -1) {
				modifiedClineMessages.splice(lastRelevantMessageIndex + 1)
			}

			// Remove any trailing reasoning-only UI messages that were not part of the persisted API conversation
			while (modifiedClineMessages.length > 0) {
				const last = modifiedClineMessages[modifiedClineMessages.length - 1]
				if (last.type === "say" && last.say === "reasoning") {
					modifiedClineMessages.pop()
				} else {
					break
				}
			}

			// Since we don't use `api_req_finished` anymore, we need to check if the
			// last `api_req_started` has a cost value, if it doesn't and no
			// cancellation reason to present, then we remove it since it indicates
			// an api request without any partial content streamed.
			const lastApiReqStartedIndex = findLastIndex(
				modifiedClineMessages,
				(m) => m.type === "say" && m.say === "api_req_started",
			)

			if (lastApiReqStartedIndex !== -1) {
				const lastApiReqStarted = modifiedClineMessages[lastApiReqStartedIndex]
				const { cost, cancelReason }: ClineApiReqInfo = JSON.parse(lastApiReqStarted.text || "{}")

				if (cost === undefined && cancelReason === undefined) {
					modifiedClineMessages.splice(lastApiReqStartedIndex, 1)
				}
			}

			await this.overwriteClineMessages(modifiedClineMessages)
			this.clineMessages = await this.getSavedClineMessages()

			// Now present the cline messages to the user and ask if they want to
			// resume (NOTE: we ran into a bug before where the
			// apiConversationHistory wouldn't be initialized when opening a old
			// task, and it was because we were waiting for resume).
			// This is important in case the user deletes messages without resuming
			// the task first.
			this.apiConversationHistory = await this.getSavedApiConversationHistory()

			const lastClineMessage = this.clineMessages
				.slice()
				.reverse()
				.find((m) => !(m.ask === "resume_task" || m.ask === "resume_completed_task")) // Could be multiple resume tasks.

			let askType: ClineAsk
			if (lastClineMessage?.ask === "completion_result") {
				askType = "resume_completed_task"
			} else {
				askType = "resume_task"
			}

			this.isInitialized = true

			this.diagLog(
				`[DIAG resumeTaskFromHistory] about to ask(${askType}), taskId=${this.taskId}.${this.instanceId}, queueSize=${this.messageQueueService.messages.length}`,
			)
			const { response, text, images } = await this.ask(askType) // Calls `postStateToWebview`.
			this.diagLog(
				`[DIAG resumeTaskFromHistory] ask returned: response=${response}, text=${text?.substring(0, 100)}, hasImages=${!!(images && images.length > 0)}`,
			)

			let responseText: string | undefined
			let responseImages: string[] | undefined

			// Handle user feedback for both messageResponse and yesButtonClicked with text.
			// When user types a message and clicks "Resume", the response is yesButtonClicked
			// but the text should still be captured as user feedback.
			if (
				response === "messageResponse" ||
				(response === "yesButtonClicked" && (text || (images && images.length > 0)))
			) {
				await this.say("user_feedback", text, images)
				responseText = text
				responseImages = images
			}

			// Make sure that the api conversation history can be resumed by the API,
			// even if it goes out of sync with cline messages.
			let existingApiConversationHistory: ApiMessage[] = await this.getSavedApiConversationHistory()

			// Tool blocks are always preserved; native tool calling only.

			// if the last message is an assistant message, we need to check if there's tool use since every tool use has to have a tool response
			// if there's no tool use and only a text block, then we can just add a user message
			// (note this isn't relevant anymore since we use custom tool prompts instead of tool use blocks, but this is here for legacy purposes in case users resume old tasks)

			// if the last message is a user message, we can need to get the assistant message before it to see if it made tool calls, and if so, fill in the remaining tool responses with 'interrupted'

			let modifiedOldUserContent: Anthropic.Messages.ContentBlockParam[] // either the last message if its user message, or the user message before the last (assistant) message
			let modifiedApiConversationHistory: ApiMessage[] // need to remove the last user message to replace with new modified user message
			if (existingApiConversationHistory.length > 0) {
				const lastMessage = existingApiConversationHistory[existingApiConversationHistory.length - 1]

				if (lastMessage.isSummary) {
					// IMPORTANT: If the last message is a condensation summary, we must preserve it
					// intact. The summary message carries critical metadata (isSummary, condenseId)
					// that getEffectiveApiHistory() uses to filter out condensed messages.
					// Removing or merging it would destroy this metadata, causing all condensed
					// messages to become "orphaned" and restored to active status — effectively
					// undoing the condensation and sending the full history to the API.
					// See: https://github.com/RooCodeInc/Roo-Code/issues/11487
					modifiedApiConversationHistory = [...existingApiConversationHistory]
					modifiedOldUserContent = []
				} else if (lastMessage.role === "assistant") {
					const content = Array.isArray(lastMessage.content)
						? lastMessage.content
						: [{ type: "text", text: lastMessage.content }]
					const hasToolUse = content.some((block) => block.type === "tool_use")

					if (hasToolUse) {
						const toolUseBlocks = content.filter(
							(block) => block.type === "tool_use",
						) as Anthropic.Messages.ToolUseBlock[]
						const toolResponses: Anthropic.ToolResultBlockParam[] = toolUseBlocks.map((block) => ({
							type: "tool_result",
							tool_use_id: block.id,
							content: "Task was interrupted before this tool call could be completed.",
						}))
						modifiedApiConversationHistory = [...existingApiConversationHistory] // no changes
						modifiedOldUserContent = [...toolResponses]
					} else {
						modifiedApiConversationHistory = [...existingApiConversationHistory]
						modifiedOldUserContent = []
					}
				} else if (lastMessage.role === "user") {
					const previousAssistantMessage: ApiMessage | undefined =
						existingApiConversationHistory[existingApiConversationHistory.length - 2]

					const existingUserContent: Anthropic.Messages.ContentBlockParam[] = Array.isArray(
						lastMessage.content,
					)
						? lastMessage.content
						: [{ type: "text", text: lastMessage.content }]
					if (previousAssistantMessage && previousAssistantMessage.role === "assistant") {
						const assistantContent = Array.isArray(previousAssistantMessage.content)
							? previousAssistantMessage.content
							: [{ type: "text", text: previousAssistantMessage.content }]

						const toolUseBlocks = assistantContent.filter(
							(block) => block.type === "tool_use",
						) as Anthropic.Messages.ToolUseBlock[]

						if (toolUseBlocks.length > 0) {
							const existingToolResults = existingUserContent.filter(
								(block) => block.type === "tool_result",
							) as Anthropic.ToolResultBlockParam[]

							const missingToolResponses: Anthropic.ToolResultBlockParam[] = toolUseBlocks
								.filter(
									(toolUse) =>
										!existingToolResults.some((result) => result.tool_use_id === toolUse.id),
								)
								.map((toolUse) => ({
									type: "tool_result",
									tool_use_id: toolUse.id,
									content: "Task was interrupted before this tool call could be completed.",
								}))

							modifiedApiConversationHistory = existingApiConversationHistory.slice(0, -1) // removes the last user message
							modifiedOldUserContent = [...existingUserContent, ...missingToolResponses]
						} else {
							modifiedApiConversationHistory = existingApiConversationHistory.slice(0, -1)
							modifiedOldUserContent = [...existingUserContent]
						}
					} else {
						modifiedApiConversationHistory = existingApiConversationHistory.slice(0, -1)
						modifiedOldUserContent = [...existingUserContent]
					}
				} else {
					throw new Error("Unexpected: Last message is not a user or assistant message")
				}
			} else {
				throw new Error("Unexpected: No existing API conversation history")
			}

			if (responseText) {
				// When the user provides a new message after stopping, send the
				// interrupted tool_results and the user's new text as SEPARATE
				// role=user messages. This ensures the model sees the user's
				// redirect as a distinct instruction rather than a footnote
				// buried in the same message as tool_result blocks.

				// 1. Close out the interrupted tool calls in the API history
				if (modifiedOldUserContent.length > 0) {
					modifiedApiConversationHistory.push({
						role: "user",
						content: modifiedOldUserContent,
					})
					// The API requires alternating user/assistant messages,
					// so insert a brief assistant acknowledgment.
					modifiedApiConversationHistory.push({
						role: "assistant",
						content: [
							{
								type: "text",
								text: "[The user interrupted the previous action. Awaiting new instructions.]",
							},
						],
					})
				}

				// 2. The user's actual text will be sent as its own role=user
				//    message by initiateTaskLoop → recursivelyMakeClineRequests.
				let userContent: Anthropic.Messages.ContentBlockParam[] = [
					{
						type: "text",
						text: `<user_message>\n${responseText}\n</user_message>`,
					},
				]

				if (responseImages && responseImages.length > 0) {
					userContent.push(...formatResponse.imageBlocks(responseImages))
				}

				this.diagLog(
					`[DIAG resumeTaskFromHistory] split messages: toolResults=${modifiedOldUserContent.length} blocks in history, userContent=${userContent.length} blocks for initiateTaskLoop`,
				)

				await this.overwriteApiConversationHistory(modifiedApiConversationHistory)
				await this.initiateTaskLoop(userContent)
			} else {
				// No user redirect — just resume with tool_results + environment
				let newUserContent: Anthropic.Messages.ContentBlockParam[] = [...modifiedOldUserContent]

				if (responseImages && responseImages.length > 0) {
					newUserContent.push(...formatResponse.imageBlocks(responseImages))
				}

				// Ensure we have at least some content to send to the API.
				if (newUserContent.length === 0) {
					newUserContent.push({
						type: "text",
						text: "[TASK RESUMPTION] Resuming task...",
					})
				}

				this.diagLog(
					`[DIAG resumeTaskFromHistory] newUserContent blocks=${newUserContent.length}, types=${newUserContent.map((b) => b.type).join(",")}, texts=${newUserContent
						.filter((b) => b.type === "text")
						.map((b) => (b as any).text?.substring(0, 80))
						.join(" | ")}`,
				)

				await this.overwriteApiConversationHistory(modifiedApiConversationHistory)
				await this.initiateTaskLoop(newUserContent)
			}
		} catch (error) {
			// Resume and cancellation can race when users issue repeated cancels.
			// Treat intentional abort/abandon flows as expected and avoid process-level crashes.
			if (this.abandoned === true || this.abort === true || this.abortReason === "user_cancelled") {
				return
			}
			throw error
		}
	}

	/**
	 * Cancels the current HTTP request if one is in progress.
	 * This immediately aborts the underlying stream rather than waiting for the next chunk.
	 */
	public cancelCurrentRequest(): void {
		if (this.currentRequestAbortController) {
			console.log(`[Task#${this.taskId}.${this.instanceId}] Aborting current HTTP request`)
			this.currentRequestAbortController.abort()
			this.currentRequestAbortController = undefined
		}
	}

	/**
	 * Force emit a final token usage update, ignoring throttle.
	 * Called before task completion or abort to ensure final stats are captured.
	 * Triggers the debounce with current values and immediately flushes to ensure emit.
	 */
	public emitFinalTokenUsageUpdate(): void {
		const tokenUsage = this.getTokenUsage()
		this.debouncedEmitTokenUsage(tokenUsage, this.toolUsage)
		this.debouncedEmitTokenUsage.flush()
	}

	public async abortTask(isAbandoned = false) {
		// Aborting task

		// Abort all background children before aborting self (Decision: abort propagation).
		// We fire-and-forget each child abort in parallel so a slow child cannot delay ours.
		if (this.backgroundChildren.size > 0) {
			const provider = this.providerRef.deref()
			if (provider) {
				await Promise.all(
					Array.from(this.backgroundChildren.keys()).map(async (childId) => {
						try {
							const child = provider.taskManager.getManagedTaskInstance(childId)
							if (child) {
								await child.abortTask(isAbandoned)
							}
						} catch (err) {
							console.error(`[Task#abortTask] Failed to abort background child ${childId}:`, err)
						}
					}),
				)
			}
			this.backgroundChildren.clear()
		}

		// Will stop any autonomously running promises.
		if (isAbandoned) {
			this.abandoned = true
		}

		this.abort = true

		// Reset consecutive error counters on abort (manual intervention)
		this.consecutiveNoToolUseCount = 0
		this.consecutiveNoAssistantMessagesCount = 0

		// Force final token usage update before abort event
		this.emitFinalTokenUsageUpdate()

		this.emit(RooCodeEventName.TaskAborted)

		try {
			this.dispose() // Call the centralized dispose method
		} catch (error) {
			console.error(`Error during task ${this.taskId}.${this.instanceId} disposal:`, error)
			// Don't rethrow - we want abort to always succeed
		}
		// Save the countdown message in the automatic retry or other content.
		try {
			// Save the countdown message in the automatic retry or other content.
			await this.saveClineMessages()
		} catch (error) {
			console.error(`Error saving messages during abort for task ${this.taskId}.${this.instanceId}:`, error)
		}
	}

	/**
	 * Walk up the parent chain to the true root and return its costLimit.
	 * Subtasks never carry their own; only roots do.
	 */
	private resolveCostLimit(): { root: Task; limit: CostLimit | undefined } {
		// eslint-disable-next-line @typescript-eslint/no-this-alias -- walking up the parentTask chain requires a mutable cursor
		let cursor: Task = this
		while (cursor.parentTask) {
			cursor = cursor.parentTask
		}
		return { root: cursor, limit: cursor.costLimit }
	}

	/**
	 * Public hook so the webview can invalidate the per-request cost cache
	 * after the user updates the limit live (e.g. via TaskHeader's editor).
	 * Without this the running stream would still apply the stale cached spent
	 * value until the next request boundary.
	 */
	public invalidateCostLimitCache(): void {
		this._costLimitCheckCache = undefined
		this._costLimitBypassed = false
		this._costLimitEnforcementFiredForRequest = false
	}

	/**
	 * Check whether the root task's aggregated cost has exceeded the budget
	 * limit. Awaited from the streaming loop after `updateApiReqMsg` writes
	 * the new per-request `cost`. If the limit is reached we either:
	 *   - pause: ask the user (yes=increase / no=abort / msg=continue)
	 *   - abort: clean abort, persists state
	 *   - kill : abandoned abort (headless / evals)
	 *
	 * Awaiting matters: the caller in the stream consumer must observe the
	 * abort flag *before* yielding the next chunk, otherwise we keep burning
	 * tokens past the cap.
	 */
	private async checkCostLimit(requestIndex: number): Promise<void> {
		if (this._costLimitBypassed) return
		if (this._costLimitCheckCache?.requestIndex === requestIndex) return

		const { root, limit } = this.resolveCostLimit()
		if (!limit || limit.maxUsd <= 0) return

		const provider = this.providerRef.deref()
		if (!provider) return

		let spent = 0
		try {
			const aggregated = await aggregateTaskCostsRecursive(root.taskId, (id) =>
				provider.getTaskWithId(id).then((r) => r.historyItem),
			)
			spent = aggregated.totalCost
		} catch (err) {
			// History scan failed — don't block the user's task on telemetry math.
			provider.log?.(
				`[Task#${this.taskId}] checkCostLimit: aggregate failed for root ${root.taskId}: ${err instanceof Error ? err.message : String(err)}`,
			)
			return
		}

		this._costLimitCheckCache = { spent, requestIndex }
		if (spent < limit.maxUsd) return

		await this.enforceCostLimit(root, limit, spent)
	}

	/**
	 * Snapshot the prior-history aggregate cost for the root and stash it
	 * on `_priorAggregateUsd` so the per-chunk in-stream check can compare
	 * `prior + currentRequestCost` against the cap without re-scanning
	 * history on every chunk.
	 *
	 * Called once at the request boundary (before the first chunk of a new
	 * API call). On error or no-limit, leaves the snapshot undefined so
	 * `checkInFlightCostLimit` becomes a no-op for this request.
	 */
	private async snapshotPriorAggregateForCostLimit(): Promise<void> {
		this._priorAggregateUsd = undefined
		this._costLimitEnforcementFiredForRequest = false
		const provider = this.providerRef.deref()
		if (this._costLimitBypassed) {
			provider?.log?.(`[Task#${this.taskId}] [DIAG cost-limit] snapshot: bypassed, skipping`)
			return
		}
		const { root, limit } = this.resolveCostLimit()
		if (!limit || limit.maxUsd <= 0) {
			provider?.log?.(
				`[Task#${this.taskId}] [DIAG cost-limit] snapshot: no limit configured (root=${root.taskId}, limit=${JSON.stringify(limit)})`,
			)
			return
		}
		if (!provider) return
		try {
			const aggregated = await aggregateTaskCostsRecursive(root.taskId, (id) =>
				provider.getTaskWithId(id).then((r) => r.historyItem),
			)
			this._priorAggregateUsd = aggregated.totalCost
			provider.log?.(
				`[Task#${this.taskId}] [DIAG cost-limit] snapshot: priorAggregate=${aggregated.totalCost.toFixed(6)}, limit=${limit.maxUsd}, action=${limit.action}, root=${root.taskId}`,
			)
		} catch (err) {
			provider.log?.(
				`[Task#${this.taskId}] snapshotPriorAggregateForCostLimit: failed for root ${root.taskId}: ${err instanceof Error ? err.message : String(err)}`,
			)
		}
	}

	/**
	 * In-stream cost-cap gate. Called from the main streaming loop on every
	 * `usage` chunk so we abort/pause AS SOON AS the cumulative spend
	 * (prior history aggregate + this request's running cost) crosses the
	 * cap, rather than waiting for the request to finish. This is critical
	 * for tight limits (e.g. 0.05 USD), where a single completion can
	 * easily blow past the cap before the post-stream check would fire.
	 *
	 * No-ops when bypass is set, no limit is configured, or the prior
	 * aggregate snapshot wasn't captured (see
	 * `snapshotPriorAggregateForCostLimit`). The actual enforcement (abort
	 * /kill /pause-ask) is delegated to `enforceCostLimit` so this path
	 * shares behaviour with the post-stream `checkCostLimit`.
	 */
	private async checkInFlightCostLimit(currentRequestCostUsd: number | undefined): Promise<void> {
		const provider = this.providerRef.deref()
		if (this._costLimitBypassed) return
		if (this._costLimitEnforcementFiredForRequest) return
		if (this._priorAggregateUsd === undefined) {
			provider?.log?.(
				`[Task#${this.taskId}] [DIAG cost-limit] in-flight: skipping (prior snapshot undefined; either no limit or snapshot failed)`,
			)
			return
		}
		if (currentRequestCostUsd === undefined || !Number.isFinite(currentRequestCostUsd)) {
			provider?.log?.(
				`[Task#${this.taskId}] [DIAG cost-limit] in-flight: skipping (no per-request cost reported by provider; chunk.totalCost=${currentRequestCostUsd})`,
			)
			return
		}
		const { root, limit } = this.resolveCostLimit()
		if (!limit || limit.maxUsd <= 0) return
		const spent = this._priorAggregateUsd + currentRequestCostUsd
		provider?.log?.(
			`[Task#${this.taskId}] [DIAG cost-limit] in-flight: prior=${this._priorAggregateUsd.toFixed(6)} + thisReq=${currentRequestCostUsd.toFixed(6)} = spent=${spent.toFixed(6)}, limit=${limit.maxUsd}, willFire=${spent >= limit.maxUsd}`,
		)
		if (spent < limit.maxUsd) return
		// Latch so subsequent chunks in the same request don't re-fire.
		this._costLimitEnforcementFiredForRequest = true
		await this.enforceCostLimit(root, limit, spent)
	}

	/**
	 * Shared enforcement step: emit telemetry + branch on
	 * `limit.action`. Used by both the post-stream `checkCostLimit` and
	 * the in-stream `checkInFlightCostLimit` so behaviour stays
	 * identical regardless of which gate fires first.
	 */
	private async enforceCostLimit(root: Task, limit: CostLimit, spent: number): Promise<void> {
		const provider = this.providerRef.deref()
		provider?.log?.(
			`[Task#${this.taskId}] [DIAG cost-limit] enforce: action=${limit.action}, spent=${spent.toFixed(6)}, limit=${limit.maxUsd}, root=${root.taskId}`,
		)
		TelemetryService.instance.captureBudgetExceeded(this.taskId, {
			rootTaskId: root.taskId,
			limitUsd: limit.maxUsd,
			spentUsd: spent,
			action: limit.action,
			modelId: getModelId(this.apiConfiguration),
		})

		if (limit.action === "abort" || limit.action === "kill") {
			// Cancel the in-flight HTTP request first so the stream consumer
			// stops yielding chunks immediately, then mark this task aborted
			// so its loop exits at the next iteration boundary. Also abort the
			// root if it's a different instance, so the whole tree winds down
			// (subtasks die via the recursive backgroundChildren walk in
			// abortTask).
			try {
				this.cancelCurrentRequest()
			} catch {
				/* best effort */
			}
			const isAbandoned = limit.action === "kill"
			await this.abortTask(isAbandoned)
			if (root !== this) {
				await root.abortTask(isAbandoned)
			}
			return
		}
		// pause
		await this.askUserForBudgetDecision(root, limit, spent)
	}

	/**
	 * Pause-mode handler. Reuses the existing `ask` machinery with three
	 * outcomes wired through ChatView's primary/secondary buttons and the
	 * text input:
	 *   yesButtonClicked    → "Continue without limit". Bypasses further
	 *                          enforcement for the remainder of this task
	 *                          (no further checks fire).
	 *   noButtonClicked     → "Abort task". Cleanly aborts the root and
	 *                          all subtasks via the existing recursive
	 *                          abort path.
	 *   messageResponse     → user typed a new dollar amount. Parsed as a
	 *                          positive float and used as the new
	 *                          maxUsd on the root (action preserved).
	 *                          Non-numeric/invalid input is treated as
	 *                          "continue without limit" so we never silently
	 *                          ignore the user's intent.
	 *
	 * The askText is JSON so the webview's BudgetLimitDialog can render
	 * a structured message; ChatView falls back to the buttons when the
	 * dialog isn't present.
	 */
	private async askUserForBudgetDecision(root: Task, limit: CostLimit, spent: number): Promise<void> {
		const askText = JSON.stringify({ spentUsd: spent, limitUsd: limit.maxUsd, action: limit.action })
		const { response, text } = await this.ask("budget_limit", askText)

		if (response === "noButtonClicked") {
			await root.abortTask(false)
			return
		}
		if (response === "messageResponse") {
			// Parse the user-supplied new limit. Accept a bare number
			// ("0.10") or a leading-$ form ("$0.10"); reject anything else.
			const raw = (text ?? "").trim().replace(/^\$/, "")
			const parsed = Number(raw)
			if (raw.length > 0 && Number.isFinite(parsed) && parsed > 0) {
				const next: CostLimit = { maxUsd: parsed, action: limit.action }
				root.costLimit = next
				root.invalidateCostLimitCache()
				const provider = this.providerRef.deref()
				if (provider) {
					try {
						const { historyItem } = await provider.getTaskWithId(root.taskId)
						if (historyItem) {
							await provider.updateTaskHistory({ ...historyItem, costLimit: next })
						}
					} catch (err) {
						provider.log?.(
							`[askUserForBudgetDecision] persist failed: ${err instanceof Error ? err.message : String(err)}`,
						)
					}
				}
				return
			}
			// Fall through to bypass on unparsable input.
		}
		// yesButtonClicked or unparsable messageResponse → "continue
		// without limit" for this task.
		root._costLimitBypassed = true
		root._costLimitCheckCache = undefined
	}

	public dispose(): void {
		console.log(`[Task#dispose] disposing task ${this.taskId}.${this.instanceId}`)

		// Cancel any in-progress HTTP request
		try {
			this.cancelCurrentRequest()
		} catch (error) {
			console.error("Error cancelling current request:", error)
		}

		// Remove provider profile change listener
		try {
			if (this.providerProfileChangeListener) {
				const provider = this.providerRef.deref()
				if (provider) {
					provider.off(RooCodeEventName.ProviderProfileChanged, this.providerProfileChangeListener)
				}
				this.providerProfileChangeListener = undefined
			}
		} catch (error) {
			console.error("Error removing provider profile change listener:", error)
		}

		// Dispose message queue and remove event listeners.
		try {
			if (this.messageQueueStateChangedHandler) {
				this.messageQueueService.removeListener("stateChanged", this.messageQueueStateChangedHandler)
				this.messageQueueStateChangedHandler = undefined
			}

			this.messageQueueService.dispose()
		} catch (error) {
			console.error("Error disposing message queue:", error)
		}

		// Remove all event listeners to prevent memory leaks.
		try {
			this.removeAllListeners()
		} catch (error) {
			console.error("Error removing event listeners:", error)
		}

		// Release any terminals associated with this task.
		try {
			// Release any terminals associated with this task.
			TerminalRegistry.releaseTerminalsForTask(this.taskId)
		} catch (error) {
			console.error("Error releasing terminals:", error)
		}

		// Cleanup command output artifacts
		getTaskDirectoryPath(this.globalStoragePath, this.taskId)
			.then((taskDir) => {
				const outputDir = path.join(taskDir, "command-output")
				return OutputInterceptor.cleanup(outputDir)
			})
			.catch((error) => {
				console.error("Error cleaning up command output artifacts:", error)
			})

		try {
			if (this.rooIgnoreController) {
				this.rooIgnoreController.dispose()
				this.rooIgnoreController = undefined
			}
		} catch (error) {
			console.error("Error disposing RooIgnoreController:", error)
			// This is the critical one for the leak fix.
		}

		try {
			this.fileContextTracker.dispose()
		} catch (error) {
			console.error("Error disposing file context tracker:", error)
		}

		try {
			// If we're not streaming then `abortStream` won't be called.
			if (this.isStreaming && this.diffViewProvider.isEditing) {
				this.diffViewProvider.revertChanges().catch(console.error)
			}
		} catch (error) {
			console.error("Error reverting diff changes:", error)
		}
	}

	// Task Loop

	private async initiateTaskLoop(userContent: Anthropic.Messages.ContentBlockParam[]): Promise<void> {
		this.diagLog(
			`[DIAG initiateTaskLoop] taskId=${this.taskId}.${this.instanceId}, userContent blocks=${userContent.length}, texts=${userContent
				.filter((b) => b.type === "text")
				.map((b) => (b as any).text?.substring(0, 80))
				.join(" | ")}`,
		)
		// Kicks off the checkpoints initialization process in the background.
		getCheckpointService(this)

		let nextUserContent = userContent
		let includeFileDetails = true

		this.emit(RooCodeEventName.TaskStarted)

		while (!this.abort) {
			this.diagLog(
				`[DIAG initiateTaskLoop] Loop iteration START taskId=${this.taskId}.${this.instanceId}, nextUserContent blocks=${nextUserContent.length}`,
			)
			const didEndLoop = await this.recursivelyMakeClineRequests(nextUserContent, includeFileDetails)
			includeFileDetails = false // We only need file details the first time.
			this.diagLog(
				`[DIAG initiateTaskLoop] Loop iteration END taskId=${this.taskId}.${this.instanceId}, didEndLoop=${didEndLoop}`,
			)

			// The way this agentic loop works is that cline will be given a
			// task that he then calls tools to complete. Unless there's an
			// attempt_completion call, we keep responding back to him with his
			// tool's responses until he either attempt_completion or does not
			// use anymore tools. If he does not use anymore tools, we ask him
			// to consider if he's completed the task and then call
			// attempt_completion, otherwise proceed with completing the task.
			// There is a MAX_REQUESTS_PER_TASK limit to prevent infinite
			// requests, but Cline is prompted to finish the task as efficiently
			// as he can.

			if (didEndLoop) {
				// For now a task never 'completes'. This will only happen if
				// the user hits max requests and denies resetting the count.
				break
			} else {
				nextUserContent = [{ type: "text", text: formatResponse.noToolsUsed() }]
			}
		}
	}

	public async recursivelyMakeClineRequests(
		userContent: Anthropic.Messages.ContentBlockParam[],
		includeFileDetails: boolean = false,
	): Promise<boolean> {
		interface StackItem {
			userContent: Anthropic.Messages.ContentBlockParam[]
			includeFileDetails: boolean
			retryAttempt?: number
			userMessageWasRemoved?: boolean // Track if user message was removed due to empty response
		}

		const stack: StackItem[] = [{ userContent, includeFileDetails, retryAttempt: 0 }]

		while (stack.length > 0) {
			const currentItem = stack.pop()!
			const currentUserContent = currentItem.userContent
			const currentIncludeFileDetails = currentItem.includeFileDetails

			if (this.abort) {
				throw new Error(`[RooCode#recursivelyMakeRooRequests] task ${this.taskId}.${this.instanceId} aborted`)
			}

			if (this.consecutiveMistakeLimit > 0 && this.consecutiveMistakeCount >= this.consecutiveMistakeLimit) {
				// Track consecutive mistake errors in telemetry via event and PostHog exception tracking.
				// The reason is "no_tools_used" because this limit is reached via initiateTaskLoop
				// which increments consecutiveMistakeCount when the model doesn't use any tools.
				TelemetryService.instance.captureConsecutiveMistakeError(this.taskId)
				TelemetryService.instance.captureException(
					new ConsecutiveMistakeError(
						`Task reached consecutive mistake limit (${this.consecutiveMistakeLimit})`,
						this.taskId,
						this.consecutiveMistakeCount,
						this.consecutiveMistakeLimit,
						"no_tools_used",
						this.apiConfiguration.apiProvider,
						getModelId(this.apiConfiguration),
					),
				)

				const { response, text, images } = await this.ask(
					"mistake_limit_reached",
					t("common:errors.mistake_limit_guidance"),
				)

				if (response === "messageResponse") {
					currentUserContent.push(
						...[
							{ type: "text" as const, text: formatResponse.tooManyMistakes(text) },
							...formatResponse.imageBlocks(images),
						],
					)

					await this.say("user_feedback", text, images)
				}

				this.consecutiveMistakeCount = 0
			}

			// Getting verbose details is an expensive operation, it uses ripgrep to
			// top-down build file structure of project which for large projects can
			// take a few seconds. For the best UX we show a placeholder api_req_started
			// message with a loading spinner as this happens.

			// Determine API protocol based on provider and model
			const modelId = getModelId(this.apiConfiguration)
			const apiProvider = this.apiConfiguration.apiProvider
			const apiProtocol = getApiProtocol(
				apiProvider && !isRetiredProvider(apiProvider) ? apiProvider : undefined,
				modelId,
			)

			// Respect user-configured provider rate limiting BEFORE we emit api_req_started.
			// This prevents the UI from showing an "API Request..." spinner while we are
			// intentionally waiting due to the rate limit slider.
			//
			// NOTE: We also set Task.lastGlobalApiRequestTime here to reserve this slot
			// before we build environment details (which can take time).
			// This ensures subsequent requests (including subtasks) still honour the
			// provider rate-limit window.
			await this.maybeWaitForProviderRateLimit(currentItem.retryAttempt ?? 0)
			Task.lastGlobalApiRequestTime = performance.now()

			await this.say(
				"api_req_started",
				JSON.stringify({
					apiProtocol,
				}),
			)

			const provider = this.providerRef.deref()
			const state = provider ? await provider.getState() : undefined

			const showRooIgnoredFiles = state?.showRooIgnoredFiles ?? false
			const includeDiagnosticMessages = state?.includeDiagnosticMessages ?? true
			const maxDiagnosticMessages = state?.maxDiagnosticMessages ?? 50
			const currentMode = state?.mode ?? defaultModeSlug

			const { content: parsedUserContent, mode: slashCommandMode } = await processUserContentMentions({
				userContent: currentUserContent,
				cwd: this.cwd,
				fileContextTracker: this.fileContextTracker,
				rooIgnoreController: this.rooIgnoreController,
				showRooIgnoredFiles,
				includeDiagnosticMessages,
				maxDiagnosticMessages,
				skillsManager: provider?.getSkillsManager(),
				currentMode,
			})

			// Switch mode if specified in a slash command's frontmatter
			if (slashCommandMode) {
				const provider = this.providerRef.deref()
				if (provider) {
					const state = await provider.getState()
					const targetMode = getModeBySlug(slashCommandMode, state?.customModes)
					if (targetMode) {
						await provider.handleModeSwitch(slashCommandMode)
					}
				}
			}

			const environmentDetails = await getEnvironmentDetails(this, currentIncludeFileDetails)

			// Remove any existing environment_details blocks before adding fresh ones.
			// This prevents duplicate environment details when resuming tasks,
			// where the old user message content may already contain environment details from the previous session.
			// We check for both opening and closing tags to ensure we're matching complete environment detail blocks,
			// not just mentions of the tag in regular content.
			const contentWithoutEnvDetails = parsedUserContent.filter((block) => {
				if (block.type === "text" && typeof block.text === "string") {
					// Check if this text block is a complete environment_details block
					// by verifying it starts with the opening tag and ends with the closing tag
					const isEnvironmentDetailsBlock =
						block.text.trim().startsWith("<environment_details>") &&
						block.text.trim().endsWith("</environment_details>")
					return !isEnvironmentDetailsBlock
				}
				return true
			})

			// Add environment details as its own text block, separate from tool
			// results.
			let finalUserContent = [...contentWithoutEnvDetails, { type: "text" as const, text: environmentDetails }]
			// Only add user message to conversation history if:
			// 1. This is the first attempt (retryAttempt === 0), AND
			// 2. The original userContent was not empty (empty signals delegation resume where
			//    the user message with tool_result and env details is already in history), OR
			// 3. The message was removed in a previous iteration (userMessageWasRemoved === true)
			// This prevents consecutive user messages while allowing re-add when needed
			const isEmptyUserContent = currentUserContent.length === 0
			const shouldAddUserMessage =
				((currentItem.retryAttempt ?? 0) === 0 && !isEmptyUserContent) || currentItem.userMessageWasRemoved
			this.diagLog(
				`[DIAG recursivelyMakeClineRequests] shouldAddUserMessage=${shouldAddUserMessage}, retryAttempt=${currentItem.retryAttempt}, isEmptyUserContent=${isEmptyUserContent}, userMessageWasRemoved=${currentItem.userMessageWasRemoved}, totalApiHistory=${this.apiConversationHistory.length}, finalUserContentBlocks=${finalUserContent.length}`,
			)
			if (shouldAddUserMessage) {
				this.diagLog(
					`[DIAG recursivelyMakeClineRequests] ADDING user message to API history, texts=${finalUserContent
						.filter((b: any) => b.type === "text")
						.map((b: any) => b.text?.substring(0, 80))
						.join(" | ")}`,
				)
				await this.addToApiConversationHistory({ role: "user", content: finalUserContent })
				TelemetryService.instance.captureConversationMessage(this.taskId, "user")
			}

			// Since we sent off a placeholder api_req_started message to update the
			// webview while waiting to actually start the API request (to load
			// potential details for example), we need to update the text of that
			// message.
			const lastApiReqIndex = findLastIndex(this.clineMessages, (m) => m.say === "api_req_started")

			this.clineMessages[lastApiReqIndex].text = JSON.stringify({
				apiProtocol,
			} satisfies ClineApiReqInfo)

			await this.saveClineMessages()
			await this.providerRef.deref()?.postStateToWebviewWithoutTaskHistory()

			try {
				let cacheWriteTokens = 0
				let cacheReadTokens = 0
				let inputTokens = 0
				let outputTokens = 0
				let totalCost: number | undefined

				// We can't use `api_req_finished` anymore since it's a unique case
				// where it could come after a streaming message (i.e. in the middle
				// of being updated or executed).
				// Fortunately `api_req_finished` was always parsed out for the GUI
				// anyways, so it remains solely for legacy purposes to keep track
				// of prices in tasks from history (it's worth removing a few months
				// from now).
				const updateApiReqMsg = (cancelReason?: ClineApiReqCancelReason, streamingFailedMessage?: string) => {
					if (lastApiReqIndex < 0 || !this.clineMessages[lastApiReqIndex]) {
						return
					}

					const existingData = JSON.parse(this.clineMessages[lastApiReqIndex].text || "{}")

					// Calculate total tokens and cost using provider-aware function
					const modelId = getModelId(this.apiConfiguration)
					const apiProvider = this.apiConfiguration.apiProvider
					const apiProtocol = getApiProtocol(
						apiProvider && !isRetiredProvider(apiProvider) ? apiProvider : undefined,
						modelId,
					)

					const costResult =
						apiProtocol === "anthropic"
							? calculateApiCostAnthropic(
									streamModelInfo,
									inputTokens,
									outputTokens,
									cacheWriteTokens,
									cacheReadTokens,
								)
							: calculateApiCostOpenAI(
									streamModelInfo,
									inputTokens,
									outputTokens,
									cacheWriteTokens,
									cacheReadTokens,
								)

					this.clineMessages[lastApiReqIndex].text = JSON.stringify({
						...existingData,
						tokensIn: costResult.totalInputTokens,
						tokensOut: costResult.totalOutputTokens,
						cacheWrites: cacheWriteTokens,
						cacheReads: cacheReadTokens,
						cost: totalCost ?? costResult.totalCost,
						cancelReason,
						streamingFailedMessage,
					} satisfies ClineApiReqInfo)
				}

				const abortStream = async (cancelReason: ClineApiReqCancelReason, streamingFailedMessage?: string) => {
					if (this.diffViewProvider.isEditing) {
						await this.diffViewProvider.revertChanges() // closes diff view
					}

					// if last message is a partial we need to update and save it
					const lastMessage = this.clineMessages.at(-1)

					if (lastMessage && lastMessage.partial) {
						// lastMessage.ts = Date.now() DO NOT update ts since it is used as a key for virtuoso list
						lastMessage.partial = false
						// instead of streaming partialMessage events, we do a save and post like normal to persist to disk
					}

					// Update `api_req_started` to have cancelled and cost, so that
					// we can display the cost of the partial stream and the cancellation reason
					updateApiReqMsg(cancelReason, streamingFailedMessage)
					await this.saveClineMessages()

					// Signals to provider that it can retrieve the saved messages
					// from disk, as abortTask can not be awaited on in nature.
					this.didFinishAbortingStream = true
				}

				// Reset streaming state for each new API request
				this.currentStreamingContentIndex = 0
				this.currentStreamingDidCheckpoint = false
				this.assistantMessageContent = []
				this.didCompleteReadingStream = false
				this.userMessageContent = []
				this.userMessageContentReady = false
				this.didRejectTool = false
				this.didAlreadyUseTool = false
				this.didExecuteAttemptCompletion = false
				this.assistantMessageSavedToHistory = false
				// Reset tool failure flag for each new assistant turn - this ensures that tool failures
				// only prevent attempt_completion within the same assistant message, not across turns
				// (e.g., if a tool fails, then user sends a message saying "just complete anyway")
				this.didToolFailInCurrentTurn = false
				this.presentAssistantMessageLocked = false
				this.presentAssistantMessageHasPendingUpdates = false
				// No legacy text-stream tool parser.
				this.streamingToolCallIndices.clear()
				// Clear any leftover streaming tool call state from previous interrupted streams
				NativeToolCallParser.clearAllStreamingToolCalls()
				NativeToolCallParser.clearRawChunkState()

				await this.diffViewProvider.reset()

				// Cache model info once per API request to avoid repeated calls during streaming
				// This is especially important for tools and background usage collection
				this.cachedStreamingModel = this.api.getModel()
				const streamModelInfo = this.cachedStreamingModel.info
				const cachedModelId = this.cachedStreamingModel.id

				// Snapshot the running spend across the root's history BEFORE
				// this request starts. The streaming `usage`-chunk handler
				// below adds this request's in-flight cost on top and triggers
				// abort/pause as soon as the sum crosses the cap, so a single
				// expensive completion can't silently blow past a tight limit
				// (e.g. $0.05) before the post-stream check fires.
				await this.snapshotPriorAggregateForCostLimit()
				if (this.abort) {
					break
				}

				// Yields only if the first chunk is successful, otherwise will
				// allow the user to retry the request (most likely due to rate
				// limit error, which gets thrown on the first chunk).
				const stream = this.attemptApiRequest(currentItem.retryAttempt ?? 0, { skipProviderRateLimit: true })
				let assistantMessage = ""
				let reasoningMessage = ""
				let pendingGroundingSources: GroundingSource[] = []
				this.isStreaming = true

				try {
					const iterator = stream[Symbol.asyncIterator]()

					// Helper to race iterator.next() with abort signal
					const nextChunkWithAbort = async () => {
						const nextPromise = iterator.next()

						// If we have an abort controller, race it with the next chunk
						if (this.currentRequestAbortController) {
							const abortPromise = new Promise<never>((_, reject) => {
								const signal = this.currentRequestAbortController!.signal
								if (signal.aborted) {
									reject(new Error("Request cancelled by user"))
								} else {
									signal.addEventListener("abort", () => {
										reject(new Error("Request cancelled by user"))
									})
								}
							})
							return await Promise.race([nextPromise, abortPromise])
						}

						// No abort controller, just return the next chunk normally
						return await nextPromise
					}

					let item = await nextChunkWithAbort()
					while (!item.done) {
						const chunk = item.value
						item = await nextChunkWithAbort()
						if (!chunk) {
							// Sometimes chunk is undefined, no idea that can cause
							// it, but this workaround seems to fix it.
							continue
						}

						// Debug log every chunk received in the stream consumer
						//this.diagLog(
						//	`[Task#${this.taskId}] [STREAM_CONSUMER] Received chunk type=${chunk?.type}, preview=${JSON.stringify(chunk)?.slice(0, 200)}`,
						//)

						switch (chunk.type) {
							case "reasoning": {
								reasoningMessage += chunk.text
								// Only apply formatting if the message contains sentence-ending punctuation followed by **
								let formattedReasoning = reasoningMessage
								if (reasoningMessage.includes("**")) {
									// Add line breaks before **Title** patterns that appear after sentence endings
									// This targets section headers like "...end of sentence.**Title Here**"
									// Handles periods, exclamation marks, and question marks
									formattedReasoning = reasoningMessage.replace(
										/([.!?])\*\*([^*\n]+)\*\*/g,
										"$1\n\n**$2**",
									)
								}
								await this.say("reasoning", formattedReasoning, undefined, true)
								break
							}
							case "usage":
								inputTokens += chunk.inputTokens
								outputTokens += chunk.outputTokens
								cacheWriteTokens += chunk.cacheWriteTokens ?? 0
								cacheReadTokens += chunk.cacheReadTokens ?? 0
								totalCost = chunk.totalCost
								// In-stream cost-cap gate. Awaited so any
								// abort/kill takes effect (sets `this.abort`
								// + cancels the in-flight HTTP request)
								// before the consumer pulls the next chunk;
								// the post-switch `if (this.abort) break`
								// then exits the streaming loop immediately
								// instead of burning more tokens past the
								// cap. The pause-mode branch awaits the
								// user's decision here too — fine because
								// no further tokens stream until we resume.
								await this.checkInFlightCostLimit(totalCost)
								break
							case "grounding":
								// Handle grounding sources separately from regular content
								// to prevent state persistence issues - store them separately
								if (chunk.sources && chunk.sources.length > 0) {
									pendingGroundingSources.push(...chunk.sources)
								}
								break
							case "tool_call_partial": {
								// Process raw tool call chunk through NativeToolCallParser
								// which handles tracking, buffering, and emits events
								const events = NativeToolCallParser.processRawChunk({
									index: chunk.index,
									id: chunk.id,
									name: chunk.name,
									arguments: chunk.arguments,
								})

								for (const event of events) {
									if (event.type === "tool_call_start") {
										// Guard against duplicate tool_call_start events for the same tool ID.
										// This can occur due to stream retry, reconnection, or API quirks.
										// Without this check, duplicate tool_use blocks with the same ID would
										// be added to assistantMessageContent, causing API 400 errors:
										// "tool_use ids must be unique"
										if (this.streamingToolCallIndices.has(event.id)) {
											console.warn(
												`[Task#${this.taskId}] Ignoring duplicate tool_call_start for ID: ${event.id} (tool: ${event.name})`,
											)
											continue
										}

										// Initialize streaming in NativeToolCallParser
										NativeToolCallParser.startStreamingToolCall(event.id, event.name as ToolName)

										// Before adding a new tool, finalize any preceding text block
										// This prevents the text block from blocking tool presentation
										const lastBlock =
											this.assistantMessageContent[this.assistantMessageContent.length - 1]
										if (lastBlock?.type === "text" && lastBlock.partial) {
											lastBlock.partial = false
										}

										// Track the index where this tool will be stored
										const toolUseIndex = this.assistantMessageContent.length
										this.streamingToolCallIndices.set(event.id, toolUseIndex)

										// Create initial partial tool use
										const partialToolUse: ToolUse = {
											type: "tool_use",
											name: event.name as ToolName,
											params: {},
											partial: true,
										}

										// Store the ID for native protocol
										;(partialToolUse as any).id = event.id

										// Add to content and present
										this.assistantMessageContent.push(partialToolUse)
										this.userMessageContentReady = false
										presentAssistantMessage(this)
									} else if (event.type === "tool_call_delta") {
										// Process chunk using streaming JSON parser
										const partialToolUse = NativeToolCallParser.processStreamingChunk(
											event.id,
											event.delta,
										)

										if (partialToolUse) {
											// Get the index for this tool call
											const toolUseIndex = this.streamingToolCallIndices.get(event.id)
											if (toolUseIndex !== undefined) {
												// Store the ID for native protocol
												;(partialToolUse as any).id = event.id

												// Update the existing tool use with new partial data
												this.assistantMessageContent[toolUseIndex] = partialToolUse

												// Present updated tool use
												presentAssistantMessage(this)
											}
										}
									} else if (event.type === "tool_call_end") {
										// Finalize the streaming tool call
										const finalToolUse = NativeToolCallParser.finalizeStreamingToolCall(event.id)

										// Get the index for this tool call
										const toolUseIndex = this.streamingToolCallIndices.get(event.id)

										if (finalToolUse) {
											// Store the tool call ID
											;(finalToolUse as any).id = event.id

											// Get the index and replace partial with final
											if (toolUseIndex !== undefined) {
												this.assistantMessageContent[toolUseIndex] = finalToolUse
											}

											// Clean up tracking
											this.streamingToolCallIndices.delete(event.id)

											// Mark that we have new content to process
											this.userMessageContentReady = false

											// Present the finalized tool call
											presentAssistantMessage(this)
										} else if (toolUseIndex !== undefined) {
											// finalizeStreamingToolCall returned null (malformed JSON or missing args)
											// Mark the tool as non-partial so it's presented as complete, but execution
											// will be short-circuited in presentAssistantMessage with a structured tool_result.
											const existingToolUse = this.assistantMessageContent[toolUseIndex]
											if (existingToolUse && existingToolUse.type === "tool_use") {
												existingToolUse.partial = false
												// Ensure it has the ID for native protocol
												;(existingToolUse as any).id = event.id
											}

											// Clean up tracking
											this.streamingToolCallIndices.delete(event.id)

											// Mark that we have new content to process
											this.userMessageContentReady = false

											// Present the tool call - validation will handle missing params
											presentAssistantMessage(this)
										}
									}
								}
								break
							}

							case "tool_call": {
								// Legacy: Handle complete tool calls (for backward compatibility)
								this.diagLog(
									`[Task#${this.taskId}] [TOOL_CALL_DEBUG] Received tool_call chunk: id=${chunk.id}, name=${chunk.name}, args_length=${chunk.arguments?.length}`,
								)
								// Convert native tool call to ToolUse format
								const toolUse = NativeToolCallParser.parseToolCall({
									id: chunk.id,
									name: chunk.name as ToolName,
									arguments: chunk.arguments,
								})

								if (!toolUse) {
									this.diagLog(
										`[Task#${this.taskId}] [TOOL_CALL_DEBUG] parseToolCall returned null for: id=${chunk.id}, name=${chunk.name}`,
									)
									console.error(`Failed to parse tool call for task ${this.taskId}:`, chunk)
									break
								}

								// Store the tool call ID on the ToolUse object for later reference
								// This is needed to create tool_result blocks that reference the correct tool_use_id
								toolUse.id = chunk.id

								// Add the tool use to assistant message content
								this.assistantMessageContent.push(toolUse)
								this.diagLog(
									`[Task#${this.taskId}] [TOOL_CALL_DEBUG] Added to assistantMessageContent, length now=${this.assistantMessageContent.length}`,
								)

								// Mark that we have new content to process
								this.userMessageContentReady = false

								// Present the tool call to user - presentAssistantMessage will execute
								// tools sequentially and accumulate all results in userMessageContent
								presentAssistantMessage(this)
								break
							}
							case "text": {
								assistantMessage += chunk.text

								// Native tool calling: text chunks are plain text.
								// Create or update a text content block directly
								const lastBlock = this.assistantMessageContent[this.assistantMessageContent.length - 1]
								if (lastBlock?.type === "text" && lastBlock.partial) {
									lastBlock.content = assistantMessage
								} else {
									this.assistantMessageContent.push({
										type: "text",
										content: assistantMessage,
										partial: true,
									})
									this.userMessageContentReady = false
								}
								presentAssistantMessage(this)
								break
							}
						}

						if (this.abort) {
							console.log(`aborting stream, this.abandoned = ${this.abandoned}`)

							if (!this.abandoned) {
								// Only need to gracefully abort if this instance
								// isn't abandoned (sometimes OpenRouter stream
								// hangs, in which case this would affect future
								// instances of Cline).
								await abortStream("user_cancelled")
							}

							break // Aborts the stream.
						}

						if (this.didRejectTool) {
							// `userContent` has a tool rejection, so interrupt the
							// assistant's response to present the user's feedback.
							assistantMessage += "\n\n[Response interrupted by user feedback]"
							// Instead of setting this preemptively, we allow the
							// present iterator to finish and set
							// userMessageContentReady when its ready.
							// this.userMessageContentReady = true
							break
						}

						if (this.didAlreadyUseTool) {
							assistantMessage +=
								"\n\n[Response interrupted by a tool use result. Only one tool may be used at a time and should be placed at the end of the message.]"
							break
						}
					}

					// Create a copy of current token values to avoid race conditions
					const currentTokens = {
						input: inputTokens,
						output: outputTokens,
						cacheWrite: cacheWriteTokens,
						cacheRead: cacheReadTokens,
						total: totalCost,
					}

					const drainStreamInBackgroundToFindAllUsage = async (apiReqIndex: number) => {
						const timeoutMs = DEFAULT_USAGE_COLLECTION_TIMEOUT_MS
						const startTime = performance.now()
						const modelId = getModelId(this.apiConfiguration)

						// Local variables to accumulate usage data without affecting the main flow
						let bgInputTokens = currentTokens.input
						let bgOutputTokens = currentTokens.output
						let bgCacheWriteTokens = currentTokens.cacheWrite
						let bgCacheReadTokens = currentTokens.cacheRead
						let bgTotalCost = currentTokens.total

						// Helper function to capture telemetry and update messages
						const captureUsageData = async (
							tokens: {
								input: number
								output: number
								cacheWrite: number
								cacheRead: number
								total?: number
							},
							messageIndex: number = apiReqIndex,
						) => {
							if (
								tokens.input > 0 ||
								tokens.output > 0 ||
								tokens.cacheWrite > 0 ||
								tokens.cacheRead > 0
							) {
								// Update the shared variables atomically
								inputTokens = tokens.input
								outputTokens = tokens.output
								cacheWriteTokens = tokens.cacheWrite
								cacheReadTokens = tokens.cacheRead
								totalCost = tokens.total

								// Update the API request message with the latest usage data
								updateApiReqMsg()
								await this.saveClineMessages()

								// Update the specific message in the webview
								const apiReqMessage = this.clineMessages[messageIndex]
								if (apiReqMessage) {
									await this.updateClineMessage(apiReqMessage)
								}

								// Capture telemetry with provider-aware cost calculation
								const modelId = getModelId(this.apiConfiguration)
								const apiProvider = this.apiConfiguration.apiProvider
								const apiProtocol = getApiProtocol(
									apiProvider && !isRetiredProvider(apiProvider) ? apiProvider : undefined,
									modelId,
								)

								// Use the appropriate cost function based on the API protocol
								const costResult =
									apiProtocol === "anthropic"
										? calculateApiCostAnthropic(
												streamModelInfo,
												tokens.input,
												tokens.output,
												tokens.cacheWrite,
												tokens.cacheRead,
											)
										: calculateApiCostOpenAI(
												streamModelInfo,
												tokens.input,
												tokens.output,
												tokens.cacheWrite,
												tokens.cacheRead,
											)

								TelemetryService.instance.captureLlmCompletion(this.taskId, {
									inputTokens: costResult.totalInputTokens,
									outputTokens: costResult.totalOutputTokens,
									cacheWriteTokens: tokens.cacheWrite,
									cacheReadTokens: tokens.cacheRead,
									cost: tokens.total ?? costResult.totalCost,
								})

								// Per-root-task cost cap. Awaited so any abort/pause takes effect
								// before the consumer pulls the next chunk; otherwise we'd keep
								// burning tokens past the cap for the rest of this stream.
								await this.checkCostLimit(messageIndex)
							}
						}

						try {
							// Continue processing the original stream from where the main loop left off
							let usageFound = false
							let chunkCount = 0

							// Use the same iterator that the main loop was using
							while (!item.done) {
								// Check for timeout
								if (performance.now() - startTime > timeoutMs) {
									console.warn(
										`[Background Usage Collection] Timed out after ${timeoutMs}ms for model: ${modelId}, processed ${chunkCount} chunks`,
									)
									// Clean up the iterator before breaking
									if (iterator.return) {
										await iterator.return(undefined)
									}
									break
								}

								const chunk = item.value
								item = await iterator.next()
								chunkCount++

								if (chunk && chunk.type === "usage") {
									usageFound = true
									bgInputTokens += chunk.inputTokens
									bgOutputTokens += chunk.outputTokens
									bgCacheWriteTokens += chunk.cacheWriteTokens ?? 0
									bgCacheReadTokens += chunk.cacheReadTokens ?? 0
									bgTotalCost = chunk.totalCost
								}
							}

							if (
								usageFound ||
								bgInputTokens > 0 ||
								bgOutputTokens > 0 ||
								bgCacheWriteTokens > 0 ||
								bgCacheReadTokens > 0
							) {
								// We have usage data either from a usage chunk or accumulated tokens
								await captureUsageData(
									{
										input: bgInputTokens,
										output: bgOutputTokens,
										cacheWrite: bgCacheWriteTokens,
										cacheRead: bgCacheReadTokens,
										total: bgTotalCost,
									},
									lastApiReqIndex,
								)
							} else {
								console.warn(
									`[Background Usage Collection] Suspicious: request ${apiReqIndex} is complete, but no usage info was found. Model: ${modelId}`,
								)
							}
						} catch (error) {
							console.error("Error draining stream for usage data:", error)
							// Still try to capture whatever usage data we have collected so far
							if (
								bgInputTokens > 0 ||
								bgOutputTokens > 0 ||
								bgCacheWriteTokens > 0 ||
								bgCacheReadTokens > 0
							) {
								await captureUsageData(
									{
										input: bgInputTokens,
										output: bgOutputTokens,
										cacheWrite: bgCacheWriteTokens,
										cacheRead: bgCacheReadTokens,
										total: bgTotalCost,
									},
									lastApiReqIndex,
								)
							}
						}
					}

					// Start the background task and handle any errors
					drainStreamInBackgroundToFindAllUsage(lastApiReqIndex).catch((error) => {
						console.error("Background usage collection failed:", error)
					})
				} catch (error) {
					// Abandoned happens when extension is no longer waiting for the
					// Cline instance to finish aborting (error is thrown here when
					// any function in the for loop throws due to this.abort).
					if (!this.abandoned) {
						// Determine cancellation reason
						const cancelReason: ClineApiReqCancelReason = this.abort ? "user_cancelled" : "streaming_failed"

						const rawErrorMessage = error.message ?? JSON.stringify(serializeError(error), null, 2)
						const streamingFailedMessage = this.abort
							? undefined
							: `${t("common:interruption.streamTerminatedByProvider")}: ${rawErrorMessage}`

						// Clean up partial state
						await abortStream(cancelReason, streamingFailedMessage)

						if (this.abort) {
							// User cancelled - abort the entire task
							this.abortReason = cancelReason
							await this.abortTask()
						} else {
							// Stream failed - log the error and retry with the same content
							// The existing rate limiting will prevent rapid retries
							console.error(
								`[Task#${this.taskId}.${this.instanceId}] Stream failed, will retry: ${streamingFailedMessage}`,
							)

							// Apply exponential backoff similar to first-chunk errors when auto-resubmit is enabled
							const stateForBackoff = await this.providerRef.deref()?.getState()
							if (stateForBackoff?.autoApprovalEnabled) {
								await this.backoffAndAnnounce(currentItem.retryAttempt ?? 0, error)

								// Check if task was aborted during the backoff
								if (this.abort) {
									console.log(
										`[Task#${this.taskId}.${this.instanceId}] Task aborted during mid-stream retry backoff`,
									)
									// Abort the entire task
									this.abortReason = "user_cancelled"
									await this.abortTask()
									break
								}
							}

							// Push the same content back onto the stack to retry, incrementing the retry attempt counter
							stack.push({
								userContent: currentUserContent,
								includeFileDetails: false,
								retryAttempt: (currentItem.retryAttempt ?? 0) + 1,
							})

							// Continue to retry the request
							continue
						}
					}
				} finally {
					this.isStreaming = false
					// Clean up the abort controller when streaming completes
					this.currentRequestAbortController = undefined
				}

				// Need to call here in case the stream was aborted.
				if (this.abort || this.abandoned) {
					throw new Error(
						`[RooCode#recursivelyMakeRooRequests] task ${this.taskId}.${this.instanceId} aborted`,
					)
				}

				this.didCompleteReadingStream = true

				// Set any blocks to be complete to allow `presentAssistantMessage`
				// to finish and set `userMessageContentReady` to true.
				// (Could be a text block that had no subsequent tool uses, or a
				// text block at the very end, or an invalid tool use, etc. Whatever
				// the case, `presentAssistantMessage` relies on these blocks either
				// to be completed or the user to reject a block in order to proceed
				// and eventually set userMessageContentReady to true.)

				// Finalize any remaining streaming tool calls that weren't explicitly ended
				// This is critical for MCP tools which need tool_call_end events to be properly
				// converted from ToolUse to McpToolUse via finalizeStreamingToolCall()
				const finalizeEvents = NativeToolCallParser.finalizeRawChunks()
				for (const event of finalizeEvents) {
					if (event.type === "tool_call_end") {
						// Finalize the streaming tool call
						const finalToolUse = NativeToolCallParser.finalizeStreamingToolCall(event.id)

						// Get the index for this tool call
						const toolUseIndex = this.streamingToolCallIndices.get(event.id)

						if (finalToolUse) {
							// Store the tool call ID
							;(finalToolUse as any).id = event.id

							// Get the index and replace partial with final
							if (toolUseIndex !== undefined) {
								this.assistantMessageContent[toolUseIndex] = finalToolUse
							}

							// Clean up tracking
							this.streamingToolCallIndices.delete(event.id)

							// Mark that we have new content to process
							this.userMessageContentReady = false

							// Present the finalized tool call
							presentAssistantMessage(this)
						} else if (toolUseIndex !== undefined) {
							// finalizeStreamingToolCall returned null (malformed JSON or missing args)
							// We still need to mark the tool as non-partial so it gets executed
							// The tool's validation will catch any missing required parameters
							const existingToolUse = this.assistantMessageContent[toolUseIndex]
							if (existingToolUse && existingToolUse.type === "tool_use") {
								existingToolUse.partial = false
								// Ensure it has the ID for native protocol
								;(existingToolUse as any).id = event.id
							}

							// Clean up tracking
							this.streamingToolCallIndices.delete(event.id)

							// Mark that we have new content to process
							this.userMessageContentReady = false

							// Present the tool call - validation will handle missing params
							presentAssistantMessage(this)
						}
					}
				}

				// IMPORTANT: Capture partialBlocks AFTER finalizeRawChunks() to avoid double-presentation.
				// Tools finalized above are already presented, so we only want blocks still partial after finalization.
				const partialBlocks = this.assistantMessageContent.filter((block) => block.partial)
				partialBlocks.forEach((block) => (block.partial = false))

				// Can't just do this b/c a tool could be in the middle of executing.
				// this.assistantMessageContent.forEach((e) => (e.partial = false))

				// No legacy streaming parser to finalize.

				// Note: updateApiReqMsg() is now called from within drainStreamInBackgroundToFindAllUsage
				// to ensure usage data is captured even when the stream is interrupted. The background task
				// uses local variables to accumulate usage data before atomically updating the shared state.

				// Complete the reasoning message if it exists
				// We can't use say() here because the reasoning message may not be the last message
				// (other messages like text blocks or tool uses may have been added after it during streaming)
				if (reasoningMessage) {
					const lastReasoningIndex = findLastIndex(
						this.clineMessages,
						(m) => m.type === "say" && m.say === "reasoning",
					)

					if (lastReasoningIndex !== -1 && this.clineMessages[lastReasoningIndex].partial) {
						this.clineMessages[lastReasoningIndex].partial = false
						await this.updateClineMessage(this.clineMessages[lastReasoningIndex])
					}
				}

				await this.saveClineMessages()
				await this.providerRef.deref()?.postStateToWebviewWithoutTaskHistory()

				// No legacy text-stream tool parser state to reset.

				// CRITICAL: Save assistant message to API history BEFORE executing tools.
				// This ensures that when new_task triggers delegation and calls flushPendingToolResultsToHistory(),
				// the assistant message is already in history. Otherwise, tool_result blocks would appear
				// BEFORE their corresponding tool_use blocks, causing API errors.

				// Check if we have any content to process (text or tool uses)
				const hasTextContent = assistantMessage.length > 0

				const hasToolUses = this.assistantMessageContent.some(
					(block) => block.type === "tool_use" || block.type === "mcp_tool_use",
				)

				this.diagLog(
					`[Task#${this.taskId}] [TOOL_CALL_DEBUG] Post-stream check: hasTextContent=${hasTextContent}, hasToolUses=${hasToolUses}, assistantMessageContent=${JSON.stringify(this.assistantMessageContent.map((b) => ({ type: b.type, name: (b as any).name })))}`,
				)

				if (hasTextContent || hasToolUses) {
					// Reset counter when we get a successful response with content
					this.consecutiveNoAssistantMessagesCount = 0
					// Display grounding sources to the user if they exist
					if (pendingGroundingSources.length > 0) {
						const citationLinks = pendingGroundingSources.map((source, i) => `[${i + 1}](${source.url})`)
						const sourcesText = `${t("common:gemini.sources")} ${citationLinks.join(", ")}`

						await this.say("text", sourcesText, undefined, false, undefined, undefined, {
							isNonInteractive: true,
						})
					}

					// Build the assistant message content array
					const assistantContent: Array<Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam> = []

					// Add text content if present
					if (assistantMessage) {
						assistantContent.push({
							type: "text" as const,
							text: assistantMessage,
						})
					}

					// Add tool_use blocks with their IDs for native protocol
					// This handles both regular ToolUse and McpToolUse types
					// IMPORTANT: Track seen IDs to prevent duplicates in the API request.
					// Duplicate tool_use IDs cause Anthropic API 400 errors:
					// "tool_use ids must be unique"
					const seenToolUseIds = new Set<string>()
					const toolUseBlocks = this.assistantMessageContent.filter(
						(block) => block.type === "tool_use" || block.type === "mcp_tool_use",
					)
					for (const block of toolUseBlocks) {
						if (block.type === "mcp_tool_use") {
							// McpToolUse already has the original tool name (e.g., "mcp_serverName_toolName")
							// The arguments are the raw tool arguments (matching the simplified schema)
							const mcpBlock = block as import("../../shared/tools").McpToolUse
							if (mcpBlock.id) {
								const sanitizedId = sanitizeToolUseId(mcpBlock.id)
								// Pre-flight deduplication: Skip if we've already added this ID
								if (seenToolUseIds.has(sanitizedId)) {
									console.warn(
										`[Task#${this.taskId}] Pre-flight deduplication: Skipping duplicate MCP tool_use ID: ${sanitizedId} (tool: ${mcpBlock.name})`,
									)
									continue
								}
								seenToolUseIds.add(sanitizedId)
								assistantContent.push({
									type: "tool_use" as const,
									id: sanitizedId,
									name: mcpBlock.name, // Original dynamic name
									input: mcpBlock.arguments, // Direct tool arguments
								})
							}
						} else {
							// Regular ToolUse
							const toolUse = block as import("../../shared/tools").ToolUse
							const toolCallId = toolUse.id
							if (toolCallId) {
								const sanitizedId = sanitizeToolUseId(toolCallId)
								// Pre-flight deduplication: Skip if we've already added this ID
								if (seenToolUseIds.has(sanitizedId)) {
									console.warn(
										`[Task#${this.taskId}] Pre-flight deduplication: Skipping duplicate tool_use ID: ${sanitizedId} (tool: ${toolUse.name})`,
									)
									continue
								}
								seenToolUseIds.add(sanitizedId)
								// nativeArgs is already in the correct API format for all tools
								const input = toolUse.nativeArgs || toolUse.params

								// Use originalName (alias) if present for API history consistency.
								// When tool aliases are used (e.g., "edit_file" -> "search_and_replace" -> "edit" (current canonical name)),
								// we want the alias name in the conversation history to match what the model
								// was told the tool was named, preventing confusion in multi-turn conversations.
								const toolNameForHistory = toolUse.originalName ?? toolUse.name

								assistantContent.push({
									type: "tool_use" as const,
									id: sanitizedId,
									name: toolNameForHistory,
									input,
								})
							}
						}
					}

					// Enforce new_task isolation: if new_task is called alongside other tools,
					// truncate any tools that come after it and inject error tool_results.
					// This prevents orphaned tools when delegation disposes the parent task.
					const newTaskIndex = assistantContent.findIndex(
						(block) => block.type === "tool_use" && block.name === "new_task",
					)

					if (newTaskIndex !== -1 && newTaskIndex < assistantContent.length - 1) {
						// new_task found but not last - truncate subsequent tools
						const truncatedTools = assistantContent.slice(newTaskIndex + 1)
						assistantContent.length = newTaskIndex + 1 // Truncate API history array

						// ALSO truncate the execution array (assistantMessageContent) to prevent
						// tools after new_task from being executed by presentAssistantMessage().
						// Find new_task index in assistantMessageContent (may differ from assistantContent
						// due to text blocks being structured differently).
						const executionNewTaskIndex = this.assistantMessageContent.findIndex(
							(block) => block.type === "tool_use" && block.name === "new_task",
						)
						if (executionNewTaskIndex !== -1) {
							this.assistantMessageContent.length = executionNewTaskIndex + 1
						}

						// Pre-inject error tool_results for truncated tools
						for (const tool of truncatedTools) {
							if (tool.type === "tool_use" && (tool as Anthropic.ToolUseBlockParam).id) {
								this.pushToolResultToUserContent({
									type: "tool_result",
									tool_use_id: (tool as Anthropic.ToolUseBlockParam).id,
									content:
										"This tool was not executed because new_task was called in the same message turn. The new_task tool must be the last tool in a message.",
									is_error: true,
								})
							}
						}
					}

					// Save assistant message BEFORE executing tools
					// This is critical for new_task: when it triggers delegation, flushPendingToolResultsToHistory()
					// will save the user message with tool_results. The assistant message must already be in history
					// so that tool_result blocks appear AFTER their corresponding tool_use blocks.
					await this.addToApiConversationHistory(
						{ role: "assistant", content: assistantContent },
						reasoningMessage || undefined,
					)
					this.assistantMessageSavedToHistory = true

					TelemetryService.instance.captureConversationMessage(this.taskId, "assistant")
				}

				// Present any partial blocks that were just completed.
				// Tool calls are typically presented during streaming via tool_call_partial events,
				// but we still present here if any partial blocks remain (e.g., malformed streams).
				// NOTE: This MUST happen AFTER saving the assistant message to API history.
				// When new_task is in the batch, it triggers delegation which calls flushPendingToolResultsToHistory().
				// If the assistant message isn't saved yet, tool_results would appear before tool_use blocks.
				if (partialBlocks.length > 0) {
					// If there is content to update then it will complete and
					// update `this.userMessageContentReady` to true, which we
					// `pWaitFor` before making the next request.
					presentAssistantMessage(this)
				}

				if (hasTextContent || hasToolUses) {
					// NOTE: This comment is here for future reference - this was a
					// workaround for `userMessageContent` not getting set to true.
					// It was due to it not recursively calling for partial blocks
					// when `didRejectTool`, so it would get stuck waiting for a
					// partial block to complete before it could continue.
					// In case the content blocks finished it may be the api stream
					// finished after the last parsed content block was executed, so
					// we are able to detect out of bounds and set
					// `userMessageContentReady` to true (note you should not call
					// `presentAssistantMessage` since if the last block i
					//  completed it will be presented again).
					// const completeBlocks = this.assistantMessageContent.filter((block) => !block.partial) // If there are any partial blocks after the stream ended we can consider them invalid.
					// if (this.currentStreamingContentIndex >= completeBlocks.length) {
					// 	this.userMessageContentReady = true
					// }

					await pWaitFor(() => this.userMessageContentReady)

					this.diagLog(
						`[DIAG recursivelyMakeClineRequests] After tools executed: taskId=${this.taskId}.${this.instanceId}, abort=${this.abort}, userMessageContent length=${this.userMessageContent.length}`,
					)

					// If the model did not tool use, then we need to tell it to
					// either use a tool or attempt_completion.
					const didToolUse = this.assistantMessageContent.some(
						(block) => block.type === "tool_use" || block.type === "mcp_tool_use",
					)

					this.diagLog(
						`[DIAG recursivelyMakeClineRequests] Tool usage check: didToolUse=${didToolUse}, consecutiveNoToolUseCount=${this.consecutiveNoToolUseCount}`,
					)

					if (!didToolUse) {
						// Increment consecutive no-tool-use counter
						this.consecutiveNoToolUseCount++

						// Only show error and count toward mistake limit after 2 consecutive failures
						if (this.consecutiveNoToolUseCount >= 2) {
							await this.say("error", "MODEL_NO_TOOLS_USED")
							// Only count toward mistake limit after second consecutive failure
							this.consecutiveMistakeCount++
						}

						// Use the task's locked protocol for consistent behavior
						this.userMessageContent.push({
							type: "text",
							text: formatResponse.noToolsUsed(),
						})
					} else {
						// Reset counter when tools are used successfully
						this.consecutiveNoToolUseCount = 0
					}

					// Push to stack if there's content OR if we're paused waiting for a subtask.
					// When paused, we push an empty item so the loop continues to the pause check.
					if (this.userMessageContent.length > 0 || this.isPaused) {
						this.diagLog(
							`[DIAG recursivelyMakeClineRequests] Pushing to stack and continuing loop: userMessageContent length=${this.userMessageContent.length}, isPaused=${this.isPaused}`,
						)
						stack.push({
							userContent: [...this.userMessageContent], // Create a copy to avoid mutation issues
							includeFileDetails: false, // Subsequent iterations don't need file details
						})

						// Add periodic yielding to prevent blocking
						await new Promise((resolve) => setImmediate(resolve))
					}

					this.diagLog(
						`[DIAG recursivelyMakeClineRequests] Continuing stack loop: stack length=${stack.length}`,
					)
					continue
				} else {
					// If there's no assistant_responses, that means we got no text
					// or tool_use content blocks from API which we should assume is
					// an error.

					// Increment consecutive no-assistant-messages counter
					this.consecutiveNoAssistantMessagesCount++

					// Only show error and count toward mistake limit after 2 consecutive failures
					// This provides a "grace retry" - first failure retries silently
					if (this.consecutiveNoAssistantMessagesCount >= 2) {
						await this.say("error", "MODEL_NO_ASSISTANT_MESSAGES")
					}

					// IMPORTANT: We already added the user message to
					// apiConversationHistory at line 1876. Since the assistant failed to respond,
					// we need to remove that message before retrying to avoid having two consecutive
					// user messages (which would cause tool_result validation errors).
					let state = await this.providerRef.deref()?.getState()
					if (this.apiConversationHistory.length > 0) {
						const lastMessage = this.apiConversationHistory[this.apiConversationHistory.length - 1]
						if (lastMessage.role === "user") {
							// Remove the last user message that we added earlier
							this.apiConversationHistory.pop()
						}
					}

					// Check if we should auto-retry or prompt the user
					// Reuse the state variable from above
					if (state?.autoApprovalEnabled) {
						// Auto-retry with backoff - don't persist failure message when retrying
						await this.backoffAndAnnounce(
							currentItem.retryAttempt ?? 0,
							new Error(
								"Unexpected API Response: The language model did not provide any assistant messages. This may indicate an issue with the API or the model's output.",
							),
						)

						// Check if task was aborted during the backoff
						if (this.abort) {
							console.log(
								`[Task#${this.taskId}.${this.instanceId}] Task aborted during empty-assistant retry backoff`,
							)
							break
						}

						// Push the same content back onto the stack to retry, incrementing the retry attempt counter
						// Mark that user message was removed so it gets re-added on retry
						stack.push({
							userContent: currentUserContent,
							includeFileDetails: false,
							retryAttempt: (currentItem.retryAttempt ?? 0) + 1,
							userMessageWasRemoved: true,
						})

						// Continue to retry the request
						continue
					} else {
						// Prompt the user for retry decision
						const { response } = await this.ask(
							"api_req_failed",
							"The model returned no assistant messages. This may indicate an issue with the API or the model's output.",
						)

						if (response === "yesButtonClicked") {
							await this.say("api_req_retried")

							// Push the same content back to retry
							stack.push({
								userContent: currentUserContent,
								includeFileDetails: false,
								retryAttempt: (currentItem.retryAttempt ?? 0) + 1,
							})

							// Continue to retry the request
							continue
						} else {
							// User declined to retry
							// Re-add the user message we removed.
							await this.addToApiConversationHistory({
								role: "user",
								content: currentUserContent,
							})

							await this.say(
								"error",
								"Unexpected API Response: The language model did not provide any assistant messages. This may indicate an issue with the API or the model's output.",
							)

							await this.addToApiConversationHistory({
								role: "assistant",
								content: [{ type: "text", text: "Failure: I did not provide a response." }],
							})
						}
					}
				}

				// If we reach here without continuing, return false (will always be false for now)
				return false
			} catch (error) {
				// This should never happen since the only thing that can throw an
				// error is the attemptApiRequest, which is wrapped in a try catch
				// that sends an ask where if noButtonClicked, will clear current
				// task and destroy this instance. However to avoid unhandled
				// promise rejection, we will end this loop which will end execution
				// of this instance (see `startTask`).
				return true // Needs to be true so parent loop knows to end task.
			}
		}

		// If we exit the while loop normally (stack is empty), return false
		return false
	}

	private async getSystemPrompt(): Promise<string> {
		const { mcpEnabled } = (await this.providerRef.deref()?.getState()) ?? {}
		let mcpHub: McpHub | undefined
		if (mcpEnabled ?? true) {
			const provider = this.providerRef.deref()

			if (!provider) {
				throw new Error("Provider reference lost during view transition")
			}

			// Wait for MCP hub initialization through McpServerManager
			mcpHub = await McpServerManager.getInstance(provider.context, provider)

			if (!mcpHub) {
				throw new Error("Failed to get MCP hub from server manager")
			}

			// Wait for MCP servers to be connected before generating system prompt
			await pWaitFor(() => !mcpHub!.isConnecting, { timeout: 10_000 }).catch(() => {
				console.error("MCP servers failed to connect in time")
			})
		}

		const rooIgnoreInstructions = this.rooIgnoreController?.getInstructions()

		const state = await this.providerRef.deref()?.getState()

		const {
			mode,
			customModes,
			customModePrompts,
			customInstructions,
			experiments,
			language,
			apiConfiguration,
			enableSubfolderRules,
		} = state ?? {}

		return await (async () => {
			const provider = this.providerRef.deref()

			if (!provider) {
				throw new Error("Provider not available")
			}

			const modelInfo = this.api.getModel().info

			return SYSTEM_PROMPT(
				provider.context,
				this.cwd,
				false,
				mcpHub,
				this.diffStrategy,
				mode ?? defaultModeSlug,
				customModePrompts,
				customModes,
				customInstructions,
				experiments,
				language,
				rooIgnoreInstructions,
				{
					todoListEnabled: apiConfiguration?.todoListEnabled ?? true,
					useAgentRules:
						vscode.workspace.getConfiguration(Package.name).get<boolean>("useAgentRules") ?? true,
					enableSubfolderRules: enableSubfolderRules ?? false,
					newTaskRequireTodos: vscode.workspace
						.getConfiguration(Package.name)
						.get<boolean>("newTaskRequireTodos", false),
					isStealthModel: modelInfo?.isStealthModel,
				},
				undefined, // todoList
				this.api.getModel().id,
				provider.getSkillsManager(),
			)
		})()
	}

	private getCurrentProfileId(state: any): string {
		return (
			state?.listApiConfigMeta?.find((profile: any) => profile.name === state?.currentApiConfigName)?.id ??
			"default"
		)
	}

	private async handleContextWindowExceededError(): Promise<void> {
		const state = await this.providerRef.deref()?.getState()
		const { profileThresholds = {}, mode, apiConfiguration } = state ?? {}

		const { contextTokens } = this.getTokenUsage()
		const modelInfo = this.api.getModel().info

		const maxTokens = getModelMaxOutputTokens({
			modelId: this.api.getModel().id,
			model: modelInfo,
			settings: this.apiConfiguration,
		})

		const contextWindow = modelInfo.contextWindow

		// Get the current profile ID using the helper method
		const currentProfileId = this.getCurrentProfileId(state)

		// Log the context window error for debugging
		console.warn(
			`[Task#${this.taskId}] Context window exceeded for model ${this.api.getModel().id}. ` +
				`Current tokens: ${contextTokens}, Context window: ${contextWindow}. ` +
				`Forcing truncation to ${FORCED_CONTEXT_REDUCTION_PERCENT}% of current context.`,
		)
		// Send condenseTaskContextStarted to show in-progress indicator
		await this.providerRef.deref()?.postMessageToWebview({ type: "condenseTaskContextStarted", text: this.taskId })

		// Build tools for condensing metadata (same tools used for normal API calls)
		const provider = this.providerRef.deref()
		let allTools: import("openai").default.Chat.ChatCompletionTool[] = []
		if (provider) {
			const toolsResult = await buildNativeToolsArrayWithRestrictions({
				provider,
				cwd: this.cwd,
				mode,
				customModes: state?.customModes,
				experiments: state?.experiments,
				apiConfiguration,
				disabledTools: state?.disabledTools,
				modelInfo,
				includeAllToolsWithRestrictions: false,
			})
			allTools = toolsResult.tools
		}

		// Build metadata with tools and taskId for the condensing API call
		const metadata: ApiHandlerCreateMessageMetadata = {
			mode,
			taskId: this.taskId,
			...(allTools.length > 0
				? {
						tools: allTools,
						tool_choice: "auto",
						parallelToolCalls: true,
					}
				: {}),
		}

		try {
			// Generate environment details to include in the condensed summary
			const environmentDetails = await getEnvironmentDetails(this, true)

			// Force aggressive truncation by keeping only 75% of the conversation history
			const truncateResult = await manageContext({
				messages: this.apiConversationHistory,
				totalTokens: contextTokens || 0,
				maxTokens,
				contextWindow,
				apiHandler: this.api,
				autoCondenseContext: true,
				autoCondenseContextPercent: FORCED_CONTEXT_REDUCTION_PERCENT,
				systemPrompt: await this.getSystemPrompt(),
				taskId: this.taskId,
				profileThresholds,
				currentProfileId,
				metadata,
				environmentDetails,
			})

			if (truncateResult.messages !== this.apiConversationHistory) {
				await this.overwriteApiConversationHistory(truncateResult.messages)
			}

			if (truncateResult.summary) {
				const { summary, cost, prevContextTokens, newContextTokens = 0 } = truncateResult
				const contextCondense: ContextCondense = { summary, cost, newContextTokens, prevContextTokens }
				await this.say(
					"condense_context",
					undefined /* text */,
					undefined /* images */,
					false /* partial */,
					undefined /* checkpoint */,
					undefined /* progressStatus */,
					{ isNonInteractive: true } /* options */,
					contextCondense,
				)
			} else if (truncateResult.truncationId) {
				// Sliding window truncation occurred (fallback when condensing fails or is disabled)
				const contextTruncation: ContextTruncation = {
					truncationId: truncateResult.truncationId,
					messagesRemoved: truncateResult.messagesRemoved ?? 0,
					prevContextTokens: truncateResult.prevContextTokens,
					newContextTokens: truncateResult.newContextTokensAfterTruncation ?? 0,
				}
				await this.say(
					"sliding_window_truncation",
					undefined /* text */,
					undefined /* images */,
					false /* partial */,
					undefined /* checkpoint */,
					undefined /* progressStatus */,
					{ isNonInteractive: true } /* options */,
					undefined /* contextCondense */,
					contextTruncation,
				)
			}
		} finally {
			// Notify webview that context management is complete (removes in-progress spinner)
			// IMPORTANT: Must always be sent to dismiss the spinner, even on error
			await this.providerRef
				.deref()
				?.postMessageToWebview({ type: "condenseTaskContextResponse", text: this.taskId })
		}
	}

	/**
	 * Enforce the user-configured provider rate limit.
	 *
	 * NOTE: This is intentionally treated as expected behavior and is surfaced via
	 * the `api_req_rate_limit_wait` say type (not an error).
	 */
	private async maybeWaitForProviderRateLimit(retryAttempt: number): Promise<void> {
		const state = await this.providerRef.deref()?.getState()
		const rateLimitSeconds =
			state?.apiConfiguration?.rateLimitSeconds ?? this.apiConfiguration?.rateLimitSeconds ?? 0

		if (rateLimitSeconds <= 0 || !Task.lastGlobalApiRequestTime) {
			return
		}

		const now = performance.now()
		const timeSinceLastRequest = now - Task.lastGlobalApiRequestTime
		const rateLimitDelay = Math.ceil(
			Math.min(rateLimitSeconds, Math.max(0, rateLimitSeconds * 1000 - timeSinceLastRequest) / 1000),
		)

		// Only show the countdown UX on the first attempt. Retry flows have their own delay messaging.
		if (rateLimitDelay > 0 && retryAttempt === 0) {
			for (let i = rateLimitDelay; i > 0; i--) {
				// Send structured JSON data for i18n-safe transport
				const delayMessage = JSON.stringify({ seconds: i })
				await this.say("api_req_rate_limit_wait", delayMessage, undefined, true)
				await delay(1000)
			}
			// Finalize the partial message so the UI doesn't keep rendering an in-progress spinner.
			await this.say("api_req_rate_limit_wait", undefined, undefined, false)
		}
	}

	public async *attemptApiRequest(
		retryAttempt: number = 0,
		options: { skipProviderRateLimit?: boolean } = {},
	): ApiStream {
		const state = await this.providerRef.deref()?.getState()

		const {
			apiConfiguration,
			autoApprovalEnabled,
			requestDelaySeconds,
			mode,
			autoCondenseContext = true,
			autoCondenseContextPercent = 90,
			profileThresholds = {},
		} = state ?? {}

		// Get condensing configuration for automatic triggers.
		const customCondensingPrompt = state?.customSupportPrompts?.CONDENSE

		if (!options.skipProviderRateLimit) {
			await this.maybeWaitForProviderRateLimit(retryAttempt)
		}

		// Update last request time right before making the request so that subsequent
		// requests — even from new subtasks — will honour the provider's rate-limit.
		//
		// NOTE: When recursivelyMakeClineRequests handles rate limiting, it sets the
		// timestamp earlier to include the environment details build. We still set it
		// here for direct callers (tests) and for the case where we didn't rate-limit
		// in the caller.
		Task.lastGlobalApiRequestTime = performance.now()

		const systemPrompt = await this.getSystemPrompt()
		const { contextTokens } = this.getTokenUsage()

		console.log(
			`[CONTEXT-DIAG] Task.attemptApiRequest entry — taskId=${this.taskId}, contextTokens=${contextTokens}, autoCondenseContext=${autoCondenseContext}, autoCondenseContextPercent=${autoCondenseContextPercent}, historyLen=${this.apiConversationHistory.length}, modelId=${this.api.getModel().id}, contextWindow=${this.api.getModel().info.contextWindow}`,
		)

		if (contextTokens) {
			const modelInfo = this.api.getModel().info

			const maxTokens = getModelMaxOutputTokens({
				modelId: this.api.getModel().id,
				model: modelInfo,
				settings: this.apiConfiguration,
			})

			const contextWindow = modelInfo.contextWindow

			// Get the current profile ID using the helper method
			const currentProfileId = this.getCurrentProfileId(state)
			// Check if context management will likely run (threshold check)
			// This allows us to show an in-progress indicator to the user
			// We use the centralized willManageContext helper to avoid duplicating threshold logic
			const lastMessage = this.apiConversationHistory[this.apiConversationHistory.length - 1]
			const lastMessageContent = lastMessage?.content
			let lastMessageTokens = 0
			if (lastMessageContent) {
				lastMessageTokens = Array.isArray(lastMessageContent)
					? await this.api.countTokens(lastMessageContent)
					: await this.api.countTokens([{ type: "text", text: lastMessageContent as string }])
			}

			const contextManagementWillRun = willManageContext({
				totalTokens: contextTokens,
				contextWindow,
				maxTokens,
				autoCondenseContext,
				autoCondenseContextPercent,
				profileThresholds,
				currentProfileId,
				lastMessageTokens,
			})

			// Send condenseTaskContextStarted BEFORE manageContext to show in-progress indicator
			// This notification must be sent here (not earlier) because the early check uses stale token count
			// (before user message is added to history), which could incorrectly skip showing the indicator
			if (contextManagementWillRun && autoCondenseContext) {
				await this.providerRef
					.deref()
					?.postMessageToWebview({ type: "condenseTaskContextStarted", text: this.taskId })
			}

			// Build tools for condensing metadata (same tools used for normal API calls)
			// This ensures the condensing API call includes tool definitions for providers that need them
			let contextMgmtTools: import("openai").default.Chat.ChatCompletionTool[] = []
			{
				const provider = this.providerRef.deref()
				if (provider) {
					const toolsResult = await buildNativeToolsArrayWithRestrictions({
						provider,
						cwd: this.cwd,
						mode,
						customModes: state?.customModes,
						experiments: state?.experiments,
						apiConfiguration,
						disabledTools: state?.disabledTools,
						modelInfo,
						includeAllToolsWithRestrictions: false,
					})
					contextMgmtTools = toolsResult.tools
				}
			}

			// Build metadata with tools and taskId for the condensing API call
			const contextMgmtMetadata: ApiHandlerCreateMessageMetadata = {
				mode,
				taskId: this.taskId,
				...(contextMgmtTools.length > 0
					? {
							tools: contextMgmtTools,
							tool_choice: "auto",
							parallelToolCalls: true,
						}
					: {}),
			}

			// Only generate environment details when context management will actually run.
			// getEnvironmentDetails(this, true) triggers a recursive workspace listing which
			// adds overhead - avoid this for the common case where context is below threshold.
			const contextMgmtEnvironmentDetails = contextManagementWillRun
				? await getEnvironmentDetails(this, true)
				: undefined

			// Get files read by Roo for code folding - only when context management will run
			const contextMgmtFilesReadByRoo =
				contextManagementWillRun && autoCondenseContext
					? await this.getFilesReadByRooSafely("attemptApiRequest")
					: undefined

			try {
				const truncateResult = await manageContext({
					messages: this.apiConversationHistory,
					totalTokens: contextTokens,
					maxTokens,
					contextWindow,
					apiHandler: this.api,
					autoCondenseContext,
					autoCondenseContextPercent,
					systemPrompt,
					taskId: this.taskId,
					customCondensingPrompt,
					profileThresholds,
					currentProfileId,
					metadata: contextMgmtMetadata,
					environmentDetails: contextMgmtEnvironmentDetails,
					filesReadByRoo: contextMgmtFilesReadByRoo,
					cwd: this.cwd,
					rooIgnoreController: this.rooIgnoreController,
				})
				if (truncateResult.messages !== this.apiConversationHistory) {
					await this.overwriteApiConversationHistory(truncateResult.messages)
				}
				if (truncateResult.error) {
					await this.say("condense_context_error", truncateResult.error)
				}
				if (truncateResult.summary) {
					const { summary, cost, prevContextTokens, newContextTokens = 0, condenseId } = truncateResult
					const contextCondense: ContextCondense = {
						summary,
						cost,
						newContextTokens,
						prevContextTokens,
						condenseId,
					}
					await this.say(
						"condense_context",
						undefined /* text */,
						undefined /* images */,
						false /* partial */,
						undefined /* checkpoint */,
						undefined /* progressStatus */,
						{ isNonInteractive: true } /* options */,
						contextCondense,
					)
				} else if (truncateResult.truncationId) {
					// Sliding window truncation occurred (fallback when condensing fails or is disabled)
					const contextTruncation: ContextTruncation = {
						truncationId: truncateResult.truncationId,
						messagesRemoved: truncateResult.messagesRemoved ?? 0,
						prevContextTokens: truncateResult.prevContextTokens,
						newContextTokens: truncateResult.newContextTokensAfterTruncation ?? 0,
					}
					await this.say(
						"sliding_window_truncation",
						undefined /* text */,
						undefined /* images */,
						false /* partial */,
						undefined /* checkpoint */,
						undefined /* progressStatus */,
						{ isNonInteractive: true } /* options */,
						undefined /* contextCondense */,
						contextTruncation,
					)
				}
			} finally {
				// Notify webview that context management is complete (sets isCondensing = false)
				// This removes the in-progress spinner and allows the completed result to show
				// IMPORTANT: Must always be sent to dismiss the spinner, even on error
				if (contextManagementWillRun && autoCondenseContext) {
					await this.providerRef
						.deref()
						?.postMessageToWebview({ type: "condenseTaskContextResponse", text: this.taskId })
				}
			}
		}

		// Get the effective API history by filtering out condensed messages
		// This allows non-destructive condensing where messages are tagged but not deleted,
		// enabling accurate rewind operations while still sending condensed history to the API.
		const effectiveHistory = getEffectiveApiHistory(this.apiConversationHistory)
		const messagesSinceLastSummary = getMessagesSinceLastSummary(effectiveHistory)
		// For API only: merge consecutive user messages (excludes summary messages per
		// mergeConsecutiveApiMessages implementation) without mutating stored history.
		const mergedForApi = mergeConsecutiveApiMessages(messagesSinceLastSummary, { roles: ["user"] })
		const messagesWithoutImages = maybeRemoveImageBlocks(mergedForApi, this.api)
		const cleanConversationHistory = this.buildCleanConversationHistory(messagesWithoutImages as ApiMessage[])

		// Check auto-approval limits
		const approvalResult = await this.autoApprovalHandler.checkAutoApprovalLimits(
			state,
			this.combineMessages(this.clineMessages.slice(1)),
			async (type, data) => this.ask(type, data),
		)

		if (!approvalResult.shouldProceed) {
			// User did not approve, task should be aborted
			throw new Error("Auto-approval limit reached and user did not approve continuation")
		}

		// Whether we include tools is determined by whether we have any tools to send.
		const modelInfo = this.api.getModel().info

		// Build complete tools array: native tools + dynamic MCP tools
		// When includeAllToolsWithRestrictions is true, returns all tools but provides
		// allowedFunctionNames for providers (like Gemini) that need to see all tool
		// definitions in history while restricting callable tools for the current mode.
		// Only Gemini currently supports this - other providers filter tools normally.
		let allTools: OpenAI.Chat.ChatCompletionTool[] = []
		let allowedFunctionNames: string[] | undefined

		// Gemini requires all tool definitions to be present for history compatibility,
		// but uses allowedFunctionNames to restrict which tools can be called.
		// Other providers (Anthropic, OpenAI, etc.) don't support this feature yet,
		// so they continue to receive only the filtered tools for the current mode.
		const supportsAllowedFunctionNames = apiConfiguration?.apiProvider === "gemini"

		{
			const provider = this.providerRef.deref()
			if (!provider) {
				throw new Error("Provider reference lost during tool building")
			}

			const toolsResult = await buildNativeToolsArrayWithRestrictions({
				provider,
				cwd: this.cwd,
				mode,
				customModes: state?.customModes,
				experiments: state?.experiments,
				apiConfiguration,
				disabledTools: state?.disabledTools,
				modelInfo,
				includeAllToolsWithRestrictions: supportsAllowedFunctionNames,
			})
			allTools = toolsResult.tools
			allowedFunctionNames = toolsResult.allowedFunctionNames
		}

		const shouldIncludeTools = allTools.length > 0

		const metadata: ApiHandlerCreateMessageMetadata = {
			mode: mode,
			taskId: this.taskId,
			suppressPreviousResponseId: this.skipPrevResponseIdOnce,
			// Include tools whenever they are present.
			...(shouldIncludeTools
				? {
						tools: allTools,
						tool_choice: "auto",
						parallelToolCalls: true,
						// When mode restricts tools, provide allowedFunctionNames so providers
						// like Gemini can see all tools in history but only call allowed ones
						...(allowedFunctionNames ? { allowedFunctionNames } : {}),
					}
				: {}),
		}

		// Create an AbortController to allow cancelling the request mid-stream
		this.currentRequestAbortController = new AbortController()
		const abortSignal = this.currentRequestAbortController.signal
		// Reset the flag after using it
		this.skipPrevResponseIdOnce = false

		// The provider accepts reasoning items alongside standard messages; cast to the expected parameter type.
		const stream = this.api.createMessage(
			systemPrompt,
			cleanConversationHistory as unknown as Anthropic.Messages.MessageParam[],
			metadata,
		)
		const iterator = stream[Symbol.asyncIterator]()

		// Set up abort handling - when the signal is aborted, clean up the controller reference
		abortSignal.addEventListener("abort", () => {
			console.log(`[Task#${this.taskId}.${this.instanceId}] AbortSignal triggered for current request`)
			this.currentRequestAbortController = undefined
		})

		try {
			// Awaiting first chunk to see if it will throw an error.
			this.isWaitingForFirstChunk = true

			// Race between the first chunk and the abort signal
			const firstChunkPromise = iterator.next()
			const abortPromise = new Promise<never>((_, reject) => {
				if (abortSignal.aborted) {
					reject(new Error("Request cancelled by user"))
				} else {
					abortSignal.addEventListener("abort", () => {
						reject(new Error("Request cancelled by user"))
					})
				}
			})

			const firstChunk = await Promise.race([firstChunkPromise, abortPromise])
			//this.diagLog(
			//	`[Task#${this.taskId}] [STREAM_PASSTHROUGH] Yielding FIRST chunk type=${firstChunk.value?.type}, preview=${JSON.stringify(firstChunk.value)?.slice(0, 200)}`,
			//)
			yield firstChunk.value
			this.isWaitingForFirstChunk = false
		} catch (error) {
			this.isWaitingForFirstChunk = false
			this.currentRequestAbortController = undefined
			const isContextWindowExceededError = checkContextWindowExceededError(error)

			// If it's a context window error and we haven't exceeded max retries for this error type
			if (isContextWindowExceededError && retryAttempt < MAX_CONTEXT_WINDOW_RETRIES) {
				console.warn(
					`[Task#${this.taskId}] Context window exceeded for model ${this.api.getModel().id}. ` +
						`Retry attempt ${retryAttempt + 1}/${MAX_CONTEXT_WINDOW_RETRIES}. ` +
						`Attempting automatic truncation...`,
				)
				await this.handleContextWindowExceededError()
				// Retry the request after handling the context window error
				yield* this.attemptApiRequest(retryAttempt + 1)
				return
			}

			// note that this api_req_failed ask is unique in that we only present this option if the api hasn't streamed any content yet (ie it fails on the first chunk due), as it would allow them to hit a retry button. However if the api failed mid-stream, it could be in any arbitrary state where some tools may have executed, so that error is handled differently and requires cancelling the task entirely.
			if (autoApprovalEnabled) {
				// Apply shared exponential backoff and countdown UX
				await this.backoffAndAnnounce(retryAttempt, error)

				// CRITICAL: Check if task was aborted during the backoff countdown
				// This prevents infinite loops when users cancel during auto-retry
				// Without this check, the recursive call below would continue even after abort
				if (this.abort) {
					throw new Error(
						`[Task#attemptApiRequest] task ${this.taskId}.${this.instanceId} aborted during retry`,
					)
				}

				// Delegate generator output from the recursive call with
				// incremented retry count.
				yield* this.attemptApiRequest(retryAttempt + 1)

				return
			} else {
				const { response } = await this.ask(
					"api_req_failed",
					error.message ?? JSON.stringify(serializeError(error), null, 2),
				)

				if (response !== "yesButtonClicked") {
					// This will never happen since if noButtonClicked, we will
					// clear current task, aborting this instance.
					throw new Error("API request failed")
				}

				await this.say("api_req_retried")

				// Delegate generator output from the recursive call.
				yield* this.attemptApiRequest()
				return
			}
		}

		// No error, so we can continue to yield all remaining chunks.
		// (Needs to be placed outside of try/catch since it we want caller to
		// handle errors not with api_req_failed as that is reserved for first
		// chunk failures only.)
		// This delegates to another generator or iterable object. In this case,
		// it's saying "yield all remaining values from this iterator". This
		// effectively passes along all subsequent chunks from the original
		// stream.
		// Manual loop with debug logging to trace chunk flow
		for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) {
			// this.diagLog(
			// 	`[Task#${this.taskId}] [STREAM_PASSTHROUGH] Yielding chunk type=${chunk?.type}, preview=${JSON.stringify(chunk)?.slice(0, 200)}`,
			// )
			yield chunk
		}
	}

	// Shared exponential backoff for retries (first-chunk and mid-stream)
	private async backoffAndAnnounce(retryAttempt: number, error: any): Promise<void> {
		try {
			const state = await this.providerRef.deref()?.getState()
			const baseDelay = state?.requestDelaySeconds || 5

			let exponentialDelay = Math.min(
				Math.ceil(baseDelay * Math.pow(2, retryAttempt)),
				MAX_EXPONENTIAL_BACKOFF_SECONDS,
			)

			// Respect provider rate limit window
			let rateLimitDelay = 0
			const rateLimit = (state?.apiConfiguration ?? this.apiConfiguration)?.rateLimitSeconds || 0
			if (Task.lastGlobalApiRequestTime && rateLimit > 0) {
				const elapsed = performance.now() - Task.lastGlobalApiRequestTime
				rateLimitDelay = Math.ceil(Math.min(rateLimit, Math.max(0, rateLimit * 1000 - elapsed) / 1000))
			}

			// Prefer RetryInfo on 429 if present
			if (error?.status === 429) {
				const retryInfo = error?.errorDetails?.find(
					(d: any) => d["@type"] === "type.googleapis.com/google.rpc.RetryInfo",
				)
				const match = retryInfo?.retryDelay?.match?.(/^(\d+)s$/)
				if (match) {
					exponentialDelay = Number(match[1]) + 1
				}
			}

			const finalDelay = Math.max(exponentialDelay, rateLimitDelay)
			if (finalDelay <= 0) {
				return
			}

			// Build header text; fall back to error message if none provided
			let headerText
			if (error.status) {
				// Include both status code (for ChatRow parsing) and detailed message (for error details)
				// Format: "<status>\n<message>" allows ChatRow to extract status via parseInt(text.substring(0,3))
				// while preserving the full error message in errorDetails for debugging
				const errorMessage = error?.message || "Unknown error"
				headerText = `${error.status}\n${errorMessage}`
			} else if (error?.message) {
				headerText = error.message
			} else {
				headerText = "Unknown error"
			}

			headerText = headerText ? `${headerText}\n` : ""

			// Show countdown timer with exponential backoff
			for (let i = finalDelay; i > 0; i--) {
				// Check abort flag during countdown to allow early exit
				if (this.abort) {
					throw new Error(`[Task#${this.taskId}] Aborted during retry countdown`)
				}

				await this.say("api_req_retry_delayed", `${headerText}<retry_timer>${i}</retry_timer>`, undefined, true)
				await delay(1000)
			}

			await this.say("api_req_retry_delayed", headerText, undefined, false)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)

			if (this.abort && message.includes("Aborted during retry countdown")) {
				return
			}

			console.error("Exponential backoff failed:", err)
		}
	}

	// Checkpoints

	public async checkpointSave(force: boolean = false, suppressMessage: boolean = false) {
		return checkpointSave(this, force, suppressMessage)
	}

	private buildCleanConversationHistory(
		messages: ApiMessage[],
	): Array<
		Anthropic.Messages.MessageParam | { type: "reasoning"; encrypted_content: string; id?: string; summary?: any[] }
	> {
		type ReasoningItemForRequest = {
			type: "reasoning"
			encrypted_content: string
			id?: string
			summary?: any[]
		}

		const cleanConversationHistory: (Anthropic.Messages.MessageParam | ReasoningItemForRequest)[] = []

		for (const msg of messages) {
			// Standalone reasoning: send encrypted, skip plain text
			if (msg.type === "reasoning") {
				if (msg.encrypted_content) {
					cleanConversationHistory.push({
						type: "reasoning",
						summary: msg.summary,
						encrypted_content: msg.encrypted_content!,
						...(msg.id ? { id: msg.id } : {}),
					})
				}
				continue
			}

			// Preferred path: assistant message with embedded reasoning as first content block
			if (msg.role === "assistant") {
				const rawContent = msg.content

				const contentArray: Anthropic.Messages.ContentBlockParam[] = Array.isArray(rawContent)
					? (rawContent as Anthropic.Messages.ContentBlockParam[])
					: rawContent !== undefined
						? ([
								{ type: "text", text: rawContent } satisfies Anthropic.Messages.TextBlockParam,
							] as Anthropic.Messages.ContentBlockParam[])
						: []

				const [first, ...rest] = contentArray

				// Check if this message has reasoning_details (OpenRouter format for Gemini 3, etc.)
				const msgWithDetails = msg
				if (msgWithDetails.reasoning_details && Array.isArray(msgWithDetails.reasoning_details)) {
					// Build the assistant message with reasoning_details
					let assistantContent: Anthropic.Messages.MessageParam["content"]

					if (contentArray.length === 0) {
						assistantContent = ""
					} else if (contentArray.length === 1 && contentArray[0].type === "text") {
						assistantContent = (contentArray[0] as Anthropic.Messages.TextBlockParam).text
					} else {
						assistantContent = contentArray
					}

					// Create message with reasoning_details property
					cleanConversationHistory.push({
						role: "assistant",
						content: assistantContent,
						reasoning_details: msgWithDetails.reasoning_details,
					} as any)

					continue
				}

				// Embedded reasoning: encrypted (send) or plain text (skip)
				const hasEncryptedReasoning =
					first && (first as any).type === "reasoning" && typeof (first as any).encrypted_content === "string"
				const hasPlainTextReasoning =
					first && (first as any).type === "reasoning" && typeof (first as any).text === "string"

				if (hasEncryptedReasoning) {
					const reasoningBlock = first as any

					// Send as separate reasoning item (OpenAI Native)
					cleanConversationHistory.push({
						type: "reasoning",
						summary: reasoningBlock.summary ?? [],
						encrypted_content: reasoningBlock.encrypted_content,
						...(reasoningBlock.id ? { id: reasoningBlock.id } : {}),
					})

					// Send assistant message without reasoning
					let assistantContent: Anthropic.Messages.MessageParam["content"]

					if (rest.length === 0) {
						assistantContent = ""
					} else if (rest.length === 1 && rest[0].type === "text") {
						assistantContent = (rest[0] as Anthropic.Messages.TextBlockParam).text
					} else {
						assistantContent = rest
					}

					cleanConversationHistory.push({
						role: "assistant",
						content: assistantContent,
					} satisfies Anthropic.Messages.MessageParam)

					continue
				} else if (hasPlainTextReasoning) {
					// Check if the model's preserveReasoning flag is set
					// If true, include the reasoning block in API requests
					// If false/undefined, strip it out (stored for history only, not sent back to API)
					const shouldPreserveForApi = this.api.getModel().info.preserveReasoning === true
					let assistantContent: Anthropic.Messages.MessageParam["content"]

					if (shouldPreserveForApi) {
						// Include reasoning block in the content sent to API
						assistantContent = contentArray
					} else {
						// Strip reasoning out - stored for history only, not sent back to API
						if (rest.length === 0) {
							assistantContent = ""
						} else if (rest.length === 1 && rest[0].type === "text") {
							assistantContent = (rest[0] as Anthropic.Messages.TextBlockParam).text
						} else {
							assistantContent = rest
						}
					}

					cleanConversationHistory.push({
						role: "assistant",
						content: assistantContent,
					} satisfies Anthropic.Messages.MessageParam)

					continue
				}
			}

			// Default path for regular messages (no embedded reasoning)
			if (msg.role) {
				cleanConversationHistory.push({
					role: msg.role,
					content: msg.content as Anthropic.Messages.ContentBlockParam[] | string,
				})
			}
		}

		return cleanConversationHistory
	}
	public async checkpointRestore(options: CheckpointRestoreOptions) {
		return checkpointRestore(this, options)
	}

	public async checkpointDiff(options: CheckpointDiffOptions) {
		return checkpointDiff(this, options)
	}

	// Metrics

	public combineMessages(messages: ClineMessage[]) {
		return combineApiRequests(combineCommandSequences(messages))
	}

	public getTokenUsage(): TokenUsage {
		return getApiMetrics(this.combineMessages(this.clineMessages.slice(1)))
	}

	public recordToolUsage(toolName: ToolName) {
		if (!this.toolUsage[toolName]) {
			this.toolUsage[toolName] = { attempts: 0, failures: 0 }
		}

		this.toolUsage[toolName].attempts++
	}

	public recordToolError(toolName: ToolName, error?: string) {
		if (!this.toolUsage[toolName]) {
			this.toolUsage[toolName] = { attempts: 0, failures: 0 }
		}

		this.toolUsage[toolName].failures++

		if (error) {
			this.emit(RooCodeEventName.TaskToolFailed, this.taskId, toolName, error)
		}
	}

	// Getters

	public get taskStatus(): TaskStatus {
		if (this.interactiveAsk) {
			return TaskStatus.Interactive
		}

		if (this.resumableAsk) {
			return TaskStatus.Resumable
		}

		if (this.idleAsk) {
			return TaskStatus.Idle
		}

		return TaskStatus.Running
	}

	public get taskAsk(): ClineMessage | undefined {
		return this.idleAsk || this.resumableAsk || this.interactiveAsk
	}

	public get queuedMessages(): QueuedMessage[] {
		return this.messageQueueService.messages
	}

	public get tokenUsage(): TokenUsage | undefined {
		if (this.tokenUsageSnapshot && this.tokenUsageSnapshotAt) {
			return this.tokenUsageSnapshot
		}

		this.tokenUsageSnapshot = this.getTokenUsage()
		this.tokenUsageSnapshotAt = this.clineMessages.at(-1)?.ts

		return this.tokenUsageSnapshot
	}

	public get cwd() {
		return this.workspacePath
	}

	/**
	 * Provides convenient access to high-level message operations.
	 * Uses lazy initialization - the MessageManager is only created when first accessed.
	 * Subsequent accesses return the same cached instance.
	 *
	 * ## Important: Single Coordination Point
	 *
	 * **All MessageManager operations must go through this getter** rather than
	 * instantiating `new MessageManager(task)` directly. This ensures:
	 * - A single shared instance for consistent behavior
	 * - Centralized coordination of all rewind/message operations
	 * - Ability to add internal state or instrumentation in the future
	 *
	 * @example
	 * ```typescript
	 * // Correct: Use the getter
	 * await task.messageManager.rewindToTimestamp(ts)
	 *
	 * // Incorrect: Do NOT create new instances directly
	 * // const manager = new MessageManager(task) // Don't do this!
	 * ```
	 */
	get messageManager(): MessageManager {
		if (!this._messageManager) {
			this._messageManager = new MessageManager(this)
		}
		return this._messageManager
	}

	/**
	 * Process any queued messages by dequeuing and submitting them.
	 * This ensures that queued user messages are sent when appropriate,
	 * preventing them from getting stuck in the queue.
	 *
	 * @param context - Context string for logging (e.g., the calling tool name)
	 */
	public processQueuedMessages(): void {
		try {
			if (!this.messageQueueService.isEmpty()) {
				const queued = this.messageQueueService.dequeueMessage()
				if (queued) {
					setTimeout(() => {
						this.submitUserMessage(queued.text, queued.images).catch((err) =>
							console.error(`[Task] Failed to submit queued message:`, err),
						)
					}, 0)
				}
			}
		} catch (e) {
			console.error(`[Task] Queue processing error:`, e)
		}
	}

	/**
	 * Cancel the current API request and immediately send the first queued message to the LLM.
	 * This allows the user to interrupt a long-running operation and prioritize a queued message.
	 *
	 * The cancellation follows these steps:
	 * 1. Cancel the current HTTP request
	 * 2. Set abort flag to stop the task loop
	 * 3. Reset task state
	 * 4. Restart the task loop with the queued message
	 */
	public cancelAndProcessQueuedMessages(): void {
		this.diagLog(`[Task#${this.taskId}.${this.instanceId}] cancelAndProcessQueuedMessages called`)

		// Step 1: Cancel the current HTTP request if one is in progress
		if (this.currentRequestAbortController) {
			this.diagLog(`[Task] Cancelling current HTTP request`)
			this.currentRequestAbortController.abort()
			this.currentRequestAbortController = undefined
		}

		// Step 2: Set abort flag to stop the task loop
		// This will cause the initiateTaskLoop to exit after the current operation completes
		this.abort = true
		this.diagLog(`[Task] Set abort=true to stop task loop`)

		// Step 3: Reset ask states so the task can handle the queued message
		this.idleAsk = undefined
		this.resumableAsk = undefined
		this.interactiveAsk = undefined
		this.emit(RooCodeEventName.TaskActive, this.taskId)

		// Step 4: Process the queued messages (if any)
		// Get the queued message but don't send via submitUserMessage - instead restart the task loop directly
		const queued = this.messageQueueService.dequeueMessage()
		if (queued) {
			this.diagLog(`[Task] Restarting task loop with queued message: ${queued.text?.substring(0, 100)}`)
			// Reset abort to allow the task loop to run
			this.abort = false
			// Start a new task loop with the queued message
			this.initiateTaskLoop([{ type: "text", text: queued.text }]).catch((err) => {
				console.error(`[Task] Failed to restart task loop:`, err)
			})
		}
	}
}
