import { parametersSchema as z } from "@shofer/types"

import { defineNativeTool } from "../../../tools/defineNativeTool.js"

const CREATE_DIRECTORY_DESCRIPTION = `Request to create a new directory. This tool creates a directory at the specified path, including any necessary parent directories.

Parameters:
- path: (required) Path of the directory to create, relative to the workspace

Example: Create a new directory
{ "path": "src/components" }`

const PATH_PARAMETER_DESCRIPTION = `Path of the directory to create, relative to the workspace`

export default defineNativeTool({
	name: "create_directory",
	description: CREATE_DIRECTORY_DESCRIPTION,
	schema: z.object({
		path: z.string().describe(PATH_PARAMETER_DESCRIPTION),
	}),
})
