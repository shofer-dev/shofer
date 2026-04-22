import type OpenAI from "openai"

const WAIT_FOR_TASK_DESCRIPTION = `Block until a background child task (started with new_task using is_background=true) completes or errors, then return its result. The call returns early as soon as the task finishes — it does not poll. Use this after starting one or more background tasks when you need their results before continuing.`

const TASK_ID_PARAMETER_DESCRIPTION = `The task ID returned when the background task was started.`

const TIMEOUT_PARAMETER_DESCRIPTION = `Maximum number of seconds to wait before returning. Defaults to 300 (5 minutes). If the task has not finished within the timeout, the tool returns with the current status.`

export default {
	type: "function",
	function: {
		name: "wait_for_task",
		description: WAIT_FOR_TASK_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				task_id: {
					type: "string",
					description: TASK_ID_PARAMETER_DESCRIPTION,
				},
				timeout: {
					type: ["number", "null"],
					description: TIMEOUT_PARAMETER_DESCRIPTION,
				},
			},
			required: ["task_id", "timeout"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
