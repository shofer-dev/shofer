import type { BackgroundTaskStatus } from "@shofer/types"

import { BaseTool, ToolCallbacks } from "./BaseTool"
import { getManagedTaskTitle } from "./helpers/managedTaskTitle"
import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import type { ToolUse } from "../../shared/tools"

interface CancelTasksParams {
	task_ids: string[]
}

export class CancelTasksTool extends BaseTool<"cancel_tasks"> {
	readonly name = "cancel_tasks" as const

	async execute(params: CancelTasksParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { task_ids } = params
		const { askApproval, pushToolResult } = callbacks

		// Validate all task IDs exist in this task's background children.
		const results: Array<{
			task_id: string
			title?: string
			was_running: boolean
			status: BackgroundTaskStatus
			error?: string
		}> = []

		for (const id of task_ids) {
			const handle = task.backgroundChildren.get(id)
			if (!handle) {
				results.push({
					task_id: id,
					was_running: false,
					status: "error",
					error: `Task ${id} not found in background children`,
				})
				continue
			}

			// Already terminal — no-op.
			if (handle.status === "completed" || handle.status === "error") {
				results.push({
					task_id: id,
					title: getManagedTaskTitle(task, id),
					was_running: false,
					status: handle.status,
				})
				continue
			}

			const wasRunning =
				handle.status === "running" || handle.status === "waiting" || handle.status === "starting"

			// Abort the live child instance if still alive.
			const provider = task.providerRef.deref()
			if (provider) {
				const liveInstance = provider.taskManager.getManagedTaskInstance(id)
				if (liveInstance) {
					try {
						await liveInstance.abortTask(false)
					} catch (err) {
						results.push({
							task_id: id,
							title: getManagedTaskTitle(task, id),
							was_running: false,
							status: "error",
							error: `Failed to abort: ${err instanceof Error ? err.message : String(err)}`,
						})
						continue
					}
				}
			}

			// Mark the handle as cancelled.
			handle.status = "error"

			results.push({
				task_id: id,
				title: getManagedTaskTitle(task, id),
				was_running: wasRunning,
				status: "error",
			})
		}

		// Finalize the streaming partial "tool" ask.  Auto-approval marks this
		// tool as always-approved, so askApproval returns immediately.
		const completeMessage = JSON.stringify({
			tool: "cancelTasks",
			task_ids,
			results: results.map((r) => ({
				task_id: r.task_id,
				title: r.title,
				was_running: r.was_running,
				status: r.status,
				...(r.error ? { error: r.error } : {}),
			})),
		})
		const didApprove = await askApproval("tool", completeMessage)
		if (!didApprove) {
			return
		}

		const canceledCount = results.filter((r) => r.was_running).length
		const alreadyDoneCount = results.filter((r) => !r.was_running && !r.error).length
		const errorCount = results.filter((r) => r.error).length

		const summaryLines: string[] = []
		summaryLines.push(`Canceled: ${canceledCount} task(s)`)
		if (alreadyDoneCount > 0) {
			summaryLines.push(`Already completed: ${alreadyDoneCount} task(s)`)
		}
		if (errorCount > 0) {
			summaryLines.push(`Errors: ${errorCount} task(s)`)
		}
		summaryLines.push("")
		for (const r of results) {
			const displayName = r.title ?? r.task_id
			if (r.error) {
				summaryLines.push(`${displayName}: ERROR — ${r.error}`)
			} else if (r.was_running) {
				summaryLines.push(`${displayName}: stopped`)
			} else {
				summaryLines.push(`${displayName}: already ${r.status}`)
			}
		}

		pushToolResult(summaryLines.join("\n"))
	}

	override async handlePartial(task: Task, block: ToolUse<"cancel_tasks">): Promise<void> {
		const rawIds = block.params.task_ids
		const ids: string[] = Array.isArray(rawIds) ? rawIds : []
		const partialMessage = JSON.stringify({
			tool: "cancelTasks",
			task_ids: ids,
		})
		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const cancelTasksTool = new CancelTasksTool()
