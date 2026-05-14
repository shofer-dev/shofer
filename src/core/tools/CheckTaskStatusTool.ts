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
				if (historyItem.taskExecutionState === "completed") {
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

		if (handle.status === "completed" || handle.status === "error") {
			const globalStoragePath = provider.contextProxy.globalStorageUri.fsPath
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

		pushToolResult(
			`Task: ${task_id}\nStatus: ${handle.status}\n` +
				(result ? `Result: ${result.slice(0, MAX_SUBTASK_RESULT_LENGTH)}\n` : "") +
				(errorText ? `Error: ${errorText.slice(0, MAX_SUBTASK_RESULT_LENGTH)}\n` : ""),
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
