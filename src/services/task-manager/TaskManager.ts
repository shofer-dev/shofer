import EventEmitter from "events"

import type {
	TaskState,
	TaskLifecycle,
	HistoryItem,
	ToolName,
	TokenUsage,
	ToolUsage,
	TaskCompletedInfo,
	TaskAbortedInfo,
} from "@shofer/types"
import { ShoferEventName, isTerminalLifecycle, IDLE_TASK_STATE } from "@shofer/types"

import type { Task } from "../../core/task/Task"
import { taskLog } from "../../utils/logging/subsystems"
import type { ShoferProvider } from "../../core/webview/ShoferProvider"
import { incTaskCreated, incTaskCompleted, incTaskErrored } from "../../metrics/registry"

interface ManagedTaskNotification {
	targetTaskId: string
	type: "needs_input" | "completed" | "error" | "file_conflict"
	message: string
	timestamp: number
}

/**
 * ManagedTask: in-memory record of a task and its current execution state.
 *
 * `state` is the *single authoritative source* for the task's runtime
 * lifecycle/rating. The persisted `HistoryItem.taskState` is a snapshot
 * written exclusively through `TaskManager.persistState`.
 */
export interface ManagedTask {
	id: string
	name: string
	taskId: string
	workspace: string
	createdAt: number
	lastActiveAt: number
	state: TaskState
}

/**
 * TaskManager events.
 */
export interface TaskManagerEvents {
	"managedTask:state-changed": [targetTaskId: string, state: TaskState]
	"managedTask:needs-input": [notification: ManagedTaskNotification]
	/**
	 * Emitted when a background child task routes a question up to its parent
	 * via `ask_followup_question`. The parent's `wait_for_task` tool listens
	 * for this so it can wake up and surface the question to the LLM instead
	 * of blocking on a non-existent terminal transition.
	 */
	"managedTask:needs-parent-input": [targetTaskId: string, question: string]
	"managedTask:completed": [targetTaskId: string]
	"managedTask:error": [targetTaskId: string, error: string]
	"managedTask:tool-error": [targetTaskId: string, error: string]
	"tasks:updated": [managedTasks: ManagedTask[]]
}

/**
 * TaskManager handles multiple concurrent tasks.
 *
 * The manager is the single authority for task lifecycle/rating state. It:
 *   1. Listens to `Task` events and translates them into `ManagedTask.state`.
 *   2. Persists state changes through to `HistoryItem.taskState` (single
 *      writer — no other component is allowed to write `taskState`).
 *   3. Hydrates from the persisted history at startup so that re-visiting a
 *      task after a restart shows the correct icon immediately.
 */
export class TaskManager extends EventEmitter<TaskManagerEvents> {
	private activeTasks: Map<string, Task> = new Map()
	private focusedTaskId: string | null = null
	private notifications: ManagedTaskNotification[] = []
	private managedTasks: Map<string, ManagedTask> = new Map()

	/** Set to true once `restoreManagedTasks` (or an explicit empty restore) has run. */
	private restored = false

	private providerRef: WeakRef<ShoferProvider>

	/**
	 * Per-task persist queue.  Each fire-and-forget persistState call chains
	 * onto the previous one so writes for the same task are serialized — the
	 * second write can never land before the first one.
	 *
	 * Without this, a fire-and-forget `completed+rating` write launched by
	 * `attempt_completion` → `TaskCompleted` can land AFTER a subsequent
	 * `running` write from `TaskActive` → `cancelAndProcessQueuedMessages`,
	 * leaving the stale rated state on disk after a restart.
	 */
	private persistChains: Map<string, Promise<void>> = new Map()

	constructor(provider: ShoferProvider) {
		super()
		this.providerRef = new WeakRef(provider)
	}

	// ────────────────────────────── State helpers ──────────────────────────────

	/**
	 * Build a new TaskState. Use this rather than instantiating literals so
	 * the lifecycle/rating invariant (rating only valid when completed) is
	 * enforced in one place.
	 */
	private static makeState(lifecycle: TaskLifecycle, rating?: TaskState["rating"]): TaskState {
		if (lifecycle === "completed" && rating) return { lifecycle, rating }
		return { lifecycle }
	}

