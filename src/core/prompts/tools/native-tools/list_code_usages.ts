import type OpenAI from "openai"

const LIST_CODE_USAGES_DESCRIPTION = `Request to find all references/usages of a symbol at a specific position. This tool uses the language server to find all references to the symbol at the given location.

Parameters:
- path: (required) Path to the file containing the symbol (also accepts filePath as alias), relative to the workspace
- line: (required) 1-based line number of the symbol
- column: (required) 1-based column number of the symbol

Example: Find all references to a function
{ "path": "src/utils.ts", "line": 15, "column": 10 }`

const FILE_PATH_PARAMETER_DESCRIPTION = `Path to the file containing the symbol, relative to the workspace`

const LINE_PARAMETER_DESCRIPTION = `1-based line number of the symbol`

const COLUMN_PARAMETER_DESCRIPTION = `1-based column number of the symbol`

export default {
	type: "function",
	function: {
		name: "list_code_usages",
		description: LIST_CODE_USAGES_DESCRIPTION,
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: FILE_PATH_PARAMETER_DESCRIPTION,
				},
				filePath: {
					type: "string",
					description: "Alias for 'path'. " + FILE_PATH_PARAMETER_DESCRIPTION,
				},
				line: {
					type: "number",
					description: LINE_PARAMETER_DESCRIPTION,
				},
				column: {
					type: "number",
					description: COLUMN_PARAMETER_DESCRIPTION,
				},
			},
			required: ["path", "line", "column"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
