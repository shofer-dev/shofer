import type OpenAI from "openai"

const WAIT_FOR_TASK_DESCRIPTION = `Block until one or more background child tasks (started with new_task using is_background=true) complete, then return their results. Use the \`wait\` parameter to control whether to wait for ALL tasks or just ANY one of them. The call is event-driven — it does not poll. Use this after starting background tasks when you need their results before continuing.`

const TASK_IDS_PARAMETER_DESCRIPTION = `One or more task IDs returned when the background tasks were started. Accepts a single ID or a list of IDs.`

const WAIT_PARAMETER_DESCRIPTION = `Completion strategy. "all" (default) — waits until every listed task reaches a terminal state. "any" — returns as soon as at least one task completes successfully. Omit or pass null to use the default ("all").`

const TIMEOUT_PARAMETER_DESCRIPTION = `Maximum seconds to wait before returning. Default: 120. If the condition is not met within the timeout the tool returns with the current statuses. Omit or pass null to use the default.`

export default {
	type: "function",
	function: {
		name: "wait_for_task",
		description: WAIT_FOR_TASK_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				task_ids: {
					type: "array",
					items: { type: "string" },
					description: TASK_IDS_PARAMETER_DESCRIPTION,
				},
				wait: {
					type: ["string", "null"],
					enum: ["all", "any", null],
					description: WAIT_PARAMETER_DESCRIPTION,
				},
				timeout: {
					type: ["number", "null"],
					description: TIMEOUT_PARAMETER_DESCRIPTION,
				},
			},
			required: ["task_ids", "wait", "timeout"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
