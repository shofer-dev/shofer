import * as vscode from "vscode"

import { ShoferEventName, type HistoryItem, type CompletionRating } from "@shofer/types"
import { TelemetryService } from "@shofer/telemetry"

import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { Package } from "../../shared/package"
import type { ToolUse } from "../../shared/tools"
import { t } from "../../i18n"
import { getChangedFiles } from "../file-changes/ChangedFilesService"
import { getOutputChannel } from "../../extension"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface AttemptCompletionParams {
	result: string
	rating: CompletionRating
	feedback?: string
	command?: string
}

export interface AttemptCompletionCallbacks extends ToolCallbacks {
	askFinishSubTaskApproval: () => Promise<boolean>
	toolDescription: () => string
}

/**
 * Interface for provider methods needed by AttemptCompletionTool for delegation handling.
 */
interface DelegationProvider {
	getTaskWithId(id: string): Promise<{ historyItem: HistoryItem }>
	/**
	 * Handles completion of a blocking foreground subtask (is_background=false).
	 * Pops the child from the stack, reveals the parent, and fires the resolver
	 * that unblocks the parent's NewTaskTool.execute() await.
	 * @returns true if a blocking resolver was found and handled; false otherwise.
	 */
	resumeBlockingParent(params: {
		parentTaskId: string
		childTaskId: string
		completionResult: string
	}): Promise<boolean>
	updateTaskHistory(item: HistoryItem): Promise<HistoryItem[]>
	taskManager?: {
		getManagedTaskInstance?(taskId: string): Task | undefined
	}
}

/**
 * Computes the total insertions and deletions across all files changed
 * by the task, aggregating the per-file stats from ChangedFilesService.
 */
async function computeFileChangeStats(task: Task): Promise<{ insertions: number; deletions: number }> {
	try {
		const payload = await getChangedFiles(task)
		let insertions = 0
		let deletions = 0
		for (const entry of payload.entries) {
			insertions += entry.insertions
			deletions += entry.deletions
		}
		return { insertions, deletions }
	} catch (err) {
		outputError(
			`[AttemptCompletionTool] Failed to compute file change stats for ${task.taskId}: ${(err as Error)?.message ?? String(err)}`,
		)
		return { insertions: 0, deletions: 0 }
	}
}

import { MAX_SUBTASK_RESULT_LENGTH } from "./NewTaskTool"
import { outputError, outputLog } from "../../utils/outputChannelLogger"

export class AttemptCompletionTool extends BaseTool<"attempt_completion"> {
	readonly name = "attempt_completion" as const

