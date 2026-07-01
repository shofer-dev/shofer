import { parametersSchema as z } from "@shofer/types"

import { defineNativeTool } from "@shofer/core"

const GET_PROJECT_SETUP_INFO_DESCRIPTION = `Request to get information about the project setup, including detected languages, frameworks, build systems, and package managers. This tool analyzes the workspace to determine the project configuration.

Parameters: None

Example: Get project setup info
{ }`

export default defineNativeTool({
	name: "get_project_setup_info",
	description: GET_PROJECT_SETUP_INFO_DESCRIPTION,
	schema: z.object({}),
})