	private static statesEqual(a: TaskState | undefined, b: TaskState | undefined): boolean {
		if (a === b) return true
		if (!a || !b) return false
		return a.lifecycle === b.lifecycle && a.rating === b.rating
	}

	// ────────────────────────────── Lifecycle ──────────────────────────────

	async createManagedTask(name: string | undefined, task: Task): Promise<ManagedTask> {
		const managedTask: ManagedTask = {
			id: task.taskId,
			name: name || "New Task",
			taskId: task.taskId,
			workspace: task.cwd || "",
			createdAt: Date.now(),
			lastActiveAt: Date.now(),
			state: TaskManager.makeState("running"),
		}

		this.managedTasks.set(managedTask.id, managedTask)
		this.activeTasks.set(managedTask.id, task)
		this.setupManagedTaskEventListeners(task)
		await this.focusTask(managedTask.id)
		this.emit("tasks:updated", this.getManagedTasks())
		this._emitTaskCreatedMetric(task)
		return managedTask
	}

	/**
	 * Register an existing Task as a background managed task.
	 *
	 * `restoreManagedTasks` MUST have been called at least once before this
	 * method is reached for any rehydrated task — otherwise the heuristic
	 * fallback below would mis-classify resumed tasks as freshly running.
	 * The provider enforces this ordering via `initializeTaskHistoryStore`.
	 */
	registerBackgroundTask(task: Task, name?: string): void {
		this.assertRestored("registerBackgroundTask")

		const existingActive = this.activeTasks.get(task.taskId)
		if (existingActive) {
			this.cleanupTaskEventListeners(existingActive)
			this.activeTasks.set(task.taskId, task)
			this.setupManagedTaskEventListeners(task)
			this._emitTaskCreatedMetric(task)
			return
		}

		const existing = this.managedTasks.get(task.taskId)

		const taskText = task.shoferMessages.find((m) => m.type === "say" && m.say === "text")?.text || ""
		const autoName =
			name || (taskText ? taskText.slice(0, 50).trim() + (taskText.length > 50 ? "..." : "") : "New Task")

		// Fallback only fires for genuinely new tasks (no persisted history).
		// For rehydrated tasks `existing` was seeded by restoreManagedTasks.
		const state = existing?.state ?? TaskManager.makeState(task.abandoned || task.abort ? "idle" : "running")

		const managedTask: ManagedTask = {
			id: task.taskId,
			name: existing?.name ?? autoName,
			taskId: task.taskId,
			workspace: task.cwd || "",
			createdAt: existing?.createdAt ?? Date.now(),
			lastActiveAt: Date.now(),
			state,
		}

		this.managedTasks.set(managedTask.id, managedTask)
		this.activeTasks.set(managedTask.id, task)
		this.setupManagedTaskEventListeners(task)
		this.emit("tasks:updated", this.getManagedTasks())
	}

	private cleanupTaskEventListeners(task: Task): void {
		const cleanupSymbol = Symbol.for("taskManager.cleanup")
		const cleanup = (task as any)[cleanupSymbol]
		if (typeof cleanup === "function") {
			cleanup()
			delete (task as any)[cleanupSymbol]
		}
	}

	updateTaskInstance(targetTaskId: string, newTask: Task): void {
		const managedTask = this.managedTasks.get(targetTaskId)
		if (!managedTask) {
			return
		}

		const oldTask = this.activeTasks.get(targetTaskId)
		if (oldTask) {
			this.cleanupTaskEventListeners(oldTask)
		}

		this.activeTasks.set(targetTaskId, newTask)
		this.setupManagedTaskEventListeners(newTask)
	}

