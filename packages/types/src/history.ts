import { z } from "zod"

/**
 * TaskExecutionState represents the current execution state of a parallel task.
 */
export const taskExecutionStateSchema = z.enum([
	"idle", // No active API calls, waiting for user
	"running", // Actively processing (API call in progress)
	"waiting_input", // Paused, needs user approval/input
	"paused", // Manually paused by user
	"error", // Stopped due to an error
])

export type TaskExecutionState = z.infer<typeof taskExecutionStateSchema>

/**
 * HistoryItem
 */

export const historyItemSchema = z.object({
	id: z.string(),
	rootTaskId: z.string().optional(),
	parentTaskId: z.string().optional(),
	number: z.number(),
	ts: z.number(),
	task: z.string(),
	tokensIn: z.number(),
	tokensOut: z.number(),
	cacheWrites: z.number().optional(),
	cacheReads: z.number().optional(),
	totalCost: z.number(),
	size: z.number().optional(),
	workspace: z.string().optional(),
	mode: z.string().optional(),
	apiConfigName: z.string().optional(), // Provider profile name for sticky profile feature
	status: z.enum(["active", "completed", "delegated"]).optional(),
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
