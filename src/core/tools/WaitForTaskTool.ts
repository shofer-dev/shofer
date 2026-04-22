import { TaskStatus } from "@roo-code/types"
import type { BackgroundTaskStatus } from "@roo-code/types"

import { BaseTool, ToolCallbacks } from "./BaseTool"
import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import type { ToolUse } from "../../shared/tools"
import { readTaskMessages } from "../task-persistence/taskMessages"

const DEFAULT_TIMEOUT_SECONDS = 300

interface WaitForTaskParams {
	task_id: string
	timeout?: number
}

/** Map a live TaskStatus to BackgroundTaskStatus. */
function mapTaskStatus(taskStatus: TaskStatus): BackgroundTaskStatus {
	switch (taskStatus) {
		case TaskStatus.Interactive:
		case TaskStatus.Resumable:
		case TaskStatus.Idle:
			return "waiting"
		case TaskStatus.Running:
			return "running"
		case TaskStatus.None:
		default:
			return "error"
	}
}

export class WaitForTaskTool extends BaseTool<"wait_for_task"> {
	readonly name = "wait_for_task" as const

	async execute(params: WaitForTaskParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { task_id, timeout = DEFAULT_TIMEOUT_SECONDS } = params
		const { pushToolResult } = callbacks

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

		// If the task has already finished (no live instance), resolve immediately
		const liveTask = provider.taskManager.getManagedTaskInstance(task_id)
		if (!liveTask) {
			try {
				const { historyItem } = await provider.getTaskWithId(task_id)
				handle.status = historyItem.status === "completed" ? "completed" : "error"
			} catch (_) {
				handle.status = "error"
			}
		} else {
			// Event-driven wait: resolves when the task emits completed or error, or times out.
			// This is non-blocking for the Node event loop (no sleep-polling).
			await new Promise<void>((resolve) => {
				let settled = false

				const cleanup = () => {
					if (settled) return
					settled = true
					provider.taskManager.off("managedTask:completed", onComplete)
					provider.taskManager.off("managedTask:error", onError)
					clearTimeout(timer)
				}

				const onComplete = (completedId: string) => {
					if (completedId !== task_id) return
					handle.status = "completed"
					cleanup()
					resolve()
				}

				const onError = (erroredId: string) => {
					if (erroredId !== task_id) return
					handle.status = "error"
					cleanup()
					resolve()
				}

				const timer = setTimeout(() => {
					// Timeout: update status from live task if still running
					const stillLive = provider.taskManager.getManagedTaskInstance(task_id)
					handle.status = stillLive ? mapTaskStatus(stillLive.taskStatus) : "error"
					cleanup()
					resolve()
				}, timeout * 1000)

				provider.taskManager.on("managedTask:completed", onComplete)
				provider.taskManager.on("managedTask:error", onError)
			})
		}

		let result: string | undefined
		let errorText: string | undefined

		if (handle.status === "completed" || handle.status === "error") {
			const globalStoragePath = provider.contextProxy.globalStorageUri.fsPath
			const messages = await readTaskMessages({ taskId: task_id, globalStoragePath })
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

		const timedOut = handle.status === "running" || handle.status === "waiting"

		pushToolResult(
			`Task: ${task_id}\nStatus: ${handle.status}\n` +
				(timedOut ? `Timed out after ${timeout}s\n` : "") +
				(result ? `Result: ${result.slice(0, 1000)}\n` : "") +
				(errorText ? `Error: ${errorText.slice(0, 1000)}\n` : ""),
		)
	}

	override async handlePartial(task: Task, block: ToolUse<"wait_for_task">): Promise<void> {
		const partialMessage = JSON.stringify({
			tool: "waitForTask",
			task_id: block.params.task_id ?? "",
			timeout: block.params.timeout ?? DEFAULT_TIMEOUT_SECONDS,
		})
		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const waitForTaskTool = new WaitForTaskTool()