	async deleteManagedTask(targetTaskId: string): Promise<void> {
		const task = this.activeTasks.get(targetTaskId)
		if (task) {
			this.cleanupTaskEventListeners(task)
			await task.abortTask(true).catch(() => {})
			this.activeTasks.delete(targetTaskId)
		}

		this.managedTasks.delete(targetTaskId)
		this.notifications = this.notifications.filter((n) => n.targetTaskId !== targetTaskId)

		if (this.focusedTaskId === targetTaskId) {
			this.focusedTaskId = null
		}

		this.emit("tasks:updated", this.getManagedTasks())
	}

	// ────────────────────────────── Focus Management ──────────────────────────────

	async focusTask(targetTaskId: string): Promise<void> {
		const managedTask = this.managedTasks.get(targetTaskId)
		if (!managedTask) {
			throw new Error(`Task ${targetTaskId} not found`)
		}

		if (this.focusedTaskId) {
			const prevManagedTask = this.managedTasks.get(this.focusedTaskId)
			if (prevManagedTask) {
				prevManagedTask.lastActiveAt = Date.now()
			}
		}

		this.focusedTaskId = targetTaskId
		managedTask.lastActiveAt = Date.now()

		this.notifications = this.notifications.filter((n) => n.targetTaskId !== targetTaskId)

		this.emit("managedTask:state-changed", targetTaskId, managedTask.state)
		this.emit("tasks:updated", this.getManagedTasks())
	}

	getFocusedTask(): ManagedTask | null {
		if (!this.focusedTaskId) {
			return null
		}
		return this.managedTasks.get(this.focusedTaskId) || null
	}

	getFocusedTaskId(): string | null {
		return this.focusedTaskId
	}

	/**
	 * Clear the focused task if it currently matches `targetTaskId`.
	 *
	 * Called when a task is removed from the visible UI stack without being
	 * aborted (parallel-task switch via the pencil/+ button). Without this,
	 * the popped task keeps satisfying the `getFocusedTaskId() === taskId`
	 * branch in `Task.addToShoferMessages` and continues streaming
	 * `shoferMessageAppended` deltas to the webview, which re-mounts
	 * ChatView for the supposedly-backgrounded task.
	 */
	clearFocusIfMatches(targetTaskId: string): void {
		if (this.focusedTaskId === targetTaskId) {
			this.focusedTaskId = null
		}
	}

	// ────────────────────────────── Execution Control ──────────────────────────────

	async startManagedTask(targetTaskId: string): Promise<void> {
		const managedTask = this.managedTasks.get(targetTaskId)
		if (!managedTask) {
			throw new Error(`Task ${targetTaskId} not found`)
		}

		const task = this.activeTasks.get(targetTaskId)
		if (!task) {
			throw new Error(`Task for managed task ${targetTaskId} not found`)
		}

		this.setState(targetTaskId, TaskManager.makeState("running"))
	}

	async pauseManagedTask(targetTaskId: string): Promise<void> {
		const managedTask = this.managedTasks.get(targetTaskId)
		if (!managedTask) {
			throw new Error(`Task ${targetTaskId} not found`)
		}

		const task = this.activeTasks.get(targetTaskId)
		if (task) {
			task.cancelCurrentRequest()
			await task.abortTask(false).catch(() => {})
		}

		this.setState(targetTaskId, TaskManager.makeState("paused"))
	}

	async stopManagedTask(targetTaskId: string): Promise<void> {
		const managedTask = this.managedTasks.get(targetTaskId)
		if (!managedTask) {
			throw new Error(`Task ${targetTaskId} not found`)
		}

		const task = this.activeTasks.get(targetTaskId)
		if (task) {
			await task.abortTask(true).catch(() => {})
		}

		this.setState(targetTaskId, IDLE_TASK_STATE)
	}

	// ────────────────────────────── Queries ──────────────────────────────

	getManagedTasks(): ManagedTask[] {
		return Array.from(this.managedTasks.values()).sort((a, b) => b.lastActiveAt - a.lastActiveAt)
	}

	getActiveManagedTasks(): ManagedTask[] {
		return this.getManagedTasks().filter((s) => this.activeTasks.has(s.id))
	}

