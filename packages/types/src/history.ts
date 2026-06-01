import { z } from "zod"

/**
 * TaskLifecycle: the *lifecycle phase* a task is in.
 *
 * Orthogonal to the agent's self-assessment of its own work (see
 * `CompletionRating`). A task that is `completed` may additionally carry a
 * rating (`poor` / `well` / `excellent`). Together they form `TaskState`.
 *
 * The lifecycle phase deliberately does not encode the rating, which keeps
 * consumers from having to enumerate `completed_poorly | completed_well | …`
 * every time they want to check "is this task done?".
 */
export const taskLifecycleSchema = z.enum([
	"idle", // No active execution; waiting or cleared
	"running", // Actively processing (API call in progress)
	"waiting_input", // Paused, needs user approval/input
	"waiting", // Blocked on a non-user external event (e.g. wait_for_task on a subtask)
	"paused", // Manually paused by the user (non-destructive abort)
	"completed", // Finished via attempt_completion (rating in TaskState.rating)
	"error", // Stopped due to an error
])

export type TaskLifecycle = z.infer<typeof taskLifecycleSchema>

/**
 * CompletionRating: agent's self-assessment of the work it just completed.
 * Only meaningful when `lifecycle === "completed"`.
 */
export const completionRatingSchema = z.enum(["poor", "well", "excellent"])

export type CompletionRating = z.infer<typeof completionRatingSchema>

/**
 * TaskState: the full execution state of a task.
 *
 * Combines lifecycle (where the task is in its life) with an optional rating
 * (how well the task was completed). `rating` is only set when `lifecycle ===
 * "completed"` — it is undefined for every other lifecycle phase.
 */
export const taskStateSchema = z.object({
	lifecycle: taskLifecycleSchema,
	rating: completionRatingSchema.optional(),
})

export type TaskState = z.infer<typeof taskStateSchema>

/**
 * Terminal lifecycle phases — those that survive a process restart unchanged.
 * Transient phases (`running`, `waiting_input`, `waiting`) are sanitized to
 * `idle` on restore because no live `Task` instance can plausibly still be
 * running.
 */
export function isTerminalLifecycle(lifecycle: TaskLifecycle): boolean {
	return lifecycle === "completed" || lifecycle === "error" || lifecycle === "paused"
}

/**
 * Convenience: build the `idle` state.
 */
export const IDLE_TASK_STATE: TaskState = { lifecycle: "idle" }

/**
 * BudgetAction defines the behaviour when a task's cost limit is exceeded.
 */
export const budgetActionSchema = z.enum(["pause", "abort", "kill"])

export type BudgetAction = z.infer<typeof budgetActionSchema>

/**
 * CostLimit defines a per-root-task USD budget cap.
 * Stored only on the root task; subtasks inherit the limit.
 */
export const costLimitSchema = z.object({
	maxUsd: z.number().positive(),
	action: budgetActionSchema,
})

export type CostLimit = z.infer<typeof costLimitSchema>

/**
 * HistoryItem
 */

export const historyItemSchema = z.object({
	id: z.string(),
	rootTaskId: z.string().optional(),
	parentTaskId: z.string().optional(),
	number: z.number(),
	ts: z.number(),
	createdAt: z.number().optional(),
	task: z.string(),
	tokensIn: z.number(),
	tokensOut: z.number(),
	cacheWrites: z.number().optional(),
	cacheReads: z.number().optional(),
	totalCost: z.number(),
	size: z.number().optional(),
	workspace: z.string().optional(),
	/** Per-task working directory (e.g., embedded worktree subdirectory).
	 *  When set, the task operates in this directory instead of the workspace root. */
	cwd: z.string().optional(),
	mode: z.string().optional(),
	apiConfigName: z.string().optional(), // Provider profile name for sticky profile feature
	costLimit: costLimitSchema.optional(), // Per-root-task budget cap
	delegatedToId: z.string().optional(), // Last child this parent delegated to
	childIds: z.array(z.string()).optional(), // All children spawned by this task
	awaitingChildId: z.string().optional(), // Child currently awaited (set when delegated)
	completedByChildId: z.string().optional(), // Child that completed and resumed this parent
	completionResultSummary: z.string().optional(), // Summary from completed child
	// Parallel task fields
	name: z.string().optional(), // User-defined task name
	lastActiveTs: z.number().optional(), // Track when last switched to
	/**
	 * Current execution state — both lifecycle and (when completed) rating.
	 * Replaces the legacy flat `taskExecutionState` enum.
	 */
	taskState: taskStateSchema.optional(),
	// Async task fields
	backgroundChildIds: z.array(z.string()).optional(),
	isBackground: z.boolean().optional(),
	// Skills that have been loaded via skills and should survive rehydration
	loadedSkills: z.array(z.string()).optional(),
	// Archive support: soft-remove from the main task listing.
	archived: z.boolean().optional(),
	archivedAt: z.number().optional(),
	// Pin support: show pinned tasks first in the listing.
	pinned: z.boolean().optional(),
	// File change stats — total lines added/removed across all files in this task.
	insertions: z.number().optional(),
	deletions: z.number().optional(),
	// Workflow support — set when this HistoryItem represents a WorkflowTask.
	/** Whether this task is a WorkflowTask (has a slang-driven loop). */
	isWorkflow: z.boolean().optional(),
	/** The .slang source content for WorkflowTasks. */
	slangSource: z.string().optional(),
	/** Serialized FlowState JSON blob for WorkflowTask checkpoint/resume. */
	flowState: z.record(z.unknown()).optional(),
})

export type HistoryItem = z.infer<typeof historyItemSchema>

/**
 * TaskNotification represents a notification from a background task.
 */
export const taskNotificationSchema = z.object({
	taskId: z.string(),
	type: z.enum(["needs_input", "completed", "error", "file_conflict"]),
	message: z.string(),
	timestamp: z.number(),
})

export type TaskNotification = z.infer<typeof taskNotificationSchema>
