import type { TaskState } from "./history.js"

/**
 * TaskManager type surface (host-agnostic).
 *
 * These are the pure data/event types the portable core + the Task-cluster tools
 * read off the `TaskManager`. The CONCRETE `TaskManager` class stays in the VS
 * Code extension `src` (it is `ShoferProvider`-coupled), but its type surface
 * lives here so `@shofer/core`'s `TaskManagerLike` and the orchestration tools can
 * be import-clean.
 */

/** A pending, user-visible notification about a managed task. */
export interface ManagedTaskNotification {
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
	/** Immutable root task ID set at task construction. Used by peer-scoped tools
	 *  to resolve same-root membership without async history lookups. */
	rootTaskId?: string
	workspace: string
	createdAt: number
	lastActiveAt: number
	state: TaskState
	/**
	 * Accumulated active wall-clock time in milliseconds — time spent in the
	 * `running` OR `waiting` (blocked on another task) lifecycle. Excludes only
	 * idle-equivalent states (idle, waiting_input, paused) and terminal states,
	 * matching the Stats "runtime" pie. Incremented each time the task leaves an
	 * active state. Persisted to HistoryItem for survival across restarts.
	 */
	activeTimeMs: number
	/** Epoch ms when the task last entered an active (running/waiting) state. `0` if not currently active. */
	_runningSince: number
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
