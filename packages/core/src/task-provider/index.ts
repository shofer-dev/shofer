import type {
	ExtensionState,
	ExtensionMessage,
	Envelope,
	HistoryItem,
	TaskState,
	TaskLike,
	TaskProviderEvents,
	ManagedTask,
	TaskManagerEvents,
	CreateTaskOptions,
	ShoferSettings,
} from "@shofer/types"

/**
 * The (browser+node-safe) slice of the concrete `ContextProxy` the Task-cluster
 * tools read off the provider. Typed narrowly here so the tools never import the
 * VS Code-coupled `ContextProxy` class. `globalStorageUri` is modelled as just
 * its `.fsPath` (a `vscode.Uri` satisfies this structurally).
 */
export interface ContextProxyLike {
	getValue<K extends keyof ShoferSettings>(key: K): ShoferSettings[K]
	readonly globalStorageUri: { readonly fsPath: string }
}

/**
 * The narrow slice of the concrete `TaskHistoryStore` the tools read off the
 * provider (lookups over the persisted task history). Mirrors the concrete
 * synchronous cache accessors.
 */
export interface TaskHistoryStoreLike {
	get(taskId: string): HistoryItem | undefined
	getAll(): HistoryItem[]
}

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
	/** Narrow settings/storage accessor (the concrete `ContextProxy`). */
	readonly contextProxy: ContextProxyLike
	/** Persisted task-history store (narrow read surface). */
	readonly taskHistoryStore: TaskHistoryStoreLike
	/** Workspace root the provider is anchored to (used to locate project MCP config). */
	readonly cwd: string

	getState(): Promise<TaskProviderState>

	/**
	 * Create (and start) a new task, optionally as a child of `parentTask`.
	 * Mirrors `ShoferProvider.createTask`.
	 */
	createTask(
		text?: string,
		images?: string[],
		parentTask?: TTask,
		options?: CreateTaskOptions,
		configuration?: ShoferSettings,
		cwd?: string,
	): Promise<TTask>
	/** Rehydrate a task from a persisted `HistoryItem`. Mirrors `ShoferProvider.createTaskWithHistoryItem`. */
	createTaskWithHistoryItem(
		historyItem: HistoryItem & { rootTask?: TTask; parentTask?: TTask },
		options?: { startTask?: boolean; keepCurrentTask?: boolean; maxMessages?: number },
	): Promise<TTask>
	/** Cancel the current (foreground) task. */
	cancelTask(): Promise<void>

	/** Register a resolver that a blocking foreground child fires on completion. */
	registerBlockingChildResolver(childTaskId: string, resolver: (result: string) => void): void
	/**
	 * Deliver an envelope into a task's mailbox — the one door every plane's
	 * inbound delivery reaches. Hands to a live instance, else rehydrates a
	 * dormant one; resolves once the envelope is durable and THROWS when there is
	 * nobody to deliver to (no history, or an `error` lifecycle). Mirrors
	 * `ShoferProvider.deliverToTask`.
	 */
	deliverToTask(taskId: string, envelope: Envelope): Promise<Envelope>
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
	/**
	 * Rename a managed task in the provider's task history. `source` records who
	 * set the title ('user' rename vs the agent's set_task_title) so a human
	 * rename is not overwritten by the agent — see HistoryItem.titleSource.
	 */
	renameManagedTask(taskId: string, name: string, source?: "user" | "agent"): void
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

	/** Look up the in-memory record for a managed task. */
	getManagedTask(taskId: string): ManagedTask | undefined
	/** All managed tasks, most-recently-active first. */
	getManagedTasks(): ManagedTask[]
	/** Count of non-terminal, non-idle managed tasks (running or waiting). */
	countActiveTasks(): number
	/** Register an existing task as a background managed task. */
	registerBackgroundTask(task: TTask, name?: string): void

	on<K extends keyof TaskManagerEvents>(
		event: K,
		listener: (...args: TaskManagerEvents[K]) => void | Promise<void>,
	): this
	off<K extends keyof TaskManagerEvents>(
		event: K,
		listener: (...args: TaskManagerEvents[K]) => void | Promise<void>,
	): this
	emit<K extends keyof TaskManagerEvents>(event: K, ...args: TaskManagerEvents[K]): boolean
}
