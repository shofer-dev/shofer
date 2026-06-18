import type OpenAI from "openai"

const SLEEP_DESCRIPTION = `Pause execution for a specified number of seconds. Use when you need to wait for a fixed amount of time — e.g. for an external process to make progress or to respect rate limits. Maximum duration is 300 seconds (5 minutes). Fractional values (e.g., 0.5) are supported. The sleep is interruptible — if the user cancels the task, the sleep terminates immediately.

Do NOT use \`sleep\` to wait for a message from another task, a peer, or the orchestrator — use \`wait_for_message\` for that (it resumes the instant a message arrives, instead of pausing for a fixed time).`

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
