import { parametersSchema as z } from "@shofer/types"

import { defineNativeTool } from "./defineNativeTool"

const LIST_BACKGROUND_TASKS_DESCRIPTION = `List background tasks. With scope="children" (default), lists all background child tasks that were started by this task using new_task with is_background=true. With scope="peers", lists all tasks sharing the same root task (siblings, aunts/uncles, grandchildren) — not just direct children. Returns each task's ID, title, current status, and creation timestamp.`

const SCOPE_DESCRIPTION = `"children" (default): list only this task's direct background children. "peers": list all tasks sharing the same rootTaskId, excluding self.`

export default defineNativeTool({
	name: "list_background_tasks",
	description: LIST_BACKGROUND_TASKS_DESCRIPTION,
	schema: z.object({
		scope: z.enum(["children", "peers"]).describe(SCOPE_DESCRIPTION).optional(),
	}),
})
