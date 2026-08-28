import { parametersSchema as z } from "@shofer/types"

import { defineNativeTool } from "../../../tools/defineNativeTool.js"

const LIST_BACKGROUND_TASKS_DESCRIPTION = `List tasks. With scope="children" (default), lists the child tasks this task started with new_task. With scope="peers", lists all tasks sharing the same root task (siblings, aunts/uncles, grandchildren) — not just direct children. Returns each task's ID, title, current status, and creation timestamp. Use it to find the task id you need for send_message, check_task_status or cancel_tasks.`

const SCOPE_DESCRIPTION = `"children" (default): list only this task's direct background children. "peers": list all tasks sharing the same rootTaskId, excluding self.`

export default defineNativeTool({
	name: "list_background_tasks",
	description: LIST_BACKGROUND_TASKS_DESCRIPTION,
	schema: z.object({
		scope: z.enum(["children", "peers"]).describe(SCOPE_DESCRIPTION).optional(),
	}),
})