	getBackgroundTasks(): ManagedTask[] {
		return this.getActiveManagedTasks().filter((s) => s.id !== this.focusedTaskId)
	}

	getTaskState(targetTaskId: string): TaskState | undefined {
		return this.managedTasks.get(targetTaskId)?.state
	}

	getManagedTask(targetTaskId: string): ManagedTask | undefined {
		return this.managedTasks.get(targetTaskId)
	}

	getManagedTaskInstance(targetTaskId: string): Task | undefined {
		return this.activeTasks.get(targetTaskId)
	}

	removeManagedTaskInstance(targetTaskId: string): void {
		const task = this.activeTasks.get(targetTaskId)
		if (task) {
			this.cleanupTaskEventListeners(task)
		}
		this.activeTasks.delete(targetTaskId)
	}

	// ────────────────────────────── Notifications ──────────────────────────────

	getNotifications(): ManagedTaskNotification[] {
		return [...this.notifications]
	}

	clearTaskNotification(targetTaskId: string): void {
		this.notifications = this.notifications.filter((n) => n.targetTaskId !== targetTaskId)
	}

	private addNotification(notification: ManagedTaskNotification): void {
		const existing = this.notifications.find(
			(n) => n.targetTaskId === notification.targetTaskId && n.type === notification.type,
		)
		if (!existing) {
			this.notifications.push(notification)
			this.emit("managedTask:needs-input", notification)
		}
	}

	// ────────────────────────────── State Mutation (single writer) ──────────────────────────────

	/**
	 * Set the in-memory state and persist it through to the HistoryItem.
	 *
	 * This is the ONLY method that writes `HistoryItem.taskState`. No other
	 * component should set `taskState` directly — they must go through
	 * TaskManager (typically via events).
	 */
	setState(targetTaskId: string, state: TaskState): void {
		const managedTask = this.managedTasks.get(targetTaskId)
		if (!managedTask) {
			return
		}

		const prevState = managedTask.state
		if (TaskManager.statesEqual(prevState, state)) return

		managedTask.state = state
		this.emit("managedTask:state-changed", targetTaskId, state)
		this.emit("tasks:updated", this.getManagedTasks())
		this.enqueuePersist(targetTaskId, state)
	}

	private async persistState(targetTaskId: string, state: TaskState): Promise<void> {
		const provider = this.providerRef.deref()
		if (!provider) return
		try {
			const existing = provider.taskHistoryStore.get(targetTaskId)
			if (!existing) return
			if (TaskManager.statesEqual(existing.taskState, state)) return
			// Write only { id, taskState } — do NOT spread the stale in-memory
			// snapshot.  TaskHistoryStore.upsert() merges { ...existing, ...item }
			// so passing just the fields we intend to update is safe and avoids
			// the "spread stale state" anti-pattern that caused the race in
			// Phase 1 of state_simplification.md.
			await provider.updateTaskHistory({
				id: targetTaskId,
				taskState: state,
			} as HistoryItem)
		} catch (err) {
			taskLog.error(
				`[TaskManager] Failed to persist taskState for ${targetTaskId}:`,
				err instanceof Error ? err.message : String(err),
			)
		}
	}

	/**
	 * Fire-and-forget persist that is serialized per task.
	 *
	 * Without chaining, two fire-and-forget writes for the same task can land
	 * out of order: a `completed+rating` write from `attempt_completion` can
	 * overwrite a later `running` write from `cancelAndProcessQueuedMessages`
	 * if the I/O scheduler delivers them backwards.  Chaining onto the previous
	 * promise guarantees the second write always lands after the first.
	 */
	private enqueuePersist(targetTaskId: string, state: TaskState): void {
		const prev = this.persistChains.get(targetTaskId) ?? Promise.resolve()
		const next = prev.then(() => this.persistState(targetTaskId, state))
		// Prune the chain once it settles so the map doesn't grow unbounded.
		next.finally(() => {
			if (this.persistChains.get(targetTaskId) === next) {
				this.persistChains.delete(targetTaskId)
			}
		})
		this.persistChains.set(targetTaskId, next)
	}

