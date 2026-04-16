import type OpenAI from "openai"

const CREATE_DIRECTORY_DESCRIPTION = `Request to create a new directory. This tool creates a directory at the specified path, including any necessary parent directories.

Parameters:
- path: (required) Path of the directory to create, relative to the workspace

Example: Create a new directory
{ "path": "src/components" }`

const PATH_PARAMETER_DESCRIPTION = `Path of the directory to create, relative to the workspace`

export default {
	type: "function",
	function: {
		name: "create_directory",
		description: CREATE_DIRECTORY_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: PATH_PARAMETER_DESCRIPTION,
				},
			},
			required: ["path"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
