import { TelemetryService } from "@shofer/telemetry"

import { BaseTool, ToolCallbacks } from "./BaseTool"
import { getManagedTaskTitle } from "./helpers/managedTaskTitle"
import { Task } from "../task/Task"
import type { TaskLifecycle } from "@shofer/types"
import { formatResponse } from "../prompts/responses"
import type { ToolUse } from "../../shared/tools"

const DEFAULT_TIMEOUT_SECONDS = 120

interface SendMessageToTaskParams {
	task_id: string
	message: string
	wait?: boolean | null
	timeout_sec?: number | null
}

/**
 * Helper: resolve the target task's lifecycle, falling back to persisted history
 * when there is no live instance. Returns the lifecycle (or "error" if the task
 * is not reachable at all) and whether the task is known to exist.
 */
async function resolveTargetLifecycle(
	task_id: string,
	provider: ReturnType<Task["providerRef"]["deref"]>,
): Promise<{ lifecycle: TaskLifecycle; exists: boolean }> {
	if (!provider) return { lifecycle: "error", exists: false }

	const targetState = provider.taskManager.getManagedTaskInstance(task_id)
	if (targetState) {
		const targetManaged = provider.taskManager.getManagedTask(task_id)
		return { lifecycle: targetManaged?.state?.lifecycle ?? "idle", exists: true }
	}

	// No live instance — check persisted history.
	try {
		const { historyItem } = await provider.getTaskWithId(task_id)
		return {
			lifecycle: historyItem.taskState?.lifecycle ?? "idle",
			exists: true,
		}
	} catch {
		return { lifecycle: "error", exists: false }
	}
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
			const effectiveRootId = task.rootTaskId ?? task.taskId

			if (task_id === task.taskId) {
				pushToolResult(formatResponse.toolError("Cannot send a message to yourself."))
				return
			}

			const provider = task.providerRef.deref()
			if (!provider) {
				pushToolResult(formatResponse.toolError("Provider reference lost"))
				return
			}

			// --- Unified target resolution ---
			const targetInstance = provider.taskManager.getManagedTaskInstance(task_id)

			if (targetInstance) {
				if (!targetInstance.isBackgroundTask) {
					pushToolResult(
						formatResponse.toolError(
							`Peer messaging requires the target task ${task_id} to be a background task.`,
						),
					)
					return
				}
				if (targetInstance.rootTaskId !== effectiveRootId) {
					pushToolResult(formatResponse.toolError(`Task ${task_id} does not share your root task.`))
					return
				}
			} else {
				try {
					const { historyItem } = await provider.getTaskWithId(task_id)
					if (!historyItem.rootTaskId || historyItem.rootTaskId !== effectiveRootId) {
						pushToolResult(formatResponse.toolError(`Task ${task_id} does not share your root task.`))
						return
					}
				} catch {
					pushToolResult(formatResponse.toolError(`Task ${task_id} is not reachable.`))
					return
				}
			}

			if (task.rootTaskId && (!task.knownPeers || !task.knownPeers.has(task_id))) {
				pushToolResult(formatResponse.toolError(`Task ${task_id} is not in your allowed peer set.`))
				return
			}

			// --- Deliverability check ---
			const { lifecycle, exists } = await resolveTargetLifecycle(task_id, provider)
			if (!exists) {
				pushToolResult(formatResponse.toolError(`Task ${task_id} is not reachable.`))
				return
			}
			if (lifecycle === "error") {
				pushToolResult(formatResponse.toolError(`Task ${task_id} has errored and cannot receive messages.`))
				return
			}

			// --- Rehydrate if no live instance but task is resumable ---
			let targetState = provider.taskManager.getManagedTaskInstance(task_id)
			if (!targetState) {
				try {
					const { historyItem } = await provider.getTaskWithId(task_id)
					await provider.createTaskWithHistoryItem(historyItem, { keepCurrentTask: true })
					targetState = provider.taskManager.getManagedTaskInstance(task_id)
				} catch {
					pushToolResult(formatResponse.toolError(`Task ${task_id} could not be rehydrated.`))
					return
				}
				if (!targetState) {
					pushToolResult(formatResponse.toolError(`Task ${task_id} is not reachable after rehydration.`))
					return
				}
			}

			// --- Busy check ---
			// Sync: fail-fast on all busy states (running/waiting_input/waiting).
			//   Sync-messaging a running peer would interrupt and terminate its
			//   in-flight work (attempt_completion is terminal), so reject — the
			//   sender should target an idle/completed peer or use async instead.
			// Async: fail-fast only on the transient non-running busy states
			//   (waiting_input/waiting), which have no clean injection point. A
			//   running peer is allowed: its live agent loop injects the
			//   peerNotificationQueue entry into the system prompt on the next turn.
			const targetBusyManaged = provider.taskManager.getManagedTask(task_id)
			const targetBusyLifecycle = targetBusyManaged?.state?.lifecycle
			if (targetBusyLifecycle) {
				if (isSync) {
					if (
						targetBusyLifecycle === "running" ||
						targetBusyLifecycle === "waiting_input" ||
						targetBusyLifecycle === "waiting"
					) {
						pushToolResult(
							formatResponse.toolError(
								`Task ${task_id} is busy (${targetBusyLifecycle}) and cannot accept a sync request. ` +
									`Use async send_message_to_task for non-interrupting coordination, ` +
									`or wait for the task to become idle.`,
							),
						)
						return
					}
				} else {
					if (targetBusyLifecycle === "waiting_input" || targetBusyLifecycle === "waiting") {
						pushToolResult(
							formatResponse.toolError(
								`Task ${task_id} is ${targetBusyLifecycle} and cannot accept messages until it becomes active.`,
							),
						)
						return
					}
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
				// Deliver the PEER PROMPT as an annotated user-turn (Form B) and
				// block until the recipient answers via attempt_completion (routed
				// back through the sync resolver) or the timeout fires. The
				// recipient is non-busy (validated above); if its loop has stopped
				// it is woken below.

				if (provider.hasPendingSyncResolver(task_id)) {
					pushToolResult(
						formatResponse.toolError(
							`Task ${task_id} is already serving a sync request and cannot accept another until it completes.`,
						),
					)
					return
				}

				const promptText =
					`PEER PROMPT from task ${task.taskId} ("${senderTitle}"):\n` +
					`${message}\n\n` +
					`This is a synchronous request. The sender is blocked waiting for your response.\n` +
					`Provide your answer by calling attempt_completion — its result is returned to\n` +
					`whoever initiated this prompt (the blocked sender, peer or parent). Calling\n` +
					`attempt_completion completes this task.\n` +
					`Timeout: ${effectiveTimeout} seconds. If you do not respond in time, the request\n` +
					`will be discarded and the sender will receive a timeout error.`

				// Deliver as an annotated user-turn via the recipient's
				// MessageQueueService (Form B) — the same well-tested path the
				// webview "Send"/queueMessage flow uses. Capture the queued id so
				// the prompt can be retracted on timeout/abort.
				const queuedMessage = targetState.messageQueueService.addMessage(promptText, [])
				// addMessage returns undefined only when both text and images are empty;
				// promptText is always non-empty here, but guard for type-safety.
				if (!queuedMessage) {
					pushToolResult(formatResponse.toolError(`Failed to queue peer prompt for task ${task_id}.`))
					return
				}
				const queuedMessageId = queuedMessage.id

				// Register the sync resolver BEFORE waking the recipient so the
				// resolver is already in place when the recipient eventually calls
				// attempt_completion.
				const responsePromise = provider.registerPendingSyncResolver(task_id, task.taskId)

				// Wake/resume a non-running recipient. A completed/paused/idle-
				// aborted recipient (abort === true) has no live loop to drain the
				// queue; cancelAndProcessQueuedMessages restarts it with the queued
				// PEER PROMPT, mirroring the webview queueMessage handler. A still-
				// running recipient drains the queue on its next Task.ask().
				if (targetState.abort) {
					void targetState.cancelAndProcessQueuedMessages()
				}

				// Block with AbortSignal-backed timeout (Cooperative Cancellation Rule).
				const abortController = new AbortController()
				const timeoutId = setTimeout(() => abortController.abort(), effectiveTimeout * 1000)
				let taskAbortHandler: (() => void) | undefined

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
					// Timeout or abort — retract the still-queued PEER PROMPT so a
					// recipient that has not yet consumed it never sees a request the
					// sender already abandoned. If it was already consumed, removeMessage
					// is a no-op and any later reply is discarded (the sender is gone).
					targetState.messageQueueService.removeMessage(queuedMessageId)
					provider.clearPendingSyncResolver(task_id)
					const reason = abortController.signal.aborted ? "aborted" : "timed out"
					pushToolResult(formatResponse.toolError(`No response from task ${task_id} (${reason}).`))
					return
				} finally {
					if (task.abortSignal && taskAbortHandler) {
						task.abortSignal.removeEventListener("abort", taskAbortHandler)
					}
					clearTimeout(timeoutId)
				}

				pushToolResult(syncResult)

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
				// Delivery form depends on the recipient's runtime state:
				//   - running: Form A (system-prompt injection via
				//     peerNotificationQueue). The live agent loop injects the
				//     notification on its next turn — no wake needed.
				//   - idle/completed/paused: Form B (annotated user-turn via
				//     MessageQueueService) that wakes/resumes the recipient,
				//     mirroring the webview queueMessage handler. A passive
				//     system-prompt injection would never be seen by a recipient
				//     whose loop has already stopped (the liveness trap).
				if (targetBusyLifecycle === "running") {
					targetState.peerNotificationQueue.push({
						senderTaskId: task.taskId,
						senderTitle,
						message,
						timestamp: Date.now(),
					})
				} else {
					const promptText =
						`PEER MESSAGE from task ${task.taskId} ("${senderTitle}"):\n` +
						`${message}\n\n` +
						`You may respond using send_message_to_task(task_id="${task.taskId}", message=...).\n` +
						`This is a notification — no response is required. If the message is not urgent,\n` +
						`you may finish your current work first and respond later.`

					targetState.messageQueueService.addMessage(promptText, [])

					if (targetState.abort) {
						void targetState.cancelAndProcessQueuedMessages()
					}
				}

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
					`Message sent to task ${task_id} ("${getManagedTaskTitle(task, task_id) ?? task_id}"). ` +
						`Delivery: on the recipient's next turn (resuming it if idle).`,
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
