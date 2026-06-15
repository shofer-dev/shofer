/**
 * SetTaskTitleTool - Allows the LLM to set a descriptive title for the current task.
 *
 * This is a meta-operation tool that updates the task's display name in the UI
 * and history. It is auto-approved since renaming is non-destructive, but still
 * shows in the chat UI for visibility.
 */

import type { ToolUse } from "../../shared/tools"
import { Task } from "../task/Task"

import { BaseTool, ToolCallbacks } from "./BaseTool"

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

			// A title assigned by the spawning parent (via new_task's `title` param)
			// is locked — the task cannot rename itself over it. Reject without
			// touching the persisted name. Not a usage mistake worth penalizing, so
			// the consecutive-mistake counter is left untouched.
			if (task.nameLocked) {
				task.recordToolError("set_task_title")
				task.didToolFailInCurrentTurn = true
				pushToolResult(
					"Error: This task's title was set by its parent and cannot be changed with set_task_title.",
				)
				return
			}

			task.consecutiveMistakeCount = 0

			// Clean and truncate the title (max 60 chars)
			const cleanTitle = title.trim().substring(0, 60)

			// Validate before showing UI/approval — the empty-after-trim case is a usage
			// error, not an action worth surfacing to the user.
			if (!cleanTitle) {
				task.recordToolError("set_task_title")
				task.didToolFailInCurrentTurn = true
				pushToolResult("Error: Title cannot be empty or whitespace only.")
				return
			}

			// Auto-approved via checkAutoApproval, but still shows in chat UI for visibility.
			const didApprove = await this.askToolApproval(callbacks, {
				tool: "setTaskTitle",
				content: `Setting task title to: "${cleanTitle}"`,
			})
			if (!didApprove) {
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
