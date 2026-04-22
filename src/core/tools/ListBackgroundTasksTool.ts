import { BaseTool, ToolCallbacks } from "./BaseTool"
import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import type { ToolUse } from "../../shared/tools"

type ListBackgroundTasksParams = Record<string, never>

export class ListBackgroundTasksTool extends BaseTool<"list_background_tasks"> {
	readonly name = "list_background_tasks" as const

	async execute(params: ListBackgroundTasksParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pushToolResult } = callbacks

		const tasks = Array.from(task.backgroundChildren.values()).map((h) => ({
			task_id: h.taskId,
			status: h.status,
			created_at: h.createdAt,
		}))

		pushToolResult(JSON.stringify({ tasks }, null, 2))
	}

	override async handlePartial(task: Task, block: ToolUse<"list_background_tasks">): Promise<void> {
		const partialMessage = JSON.stringify({
			tool: "listBackgroundTasks",
		})
		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const listBackgroundTasksTool = new ListBackgroundTasksTool()
