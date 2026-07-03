import { parametersSchema as z } from "@shofer/types"

import { defineNativeTool } from "../../../tools/defineNativeTool.js"

const RUN_SLASH_COMMAND_DESCRIPTION = `Execute a slash command to get specific instructions or content. Slash commands are predefined templates that provide detailed guidance for common tasks.`

const COMMAND_PARAMETER_DESCRIPTION = `Name of the slash command to run (e.g., init, test, deploy)`

const ARGS_PARAMETER_DESCRIPTION = `Optional additional context or arguments for the command`

export default defineNativeTool({
	name: "run_slash_command",
	description: RUN_SLASH_COMMAND_DESCRIPTION,
	schema: z.object({
		command: z.string().describe(COMMAND_PARAMETER_DESCRIPTION),
		args: z.string().describe(ARGS_PARAMETER_DESCRIPTION).optional(),
	}),
})
