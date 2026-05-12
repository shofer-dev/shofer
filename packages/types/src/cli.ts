import { z } from "zod"

import { shoferSettingsSchema } from "./global-settings.js"

/**
 * Shofer CLI stdin commands
 */

export const shoferCliCommandNames = ["start", "message", "cancel", "ping", "shutdown"] as const

export const shoferCliCommandNameSchema = z.enum(shoferCliCommandNames)

export type ShoferCliCommandName = z.infer<typeof shoferCliCommandNameSchema>

export const shoferCliCommandBaseSchema = z.object({
	command: shoferCliCommandNameSchema,
	requestId: z.string().min(1),
})

export type ShoferCliCommandBase = z.infer<typeof shoferCliCommandBaseSchema>

const shoferCliSessionIdSchema = z
	.string()
	.trim()
	.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)

export const shoferCliStartCommandSchema = shoferCliCommandBaseSchema.extend({
	command: z.literal("start"),
	prompt: z.string(),
	taskId: shoferCliSessionIdSchema.optional(),
	images: z.array(z.string()).optional(),
	configuration: shoferSettingsSchema.optional(),
})

export type ShoferCliStartCommand = z.infer<typeof shoferCliStartCommandSchema>

export const shoferCliMessageCommandSchema = shoferCliCommandBaseSchema.extend({
	command: z.literal("message"),
	prompt: z.string(),
	images: z.array(z.string()).optional(),
})

export type ShoferCliMessageCommand = z.infer<typeof shoferCliMessageCommandSchema>

export const shoferCliCancelCommandSchema = shoferCliCommandBaseSchema.extend({
	command: z.literal("cancel"),
})

export type ShoferCliCancelCommand = z.infer<typeof shoferCliCancelCommandSchema>

export const shoferCliPingCommandSchema = shoferCliCommandBaseSchema.extend({
	command: z.literal("ping"),
})

export type ShoferCliPingCommand = z.infer<typeof shoferCliPingCommandSchema>

export const shoferCliShutdownCommandSchema = shoferCliCommandBaseSchema.extend({
	command: z.literal("shutdown"),
})

export type ShoferCliShutdownCommand = z.infer<typeof shoferCliShutdownCommandSchema>

export const shoferCliInputCommandSchema = z.discriminatedUnion("command", [
	shoferCliStartCommandSchema,
	shoferCliMessageCommandSchema,
	shoferCliCancelCommandSchema,
	shoferCliPingCommandSchema,
	shoferCliShutdownCommandSchema,
])

export type ShoferCliInputCommand = z.infer<typeof shoferCliInputCommandSchema>

/**
 * Shofer CLI stream-json output
 */

export const shoferCliOutputFormats = ["text", "json", "stream-json"] as const

export const shoferCliOutputFormatSchema = z.enum(shoferCliOutputFormats)

export type ShoferCliOutputFormat = z.infer<typeof shoferCliOutputFormatSchema>

export const shoferCliEventTypes = [
	"system",
	"control",
	"queue",
	"assistant",
	"user",
	"tool_use",
	"tool_result",
	"thinking",
	"error",
	"result",
] as const

export const shoferCliEventTypeSchema = z.enum(shoferCliEventTypes)

export type ShoferCliEventType = z.infer<typeof shoferCliEventTypeSchema>

export const shoferCliControlSubtypes = ["ack", "done", "error"] as const

export const shoferCliControlSubtypeSchema = z.enum(shoferCliControlSubtypes)

export type ShoferCliControlSubtype = z.infer<typeof shoferCliControlSubtypeSchema>

export const shoferCliQueueItemSchema = z.object({
	id: z.string().min(1),
	text: z.string().optional(),
	imageCount: z.number().optional(),
	timestamp: z.number().optional(),
})

export type ShoferCliQueueItem = z.infer<typeof shoferCliQueueItemSchema>

export const shoferCliToolUseSchema = z.object({
	name: z.string(),
	input: z.record(z.unknown()).optional(),
})

export type ShoferCliToolUse = z.infer<typeof shoferCliToolUseSchema>

export const shoferCliToolResultSchema = z.object({
	name: z.string(),
	output: z.string().optional(),
	error: z.string().optional(),
	exitCode: z.number().optional(),
})

export type ShoferCliToolResult = z.infer<typeof shoferCliToolResultSchema>

export const shoferCliCostSchema = z.object({
	totalCost: z.number().optional(),
	inputTokens: z.number().optional(),
	outputTokens: z.number().optional(),
	cacheWrites: z.number().optional(),
	cacheReads: z.number().optional(),
})

export type ShoferCliCost = z.infer<typeof shoferCliCostSchema>

export const shoferCliStreamEventSchema = z
	.object({
		type: shoferCliEventTypeSchema.optional(),
		subtype: z.string().optional(),
		requestId: z.string().optional(),
		command: shoferCliCommandNameSchema.optional(),
		taskId: z.string().optional(),
		code: z.string().optional(),
		content: z.string().optional(),
		success: z.boolean().optional(),
		id: z.number().optional(),
		done: z.boolean().optional(),
		queueDepth: z.number().optional(),
		queue: z.array(shoferCliQueueItemSchema).optional(),
		schemaVersion: z.number().optional(),
		protocol: z.string().optional(),
		capabilities: z.array(z.string()).optional(),
		tool_use: shoferCliToolUseSchema.optional(),
		tool_result: shoferCliToolResultSchema.optional(),
		cost: shoferCliCostSchema.optional(),
	})
	.passthrough()

export type ShoferCliStreamEvent = z.infer<typeof shoferCliStreamEventSchema>

export const shoferCliControlEventSchema = shoferCliStreamEventSchema.extend({
	type: z.literal("control"),
	subtype: shoferCliControlSubtypeSchema,
	requestId: z.string().min(1),
})

export type ShoferCliControlEvent = z.infer<typeof shoferCliControlEventSchema>

export const shoferCliFinalOutputSchema = z.object({
	type: z.literal("result"),
	success: z.boolean(),
	content: z.string().optional(),
	cost: shoferCliCostSchema.optional(),
	events: z.array(shoferCliStreamEventSchema),
})

export type ShoferCliFinalOutput = z.infer<typeof shoferCliFinalOutputSchema>
