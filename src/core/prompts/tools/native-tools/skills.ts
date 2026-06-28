import { parametersSchema as z } from "@shofer/types"

import { defineNativeTool } from "./defineNativeTool"

const SKILL_DESCRIPTION = `Load and execute a skill by name. Skills provide specialized instructions for common tasks like creating MCP servers or custom modes.

Use this tool when you need to follow specific procedures documented in a skill. Available skills are listed in the AVAILABLE SKILLS section of the system prompt.`

const SKILL_PARAMETER_DESCRIPTION = `Name of the skill to load (e.g., create-mcp-server, create-mode). Must match a skill name from the available skills list.`

const ARGS_PARAMETER_DESCRIPTION = `Optional context or arguments to pass to the skill`

export default defineNativeTool({
	name: "skills",
	description: SKILL_DESCRIPTION,
	schema: z.object({
		skill: z.string().describe(SKILL_PARAMETER_DESCRIPTION),
		args: z.string().describe(ARGS_PARAMETER_DESCRIPTION).optional(),
	}),
})
