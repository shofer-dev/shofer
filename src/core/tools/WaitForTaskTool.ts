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
		const { askApproval, pushToolResult } = callbacks

		// Finalize the streaming partial "tool" ask so the ChatRow shows a complete
		// entry instead of a dangling partial. Auto-approval marks this tool as
		// always-approved (see src/core/auto-approval/index.ts), so this does not
		// block on user input.
		const completeMessage = JSON.stringify({
			tool: "waitForTask",
			task_id,
			timeout,
		})
		const didApprove = await askApproval("tool", completeMessage)
		if (!didApprove) {
			return
		}

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

		// Authoritative-status resolution order:
		//   1. In-memory `handle.status` — AttemptCompletionTool sets this to
		//      "completed" the instant the background child finishes, before the
		//      managed Task instance is cleaned up. It is the fastest and most
		//      reliable terminal indicator.
		//   2. Persisted HistoryItem.status — survives process boundaries.
		//   3. Live managed Task instance — only meaningful if the task has NOT
		//      yet reached a terminal state.
		//
		// Previously this tool jumped straight to step 3 and entered an
		// event-driven wait whenever `getManagedTaskInstance` returned a value.
		// Because the managed instance lingers in the TaskManager maps after the
		// child has already completed and emitted `managedTask:completed`, the
		// listener was registered too late and the wait timed out — reporting
		// "running" even though both handle.status and the persisted history
		// said "completed". Check the authoritative sources first.

		const readPersistedStatus = async (): Promise<"completed" | "error" | "pending"> => {
			try {
				const { historyItem } = await provider.getTaskWithId(task_id)
				if (historyItem.status === "completed") return "completed"
				// A persisted status of "active" / "delegated" is not terminal for
				// the purposes of wait_for_task — the task may still be running.
				return "pending"
			} catch (_) {
				// No persisted history yet — treat as pending, not error. The
				// child may simply not have saved its first history snapshot.
				return "pending"
			}
		}

		if (handle.status !== "completed" && handle.status !== "error") {
			const persisted = await readPersistedStatus()
			if (persisted === "completed") {
				handle.status = "completed"
			}
		}

		if (handle.status !== "completed" && handle.status !== "error") {
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

				const timer = setTimeout(async () => {
					// Timeout: re-check authoritative sources before giving up.
					// The task may have completed between our initial check and
					// now without us observing the event (race window).
					const persisted = await readPersistedStatus()
					if (persisted === "completed") {
						handle.status = "completed"
					} else {
						const stillLive = provider.taskManager.getManagedTaskInstance(task_id)
						handle.status = stillLive ? mapTaskStatus(stillLive.taskStatus) : "error"
					}
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
