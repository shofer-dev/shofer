import type OpenAI from "openai"

const INSERT_EDIT_DESCRIPTION = `Request to insert text at a specific position in a file. This tool inserts text at the specified line and column position.

Parameters:
- filePath: (required) Path to the file, relative to the workspace
- line: (required) 1-based line number to insert at
- column: (optional) 1-based column number to insert at. Defaults to 1 (start of line).
- text: (required) Text to insert

Example: Insert at beginning of line 10
{ "filePath": "src/app.ts", "line": 10, "text": "// New comment\n" }

Example: Insert at specific position
{ "filePath": "src/app.ts", "line": 10, "column": 5, "text": "newCode" }`

const FILE_PATH_PARAMETER_DESCRIPTION = `Path to the file, relative to the workspace`

const LINE_PARAMETER_DESCRIPTION = `1-based line number to insert at`

const COLUMN_PARAMETER_DESCRIPTION = `1-based column number to insert at (default: 1)`

const TEXT_PARAMETER_DESCRIPTION = `Text to insert`

export default {
	type: "function",
	function: {
		name: "insert_edit",
		description: INSERT_EDIT_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				filePath: {
					type: "string",
					description: FILE_PATH_PARAMETER_DESCRIPTION,
				},
				line: {
					type: "number",
					description: LINE_PARAMETER_DESCRIPTION,
				},
				column: {
					type: ["number", "null"],
					description: COLUMN_PARAMETER_DESCRIPTION,
				},
				text: {
					type: "string",
					description: TEXT_PARAMETER_DESCRIPTION,
				},
			},
			required: ["filePath", "line", "text"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
