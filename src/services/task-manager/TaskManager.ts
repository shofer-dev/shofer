import EventEmitter from "events"

import type { TaskExecutionState, HistoryItem, ToolName, TokenUsage, ToolUsage } from "@shofer/types"
import { ShoferEventName } from "@shofer/types"

import type { Task } from "../../core/task/Task"
import type { ShoferProvider } from "../../core/webview/ShoferProvider"

/** Type aliases for managed task state and notifications. */
type ManagedTaskState = TaskExecutionState
interface ManagedTaskNotification {
	targetTaskId: string
	type: "needs_input" | "completed" | "error" | "file_conflict"
	message: string
	timestamp: number
}

/**
 * ManagedTask represents a task managed by the TaskManager.
 */
export interface ManagedTask {
	id: string
	name: string
	taskId: string
	workspace: string
	createdAt: number
	lastActiveAt: number
	state: ManagedTaskState
}

/**
 * TaskManager events.
 */
export interface TaskManagerEvents {
	"managedTask:state-changed": [targetTaskId: string, state: ManagedTaskState]
	"managedTask:needs-input": [notification: ManagedTaskNotification]
	"managedTask:completed": [targetTaskId: string]
	"managedTask:error": [targetTaskId: string, error: string]
	"managedTask:tool-error": [targetTaskId: string, error: string]
	"tasks:updated": [managedTasks: ManagedTask[]]
}

/**
 * Resource limits for concurrent tasks.
 */
export interface TaskResourceLimits {
	/** Maximum concurrent active tasks (default: 3) */
	maxConcurrentActive: number
	/** Maximum concurrent streaming tasks (default: 2) */
	maxConcurrentStreaming: number
	/** Auto-pause after N minutes of waiting in background (default: 30) */
	backgroundTimeout: number
}

/**
 * TaskManager handles multiple concurrent tasks.
 *
 * Key concepts:
 * - "Active tasks: Have a running Task instance (may be processing or waiting)
 * - "Focused" managedTask: The one currently displayed in the UI (receives user input)
 * - "Background tasks: Active but not focused (continue processing autonomously)
 *
 * LLM hint: This manager coordinates parallel task execution while maintaining
 * a single focused task for user interaction. Background tasks continue
 * processing autonomously and emit notifications when they need user input.
 */
export class TaskManager extends EventEmitter<TaskManagerEvents> {
	/** Multiple tasks can be "active" simultaneously */
	private activeTasks: Map<string, Task> = new Map()

	/** Only one task receives user input at a time */
	private focusedTaskId: string | null = null

	/** Notifications for background tasks needing attention */
	private notifications: ManagedTaskNotification[] = []

	/** ManagedTask metadata cache */
	private managedTasks: Map<string, ManagedTask> = new Map()

	/** Resource limits */
	private resourceLimits: TaskResourceLimits = {
		maxConcurrentActive: 3,
		maxConcurrentStreaming: 2,
		backgroundTimeout: 30,
	}

	/** Weak reference to provider for state updates */
	private providerRef: WeakRef<ShoferProvider>

	constructor(provider: ShoferProvider, limits?: Partial<TaskResourceLimits>) {
		super()
		this.providerRef = new WeakRef(provider)
		if (limits) {
			this.resourceLimits = { ...this.resourceLimits, ...limits }
		}
	}

	// ────────────────────────────── Lifecycle ──────────────────────────────

	/**
	 * Create a new task with an associated task.
	 *
	 * @param name Optional user-defined task name
	 * @param task The Task instance to associate with this task
	 * @returns The created ManagedTask
	 */
	async createManagedTask(name: string | undefined, task: Task): Promise<ManagedTask> {
		// Initial state is "running" since the task starts processing immediately
		// after creation. The TaskStarted event will confirm this once the API call begins.
		const managedTask: ManagedTask = {
			id: task.taskId,
			name: name || "New Task",
			taskId: task.taskId,
			workspace: task.cwd || "",
			createdAt: Date.now(),
			lastActiveAt: Date.now(),
			state: "running",
		}

		this.managedTasks.set(managedTask.id, managedTask)
		this.activeTasks.set(managedTask.id, task)

		// Set up task event listeners for background task handling
		this.setupManagedTaskEventListeners(task)

		// Focus the new task by default
		await this.focusTask(managedTask.id)

		this.emit("tasks:updated", this.getManagedTasks())
		return managedTask
	}

