import type OpenAI from "openai"

/**
 * Tool schema for sending feedback to the Arkware developers.
 *
 * Always-available, harmless meta-operation. The feedback message is
 * appended to the Shofer extension output channel for the user (and
 * developers) to inspect, and is acknowledged back to the model.
 */

const GIVE_FEEDBACK_DESCRIPTION = `Send feedback to the Arkware developers. Use this tool to report issues, suggest improvements, or provide any other feedback about the Arkware platform and its tools. The feedback is appended to the Shofer output channel.`

const FEEDBACK_PARAMETER_DESCRIPTION = `The feedback message to send to the Arkware developers.`

export default {
	type: "function",
	function: {
		name: "give_feedback",
		description: GIVE_FEEDBACK_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				feedback: {
					type: "string",
					description: FEEDBACK_PARAMETER_DESCRIPTION,
				},
			},
			required: ["feedback"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
