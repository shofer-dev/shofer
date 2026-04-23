import { BaseTool, ToolCallbacks } from "./BaseTool"
import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import type { ToolUse } from "../../shared/tools"

type ListBackgroundTasksParams = Record<string, never>

export class ListBackgroundTasksTool extends BaseTool<"list_background_tasks"> {
	readonly name = "list_background_tasks" as const

	async execute(params: ListBackgroundTasksParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { askApproval, pushToolResult } = callbacks

		const tasks = Array.from(task.backgroundChildren.values()).map((h) => ({
			task_id: h.taskId,
			title: h.title,
			status: h.status,
			created_at: h.createdAt,
		}))

		// Finalize the streaming partial "tool" ask with the task snapshot so the
		// ChatRow can render a list of background children. Auto-approval marks
		// this tool as always-approved, so askApproval returns immediately.
		const completeMessage = JSON.stringify({
			tool: "listBackgroundTasks",
			tasks,
		})
		const didApprove = await askApproval("tool", completeMessage)
		if (!didApprove) {
			return
		}

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
