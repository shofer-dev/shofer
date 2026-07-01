import { parametersSchema as z } from "@shofer/types"

import { defineNativeTool } from "@shofer/core"

const CANCEL_TASKS_DESCRIPTION = `Stop one or more background child tasks. Already-completed or errored tasks are unaffected. Use this to terminate redundant parallel work — for example, when one search subtask found the answer and the others are no longer needed.`

export default defineNativeTool({
	name: "cancel_tasks",
	description: CANCEL_TASKS_DESCRIPTION,
	schema: z.object({
		task_ids: z.array(z.string()).describe("One or more task IDs of background child tasks to stop."),
	}),
})