	/**
	 * Register an existing Task as a background managed task.
	 * Used when a previously focused task is moved to the background.
	 * If the task is already registered, this is a no-op.
	 *
	 * @param task The Task instance to register
	 * @param name Optional name (falls back to task text or generic name)
	 */
	registerBackgroundTask(task: Task, name?: string): void {
		const existingActive = this.activeTasks.get(task.taskId)
		if (existingActive) {
			// Already registered — update the Task instance but keep the state.
			this.cleanupTaskEventListeners(existingActive)
			this.activeTasks.set(task.taskId, task)
			this.setupManagedTaskEventListeners(task)
			return
		}

		// Check whether a managedTask already exists (e.g. surviving from
		// a previous stop/clear); preserve its state so the TaskSelector
		// doesn't flip back to "running" after a re-focus.
		const existing = this.managedTasks.get(task.taskId)

		const taskText = task.shoferMessages.find((m) => m.type === "say" && m.say === "text")?.text || ""
		const autoName =
			name || (taskText ? taskText.slice(0, 50).trim() + (taskText.length > 50 ? "..." : "") : "New Task")

		const managedTask: ManagedTask = {
			id: task.taskId,
			name: existing?.name ?? autoName,
			taskId: task.taskId,
			workspace: task.cwd || "",
			createdAt: existing?.createdAt ?? Date.now(),
			lastActiveAt: Date.now(),
			state: existing?.state ?? (task.abandoned || task.abort ? "idle" : "running"),
		}

		this.managedTasks.set(managedTask.id, managedTask)
		this.activeTasks.set(managedTask.id, task)

		// Set up task event listeners for background task handling
		this.setupManagedTaskEventListeners(task)

		this.emit("tasks:updated", this.getManagedTasks())
	}

	/**
	 * Clean up event listeners for a task.
	 */
	private cleanupTaskEventListeners(task: Task): void {
		const cleanupSymbol = Symbol.for("taskManager.cleanup")
		const cleanup = (task as any)[cleanupSymbol]
		if (typeof cleanup === "function") {
			cleanup()
			delete (task as any)[cleanupSymbol]
		}
	}

	/**
	 * Update the Task instance for a managed task (e.g., after rehydration).
	 * This removes event listeners from the old instance and sets up listeners
	 * on the new instance, then updates the activeTasks map.
	 *
	 * Note: Does NOT change the task state - let the task's natural event flow
	 * (TaskStarted, TaskInteractive, TaskIdle, etc.) determine the correct state.
	 *
	 * @param targetTaskId The task ID
	 * @param newTask The new Task instance
	 */
	updateTaskInstance(targetTaskId: string, newTask: Task): void {
		const managedTask = this.managedTasks.get(targetTaskId)
		if (!managedTask) {
			// Task not tracked by TaskManager, nothing to update
			return
		}

		const oldTask = this.activeTasks.get(targetTaskId)
		if (oldTask) {
			this.cleanupTaskEventListeners(oldTask)
		}

		this.activeTasks.set(targetTaskId, newTask)
		this.setupManagedTaskEventListeners(newTask)
	}

