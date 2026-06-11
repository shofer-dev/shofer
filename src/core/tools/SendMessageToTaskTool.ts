import { TelemetryService } from "@shofer/telemetry"

import { BaseTool, ToolCallbacks } from "./BaseTool"
import { getManagedTaskTitle } from "./helpers/managedTaskTitle"
import { Task } from "../task/Task"
import type { TaskState, TaskLifecycle } from "@shofer/types"
import { formatResponse } from "../prompts/responses"
import type { ToolUse } from "../../shared/tools"

const DEFAULT_TIMEOUT_SECONDS = 120

/** Lifecycle values where the task is not actively processing a turn. */
const NON_BUSY_LIFECYCLES: ReadonlySet<TaskLifecycle> = new Set(["idle", "completed", "paused", "error"])

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
			// Lifetimes where the target is actively doing work and cannot
			// accept a peer message. Messages must fail fast instead of
			// being queued behind in-progress work.
			const BUSY_LIFECYCLES: TaskLifecycle[] = ["running", "waiting_input", "waiting"]

			// --- Scope validation ---
			// The root task (user-initiated, not spawned via new_task) has
			// no rootTaskId because it IS the root. Use its own taskId as the
			// effective root for peer scope validation, consistent with
			// NewTaskTool and ListBackgroundTasksTool.
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
			// Check live instance first, then persisted history.
			const targetInstance = provider.taskManager.getManagedTaskInstance(task_id)

			if (targetInstance) {
				// Live instance — validate scope and deliverability.
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
				// No live instance — check persisted history.
				try {
					const { historyItem } = await provider.getTaskWithId(task_id)
					if (!historyItem.rootTaskId || historyItem.rootTaskId !== effectiveRootId) {
						pushToolResult(formatResponse.toolError(`Task ${task_id} does not share your root task.`))
						return
					}
					// isBackgroundTask is a runtime-only flag; persisted tasks from
					// new_task(is_background=true) implicitly qualify. A manually-
					// created top-level task without rootTaskId was already rejected.
				} catch {
					pushToolResult(formatResponse.toolError(`Task ${task_id} is not reachable.`))
					return
				}
			}

			// Check least-privilege peer scope: undefined ⇒ deny all, except
			// for the root task (no rootTaskId) which is omnipotent within its
			// own tree — it has no knownPeers because it wasn't spawned.
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
				// The task has persisted history and is not "error". Rehydrate it
				// so we have a live MessageQueueService to enqueue into. Follow
				// the same pattern as WorkflowTask.resumeAgentTask.
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

			// Reject messages to busy targets — fail fast instead of queueing.
			const targetManagedForBusy = provider.taskManager.getManagedTask(task_id)
			const targetLifecycle = targetManagedForBusy?.state?.lifecycle
			if (targetLifecycle && BUSY_LIFECYCLES.includes(targetLifecycle)) {
				pushToolResult(
					formatResponse.toolError(
						`Task ${task_id} is busy (${targetLifecycle}) and cannot accept messages until it finishes.`,
					),
				)
				return
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

			// Determine whether recipient is busy (mid-turn).
			const isBusy = targetState.taskStatus === "running" && !NON_BUSY_LIFECYCLES.has(lifecycle)

			if (isSync) {
				// --- Sync mode: blocking wait ---
				// Sync always delivers as an annotated user-turn via MessageQueueService
				// (Form B) so it wakes/resumes the recipient. If the recipient is busy
				// (actively running a turn), fail-fast — syncing to a busy worker
				// would abort its in-flight work (see docs/task_messaging.md).
				if (isBusy) {
					pushToolResult(
						formatResponse.toolError(
							`Task ${task_id} is currently running and cannot accept a sync request. ` +
								`Use async send_message_to_task for non-interrupting coordination, ` +
								`or wait for the task to become idle.`,
						),
					)
					return
				}

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

				const queuedMessage = targetState.messageQueueService.addMessage(promptText, [])
				const queuedMessageId = queuedMessage.id

				// Mirror the webview queueMessage handler: if the recipient is idle
				// (abort=true after attempt_completion), trigger cancelAndProcessQueuedMessages
				// to restart the recipient's event loop, just like the user clicking "Send".
				if (targetState.abort) {
					targetState.cancelAndProcessQueuedMessages()
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
					const removed = targetState.messageQueueService.removeMessage(queuedMessageId)
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
				// Async messages to a BUSY recipient are delivered as Form A
				// (system-prompt injection via peerNotificationQueue). For a
				// NON-BUSY recipient, deliver as Form B (annotated user-turn via
				// MessageQueueService) to wake/resume the task — same as sync
				// but without the blocking resolver.
				if (isBusy) {
					// Form A: system-prompt injection on the next API call.
					targetState.peerNotificationQueue.push({
						senderTaskId: task.taskId,
						senderTitle,
						message,
						timestamp: Date.now(),
					})

					// Telemetry: async message enqueued (Form A).
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
							`Delivery: on the recipient's next turn.`,
					)
				} else {
					// Form B: enqueue as an annotated user-turn that wakes/resumes the task.
					const promptText =
						`PEER MESSAGE from task ${task.taskId} ("${senderTitle}"):\n` +
						`${message}\n\n` +
						`You may respond using send_message_to_task(task_id="${task.taskId}", message=...).\n` +
						`This is a notification — no response is required. If the message is not urgent,\n` +
						`you may finish your current work first and respond later.`

					targetState.messageQueueService.addMessage(promptText, [])

					// Wake the recipient if it's idle/completed/paused.
					if (targetState.abort) {
						targetState.cancelAndProcessQueuedMessages()
					}

					// Telemetry: async message enqueued (Form B).
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
