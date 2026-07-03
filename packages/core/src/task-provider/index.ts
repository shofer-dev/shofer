import type {
	ExtensionState,
	ExtensionMessage,
	HistoryItem,
	TaskState,
	TaskLike,
	TaskProviderEvents,
} from "@shofer/types"

// Type-only import: `McpHub` lives in `@shofer/core` (portable, Node-only). The
// import is `type`-only so it never creates a runtime cycle
// (McpHub → TaskProviderLike → McpHub).
import type { McpHub } from "../services/mcp/McpHub.js"

/**
 * TaskProviderLike — the narrow provider surface the portable {@link Task} core
 * depends on.
 *
 * The concrete VS Code implementation is the Category II `ShoferProvider`
 * (webview provider), which lives in the extension `src` and must NOT be
 * imported by the core. This interface captures ONLY the members `Task`
 * actually calls on its provider, which lets `Task` hold a
 * `WeakRef<TaskProviderLike>` and drop its concrete `ShoferProvider` import —
 * breaking the Task ↔ ShoferProvider ↔ TaskManager circularity so `Task` can
 * relocate into `@shofer/core`.
 *
 * It is generic over the concrete task type (`TTask`). Inside `@shofer/core`
 * the default is the host-agnostic {@link TaskLike}; the extension instantiates
 * it as `TaskProviderLike<Task>` so its own call sites keep the precise `Task`
 * type (e.g. `handleModeSwitch(mode, this)`, `getManagedTaskInstance(id)`).
 *
 * `context` is deliberately typed `unknown`: the concrete provider hands the
 * core a `vscode.ExtensionContext`, but that platform type must never surface in
 * a core interface. The (Category II) call sites that need the real type cast at
 * the boundary.
 */
export interface TaskProviderLike<TTask = TaskLike> {
	/** Opaque host context (a `vscode.ExtensionContext` in the VS Code front-end). */
	readonly context: unknown
	readonly taskManager: TaskManagerLike<TTask>
	/** Workspace root the provider is anchored to (used to locate project MCP config). */
	readonly cwd: string

	getState(): Promise<TaskProviderState>
	/** Returns the provider's MCP hub, or `undefined` when MCP is unavailable. */
	getMcpHub(): McpHub | undefined
	/** Ensures the global MCP servers directory exists and returns its path. */
	ensureMcpServersDirectoryExists(): Promise<string>
	/** Ensures the settings directory exists and returns its path. */
	ensureSettingsDirectoryExists(): Promise<string>
	log(message: string): void
	postMessageToWebview(message: ExtensionMessage): Promise<void>
	getTaskWithId(id: string, opts?: { skipApiHistory?: boolean }): Promise<{ historyItem: HistoryItem }>
	updateTaskHistory(item: HistoryItem, options?: { broadcast?: boolean }): Promise<HistoryItem[]>
	getCurrentTask(): TTask | undefined
	handleModeSwitch(mode: string, sourceTask: TTask): Promise<void>
	setProviderProfile(name: string): Promise<void>
	/** Returns the Category II skills manager (typed opaquely in the core). */
	getSkillsManager(): unknown
	/** Resolve a filesystem path to a webview-safe URI string (for image tools). */
	convertToWebviewUri(filePath: string): string
	/** Rename a managed task in the provider's task history. */
	renameManagedTask(taskId: string, name: string): void
	/**
	 * Schedule a debounced "changed files" refresh for the given task's
	 * FileChangesPanel. Optional: headless hosts have no such panel.
	 */
	scheduleChangedFilesUpdate?(taskId: string): void
	postTaskStateUpdate(
		updates: Partial<
			Pick<
				ExtensionState,
				"currentTaskId" | "currentTaskItem" | "messageQueue" | "parallelTasks" | "focusedTaskId"
			>
		>,
	): void

	on<K extends keyof TaskProviderEvents>(
		event: K,
		listener: (...args: TaskProviderEvents[K]) => void | Promise<void>,
	): this
	off<K extends keyof TaskProviderEvents>(
		event: K,
		listener: (...args: TaskProviderEvents[K]) => void | Promise<void>,
	): this
}

/**
 * The subset of the concrete `getState()` result the core reads — mirrors the
 * `ShoferProvider.getState()` return type (the webview-only fields are stripped
 * before the state reaches the core).
 */
export type TaskProviderState = Omit<
	ExtensionState,
	"shoferMessages" | "renderContext" | "hasOpenedModeSelector" | "version" | "shouldShowAnnouncement"
>

/**
 * The narrow slice of the (vscode-free) `TaskManager` the core `Task` calls.
 * Generic over the concrete task type so the extension keeps precise `Task`
 * typing while the core defaults to {@link TaskLike}.
 */
export interface TaskManagerLike<TTask = TaskLike> {
	getFocusedTaskId(): string | null
	getManagedTaskInstance(taskId: string): TTask | undefined
	getTaskState(taskId: string): TaskState | undefined
	waitForPendingPersist(taskId: string): Promise<void>
	focusTask(taskId: string): Promise<void>
	/** Set the persisted lifecycle state of a managed task. */
	setState(targetTaskId: string, state: TaskState): void
}
