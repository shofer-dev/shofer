import { z } from "zod"

import type { ExtensionState } from "./vscode-extension-host.js"
import { ShoferEventName } from "./events.js"
import type { ShoferSettings } from "./global-settings.js"
import type { ShoferMessage, QueuedMessage, TokenUsage } from "./message.js"
import type { TaskState, CompletionRating } from "./history.js"
import type { ToolUsage, ToolName } from "./tool.js"
import type { StaticAppProperties, GitProperties, TelemetryProperties } from "./telemetry.js"
import type { TodoItem } from "./todo.js"

/**
 * TaskProviderLike
 */

export interface TaskProviderLike {
	// Tasks
	getCurrentTask(): TaskLike | undefined
	getRecentTasks(): string[]
	createTask(
		text?: string,
		images?: string[],
		parentTask?: TaskLike,
		options?: CreateTaskOptions,
		configuration?: ShoferSettings,
	): Promise<TaskLike>
	cancelTask(): Promise<void>
	clearTask(): Promise<void>
	resumeTask(taskId: string): void

	// Modes
	getModes(): Promise<{ slug: string; name: string }[]>
	getMode(): Promise<string>
	setMode(mode: string): Promise<void>

	// Provider Profiles
	getProviderProfiles(): Promise<{ name: string; provider?: string }[]>
	getProviderProfile(): Promise<string>
	setProviderProfile(providerProfile: string): Promise<void>

	// Telemetry
	readonly appProperties: StaticAppProperties
	readonly gitProperties: GitProperties | undefined
	getTelemetryProperties(): Promise<TelemetryProperties>
	readonly cwd: string

	// Event Emitter
	on<K extends keyof TaskProviderEvents>(
		event: K,
		listener: (...args: TaskProviderEvents[K]) => void | Promise<void>,
	): this

	off<K extends keyof TaskProviderEvents>(
		event: K,
		listener: (...args: TaskProviderEvents[K]) => void | Promise<void>,
	): this

	// @TODO: Find a better way to do this.
	postInitState(): Promise<void>
	postConfigUpdate(key: string, value: unknown): void
	postTaskStateUpdate(
		updates: Partial<
			Pick<
				ExtensionState,
				"currentTaskId" | "currentTaskItem" | "messageQueue" | "parallelTasks" | "focusedTaskId"
			>
		>,
	): void
}

export type TaskAbortReason = "user" | "completed" | "error" | "abandoned"

export interface TaskCompletedInfo {
	rating: CompletionRating
	isSubtask: boolean
}

export interface TaskAbortedInfo {
	reason: TaskAbortReason
}

export type TaskProviderEvents = {
	[ShoferEventName.TaskCreated]: [task: TaskLike]
	[ShoferEventName.TaskStarted]: [taskId: string]
	[ShoferEventName.TaskCompleted]: [
		taskId: string,
		tokenUsage: TokenUsage,
		toolUsage: ToolUsage,
		info: TaskCompletedInfo,
	]
	[ShoferEventName.TaskAborted]: [taskId: string, info: TaskAbortedInfo]
	[ShoferEventName.TaskFocused]: [taskId: string]
	[ShoferEventName.TaskUnfocused]: [taskId: string]
	[ShoferEventName.TaskActive]: [taskId: string]
	[ShoferEventName.TaskInteractive]: [taskId: string]
	[ShoferEventName.TaskResumable]: [taskId: string]
	[ShoferEventName.TaskIdle]: [taskId: string]

	[ShoferEventName.TaskPaused]: [taskId: string]
	[ShoferEventName.TaskUnpaused]: [taskId: string]
	[ShoferEventName.TaskSpawned]: [taskId: string]
	[ShoferEventName.TaskDelegated]: [parentTaskId: string, childTaskId: string]
	[ShoferEventName.TaskDelegationCompleted]: [parentTaskId: string, childTaskId: string, summary: string]
	[ShoferEventName.TaskDelegationResumed]: [parentTaskId: string, childTaskId: string]

	[ShoferEventName.TaskUserMessage]: [taskId: string]

	[ShoferEventName.TaskTokenUsageUpdated]: [taskId: string, tokenUsage: TokenUsage, toolUsage: ToolUsage]

	[ShoferEventName.ModeChanged]: [mode: string]
	[ShoferEventName.ProviderProfileChanged]: [config: { name: string; provider?: string }]
}

/**
 * TaskLike
 */

