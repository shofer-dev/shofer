import { parametersSchema as z } from "@shofer/types"

import { defineNativeTool } from "@shofer/core"

const INSERT_EDIT_DESCRIPTION = `Request to insert text at a specific position in a file. This tool inserts text at the specified line and column position.

Parameters:
- path: (required) Path to the file (also accepts filePath as alias), relative to the workspace
- line: (required) 1-based line number to insert at
- column: (optional) 1-based column number to insert at. Defaults to 1 (start of line).
- text: (required) Text to insert

Example: Insert at beginning of line 10
{ "path": "src/app.ts", "line": 10, "text": "// New comment\\n" }

Example: Insert at specific position
{ "path": "src/app.ts", "line": 10, "column": 5, "text": "newCode" }`

const FILE_PATH_PARAMETER_DESCRIPTION = `Path to the file, relative to the workspace`

const LINE_PARAMETER_DESCRIPTION = `1-based line number to insert at`

const COLUMN_PARAMETER_DESCRIPTION = `1-based column number to insert at (default: 1)`

const TEXT_PARAMETER_DESCRIPTION = `Text to insert`

export default defineNativeTool({
	name: "insert_edit",
	description: INSERT_EDIT_DESCRIPTION,
	schema: z.object({
		path: z.string().describe(FILE_PATH_PARAMETER_DESCRIPTION),
		filePath: z
			.string()
			.describe("Alias for 'path'. " + FILE_PATH_PARAMETER_DESCRIPTION)
			.optional(),
		line: z.number().describe(LINE_PARAMETER_DESCRIPTION),
		column: z.number().describe(COLUMN_PARAMETER_DESCRIPTION).optional(),
		text: z.string().describe(TEXT_PARAMETER_DESCRIPTION),
	}),
})
