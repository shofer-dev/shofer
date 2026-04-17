/**
 * SetTaskTitleTool - Allows the LLM to set a descriptive title for the current task.
 *
 * This is a meta-operation tool that updates the task's display name in the UI
 * and history. It does not require user approval since renaming is non-destructive.
 */

import { Task } from "../task/Task"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { ToolUse } from "../../shared/tools"

interface SetTaskTitleParams {
	title: string
}

export class SetTaskTitleTool extends BaseTool<"set_task_title"> {
	readonly name = "set_task_title" as const

	async execute(params: SetTaskTitleParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { title } = params
		const { handleError, pushToolResult } = callbacks

		try {
			// Validate required param
			if (!title) {
				task.consecutiveMistakeCount++
				task.recordToolError("set_task_title")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("set_task_title", "title"))
				return
			}

			task.consecutiveMistakeCount = 0

			// Clean and truncate the title (max 60 chars)
			const cleanTitle = title.trim().substring(0, 60)

			if (!cleanTitle) {
				task.recordToolError("set_task_title")
				task.didToolFailInCurrentTurn = true
				pushToolResult("Error: Title cannot be empty or whitespace only.")
				return
			}

			// Get provider reference to update the task history
			const provider = task.providerRef.deref()
			if (!provider) {
				task.recordToolError("set_task_title")
				task.didToolFailInCurrentTurn = true
				pushToolResult("Error: Unable to access provider to update task title.")
				return
			}

			// Get the current task's history item and update its name
			try {
				const { historyItem } = await provider.getTaskWithId(task.taskId)
				await provider.updateTaskHistory({ ...historyItem, name: cleanTitle })

				// Also update managed task name if this is a managed task
				provider.renameManagedTask(task.taskId, cleanTitle)
			} catch (error) {
				task.recordToolError("set_task_title")
				task.didToolFailInCurrentTurn = true
				pushToolResult(
					`Error: Failed to update task title: ${error instanceof Error ? error.message : String(error)}`,
				)
				return
			}

			// No approval needed - this is a non-destructive meta-operation
			pushToolResult(`Task title set to: "${cleanTitle}"`)
		} catch (error) {
			await handleError("setting task title", error instanceof Error ? error : new Error(String(error)))
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"set_task_title">): Promise<void> {
		const title: string | undefined = block.params.title

		const partialMessage = JSON.stringify({
			tool: "setTaskTitle",
			title: title ?? "",
		})

		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const setTaskTitleTool = new SetTaskTitleTool()
