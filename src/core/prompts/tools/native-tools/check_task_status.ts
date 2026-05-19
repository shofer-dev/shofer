import type OpenAI from "openai"

const CHECK_TASK_STATUS_DESCRIPTION = `Check the current status of a background child task that was previously started with new_task using is_background=true. Returns the task's status and, if it has completed/errored/cancelled, its result or error message. If the child is blocked waiting for clarification from you (it called ask_followup_question), the pending question is surfaced here so you can answer it via answer_subtask_question. Set include_activity to true to also see what the child is currently doing (last few tool calls or messages).`

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
			required: ["task_id", "include_activity"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
