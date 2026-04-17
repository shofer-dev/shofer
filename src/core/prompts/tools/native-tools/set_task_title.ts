import type OpenAI from "openai"

/**
 * Tool schema for setting the task/conversation title.
 *
 * This tool allows the LLM to provide a meaningful, descriptive title
 * for the current task after understanding the user's request, rather
 * than relying on the auto-generated truncated first-message text.
 */

const SET_TASK_TITLE_DESCRIPTION = `Set a short, descriptive title for the current task/conversation. Use this early in a conversation to replace the auto-generated title with something meaningful. Keep titles concise (under 60 characters).`

const TITLE_PARAMETER_DESCRIPTION = `Short descriptive title for this task (max 60 characters)`

export default {
	type: "function",
	function: {
		name: "set_task_title",
		description: SET_TASK_TITLE_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				title: {
					type: "string",
					description: TITLE_PARAMETER_DESCRIPTION,
				},
			},
			required: ["title"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
