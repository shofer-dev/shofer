import type OpenAI from "openai"

const CHECK_TASK_STATUS_DESCRIPTION = `Check the current status of a background child task that was previously started with new_task using is_background=true. Returns the task's status and, if it has completed or errored, its result or error message. Set include_activity to true to also see what the child is currently doing (last few tool calls or messages).`

const TASK_ID_PARAMETER_DESCRIPTION = `The task ID returned when the background task was started.`

const INCLUDE_ACTIVITY_PARAMETER_DESCRIPTION = `When true, include the child's most recent tool calls and messages in the response so you can see what it is currently working on.`

export default {
	type: "function",
	function: {
		name: "check_task_status",
		description: CHECK_TASK_STATUS_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				task_id: {
					type: "string",
					description: TASK_ID_PARAMETER_DESCRIPTION,
				},
				include_activity: {
					type: ["boolean", "null"],
					description: INCLUDE_ACTIVITY_PARAMETER_DESCRIPTION,
				},
			},
			required: ["task_id"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
