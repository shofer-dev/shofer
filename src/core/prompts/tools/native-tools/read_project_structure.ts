import type OpenAI from "openai"

const READ_PROJECT_STRUCTURE_DESCRIPTION = `Request to read the project structure as a tree view. This tool provides an overview of the workspace directory structure, useful for understanding project organization.

Parameters:
- maxDepth: (optional) Maximum depth to traverse. Defaults to 3.
- includeHidden: (optional) Whether to include hidden files/directories (starting with '.'). Defaults to false.

Example: Read project structure with default settings
{ }

Example: Read project structure with deeper traversal
{ "maxDepth": 5 }

Example: Include hidden files
{ "includeHidden": true }`

const MAX_DEPTH_PARAMETER_DESCRIPTION = `Maximum depth to traverse (default: 3)`

const INCLUDE_HIDDEN_PARAMETER_DESCRIPTION = `Whether to include hidden files/directories (default: false)`

export default {
	type: "function",
	function: {
		name: "read_project_structure",
		description: READ_PROJECT_STRUCTURE_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				maxDepth: {
					type: ["number", "null"],
					description: MAX_DEPTH_PARAMETER_DESCRIPTION,
				},
				includeHidden: {
					type: ["boolean", "null"],
					description: INCLUDE_HIDDEN_PARAMETER_DESCRIPTION,
				},
			},
			required: ["maxDepth", "includeHidden"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