	/**
	 * Delete a task and clean up its resources.
	 */
	async deleteManagedTask(targetTaskId: string): Promise<void> {
		const task = this.activeTasks.get(targetTaskId)
		if (task) {
			// Clean up event listeners
			this.cleanupTaskEventListeners(task)
			// Stop the task if running
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

	/**
	 * Switch UI focus to a task without stopping background processing.
	 *
	 * @param targetTaskId The task to focus
	 */
	async focusTask(targetTaskId: string): Promise<void> {
		const managedTask = this.managedTasks.get(targetTaskId)
		if (!managedTask) {
			throw new Error(`Task ${targetTaskId} not found`)
		}

		// Update last active timestamp for previous focused task
		if (this.focusedTaskId) {
			const prevManagedTask = this.managedTasks.get(this.focusedTaskId)
			if (prevManagedTask) {
				prevManagedTask.lastActiveAt = Date.now()
			}
		}

		this.focusedTaskId = targetTaskId
		managedTask.lastActiveAt = Date.now()

		// Clear notifications for this task
		this.notifications = this.notifications.filter((n) => n.targetTaskId !== targetTaskId)

		this.emit("managedTask:state-changed", targetTaskId, managedTask.state)
		this.emit("tasks:updated", this.getManagedTasks())
	}

	/**
	 * Get the currently focused managedTask.
	 */
	getFocusedTask(): ManagedTask | null {
		if (!this.focusedTaskId) {
			return null
		}
		return this.managedTasks.get(this.focusedTaskId) || null
	}

	/**
	 * Get the focused task ID.
	 */
	getFocusedTaskId(): string | null {
		return this.focusedTaskId
	}

	// ────────────────────────────── Execution Control ──────────────────────────────

	/**
	 * Start or resume a task's processing.
	 */
	async startManagedTask(targetTaskId: string): Promise<void> {
		const managedTask = this.managedTasks.get(targetTaskId)
		if (!managedTask) {
			throw new Error(`Task ${targetTaskId} not found`)
		}

		const task = this.activeTasks.get(targetTaskId)
		if (!task) {
			throw new Error(`Task for managed task ${targetTaskId} not found`)
		}

		// Check resource limits
		const runningCount = Array.from(this.managedTasks.values()).filter((s) => s.state === "running").length
		if (runningCount >= this.resourceLimits.maxConcurrentActive) {
			throw new Error(`Maximum concurrent active tasks (${this.resourceLimits.maxConcurrentActive}) reached`)
		}

		this.updateTaskExecutionState(targetTaskId, "running")
	}

	/**
	 * Pause a task's processing (non-destructive).
	 * Cancels the in-flight HTTP request immediately so the API stream stops,
	 * then soft-aborts the task loop (abandoned=false) so task history is preserved
	 * and the task can be resumed later via focusTask / showTaskWithId.
	 */
	async pauseManagedTask(targetTaskId: string): Promise<void> {
		const managedTask = this.managedTasks.get(targetTaskId)
		if (!managedTask) {
			throw new Error(`Task ${targetTaskId} not found`)
		}

		const task = this.activeTasks.get(targetTaskId)
		if (task) {
			// Cancel the in-flight HTTP request before aborting the loop so that
			// the API stream stops immediately rather than draining to completion.
			task.cancelCurrentRequest()
			// Non-destructive abort - keeps task state (abandoned=false) so the
			// task can be resumed from history.
			await task.abortTask(false).catch(() => {})
		}

		this.updateTaskExecutionState(targetTaskId, "paused")
	}

	/**
	 * Stop a task completely (destructive abort).
	 */
	async stopManagedTask(targetTaskId: string): Promise<void> {
		const managedTask = this.managedTasks.get(targetTaskId)
		if (!managedTask) {
			throw new Error(`Task ${targetTaskId} not found`)
		}

		const task = this.activeTasks.get(targetTaskId)
		if (task) {
			await task.abortTask(true).catch(() => {})
		}

		this.updateTaskExecutionState(targetTaskId, "idle")
	}

	// ────────────────────────────── Queries ──────────────────────────────

	/**
	 * Get all managed tasks sorted by last active time.
	 */
	getManagedTasks(): ManagedTask[] {
		return Array.from(this.managedTasks.values()).sort((a, b) => b.lastActiveAt - a.lastActiveAt)
	}

	/**
	 * Get managed tasks that have active Task instances.
	 */
	getActiveManagedTasks(): ManagedTask[] {
		return this.getManagedTasks().filter((s) => this.activeTasks.has(s.id))
	}

	/**
	 * Get managed tasks that are active but not focused.
	 */
	getBackgroundTasks(): ManagedTask[] {
		return this.getActiveManagedTasks().filter((s) => s.id !== this.focusedTaskId)
	}

	/**
	 * Get the state of a specific managedTask.
	 */
	getTaskExecutionState(targetTaskId: string): ManagedTaskState | undefined {
		return this.managedTasks.get(targetTaskId)?.state
	}

	/**
	 * Get a task by ID.
	 */
	getManagedTask(targetTaskId: string): ManagedTask | undefined {
		return this.managedTasks.get(targetTaskId)
	}

	/**
	 * Get the Task instance for a managedTask.
	 */
	getManagedTaskInstance(targetTaskId: string): Task | undefined {
		return this.activeTasks.get(targetTaskId)
	}

	/**
	 * Remove a Task instance from activeTasks (e.g., when it's stale/aborted).
	 * Cleans up event listeners but does NOT delete the managedTask metadata.
	 */
	removeManagedTaskInstance(targetTaskId: string): void {
		const task = this.activeTasks.get(targetTaskId)
		if (task) {
			this.cleanupTaskEventListeners(task)
		}
		this.activeTasks.delete(targetTaskId)
	}

	// ────────────────────────────── Notifications ──────────────────────────────

	/**
	 * Get all pending notifications.
	 */
	getNotifications(): ManagedTaskNotification[] {
		return [...this.notifications]
	}

	/**
	 * Clear notifications for a specific task.
	 */
	clearTaskNotification(targetTaskId: string): void {
		this.notifications = this.notifications.filter((n) => n.targetTaskId !== targetTaskId)
	}

	/**
	 * Add a notification for a managedTask.
	 */
	private addNotification(notification: ManagedTaskNotification): void {
		// Avoid duplicate notifications
		const existing = this.notifications.find(
			(n) => n.targetTaskId === notification.targetTaskId && n.type === notification.type,
		)
		if (!existing) {
			this.notifications.push(notification)
			this.emit("managedTask:needs-input", notification)
		}
	}

	// ────────────────────────────── Managed Task State Management ──────────────────────────────

	/**
	 * Update the state of a managedTask.
	 *
	 * Side effect: persists the new state to the corresponding HistoryItem so that
	 * the icon shown in the Task Selector survives an extension/code-server restart.
	 * Persistence is fire-and-forget — failure to persist is non-fatal because the
	 * in-memory overlay is still authoritative for live UI updates.
	 */
	updateTaskExecutionState(targetTaskId: string, state: ManagedTaskState): void {
		const managedTask = this.managedTasks.get(targetTaskId)
		if (!managedTask) {
			return
		}

		const prevState = managedTask.state
		managedTask.state = state

		if (prevState !== state) {
			this.emit("managedTask:state-changed", targetTaskId, state)
			this.emit("tasks:updated", this.getManagedTasks())
			void this.persistTaskExecutionState(targetTaskId, state)
		}
	}

	/**
	 * Write the given execution state through to the persisted HistoryItem.
	 * No-op when the history item does not yet exist (the initial save will
	 * include `taskExecutionState` because `updateTaskInstance`/`createManagedTask`
	 * write it via `managedTaskToHistoryItem`).
	 */
	private async persistTaskExecutionState(targetTaskId: string, state: ManagedTaskState): Promise<void> {
		const provider = this.providerRef.deref()
		if (!provider) return
		try {
			const existing = provider.taskHistoryStore.get(targetTaskId)
			if (!existing) return
			if (existing.taskExecutionState === state) return
			await provider.updateTaskHistory({ ...existing, taskExecutionState: state })
		} catch (err) {
			// Non-fatal — UI overlay still works without persistence.
			console.error(
				`[TaskManager] Failed to persist taskExecutionState for ${targetTaskId}:`,
				err instanceof Error ? err.message : String(err),
			)
		}
	}

	/**
	 * Rename a managedTask.
	 */
	renameManagedTask(targetTaskId: string, name: string): void {
		const managedTask = this.managedTasks.get(targetTaskId)
		if (managedTask) {
			managedTask.name = name
			this.emit("tasks:updated", this.getManagedTasks())
		}
	}

	// ────────────────────────────── Task Event Handling ──────────────────────────────

	/**
	 * Set up event listeners for a task to handle background task events.
	 *
	 * LLM hint: This is the key integration point where Task events are
	 * translated into ManagedTask events. The Task emits events like TaskInteractive
	 * when it needs user approval, and we capture those to update task state
	 * and create notifications for background tasks.
	 */
	private setupManagedTaskEventListeners(task: Task): void {
		const targetTaskId = task.taskId

		// Handle task starting (first API call begins)
		const onStarted = () => {
			this.updateTaskExecutionState(targetTaskId, "running")
		}

		// Handle task needing user input (approval required)
		const onInteractive = (taskId: string) => {
			if (taskId !== targetTaskId) return
			this.updateTaskExecutionState(targetTaskId, "waiting_input")

			// Create notification for background tasks
			if (this.focusedTaskId !== targetTaskId) {
				this.addNotification({
					targetTaskId,
					type: "needs_input",
					message: "Task needs your approval to continue",
					timestamp: Date.now(),
				})
			}
		}

		// Handle task becoming active again (after approval)
		const onActive = (taskId: string) => {
			if (taskId !== targetTaskId) return
			this.updateTaskExecutionState(targetTaskId, "running")
		}

		// Handle task entering idle state (completion_result, api_req_failed, etc.)
		// This is emitted when the task reaches an idle ask state.
		const onIdle = (taskId: string) => {
			if (taskId !== targetTaskId) return
			this.updateTaskExecutionState(targetTaskId, "idle")
		}

		// Handle task completion — use whatever state is persisted (which may
		// be completed_poorly/well/excellent from AttemptCompletionTool, or any
		// other state from preceding events). Fall back to idle.
		const onComplete = (taskId: string, _tokenUsage: TokenUsage, _toolUsage: ToolUsage) => {
			if (taskId !== targetTaskId) return
			const provider = this.providerRef.deref()
			const persisted = provider?.taskHistoryStore?.get?.(targetTaskId)?.taskExecutionState
			this.updateTaskExecutionState(targetTaskId, persisted ?? "idle")
			this.emit("managedTask:completed", targetTaskId)
		}

		// Handle task error (tool failures - for analytics, doesn't change state
		// since the task may continue after tool errors)
		const onToolError = (taskId: string, _tool: ToolName, error: string) => {
			if (taskId !== targetTaskId) return
			// Don't change state - tool errors are often recoverable
			// The task may continue processing after a tool failure
			this.emit("managedTask:tool-error", targetTaskId, error)
		}

		// Handle task abort (user cancelled or abandoned)
		const onAborted = () => {
			const currentState = this.getTaskExecutionState(targetTaskId)
			// Preserve terminal outcomes when abort is used for cleanup (e.g.,
			// delegated child shutdown after completion/error).
			if (currentState === "idle" || currentState === "error") {
				return
			}
			this.updateTaskExecutionState(targetTaskId, "paused")
		}

		// Handle task error (api_req_failed, mistake_limit_reached, etc.)
		const onTaskError = (taskId: string, _errorType: string) => {
			if (taskId !== targetTaskId) return
			this.updateTaskExecutionState(targetTaskId, "error")
		}

		// Register listeners
		task.on(ShoferEventName.TaskStarted, onStarted)
		task.on(ShoferEventName.TaskInteractive, onInteractive)
		task.on(ShoferEventName.TaskActive, onActive)
		task.on(ShoferEventName.TaskIdle, onIdle)
		task.on(ShoferEventName.TaskCompleted, onComplete)
		task.on(ShoferEventName.TaskToolFailed, onToolError)
		task.on(ShoferEventName.TaskAborted, onAborted)
		task.on(ShoferEventName.TaskError, onTaskError)

		// Store cleanup function for later removal
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

		// Use a symbol to store cleanup function on the task
		const cleanupSymbol = Symbol.for("taskManager.cleanup")
		;(task as any)[cleanupSymbol] = cleanup
	}

	// ────────────────────────────── Resource Management ──────────────────────────────

	/**
	 * Get current resource limits.
	 */
	getResourceLimits(): TaskResourceLimits {
		return { ...this.resourceLimits }
	}

	/**
	 * Update resource limits.
	 */
	setResourceLimits(limits: Partial<TaskResourceLimits>): void {
		this.resourceLimits = { ...this.resourceLimits, ...limits }
	}

	/**
	 * Check if a new task can be created based on resource limits.
	 */
	canCreateManagedTask(): boolean {
		return this.activeTasks.size < this.resourceLimits.maxConcurrentActive
	}

	// ────────────────────────────── HistoryItem Integration ──────────────────────────────

	/**
	 * Create a HistoryItem from a task for persistence.
	 */
	managedTaskToHistoryItem(
		managedTask: ManagedTask,
		task: string,
		tokensIn: number,
		tokensOut: number,
		totalCost: number,
	): HistoryItem {
		return {
			id: managedTask.taskId,
			number: 0, // Will be set by TaskHistoryStore
			ts: managedTask.createdAt,
			task,
			tokensIn,
			tokensOut,
			totalCost,
			workspace: managedTask.workspace,
			name: managedTask.name,

			lastActiveTs: managedTask.lastActiveAt,
			taskExecutionState: managedTask.state,
		}
	}

	/**
	 * Restore managed tasks from persisted HistoryItems.
	 */
	async restoreManagedTasks(historyItems: HistoryItem[]): Promise<void> {
		for (const item of historyItems) {
			if (item.id) {
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
					state: TaskManager.sanitizeRestoredState(item),
				}
				this.managedTasks.set(managedTask.id, managedTask)
			}
		}
		this.emit("tasks:updated", this.getManagedTasks())
	}

	/**
	 * Resolve the in-memory ManagedTask state from a persisted HistoryItem.
	 *
	 * After a restart there are no live Task instances, so any execution state
	 * that implies in-flight work (`running`, `waiting_input`) is stale and must
	 * be downgraded to `idle`. Terminal states (`completed_*`, `error`, `paused`)
	 * are preserved across restarts.
	 */
	private static sanitizeRestoredState(item: HistoryItem): ManagedTaskState {
		const persisted = item.taskExecutionState
		if (persisted === "running" || persisted === "waiting_input") return "idle"
		// Terminal states persist across restarts
		if (persisted === "error" || persisted === "paused" || persisted?.startsWith("completed_")) return persisted
		return persisted ?? "idle"
	}

	// ────────────────────────────── Cleanup ──────────────────────────────

	/**
	 * Dispose of all managed tasks and clean up resources.
	 */
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
}
