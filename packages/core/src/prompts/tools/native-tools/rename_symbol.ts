import { parametersSchema as z } from "@shofer/types"

import { defineNativeTool } from "../../../tools/defineNativeTool.js"

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

export default defineNativeTool({
	name: "rename_symbol",
	description: RENAME_SYMBOL_DESCRIPTION,
	schema: z.object({
		path: z.string().describe(FILE_PATH_PARAMETER_DESCRIPTION),
		filePath: z
			.string()
			.describe("Alias for 'path'. " + FILE_PATH_PARAMETER_DESCRIPTION)
			.optional(),
		line: z.number().describe(LINE_PARAMETER_DESCRIPTION),
		column: z.number().describe(COLUMN_PARAMETER_DESCRIPTION),
		newName: z.string().describe(NEW_NAME_PARAMETER_DESCRIPTION),
	}),
})
