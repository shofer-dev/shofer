import { z } from "zod"

/**
 * TaskExecutionState represents the current execution state of a parallel task.
 */
export const taskExecutionStateSchema = z.enum([
	"idle", // No active API calls, waiting for user
	"running", // Actively processing (API call in progress)
	"waiting", // Blocked — waiting for a tool/agent to complete	"waiting_input", // Paused, needs user approval/input
	"paused", // Manually paused by user
	"error", // Stopped due to an error
	"completed_poorly", // Finished — agent rated it poor
	"completed_well", // Finished — agent rated it well
	"completed_excellent", // Finished — agent rated it excellent
])

export type TaskExecutionState = z.infer<typeof taskExecutionStateSchema>

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
	taskExecutionState: taskExecutionStateSchema.optional(), // Current execution state
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
