import type { BackgroundTaskStatus } from "@shofer/types"
import { TelemetryService } from "@shofer/telemetry"

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

		// Classify each id BEFORE asking approval so the chat-row preview
		// renders an accurate per-task verdict (was_running / already-terminal
		// / not-found). We do NOT mutate handle.status here; the actual abort
		// happens after the user approves (or auto-approval short-circuits).
		interface PlannedResult {
			task_id: string
			title?: string
			was_running: boolean
			status: BackgroundTaskStatus
			error?: string
			// Internal: present when we need to issue an abort after approval.
			abortTarget?: { id: string }
		}

		const plan: PlannedResult[] = task_ids.map((id) => {
			const handle = task.backgroundChildren.get(id)
			if (!handle) {
				return {
					task_id: id,
					was_running: false,
					status: "error",
					error: `Task ${id} not found in background children`,
				}
			}
			if (handle.status === "completed" || handle.status === "error" || handle.status === "cancelled") {
				return {
					task_id: id,
					title: getManagedTaskTitle(task, id),
					was_running: false,
					status: handle.status,
				}
			}
			const wasRunning =
				handle.status === "running" ||
				handle.status === "waiting" ||
				handle.status === "waiting_for_parent" ||
				handle.status === "starting"
			return {
				task_id: id,
				title: getManagedTaskTitle(task, id),
				was_running: wasRunning,
				// Optimistic — corrected to "error" below if abort throws.
				status: "cancelled",
				abortTarget: { id },
			}
		})

		// Render the chat row first (with optimistic outcomes) so the user
		// sees a complete preview, then perform the destructive abort step.
		const completeMessage = JSON.stringify({
			tool: "cancelTasks",
			task_ids,
			results: plan.map((r) => ({
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

		// Now perform the aborts. We mutate `plan` in place to record the
		// authoritative outcome and to flip handle.status accordingly.
		const provider = task.providerRef.deref()
		for (const r of plan) {
			if (!r.abortTarget) continue
			const handle = task.backgroundChildren.get(r.abortTarget.id)
			if (!handle) continue

			if (provider) {
				const liveInstance = provider.taskManager.getManagedTaskInstance(r.abortTarget.id)
				if (liveInstance) {
					try {
						await liveInstance.abortTask(false)
					} catch (err) {
						r.status = "error"
						r.error = `Failed to abort: ${err instanceof Error ? err.message : String(err)}`
						handle.status = "error"
						continue
					}
				}
			}
			handle.status = "cancelled"
			if (TelemetryService.hasInstance()) {
				TelemetryService.instance.captureTaskCancelled(r.abortTarget.id)
			}
		}

		const canceledCount = plan.filter((r) => r.status === "cancelled" && r.was_running).length
		const alreadyDoneCount = plan.filter((r) => !r.was_running && !r.error).length
		const errorCount = plan.filter((r) => !!r.error).length

		const summaryLines: string[] = []
		summaryLines.push(`Canceled: ${canceledCount} task(s)`)
		if (alreadyDoneCount > 0) {
			summaryLines.push(`Already terminal: ${alreadyDoneCount} task(s)`)
		}
		if (errorCount > 0) {
			summaryLines.push(`Errors: ${errorCount} task(s)`)
		}
		summaryLines.push("")
		for (const r of plan) {
			const displayName = r.title ?? r.task_id
			if (r.error) {
				summaryLines.push(`${displayName}: ERROR — ${r.error}`)
			} else if (r.was_running) {
				summaryLines.push(`${displayName}: cancelled`)
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