	renameManagedTask(targetTaskId: string, name: string): void {
		const managedTask = this.managedTasks.get(targetTaskId)
		if (managedTask) {
			managedTask.name = name
			this.emit("tasks:updated", this.getManagedTasks())
		}
	}

	// ────────────────────────────── Task Event Handling ──────────────────────────────

	/**
	 * Translate Task events into `ManagedTask.state` updates.
	 *
	 * Each Task event is self-contained — `TaskCompleted` carries the rating,
	 * `TaskAborted` carries the abort reason — so the manager never needs to
	 * read state back from disk to interpret an event.
	 */
	private setupManagedTaskEventListeners(task: Task): void {
		const targetTaskId = task.taskId

		const onStarted = () => {
			this.setState(targetTaskId, TaskManager.makeState("running"))
		}

		const onInteractive = (taskId: string) => {
			if (taskId !== targetTaskId) return
			this.setState(targetTaskId, TaskManager.makeState("waiting_input"))

			if (this.focusedTaskId !== targetTaskId) {
				this.addNotification({
					targetTaskId,
					type: "needs_input",
					message: "Task needs your approval to continue",
					timestamp: Date.now(),
				})
			}
		}

		const onActive = (taskId: string) => {
			if (taskId !== targetTaskId) return
			this.setState(targetTaskId, TaskManager.makeState("running"))
		}

		const onIdle = (taskId: string) => {
			if (taskId !== targetTaskId) return
			this.setState(targetTaskId, IDLE_TASK_STATE)
		}

		const onComplete = (
			taskId: string,
			_tokenUsage: TokenUsage,
			_toolUsage: ToolUsage,
			info: TaskCompletedInfo,
		) => {
			if (taskId !== targetTaskId) return
			this.setState(targetTaskId, TaskManager.makeState("completed", info.rating))
			this._emitTaskCompletedMetric(targetTaskId, info.rating)
			this.emit("managedTask:completed", targetTaskId)
		}

		const onToolError = (taskId: string, _tool: ToolName, error: string) => {
			if (taskId !== targetTaskId) return
			this.emit("managedTask:tool-error", targetTaskId, error)
		}

		const onAborted = (info: TaskAbortedInfo) => {
			// Reason-driven mapping — no peeking at current state.
			switch (info.reason) {
				case "completed":
				case "error":
					// Terminal outcome was already set by the originating event;
					// the abort here is just cleanup.
					return
				case "user":
				case "abandoned":
					this.setState(targetTaskId, TaskManager.makeState("paused"))
					return
			}
		}

		const onTaskError = (taskId: string, errorType: string) => {
			if (taskId !== targetTaskId) return
			this.setState(targetTaskId, TaskManager.makeState("error"))
			this._emitTaskErroredMetric(targetTaskId, errorType)
		}

		task.on(ShoferEventName.TaskStarted, onStarted)
		task.on(ShoferEventName.TaskInteractive, onInteractive)
		task.on(ShoferEventName.TaskActive, onActive)
		task.on(ShoferEventName.TaskIdle, onIdle)
		task.on(ShoferEventName.TaskCompleted, onComplete)
		task.on(ShoferEventName.TaskToolFailed, onToolError)
		task.on(ShoferEventName.TaskAborted, onAborted)
		task.on(ShoferEventName.TaskError, onTaskError)

		const cleanup = () => {
			task.off(ShoferEventName.TaskStarted, onStarted)
			task.off(ShoferEventName.TaskInteractive, onInteractive)
			task.off(ShoferEventName.TaskActive, onActive)
			task.off(ShoferEventName.TaskIdle, onIdle)
			task.off(ShoferEventName.TaskCompleted, onComplete)
			task.off(ShoferEventName.TaskToolFailed, onToolError)
			task.off(ShoferEventName.TaskAborted, onAborted)
			task.off(ShoferEventName.TaskError, onTaskError)
		}

		const cleanupSymbol = Symbol.for("taskManager.cleanup")
		;(task as any)[cleanupSymbol] = cleanup
	}

