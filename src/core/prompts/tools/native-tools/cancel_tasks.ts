import type OpenAI from "openai"

const CANCEL_TASKS_DESCRIPTION = `Stop one or more background child tasks. Already-completed or errored tasks are unaffected. Use this to terminate redundant parallel work — for example, when one search subtask found the answer and the others are no longer needed.`

export default {
	type: "function",
	function: {
		name: "cancel_tasks",
		description: CANCEL_TASKS_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				task_ids: {
					type: "array",
					items: { type: "string" },
					description: "One or more task IDs of background child tasks to stop.",
				},
			},
			required: ["task_ids"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
