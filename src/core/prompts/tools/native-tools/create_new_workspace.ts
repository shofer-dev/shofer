import type OpenAI from "openai"

const CREATE_NEW_WORKSPACE_DESCRIPTION = `Request to create a new workspace/project directory structure. This tool creates a new directory with optional subdirectories.

Parameters:
- path: (required) Parent directory path where the workspace will be created
- name: (required) Name of the workspace/project
- folders: (optional) Array of subdirectory names to create within the workspace
- openInNewWindow: (optional) Whether to open the workspace in a new window. Defaults to false.

Example: Create a new project
{ "path": "/home/user/projects", "name": "my-app" }

Example: Create project with subdirectories
{ "path": "/home/user/projects", "name": "my-app", "folders": ["src", "tests", "docs"] }`

const PATH_PARAMETER_DESCRIPTION = `Parent directory path where the workspace will be created`

const NAME_PARAMETER_DESCRIPTION = `Name of the workspace/project`

const FOLDERS_PARAMETER_DESCRIPTION = `Array of subdirectory names to create within the workspace`

const OPEN_IN_NEW_WINDOW_PARAMETER_DESCRIPTION = `Whether to open the workspace in a new window (default: false)`

export default {
	type: "function",
	function: {
		name: "create_new_workspace",
		description: CREATE_NEW_WORKSPACE_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: PATH_PARAMETER_DESCRIPTION,
				},
				name: {
					type: "string",
					description: NAME_PARAMETER_DESCRIPTION,
				},
				folders: {
					type: ["array", "null"],
					items: {
						type: "string",
					},
					description: FOLDERS_PARAMETER_DESCRIPTION,
				},
				openInNewWindow: {
					type: ["boolean", "null"],
					description: OPEN_IN_NEW_WINDOW_PARAMETER_DESCRIPTION,
				},
			},
			required: ["path", "name", "folders", "openInNewWindow"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
