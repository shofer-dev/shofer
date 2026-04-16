import EventEmitter from "events"

import type { TaskExecutionState, HistoryItem, ToolName, TokenUsage, ToolUsage } from "@roo-code/types"
import { RooCodeEventName } from "@roo-code/types"

import type { Task } from "../../core/task/Task"
import type { ClineProvider } from "../../core/webview/ClineProvider"

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
	private providerRef: WeakRef<ClineProvider>

	constructor(provider: ClineProvider, limits?: Partial<TaskResourceLimits>) {
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
		const managedTask: ManagedTask = {
			id: task.taskId,
			name: name || `Task ${this.managedTasks.size + 1}`,
			taskId: task.taskId,
			workspace: task.cwd || "",
			createdAt: Date.now(),
			lastActiveAt: Date.now(),
			state: "idle",
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
		if (this.activeTasks.has(task.taskId)) {
			// Already registered
			return
		}

		const taskText = task.clineMessages.find((m) => m.type === "say" && m.say === "text")?.text || ""
		const autoName =
			name ||
			(taskText ? taskText.slice(0, 50).trim() + (taskText.length > 50 ? "..." : "") : `Task ${Date.now()}`)

		const managedTask: ManagedTask = {
			id: task.taskId,
			name: autoName,
			taskId: task.taskId,
			workspace: task.cwd || "",
			createdAt: Date.now(),
			lastActiveAt: Date.now(),
			state: task.abandoned || task.abort ? "idle" : "running",
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
	 */
	async pauseManagedTask(targetTaskId: string): Promise<void> {
		const managedTask = this.managedTasks.get(targetTaskId)
		if (!managedTask) {
			throw new Error(`Task ${targetTaskId} not found`)
		}

		const task = this.activeTasks.get(targetTaskId)
		if (task) {
			// Non-destructive abort - keeps task state
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

		// Handle task completion
		const onComplete = (taskId: string, _tokenUsage: TokenUsage, _toolUsage: ToolUsage) => {
			if (taskId !== targetTaskId) return
			this.updateTaskExecutionState(targetTaskId, "idle")
			this.emit("managedTask:completed", targetTaskId)
		}

		// Handle task error
		const onError = (taskId: string, _tool: ToolName, error: string) => {
			if (taskId !== targetTaskId) return
			this.updateTaskExecutionState(targetTaskId, "idle")
			this.emit("managedTask:error", targetTaskId, error)
		}

		// Register listeners
		task.on(RooCodeEventName.TaskInteractive, onInteractive)
		task.on(RooCodeEventName.TaskActive, onActive)
		task.on(RooCodeEventName.TaskCompleted, onComplete)
		task.on(RooCodeEventName.TaskToolFailed, onError)

		// Store cleanup function for later removal
		const cleanup = () => {
			task.off(RooCodeEventName.TaskInteractive, onInteractive)
			task.off(RooCodeEventName.TaskActive, onActive)
			task.off(RooCodeEventName.TaskCompleted, onComplete)
			task.off(RooCodeEventName.TaskToolFailed, onError)
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
					state: item.taskExecutionState || "idle",
				}
				this.managedTasks.set(managedTask.id, managedTask)
			}
		}
		this.emit("tasks:updated", this.getManagedTasks())
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