	// ────────────────────────────── HistoryItem Integration ──────────────────────────────

	managedTaskToHistoryItem(
		managedTask: ManagedTask,
		task: string,
		tokensIn: number,
		tokensOut: number,
		totalCost: number,
	): HistoryItem {
		return {
			id: managedTask.taskId,
			number: 0,
			ts: managedTask.createdAt,
			task,
			tokensIn,
			tokensOut,
			totalCost,
			workspace: managedTask.workspace,
			name: managedTask.name,
			lastActiveTs: managedTask.lastActiveAt,
			taskState: managedTask.state,
		}
	}

	// ────────────────────────────── Cleanup ──────────────────────────────

	async dispose(): Promise<void> {
		for (const [_targetTaskId, task] of this.activeTasks) {
			this.cleanupTaskEventListeners(task)
			await task.abortTask(true).catch(() => {})
		}
		this.activeTasks.clear()
		this.managedTasks.clear()
		this.notifications = []
		this.focusedTaskId = null
		this.removeAllListeners()
	}

	// ────────────────────────────── Restore ordering ──────────────────────────────

	/**
	 * Seed `managedTasks` from persisted history. MUST be called once before
	 * any task is registered so the in-memory map can supply correct state for
	 * rehydrated tasks. Calling more than once is a no-op after the first call.
	 */
	async restoreManagedTasks(historyItems: HistoryItem[]): Promise<void> {
		if (this.restored) return
		this.restored = true

		for (const item of historyItems) {
			if (!item.id) continue
			const managedTask: ManagedTask = {
				id: item.id,
				name:
					item.name ||
					(item.task
						? item.task.slice(0, 50).trim() + (item.task.length > 50 ? "..." : "")
						: `Task ${item.number}`),
				taskId: item.id,
				workspace: item.workspace || "",
				createdAt: item.ts,
				lastActiveAt: item.lastActiveTs || item.ts,
				state: TaskManager.sanitizeRestoredState(item.taskState),
			}
			this.managedTasks.set(managedTask.id, managedTask)
		}
		this.emit("tasks:updated", this.getManagedTasks())
	}

	private assertRestored(method: string): void {
		if (!this.restored) {
			throw new Error(
				`[TaskManager] ${method}() called before restoreManagedTasks(). ` +
					`The provider must call restoreManagedTasks() during startup.`,
			)
		}
	}

	/**
	 * Resolve an in-memory state from a persisted snapshot.
	 *
	 * Transient lifecycles (`running`, `waiting_input`, `waiting`) imply
	 * in-flight work, which cannot survive a restart — downgrade them to
	 * `idle`. Terminal lifecycles (`completed` with rating, `error`, `paused`)
	 * are preserved.
	 */
	private static sanitizeRestoredState(state: TaskState | undefined): TaskState {
		if (!state) return IDLE_TASK_STATE
		if (state.lifecycle === "running" || state.lifecycle === "waiting_input" || state.lifecycle === "waiting")
			return IDLE_TASK_STATE
		if (isTerminalLifecycle(state.lifecycle) || state.lifecycle === "idle") return state
		return IDLE_TASK_STATE
	}

	// ──────────────────────── Metric helpers ────────────────────────

	private _getTaskMode(taskId: string): string {
		const task = this.activeTasks.get(taskId)
		if (!task) return "unknown"
		try {
			return task.taskMode
		} catch {
			return "unknown"
		}
	}

	private _emitTaskCreatedMetric(task: Task): void {
		try {
			incTaskCreated(task.taskMode)
		} catch {
			incTaskCreated("unknown")
		}
	}

	private _emitTaskCompletedMetric(taskId: string, rating: string): void {
		incTaskCompleted(this._getTaskMode(taskId), rating)
	}

	private _emitTaskErroredMetric(taskId: string, errorType: string): void {
		incTaskErrored(this._getTaskMode(taskId), errorType)
	}
}
