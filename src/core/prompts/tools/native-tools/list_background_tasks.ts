import type OpenAI from "openai"

const LIST_BACKGROUND_TASKS_DESCRIPTION = `List all background child tasks that were started by this task using new_task with is_background=true. Returns each task's ID, current status, and creation timestamp.`

export default {
	type: "function",
	function: {
		name: "list_background_tasks",
		description: LIST_BACKGROUND_TASKS_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {},
			required: [],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
