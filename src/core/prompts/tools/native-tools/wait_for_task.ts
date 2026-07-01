import { parametersSchema as z } from "@shofer/types"

import { defineNativeTool } from "@shofer/core"

const WAIT_FOR_TASK_DESCRIPTION = `Block until one or more background child tasks (started with new_task using is_background=true) or peer tasks sharing your root task complete, then return their results. Use the \`wait\` parameter to control whether to wait for ALL tasks or just ANY one of them. The call is event-driven — it does not poll. Use this after starting background tasks when you need their results before continuing.`

const TASK_IDS_PARAMETER_DESCRIPTION = `One or more task IDs returned when the background tasks were started. Accepts a single ID or a list of IDs.`

const WAIT_PARAMETER_DESCRIPTION = `Completion strategy. "all" (default) — waits until every listed task reaches a terminal state. "any" — returns as soon as at least one task completes successfully. Omit or pass null to use the default ("all").`

const TIMEOUT_PARAMETER_DESCRIPTION = `Maximum seconds to wait before returning. Default: 120. If the condition is not met within the timeout the tool returns with the current statuses. Omit or pass null to use the default.`

export default defineNativeTool({
	name: "wait_for_task",
	description: WAIT_FOR_TASK_DESCRIPTION,
	schema: z.object({
		task_ids: z.array(z.string()).describe(TASK_IDS_PARAMETER_DESCRIPTION),
		wait: z.enum(["all", "any"]).describe(WAIT_PARAMETER_DESCRIPTION).optional(),
		timeout: z.number().describe(TIMEOUT_PARAMETER_DESCRIPTION).optional(),
	}),
})
