import type OpenAI from "openai"

const SLEEP_DESCRIPTION = `Pause execution for a specified number of seconds. Use when you need to wait for an external process or respect rate limits. Maximum duration is 300 seconds (5 minutes). Fractional values (e.g., 0.5) are supported. The sleep is interruptible — if the user cancels the task, the sleep terminates immediately.`

export default {
	type: "function" as const,
	function: {
		name: "sleep",
		description: SLEEP_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				seconds: {
					type: "number",
					description:
						"Number of seconds to sleep (0.1–300). Fractional values (e.g., 0.5 for 500ms) are supported.",
				},
			},
			required: ["seconds"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
