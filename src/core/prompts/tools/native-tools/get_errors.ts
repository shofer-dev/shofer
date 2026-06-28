import { parametersSchema as z } from "@shofer/types"

import { defineNativeTool } from "./defineNativeTool"

const GET_ERRORS_DESCRIPTION = `Request to get errors and warnings from the workspace or specific files. This tool retrieves diagnostics from the language server.

Parameters:
- filePaths: (optional) Array of file paths to check. If not provided, checks all files in the workspace.

Example: Get all errors in workspace
{ }

Example: Get errors in specific files
{ "filePaths": ["src/app.ts", "src/utils.ts"] }`

const FILE_PATHS_PARAMETER_DESCRIPTION = `Array of file paths to check (optional, checks all files if not provided)`

export default defineNativeTool({
	name: "get_errors",
	description: GET_ERRORS_DESCRIPTION,
	schema: z.object({
		filePaths: z.array(z.string()).describe(FILE_PATHS_PARAMETER_DESCRIPTION).optional(),
	}),
})