export interface CreateTaskOptions {
	taskId?: string
	enableCheckpoints?: boolean
	consecutiveMistakeLimit?: number
	experiments?: Record<string, boolean>
	initialTodos?: TodoItem[]
	/**
	 * Override the initial task mode for this task only.
	 * Useful when creating delegated/background tasks without mutating global mode.
	 */
	initialMode?: string
	/**
	 * Override the initial API configuration profile (by name) for this task only.
	 * The profile's full settings are loaded and used to build the task's API
	 * handler without mutating the global active profile. Useful for seeding a
	 * new task from a pre-task dropdown selection.
	 */
	initialApiConfigName?: string
	/** Initial execution state for the task's history item. */
	initialState?: TaskState
	/**
	 * When true, marks the task as a background child of its parent so that
	 * `attempt_completion` does NOT trigger the synchronous delegation flow
	 * (which would otherwise abort/rehydrate the parent). The flag is persisted
	 * onto the task's `HistoryItem.isBackground` from the very first save.
	 */
	isBackground?: boolean
	/** Whether to start the task loop immediately (default: true).
	 *  When false, the caller must invoke `task.start()` manually. */
	startTask?: boolean
	/**
	 * Whether to push the created task onto the provider stack and focus it.
	 * Defaults to true. Set to false for background-only task creation.
	 */
	openInStack?: boolean
	/**
	 * When true, skip the single-open-task invariant (don't remove/abort the current task).
	 * Used for parallel task creation where multiple tasks run simultaneously.
	 */
	keepCurrentTask?: boolean
	/**
	 * Working directory for the new task. When set (e.g., for embedded worktree
	 * tasks), overrides the default workspace root as the task's CWD for tool
	 * invocations, file path resolution, and git operations.
	 *
	 * Defaults to the workspace root.
	 */
	cwd?: string
	/**
	 * Maximum characters the parent will accept as the completion result.
	 * The subtask MUST keep its attempt_completion result within this limit.
	 * If unset, no result length constraint is applied.
	 */
	softResultLength?: number
	/**
	 * Soft guidance (in seconds) for how long the parent expects to wait.
	 * Not a hard deadline; the parent may wait longer and the child may take longer.
	 * Informational only — used to guide the subtask's pacing.
	 */
	softTimeoutSec?: number
}

export enum TaskStatus {
	Running = "running",
	Interactive = "interactive",
	Resumable = "resumable",
	Idle = "idle",
	None = "none",
}

export type BackgroundTaskStatus =
	| "starting"
	| "running"
	| "waiting"
	| "waiting_for_parent"
	| "completed"
	| "error"
	| "cancelled"
	| "paused"

export interface TaskHandle {
	taskId: string
	status: BackgroundTaskStatus
	createdAt: number
	parentTaskId: string
}

/**
 * Read-only view of a question that a background child task routed up to
 * its parent via `ask_followup_question`. Consumers (CheckTaskStatusTool,
 * WaitForTaskTool, AnswerSubtaskQuestionTool) read this; only the child's
 * Task instance produces it.
 */
export interface PendingParentQuestionInfo {
	question: string
	suggestions: Array<{ answer: string; mode?: string }>
}

export const taskMetadataSchema = z.object({
	task: z.string().optional(),
	images: z.array(z.string()).optional(),
})

export type TaskMetadata = z.infer<typeof taskMetadataSchema>

export interface TaskLike {
	readonly taskId: string
	readonly rootTaskId?: string
	readonly parentTaskId?: string
	readonly childTaskId?: string
	readonly metadata: TaskMetadata
	readonly taskStatus: TaskStatus
	readonly taskAsk: ShoferMessage | undefined
	readonly queuedMessages: QueuedMessage[]
	readonly tokenUsage: TokenUsage | undefined

	on<K extends keyof TaskEvents>(event: K, listener: (...args: TaskEvents[K]) => void | Promise<void>): this
	off<K extends keyof TaskEvents>(event: K, listener: (...args: TaskEvents[K]) => void | Promise<void>): this

	approveAsk(options?: { text?: string; images?: string[] }): void
	denyAsk(options?: { text?: string; images?: string[] }): void
	submitUserMessage(text: string, images?: string[], mode?: string, providerProfile?: string): Promise<void>
	abortTask(): void
}

export type TaskEvents = {
	// Task Lifecycle
	[ShoferEventName.TaskStarted]: []
	[ShoferEventName.TaskCompleted]: [
		taskId: string,
		tokenUsage: TokenUsage,
		toolUsage: ToolUsage,
		info: TaskCompletedInfo,
	]
	[ShoferEventName.TaskAborted]: [info: TaskAbortedInfo]
	[ShoferEventName.TaskError]: [taskId: string, errorType: string]
	[ShoferEventName.TaskFocused]: []
	[ShoferEventName.TaskUnfocused]: []
	[ShoferEventName.TaskActive]: [taskId: string]
	[ShoferEventName.TaskInteractive]: [taskId: string]
	[ShoferEventName.TaskResumable]: [taskId: string]
	[ShoferEventName.TaskIdle]: [taskId: string]

	// Subtask Lifecycle
	[ShoferEventName.TaskPaused]: [taskId: string]
	[ShoferEventName.TaskUnpaused]: [taskId: string]
	[ShoferEventName.TaskSpawned]: [taskId: string]

	// Task Execution
	[ShoferEventName.Message]: [{ action: "created" | "updated"; message: ShoferMessage }]
	[ShoferEventName.TaskModeSwitched]: [taskId: string, mode: string]
	[ShoferEventName.TaskAskResponded]: []
	[ShoferEventName.TaskUserMessage]: [taskId: string]
	[ShoferEventName.QueuedMessagesUpdated]: [taskId: string, messages: QueuedMessage[]]

	// Task Analytics
	[ShoferEventName.TaskToolFailed]: [taskId: string, tool: ToolName, error: string]
	[ShoferEventName.TaskTokenUsageUpdated]: [taskId: string, tokenUsage: TokenUsage, toolUsage: ToolUsage]
}
