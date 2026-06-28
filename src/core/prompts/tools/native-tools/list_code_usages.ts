import { parametersSchema as z } from "@shofer/types"

import { defineNativeTool } from "./defineNativeTool"

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

export default defineNativeTool({
	name: "list_code_usages",
	description: LIST_CODE_USAGES_DESCRIPTION,
	schema: z.object({
		path: z.string().describe(FILE_PATH_PARAMETER_DESCRIPTION),
		filePath: z
			.string()
			.describe("Alias for 'path'. " + FILE_PATH_PARAMETER_DESCRIPTION)
			.optional(),
		line: z.number().describe(LINE_PARAMETER_DESCRIPTION),
		column: z.number().describe(COLUMN_PARAMETER_DESCRIPTION),
	}),
})
