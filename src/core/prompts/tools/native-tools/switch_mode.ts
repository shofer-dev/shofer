import type OpenAI from "openai"

const SWITCH_MODE_DESCRIPTION = `Request to switch to a different mode. This tool allows modes to request switching to another mode when needed, such as switching to Code mode to make code changes. The user must approve the mode switch. When the optional \`task_id\` parameter is provided, the mode switch is applied to the specified child task instead of the calling task — this allows a parent to control the mode of its background children.`

const MODE_SLUG_PARAMETER_DESCRIPTION = `Slug of the mode to switch to (e.g., code, ask, architect)`

const REASON_PARAMETER_DESCRIPTION = `Explanation for why the mode switch is needed`

const TASK_ID_PARAMETER_DESCRIPTION = `Optional task ID of a background child task to switch the mode of. When omitted, the mode switch applies to the calling task itself.`

export default {
	type: "function",
	function: {
		name: "switch_mode",
		description: SWITCH_MODE_DESCRIPTION,
		parameters: {
			type: "object",
			properties: {
				mode_slug: {
					type: "string",
					description: MODE_SLUG_PARAMETER_DESCRIPTION,
				},
				reason: {
					type: "string",
					description: REASON_PARAMETER_DESCRIPTION,
				},
				task_id: {
					type: "string",
					description: TASK_ID_PARAMETER_DESCRIPTION,
				},
			},
			required: ["mode_slug", "reason"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
