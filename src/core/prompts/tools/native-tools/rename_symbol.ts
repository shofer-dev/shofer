import type OpenAI from "openai"

const RENAME_SYMBOL_DESCRIPTION = `Request to rename a symbol at a specific position. This tool uses the language server to rename the symbol and all its references across the codebase.

Parameters:
- path: (required) Path to the file containing the symbol (also accepts filePath as alias), relative to the workspace
- line: (required) 1-based line number of the symbol
- column: (required) 1-based column number of the symbol
- newName: (required) New name for the symbol

Example: Rename a function
{ "path": "src/utils.ts", "line": 15, "column": 10, "newName": "calculateTotal" }`

const FILE_PATH_PARAMETER_DESCRIPTION = `Path to the file containing the symbol, relative to the workspace`

const LINE_PARAMETER_DESCRIPTION = `1-based line number of the symbol`

const COLUMN_PARAMETER_DESCRIPTION = `1-based column number of the symbol`

const NEW_NAME_PARAMETER_DESCRIPTION = `New name for the symbol`

export default {
	type: "function",
	function: {
		name: "rename_symbol",
		description: RENAME_SYMBOL_DESCRIPTION,
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
				newName: {
					type: "string",
					description: NEW_NAME_PARAMETER_DESCRIPTION,
				},
			},
			required: ["path", "line", "column", "newName"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
