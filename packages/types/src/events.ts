import { z } from "zod"

import { shoferMessageSchema, queuedMessageSchema, tokenUsageSchema } from "./message.js"
import { modelInfoSchema } from "./model.js"
import { toolNamesSchema, toolUsageSchema } from "./tool.js"
import { completionRatingSchema } from "./history.js"

/**
 * ShoferEventName
 */

export enum ShoferEventName {
	// Task Provider Lifecycle
	TaskCreated = "taskCreated",

	// Task Lifecycle
	TaskStarted = "taskStarted",
	TaskCompleted = "taskCompleted",
	TaskAborted = "taskAborted",
	TaskError = "taskError",
	TaskFocused = "taskFocused",
	TaskUnfocused = "taskUnfocused",
	TaskActive = "taskActive",
	TaskInteractive = "taskInteractive",
	TaskResumable = "taskResumable",
	TaskIdle = "taskIdle",

	// Subtask Lifecycle
	TaskPaused = "taskPaused",
	TaskUnpaused = "taskUnpaused",
	TaskSpawned = "taskSpawned",
	TaskDelegated = "taskDelegated",
	TaskDelegationCompleted = "taskDelegationCompleted",
	TaskDelegationResumed = "taskDelegationResumed",

	// Task Execution
	Message = "message",
	TaskModeSwitched = "taskModeSwitched",
	TaskAskResponded = "taskAskResponded",
	TaskUserMessage = "taskUserMessage",
	QueuedMessagesUpdated = "queuedMessagesUpdated",

	// Task Analytics
	TaskTokenUsageUpdated = "taskTokenUsageUpdated",
	TaskToolFailed = "taskToolFailed",

	// Configuration Changes
	ModeChanged = "modeChanged",
	ProviderProfileChanged = "providerProfileChanged",

	// Query Responses
	CommandsResponse = "commandsResponse",
	ModesResponse = "modesResponse",
	ModelsResponse = "modelsResponse",

	// Evals
	EvalPass = "evalPass",
	EvalFail = "evalFail",
}

/**
 * ShoferEvents
 */

export const shoferEventsSchema = z.object({
	[ShoferEventName.TaskCreated]: z.tuple([z.string()]),

	[ShoferEventName.TaskStarted]: z.tuple([z.string()]),
	[ShoferEventName.TaskCompleted]: z.tuple([
		z.string(),
		tokenUsageSchema,
		toolUsageSchema,
		z.object({
			rating: completionRatingSchema,
			isSubtask: z.boolean(),
		}),
	]),
	[ShoferEventName.TaskAborted]: z.tuple([
		z.string(),
		z.object({
			// Why the task was aborted. Lets listeners decide whether the
			// abort represents a paused/stopped task or merely cleanup
			// after a terminal state was already set elsewhere.
			reason: z.enum(["user", "completed", "error", "abandoned"]),
		}),
	]),
	[ShoferEventName.TaskError]: z.tuple([z.string(), z.string()]), // taskId, errorType
	[ShoferEventName.TaskFocused]: z.tuple([z.string()]),
	[ShoferEventName.TaskUnfocused]: z.tuple([z.string()]),
	[ShoferEventName.TaskActive]: z.tuple([z.string()]),
	[ShoferEventName.TaskInteractive]: z.tuple([z.string()]),
	[ShoferEventName.TaskResumable]: z.tuple([z.string()]),
	[ShoferEventName.TaskIdle]: z.tuple([z.string()]),

	[ShoferEventName.TaskPaused]: z.tuple([z.string()]),
	[ShoferEventName.TaskUnpaused]: z.tuple([z.string()]),
	[ShoferEventName.TaskSpawned]: z.tuple([z.string(), z.string()]),
	[ShoferEventName.TaskDelegated]: z.tuple([
		z.string(), // parentTaskId
		z.string(), // childTaskId
	]),
	[ShoferEventName.TaskDelegationCompleted]: z.tuple([
		z.string(), // parentTaskId
		z.string(), // childTaskId
		z.string(), // completionResultSummary
	]),
	[ShoferEventName.TaskDelegationResumed]: z.tuple([
		z.string(), // parentTaskId
		z.string(), // childTaskId
	]),

	[ShoferEventName.Message]: z.tuple([
		z.object({
			taskId: z.string(),
			action: z.union([z.literal("created"), z.literal("updated")]),
			message: shoferMessageSchema,
		}),
	]),
	[ShoferEventName.TaskModeSwitched]: z.tuple([z.string(), z.string()]),
	[ShoferEventName.TaskAskResponded]: z.tuple([z.string()]),
	[ShoferEventName.TaskUserMessage]: z.tuple([z.string()]),
	[ShoferEventName.QueuedMessagesUpdated]: z.tuple([z.string(), z.array(queuedMessageSchema)]),

	[ShoferEventName.TaskToolFailed]: z.tuple([z.string(), toolNamesSchema, z.string()]),
	[ShoferEventName.TaskTokenUsageUpdated]: z.tuple([z.string(), tokenUsageSchema, toolUsageSchema]),

	[ShoferEventName.ModeChanged]: z.tuple([z.string()]),
	[ShoferEventName.ProviderProfileChanged]: z.tuple([z.object({ name: z.string(), provider: z.string() })]),

	[ShoferEventName.CommandsResponse]: z.tuple([
		z.array(
			z.object({
				name: z.string(),
				source: z.enum(["global", "project", "built-in"]),
				filePath: z.string().optional(),
				description: z.string().optional(),
				argumentHint: z.string().optional(),
			}),
		),
	]),
	[ShoferEventName.ModesResponse]: z.tuple([z.array(z.object({ slug: z.string(), name: z.string() }))]),
	[ShoferEventName.ModelsResponse]: z.tuple([z.record(z.string(), modelInfoSchema)]),
})