	async execute(params: AttemptCompletionParams, task: Task, callbacks: AttemptCompletionCallbacks): Promise<void> {
		const { result, rating, feedback } = params
		const { handleError, pushToolResult } = callbacks

		outputLog(
			`[AttemptCompletionTool.execute] START taskId=${task.taskId}, parentTaskId=${task.parentTaskId ?? "none"}, rating=${rating}, result=${result?.substring(0, 100)}`,
		)

		// Prevent attempt_completion if any tool failed in the current turn
		if (task.didToolFailInCurrentTurn) {
			const errorMsg = t("common:errors.attempt_completion_tool_failed")

			await task.say("error", errorMsg)
			pushToolResult(formatResponse.toolError(errorMsg))
			return
		}

		const preventCompletionWithOpenTodos = vscode.workspace
			.getConfiguration(Package.name)
			.get<boolean>("preventCompletionWithOpenTodos", false)

		const hasIncompleteTodos = task.todoList && task.todoList.some((todo) => todo.status !== "completed")

		if (preventCompletionWithOpenTodos && hasIncompleteTodos) {
			task.consecutiveMistakeCount++
			task.recordToolError("attempt_completion")

			pushToolResult(
				formatResponse.toolError(
					"Cannot complete task while there are incomplete todos. Please finish all todos before attempting completion.",
				),
			)

			return
		}

		try {
			if (!result) {
				task.consecutiveMistakeCount++
				task.recordToolError("attempt_completion")
				pushToolResult(await task.sayAndCreateMissingParamError("attempt_completion", "result"))
				return
			}

			// Default rating to "poor" if missing or invalid. The schema declares
			// rating as required so well-behaved LLMs will include it, but providers
			// like vscode-lm don't enforce strict schemas. Rather than blocking
			// completion, we accept a missing rating with a default.
			const ALLOWED_RATINGS = new Set(["poor", "well", "excellent"])
			const effectiveRating: CompletionRating =
				rating && ALLOWED_RATINGS.has(rating) ? (rating as CompletionRating) : "poor"
			if (!rating || !ALLOWED_RATINGS.has(rating)) {
				outputLog(
					`[AttemptCompletionTool.execute] Rating missing or invalid (got: ${rating}), defaulting to "poor"`,
				)
			}

			// Route optional feedback to the output channel (same mechanism as GiveFeedbackTool)
			if (feedback && feedback.trim()) {
				const trimmed = feedback.trim()
				const channel = getOutputChannel()
				const stamp = new Date().toISOString()
				const header = `[${stamp}] [FEEDBACK via attempt_completion] taskId=${task.taskId} rating=${effectiveRating}`
				if (channel) {
					channel.appendLine(header)
					channel.appendLine(trimmed)
					channel.appendLine("")
				}
			}

			task.consecutiveMistakeCount = 0

			// Apply hard safety cap only.  The parent's softResultLength is a soft
			// suggestion communicated via the SUBTASK CONSTRAINTS system prompt —
			// the subtask should keep its result within budget but we don't
			// hard-truncate here.  The MAX_SUBTASK_RESULT_LENGTH cap prevents
			// runaway subtasks from blowing up the parent's context.
			let effectiveResult = result
			if (effectiveResult.length > MAX_SUBTASK_RESULT_LENGTH) {
				effectiveResult =
					effectiveResult.slice(0, MAX_SUBTASK_RESULT_LENGTH) +
					`\n[...truncated to ${MAX_SUBTASK_RESULT_LENGTH} characters (hard safety cap)]`
			}

			await task.say("completion_result", effectiveResult, undefined, false)

			outputLog(
				`[AttemptCompletionTool.execute] Checking delegation: taskId=${task.taskId}, parentTaskId=${task.parentTaskId ?? "none"}`,
			)

			// Check for subtask using parentTaskId (metadata-driven delegation)
			if (task.parentTaskId) {
				// Check if this subtask has already completed and returned to parent
				// to prevent duplicate tool_results when user revisits from history
				const provider = task.providerRef.deref() as DelegationProvider | undefined
				if (provider) {
					try {
						// Blocking foreground path (is_background=false, new design):
						// The parent is suspended in NewTaskTool.execute() awaiting a Promise.
						// resumeBlockingParent() pops the child from the stack to reveal
						// the parent, updates history, and fires the resolver — no rehydration.
						const blockingHandled = await provider.resumeBlockingParent({
							parentTaskId: task.parentTaskId,
							childTaskId: task.taskId,
							completionResult: effectiveResult,
						})
						if (blockingHandled) {
							outputLog(
								`[AttemptCompletionTool.execute] Blocking foreground path handled taskId=${task.taskId}`,
							)
							pushToolResult("")
							this.emitTaskCompleted(task, effectiveRating)
							task.abort = true
							return
						}

						const { historyItem } = await provider.getTaskWithId(task.taskId)

						if (historyItem?.isBackground) {
							// Background child completion path. The parent is the focused
							// task and is running concurrently; we MUST NOT call
							// removeShoferFromStack on the parent or fire the blocking
							// parent resolver (which is only for foreground subtasks).
							//
							// Instead: persist completion status on the child's own
							// history, update the parent's in-memory backgroundChildren
							// handle, emit TaskCompleted, and abort the child cleanly.
							outputLog(
								`[AttemptCompletionTool.execute] Background child completed, skipping delegation taskId=${task.taskId}`,
							)

							pushToolResult("")

							try {
								const fileStats = await computeFileChangeStats(task)
								// Persist file stats + completion summary only — taskState is
								// owned exclusively by TaskManager, which writes it in response
								// to the TaskCompleted event emitted below.
								await provider.updateTaskHistory({
									...historyItem,
									completionResultSummary: effectiveResult,
									insertions: fileStats.insertions,
									deletions: fileStats.deletions,
								})
							} catch (err) {
								outputError(
									`[AttemptCompletionTool] Failed to persist background child completion for ${task.taskId}: ${(err as Error)?.message ?? String(err)}`,
								)
							}

							const parentInstance = provider.taskManager?.getManagedTaskInstance?.(task.parentTaskId)
							const handle = parentInstance?.backgroundChildren.get(task.taskId)
							if (handle) {
								handle.status = "completed"
							}

							this.emitTaskCompleted(task, effectiveRating)
							task.abort = true
							return
						}
					} catch (err) {
						// If we can't get the history, log error and skip delegation
						outputError(
							`[AttemptCompletionTool] Failed to get history for task ${task.taskId}: ${(err as Error)?.message ?? String(err)}. ` +
								`Skipping delegation.`,
						)
						// Fall through to normal completion flow
					}
				}
			}

			// Drain the message queue BEFORE declaring terminal state. If the user
			// queued one or more messages while the task was running, FIFO ordering
			// requires that the next queued message become the continuation of this
			// turn — not a new task and not a "Send Now" override. We dequeue one
			// message (the head), render it as user feedback, push it as the tool
			// result, and let the task loop continue to the next LLM iteration. The
			// remaining queued messages stay in the queue and are drained naturally
			// by the next `Task.ask()` (per the queue-drain branch in `Task.ask()`).
			//
			// This mirrors the pre-fix behavior where `task.ask("completion_result", …)`
			// would synthesize a `messageResponse` from the queue and the tool would
			// fall through to the user-feedback path. We do it explicitly here now
			// that `attempt_completion` no longer asks (see the Self-Declared
			// Terminal State Rule in AGENTS.md and `docs/message_queue.md`).
			if (!task.messageQueueService.isEmpty()) {
				const queued = task.messageQueueService.dequeueMessage()
				if (queued) {
					outputLog(
						`[AttemptCompletionTool.execute] Draining queued message instead of completing, taskId=${task.taskId}, text=${queued.text?.substring(0, 100)}`,
					)
					await task.say("user_feedback", queued.text ?? "", queued.images)
					const feedbackText = `<user_message>\n${queued.text ?? ""}\n</user_message>`
					pushToolResult(formatResponse.toolResult(feedbackText, queued.images))
					return
				}
			}

			// `attempt_completion` is the agent's self-declared terminal state — the
			// rating and optional `feedback` are produced by the agent itself, so we
			// do NOT ask the user to approve or to provide additional feedback.
			// The completion result is rendered via the `say("completion_result", …)`
			// above; here we just persist completion artefacts and emit the event.
			try {
				const provider = task.providerRef.deref() as DelegationProvider | undefined
				if (provider) {
					const { historyItem } = await provider.getTaskWithId(task.taskId)
					if (historyItem && historyItem.taskState?.lifecycle !== "completed") {
						const fileStats = await computeFileChangeStats(task)
						await provider.updateTaskHistory({
							...historyItem,
							completionResultSummary: effectiveResult,
							insertions: fileStats.insertions,
							deletions: fileStats.deletions,
						})
					}
				}
			} catch (err) {
				outputError(
					`[AttemptCompletionTool] Failed to persist completion artefacts for ${task.taskId}: ${(err as Error)?.message ?? String(err)}`,
				)
			}

			// Abort all background children before completing.  Without this a
			// parent task that calls attempt_completion would leave its
			// background sub-tasks running — their live Task instances continue
			// the API loop indefinitely.
			await task.abortBackgroundChildren()

			pushToolResult("")
			this.emitTaskCompleted(task, effectiveRating)
			task.abort = true
		} catch (error) {
			await handleError("inspecting site", error as Error)
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"attempt_completion">): Promise<void> {
		const result: string | undefined = block.params.result
		const command: string | undefined = block.params.command

		const lastMessage = task.shoferMessages.at(-1)

		if (command) {
			if (lastMessage && lastMessage.ask === "command") {
				await task.ask("command", command ?? "", block.partial).catch(() => {})
			} else {
				await task.say("completion_result", result ?? "", undefined, false)
				await task.ask("command", command ?? "", block.partial).catch(() => {})
			}
		} else {
			await task.say("completion_result", result ?? "", undefined, block.partial)
		}
	}

	private emitTaskCompleted(task: Task, rating: CompletionRating): void {
		outputLog(`[AttemptCompletionTool.emitTaskCompleted] Emitting TaskCompleted event, taskId=${task.taskId}`)
		// Force final token usage update before emitting TaskCompleted.
		// This ensures the latest stats are captured regardless of throttle timer.
		task.emitFinalTokenUsageUpdate()

		TelemetryService.instance.captureTaskCompleted(task.taskId)
		task.emit(ShoferEventName.TaskCompleted, task.taskId, task.getTokenUsage(), task.toolUsage, {
			rating,
			isSubtask: !!task.parentTaskId,
		})
		outputLog(`[AttemptCompletionTool.emitTaskCompleted] TaskCompleted event emitted, taskId=${task.taskId}`)
	}
}

export const attemptCompletionTool = new AttemptCompletionTool()
