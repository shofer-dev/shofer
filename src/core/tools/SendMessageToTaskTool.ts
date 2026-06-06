import { TelemetryService } from "@shofer/telemetry"

import { BaseTool, ToolCallbacks } from "./BaseTool"
import { getManagedTaskTitle } from "./helpers/managedTaskTitle"
import { Task } from "../task/Task"
import type { TaskState } from "@shofer/types"
import { formatResponse } from "../prompts/responses"
import type { ToolUse } from "../../shared/tools"

const DEFAULT_TIMEOUT_SECONDS = 120

interface SendMessageToTaskParams {
	task_id: string
	message: string
	wait?: boolean | null
	timeout_sec?: number | null
}

export class SendMessageToTaskTool extends BaseTool<"send_message_to_task"> {
	readonly name = "send_message_to_task" as const

	async execute(params: SendMessageToTaskParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { task_id, message, wait, timeout_sec } = params
		const isSync = wait === true
		const effectiveTimeout = timeout_sec ?? DEFAULT_TIMEOUT_SECONDS
		const { askApproval, handleError, pushToolResult } = callbacks

		try {
			// --- Scope validation ---
			if (!task.rootTaskId) {
				pushToolResult(
					formatResponse.toolError(
						"send_message_to_task is only available to tasks spawned via new_task (rootTaskId required).",
					),
				)
				return
			}

			if (task_id === task.taskId) {
				pushToolResult(formatResponse.toolError("Cannot send a message to yourself."))
				return
			}

			// Both participants must be background tasks.
			if (!task.isBackgroundTask) {
				pushToolResult(
					formatResponse.toolError(
						"Peer messaging requires the caller to be a background task (is_background=true).",
					),
				)
				return
			}

			const provider = task.providerRef.deref()
			if (!provider) {
				pushToolResult(formatResponse.toolError("Provider reference lost"))
				return
			}

			// Resolve the target task.
			const targetInstance = provider.taskManager.getManagedTaskInstance(task_id)
			if (!targetInstance) {
				// Check persisted history for a resumable task.
				try {
					const { historyItem } = await provider.getTaskWithId(task_id)
					if (!historyItem.rootTaskId || historyItem.rootTaskId !== task.rootTaskId) {
						pushToolResult(formatResponse.toolError(`Task ${task_id} does not share your root task.`))
						return
					}
				} catch {
					pushToolResult(formatResponse.toolError(`Task ${task_id} is not reachable.`))
					return
				}
			} else {
				if (!targetInstance.isBackgroundTask) {
					pushToolResult(
						formatResponse.toolError(
							`Peer messaging requires the target task ${task_id} to be a background task.`,
						),
					)
					return
				}
				if (targetInstance.rootTaskId !== task.rootTaskId) {
					pushToolResult(formatResponse.toolError(`Task ${task_id} does not share your root task.`))
					return
				}
			}

			// Check least-privilege peer scope: undefined ⇒ deny all.
			if (!task.knownPeers || !task.knownPeers.has(task_id)) {
				pushToolResult(formatResponse.toolError(`Task ${task_id} is not in your allowed peer set.`))
				return
			}

			// Resolve target state for delivery model.
			const targetState = provider.taskManager.getManagedTaskInstance(task_id)

			// Reject unreachable targets. Reject, don't drop — both async and sync
			// fail loud so the sender can react instead of assuming silent delivery.
			if (!targetState) {
				// Check if resumable from persisted history.
				try {
					const { historyItem } = await provider.getTaskWithId(task_id)
					const lifecycle = historyItem.taskState?.lifecycle
					if (lifecycle === "error") {
						pushToolResult(
							formatResponse.toolError(`Task ${task_id} has errored and cannot receive messages.`),
						)
						return
					}
				} catch {
					pushToolResult(formatResponse.toolError(`Task ${task_id} is not reachable.`))
					return
				}
			} else {
				const targetManaged = provider.taskManager.getManagedTask(task_id)
				const lifecycle = targetManaged?.state?.lifecycle
				if (lifecycle === "error") {
					pushToolResult(formatResponse.toolError(`Task ${task_id} has errored and cannot receive messages.`))
					return
				}
			}

			// Resolve sender title.
			const senderTitle = getManagedTaskTitle(task, task.taskId) ?? task.taskId

			// Render chat-row via approval path.
			const completeMessage = JSON.stringify({
				tool: "sendMessageToTask",
				task_id,
				message,
				wait: isSync,
				timeout: effectiveTimeout,
			})
			const didApprove = await askApproval("tool", completeMessage)
			if (!didApprove) {
				return
			}

			if (isSync) {
				// --- Sync mode: blocking wait ---

				// 1. Check for existing sync prompt on this recipient.
				if (provider.hasPendingSyncResolver(task_id)) {
					pushToolResult(
						formatResponse.toolError(
							`Task ${task_id} is already serving a sync request and cannot accept another until it completes.`,
						),
					)
					return
				}

				// 2. Enqueue an annotated user-turn via the recipient's MessageQueueService.
				const promptText =
					`PEER PROMPT from task ${task.taskId} ("${senderTitle}"):\n` +
					`${message}\n\n` +
					`This is a synchronous request. The sender is blocked waiting for your response.\n` +
					`Provide your answer by calling attempt_completion — its result is returned to\n` +
					`whoever initiated this prompt (the blocked sender, peer or parent). Calling\n` +
					`attempt_completion completes this task.\n` +
					`Timeout: ${effectiveTimeout} seconds. If you do not respond in time, the request\n` +
					`will be discarded and the sender will receive a timeout error.`

				const queuedMessage = targetState ? targetState.messageQueueService.addMessage(promptText, []) : null
				const queuedMessageId = queuedMessage?.id

				if (!queuedMessageId) {
					pushToolResult(formatResponse.toolError(`Task ${task_id} is not reachable for sync delivery.`))
					return
				}

				// 3. Register a sync resolver for this recipient.
				const responsePromise = provider.registerPendingSyncResolver(task_id, task.taskId)

				// 4. Block with AbortSignal-backed timeout (Cooperative Cancellation Rule).
				const abortController = new AbortController()
				const timeoutId = setTimeout(() => abortController.abort(), effectiveTimeout * 1000)
				let taskAbortHandler: (() => void) | undefined

				// Wire the task's abort signal into our controller.
				if (task.abortSignal?.aborted) {
					abortController.abort()
				} else if (task.abortSignal) {
					taskAbortHandler = () => abortController.abort()
					task.abortSignal.addEventListener("abort", taskAbortHandler)
				}

				let syncResult: string
				try {
					syncResult = await new Promise<string>((resolve, reject) => {
						if (abortController.signal.aborted) {
							reject(new Error("ABORTED"))
							return
						}
						const onAbort = () => reject(new Error("ABORTED"))
						abortController.signal.addEventListener("abort", onAbort, { once: true })
						responsePromise.then(
							(r) => {
								abortController.signal.removeEventListener("abort", onAbort)
								resolve(r)
							},
							(err) => {
								abortController.signal.removeEventListener("abort", onAbort)
								reject(err)
							},
						)
					})
				} catch (_err) {
					// Timeout or abort — try to retract the message from the queue.
					const removed =
						queuedMessageId && targetState
							? targetState.messageQueueService.removeMessage(queuedMessageId)
							: false
					provider.clearPendingSyncResolver(task_id)
					const reason = abortController.signal.aborted ? "aborted" : "timed out"
					if (removed) {
						pushToolResult(
							formatResponse.toolError(
								`No response from task ${task_id} (${reason}). The message was retracted.`,
							),
						)
					} else {
						pushToolResult(formatResponse.toolError(`No response from task ${task_id} (${reason}).`))
					}
					return
				} finally {
					// Clean up task abort listener and timeout on both success and failure.
					if (task.abortSignal && taskAbortHandler) {
						task.abortSignal.removeEventListener("abort", taskAbortHandler)
					}
					clearTimeout(timeoutId)
				}

				// 5. Success — deliver result.
				pushToolResult(syncResult)

				// Telemetry: message sent.
				try {
					TelemetryService.instance.capturePeerMessageSent(task.taskId, {
						mode: "sync",
						status: "delivered",
						targetTaskId: task_id,
					})
				} catch {
					// non-fatal
				}
			} else {
				// --- Async mode: fire-and-forget ---
				// All async peer messages go into the recipient's dedicated
				// peerNotificationQueue FIFO, which is drained at the start of the
				// next agent loop via system-prompt injection (see Task.getSystemPrompt).
				// There is no Form A / Form B distinction — everything is delivered
				// uniformly.  This queue is independent of the MessageQueueService,
				// which is reserved for user messages and sync prompts.
				if (targetState) {
					targetState.peerNotificationQueue.push({
						senderTaskId: task.taskId,
						senderTitle,
						message,
						timestamp: Date.now(),
					})
				}
				// Note: if there's no live instance (task is not running but is
				// resumable from persisted history), the message cannot be delivered.
				// This is a documented gap (see docs/task_messaging.md).

				// Telemetry: message enqueued to peerNotificationQueue.
				try {
					TelemetryService.instance.capturePeerMessageSent(task.taskId, {
						mode: "async",
						status: "delivered",
						targetTaskId: task_id,
					})
				} catch {
					// non-fatal
				}

				pushToolResult(
					`Message sent to task ${task_id} ("${getManagedTaskTitle(task, task_id) ?? task_id}"). Delivery: on the recipient's next turn (resuming it if idle).`,
				)
			}
		} catch (error) {
			await handleError("sending peer message", error instanceof Error ? error : new Error(String(error)))
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"send_message_to_task">): Promise<void> {
		const partialMessage = JSON.stringify({
			tool: "sendMessageToTask",
			task_id: block.params.task_id ?? "",
			wait: block.params.wait ?? false,
		})
		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const sendMessageToTaskTool = new SendMessageToTaskTool()