export type ShoferEvents = z.infer<typeof shoferEventsSchema>

/**
 * TaskEvent
 */

export const taskEventSchema = z.discriminatedUnion("eventName", [
	// Task Provider Lifecycle
	z.object({
		eventName: z.literal(ShoferEventName.TaskCreated),
		payload: shoferEventsSchema.shape[ShoferEventName.TaskCreated],
		taskId: z.number().optional(),
	}),

	// Task Lifecycle
	z.object({
		eventName: z.literal(ShoferEventName.TaskStarted),
		payload: shoferEventsSchema.shape[ShoferEventName.TaskStarted],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(ShoferEventName.TaskCompleted),
		payload: shoferEventsSchema.shape[ShoferEventName.TaskCompleted],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(ShoferEventName.TaskAborted),
		payload: shoferEventsSchema.shape[ShoferEventName.TaskAborted],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(ShoferEventName.TaskFocused),
		payload: shoferEventsSchema.shape[ShoferEventName.TaskFocused],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(ShoferEventName.TaskUnfocused),
		payload: shoferEventsSchema.shape[ShoferEventName.TaskUnfocused],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(ShoferEventName.TaskActive),
		payload: shoferEventsSchema.shape[ShoferEventName.TaskActive],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(ShoferEventName.TaskInteractive),
		payload: shoferEventsSchema.shape[ShoferEventName.TaskInteractive],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(ShoferEventName.TaskResumable),
		payload: shoferEventsSchema.shape[ShoferEventName.TaskResumable],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(ShoferEventName.TaskIdle),
		payload: shoferEventsSchema.shape[ShoferEventName.TaskIdle],
		taskId: z.number().optional(),
	}),

	// Subtask Lifecycle
	z.object({
		eventName: z.literal(ShoferEventName.TaskPaused),
		payload: shoferEventsSchema.shape[ShoferEventName.TaskPaused],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(ShoferEventName.TaskUnpaused),
		payload: shoferEventsSchema.shape[ShoferEventName.TaskUnpaused],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(ShoferEventName.TaskSpawned),
		payload: shoferEventsSchema.shape[ShoferEventName.TaskSpawned],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(ShoferEventName.TaskDelegated),
		payload: shoferEventsSchema.shape[ShoferEventName.TaskDelegated],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(ShoferEventName.TaskDelegationCompleted),
		payload: shoferEventsSchema.shape[ShoferEventName.TaskDelegationCompleted],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(ShoferEventName.TaskDelegationResumed),
		payload: shoferEventsSchema.shape[ShoferEventName.TaskDelegationResumed],
		taskId: z.number().optional(),
	}),

	// Task Execution
	z.object({
		eventName: z.literal(ShoferEventName.Message),
		payload: shoferEventsSchema.shape[ShoferEventName.Message],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(ShoferEventName.TaskModeSwitched),
		payload: shoferEventsSchema.shape[ShoferEventName.TaskModeSwitched],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(ShoferEventName.TaskAskResponded),
		payload: shoferEventsSchema.shape[ShoferEventName.TaskAskResponded],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(ShoferEventName.QueuedMessagesUpdated),
		payload: shoferEventsSchema.shape[ShoferEventName.QueuedMessagesUpdated],
		taskId: z.number().optional(),
	}),

	// Task Analytics
	z.object({
		eventName: z.literal(ShoferEventName.TaskToolFailed),
		payload: shoferEventsSchema.shape[ShoferEventName.TaskToolFailed],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(ShoferEventName.TaskTokenUsageUpdated),
		payload: shoferEventsSchema.shape[ShoferEventName.TaskTokenUsageUpdated],
		taskId: z.number().optional(),
	}),

	// Query Responses
	z.object({
		eventName: z.literal(ShoferEventName.CommandsResponse),
		payload: shoferEventsSchema.shape[ShoferEventName.CommandsResponse],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(ShoferEventName.ModesResponse),
		payload: shoferEventsSchema.shape[ShoferEventName.ModesResponse],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(ShoferEventName.ModelsResponse),
		payload: shoferEventsSchema.shape[ShoferEventName.ModelsResponse],
		taskId: z.number().optional(),
	}),

	// Evals
	z.object({
		eventName: z.literal(ShoferEventName.EvalPass),
		payload: z.undefined(),
		taskId: z.number(),
	}),
	z.object({
		eventName: z.literal(ShoferEventName.EvalFail),
		payload: z.undefined(),
		taskId: z.number(),
	}),
])

export type TaskEvent = z.infer<typeof taskEventSchema>
