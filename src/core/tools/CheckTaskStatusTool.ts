import { TaskStatus } from "@shofer/types"
import type { BackgroundTaskStatus } from "@shofer/types"

import { BaseTool, ToolCallbacks } from "./BaseTool"
import { getManagedTaskTitle } from "./helpers/managedTaskTitle"
import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import type { ToolUse } from "../../shared/tools"
import { readTaskMessages } from "../task-persistence/taskMessages"
import { MAX_SUBTASK_RESULT_LENGTH } from "./NewTaskTool"

interface CheckTaskStatusParams {
	task_id: string
	include_activity?: boolean | null
}

/** Map a Task's runtime TaskStatus to our BackgroundTaskStatus representation. */
function mapTaskStatusToBackground(taskStatus: TaskStatus): BackgroundTaskStatus {
	switch (taskStatus) {
		case TaskStatus.Interactive:
		case TaskStatus.Resumable:
			return "waiting"
		case TaskStatus.Idle:
			return "waiting"
		case TaskStatus.Running:
			return "running"
		case TaskStatus.None:
		default:
			return "error"
	}
}

export class CheckTaskStatusTool extends BaseTool<"check_task_status"> {
	readonly name = "check_task_status" as const

	async execute(params: CheckTaskStatusParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { task_id } = params
		const { askApproval, pushToolResult } = callbacks

		// Check if task is tracked by this parent.
		const handle = task.backgroundChildren.get(task_id)
		if (!handle) {
			pushToolResult(formatResponse.toolError(`Task ${task_id} not found in background children`))
			return
		}

		const provider = task.providerRef.deref()
		if (!provider) {
			pushToolResult(formatResponse.toolError("Provider reference lost"))
			return
		}

		// Finalize the streaming partial "tool" ask so the ChatRow shows a complete
		// entry. Auto-approval marks this tool as always-approved, so askApproval
		// returns immediately without blocking on user input.
		const completeMessage = JSON.stringify({
			tool: "checkTaskStatus",
			task_id,
			task_title: getManagedTaskTitle(task, task_id),
		})
		const didApprove = await askApproval("tool", completeMessage)
		if (!didApprove) {
			return
		}

		// Authoritative-status resolution order (see WaitForTaskTool for rationale):
		//   1. `handle.status` if already terminal — AttemptCompletionTool marks
		//      background children "completed" before the managed instance is
		//      cleaned up, and live-instance inspection would incorrectly
		//      downgrade that to "running".
		//   2. Persisted HistoryItem.status — survives process restarts.
		//   3. Live managed Task instance — only consulted when no terminal
		//      verdict is available from (1) or (2).
		if (handle.status !== "completed" && handle.status !== "error") {
			let resolvedFromHistory = false
			try {
				const { historyItem } = await provider.getTaskWithId(task_id)
				if (historyItem.taskState?.lifecycle === "completed") {
					handle.status = "completed"
					resolvedFromHistory = true
				}
			} catch (_) {
				// No persisted history yet — fall through to live check.
			}

			if (!resolvedFromHistory) {
				const liveTask = provider.taskManager.getManagedTaskInstance(task_id)
				if (liveTask) {
					handle.status = mapTaskStatusToBackground(liveTask.taskStatus)
				} else {
					handle.status = "error"
				}
			}
		}

		let result: string | undefined
		let errorText: string | undefined
		let recentActivity: string | undefined

		const globalStoragePath = provider.contextProxy.globalStorageUri.fsPath

		if (handle.status === "completed" || handle.status === "error") {
			const messages = await readTaskMessages({ taskId: task_id, globalStoragePath })
			// Find the last completion or error message
			for (let i = messages.length - 1; i >= 0; i--) {
				const msg = messages[i]
				if (msg.type === "say" && msg.say === "completion_result") {
					result = msg.text
					break
				}
				if (msg.type === "say" && msg.say === "error") {
					errorText = msg.text
					break
				}
			}
		}

		// When include_activity is true, surface the child's most recent tool
		// calls or messages so the parent can see what the child is currently
		// doing (useful for deciding whether to wait or cancel).
		if (params.include_activity) {
			try {
				const messages = await readTaskMessages({ taskId: task_id, globalStoragePath })
				// Collect the last 3 tool-use or say messages for context.
				const activityLines: string[] = []
				let collected = 0
				for (let i = messages.length - 1; i >= 0 && collected < 3; i--) {
					const msg = messages[i]
					if (
						msg.type === "say" &&
						(msg.say === "text" || msg.say === "completion_result" || msg.say === "error")
					) {
						const snippet = (msg.text ?? "").replace(/\n/g, " ").slice(0, 120)
						activityLines.unshift(`[say:${msg.say}] ${snippet}`)
						collected++
					} else if (msg.type === "say" && msg.say === "tool") {
						// The "tool" message is a JSON blob; try to extract tool name + args summary.
						try {
							const parsed = JSON.parse(msg.text ?? "{}")
							activityLines.unshift(`[tool] ${parsed.tool ?? "unknown"}`)
						} catch {
							activityLines.unshift("[tool] (parsing failed)")
						}
						collected++
					}
				}
				if (activityLines.length > 0) {
					recentActivity = "Recent activity:\n" + activityLines.map((l) => `  ${l}`).join("\n")
				}
			} catch {
				// Non-fatal: activity feed is best-effort.
			}
		}

		// Surface a pending parent question if the child is waiting for input
		// from the parent (ask_followup_question routed to parent).
		let pendingQuestionText: string | undefined
		try {
			const liveInstance = provider.taskManager.getManagedTaskInstance(task_id)
			const pq = (liveInstance as any)?._pendingParentQuestion
			if (pq) {
				pendingQuestionText = `\nPending parent question: "${pq.question}"\nSuggestions: ${pq.suggestions?.map((s: any) => `"${s.answer}"`).join(", ") ?? "none"}`
			}
		} catch {
			// Non-fatal.
		}

		pushToolResult(
			`Task: ${task_id}\nStatus: ${handle.status}\n` +
				(result ? `Result: ${result.slice(0, MAX_SUBTASK_RESULT_LENGTH)}\n` : "") +
				(errorText ? `Error: ${errorText.slice(0, MAX_SUBTASK_RESULT_LENGTH)}\n` : "") +
				(recentActivity ? `\n${recentActivity}` : "") +
				(pendingQuestionText ?? ""),
		)
	}

	override async handlePartial(task: Task, block: ToolUse<"check_task_status">): Promise<void> {
		const partialMessage = JSON.stringify({
			tool: "checkTaskStatus",
			task_id: block.params.task_id ?? "",
		})
		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const checkTaskStatusTool = new CheckTaskStatusTool()
