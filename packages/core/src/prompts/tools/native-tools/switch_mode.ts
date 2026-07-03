import { parametersSchema as z } from "@shofer/types"

import { defineNativeTool } from "../../../tools/defineNativeTool.js"

const SWITCH_MODE_DESCRIPTION = `Request to switch to a different mode. This tool allows modes to request switching to another mode when needed, such as switching to Code mode to make code changes. The user must approve the mode switch. When the optional \`task_id\` parameter is provided, the mode switch is applied to the specified child task instead of the calling task — this allows a parent to control the mode of its background children.`

const MODE_SLUG_PARAMETER_DESCRIPTION = `Slug of the mode to switch to (e.g., code, ask, architect)`

const REASON_PARAMETER_DESCRIPTION = `Explanation for why the mode switch is needed`

const TASK_ID_PARAMETER_DESCRIPTION = `Optional task ID of a background child task to switch the mode of. When omitted, the mode switch applies to the calling task itself.`

export default defineNativeTool({
	name: "switch_mode",
	description: SWITCH_MODE_DESCRIPTION,
	schema: z.object({
		mode_slug: z.string().describe(MODE_SLUG_PARAMETER_DESCRIPTION),
		reason: z.string().describe(REASON_PARAMETER_DESCRIPTION),
		task_id: z.string().describe(TASK_ID_PARAMETER_DESCRIPTION).optional(),
	}),
})
