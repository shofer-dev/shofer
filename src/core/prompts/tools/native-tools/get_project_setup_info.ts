import type OpenAI from "openai"

const GET_PROJECT_SETUP_INFO_DESCRIPTION = `Request to get information about the project setup, including detected languages, frameworks, build systems, and package managers. This tool analyzes the workspace to determine the project configuration.

Parameters: None

Example: Get project setup info
{ }`

export default {
	type: "function",
	function: {
		name: "get_project_setup_info",
		description: GET_PROJECT_SETUP_INFO_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {},
			required: [],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
