import { parametersSchema as z } from "@shofer/types"

import { defineNativeTool } from "@shofer/core"

/**
 * Tool schema for sending feedback to the Shofer.Dev developers.
 *
 * Always-available, harmless meta-operation. The feedback message is
 * appended to the Shofer extension output channel for the user (and
 * developers) to inspect, and is acknowledged back to the model.
 */

const GIVE_FEEDBACK_DESCRIPTION = `Send feedback to the Shofer.Dev developers. Use this tool to report issues, suggest improvements, or provide any other feedback about the Shofer platform and its tools. The feedback is appended to the Shofer output channel.`

const FEEDBACK_PARAMETER_DESCRIPTION = `The feedback message to send to the Shofer.Dev developers.`

export default defineNativeTool({
	name: "give_feedback",
	description: GIVE_FEEDBACK_DESCRIPTION,
	schema: z.object({
		feedback: z.string().describe(FEEDBACK_PARAMETER_DESCRIPTION),
	}),
})
