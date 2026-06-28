import { parametersSchema as z } from "@shofer/types"

import { defineNativeTool } from "./defineNativeTool"

/**
 * Tool schema for setting the task/conversation title.
 *
 * This tool allows the LLM to provide a meaningful, descriptive title
 * for the current task after understanding the user's request, rather
 * than relying on the auto-generated truncated first-message text.
 */

const SET_TASK_TITLE_DESCRIPTION = `Set a short, descriptive title for the current task/conversation. Use this early in a conversation to replace the auto-generated title with something meaningful. Keep titles concise (under 60 characters).`

const TITLE_PARAMETER_DESCRIPTION = `Short descriptive title for this task (max 60 characters)`

export default defineNativeTool({
	name: "set_task_title",
	description: SET_TASK_TITLE_DESCRIPTION,
	schema: z.object({
		title: z.string().describe(TITLE_PARAMETER_DESCRIPTION),
	}),
})
