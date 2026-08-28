import { randomUUID } from "crypto"

import { type HistoryItem, type CompletionRating, type Envelope } from "@shofer/types"
import { MAILBOX_NOTIFICATION_TIMEOUT_SEC } from "@shofer/types"
import { getHost } from "@shofer/types"

import { Task } from "../task/Task.js"
import { emitTaskCompleted } from "../task/emit-task-completed.js"
import { formatResponse } from "../prompts/responses.js"
import { Package } from "../shared/package.js"
import { type ToolUse } from "@shofer/types"
import { t } from "../i18n/index.js"
import { pluginRegistry } from "../plugins/plugin-registry.js"
import { getOutputChannel } from "../utils/outputChannel.js"

import { BaseTool, ToolCallbacks } from "./BaseTool.js"

interface AttemptCompletionParams {
	result: string | Record<string, unknown>
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
	/** Deliver an envelope into a task's mailbox. Mirrors `ShoferProvider.deliverToTask`. */
	deliverToTask(taskId: string, envelope: Envelope): Promise<Envelope>
	updateTaskHistory(item: HistoryItem): Promise<HistoryItem[]>
	taskManager?: {
		getManagedTaskInstance?(taskId: string): Task | undefined
		getManagedTask?(taskId: string): { name?: string } | undefined
		getTaskState?(taskId: string): { lifecycle: string; rating?: string } | undefined
	}
}

/**
 * How much this task changed, for the +/− badge on its history entry.
 *
 * Core does not track file changes — a plugin does (the bundled `file-changes` one) —
 * so the numbers are asked for rather than computed: every plugin is offered the
 * `"task-stats"` question and the ones that answer are summed. No plugin answering
 * means no badge, which is the correct rendering of "nothing is tracking this".
 */
async function computeFileChangeStats(task: Task): Promise<{ insertions: number; deletions: number }> {
	try {
		const answers = await pluginRegistry.requestAll("task-stats", undefined, {
			taskId: task.taskId,
			cwd: task.cwd,
		})
		let insertions = 0
		let deletions = 0
		for (const answer of answers) {
			const stats = answer as { insertions?: unknown; deletions?: unknown } | undefined
			if (typeof stats?.insertions === "number") insertions += stats.insertions
			if (typeof stats?.deletions === "number") deletions += stats.deletions
		}
		return { insertions, deletions }
	} catch (err) {
		taskLog.error(
			`[AttemptCompletionTool] Failed to compute file change stats for ${task.taskId}: ${(err as Error)?.message ?? String(err)}`,
		)
		return { insertions: 0, deletions: 0 }
	}
}

import { MAX_SUBTASK_RESULT_LENGTH } from "./NewTaskTool.js"
import { taskLog } from "../logging/subsystems.js"

export class AttemptCompletionTool extends BaseTool<"attempt_completion"> {
	readonly name = "attempt_completion" as const

	async execute(params: AttemptCompletionParams, task: Task, callbacks: AttemptCompletionCallbacks): Promise<void> {
		const { result, rating, feedback } = params
		const { handleError, pushToolResult } = callbacks

		// When the task has a `completionSchema` (set by the caller's output contract),
		// the LLM returns `result` as a structured object rather than a free-form
		// string.  Normalise to a string for display + persistence so the rest of
		// the pipeline — `say("completion_result", …)`, `completionResultSummary`,
		// and the caller's own check on the returned result — sees a stable
		// string representation.
		const effectiveResult: string =
			typeof result === "object" && result !== null
				? JSON.stringify(result)
				: typeof result === "string"
					? result
					: ""

		taskLog.info(
			`[AttemptCompletionTool.execute] START taskId=${task.taskId}, parentTaskId=${task.parentTaskId ?? "none"}, rating=${rating}, result=${effectiveResult?.substring(0, 100)}`,
		)

		// Prevent attempt_completion if any tool failed in the current turn
		if (task.didToolFailInCurrentTurn) {
			const errorMsg = t("common:errors.attempt_completion_tool_failed")

			await task.say("error", errorMsg)
			pushToolResult(formatResponse.toolError(errorMsg))
			return
		}

		const preventCompletionWithOpenTodos = getHost().config.get<boolean>(
			Package.name,
			"preventCompletionWithOpenTodos",
			false,
		)

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
			// Check for missing result: empty string, null, undefined, or empty object.
			if (!result || (typeof result === "object" && Object.keys(result).length === 0)) {
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
				taskLog.info(
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
			let cappedResult = effectiveResult
			if (cappedResult.length > MAX_SUBTASK_RESULT_LENGTH) {
				cappedResult =
					cappedResult.slice(0, MAX_SUBTASK_RESULT_LENGTH) +
					`\n[...truncated to ${MAX_SUBTASK_RESULT_LENGTH} characters (hard safety cap)]`
			}

			await task.say("completion_result", cappedResult, undefined, false)

			taskLog.info(
				`[AttemptCompletionTool.execute] Checking delegation: taskId=${task.taskId}, parentTaskId=${task.parentTaskId ?? "none"}`,
			)

			// There is no peer branch here any more. A peer that wanted an answer
			// used to get it by making this task COMPLETE — which is why answering
			// was terminal. It now sends a `request` and gets a `reply`, so
			// `attempt_completion` means only what its name says.

			// A CHILD's result goes to its parent's mailbox.
			//
			// There is no blocking-parent branch any more, because nothing blocks: a
			// parent is never suspended inside `new_task`, so there is no resolver to
			// fire and no stack to unwind. The result is persisted on the child's own
			// history exactly as before AND delivered as a `notification` the parent
			// reads with `wait` — or finds in its digest on its next turn. `wake: true`
			// because a parent that ended its turn while its children worked is the
			// normal case, and the whole point of delegating is to be told the answer.
			if (task.parentTaskId) {
				const provider = task.providerRef.deref() as DelegationProvider | undefined
				if (provider) {
					taskLog.info(
						`[AttemptCompletionTool.execute] Child completed, delivering result to parent taskId=${task.taskId}`,
					)

					pushToolResult("")

					try {
						const fileStats = await computeFileChangeStats(task)
						// Persist file stats + completion summary only — taskState is
						// owned exclusively by TaskManager, which writes it in response
						// to the TaskCompleted event emitted below. Do NOT spread a
						// historyItem here: it carries a stale taskState snapshot and
						// racesTaskManager.persistState()'s write of "completed".
						await provider.updateTaskHistory({
							id: task.taskId,
							completionResultSummary: cappedResult,
							insertions: fileStats.insertions,
							deletions: fileStats.deletions,
						} as HistoryItem)
					} catch (err) {
						taskLog.error(
							`[AttemptCompletionTool] Failed to persist child completion for ${task.taskId}: ${(err as Error)?.message ?? String(err)}`,
						)
					}

					const parentInstance = provider.taskManager?.getManagedTaskInstance?.(task.parentTaskId)
					const handle = parentInstance?.backgroundChildren.get(task.taskId)
					if (handle) {
						handle.status = "completed"
					}

					// Deliver the result. Best-effort by design: a parent that has been
					// deleted, or whose box is full, must not stop this child from
					// completing — the result is already durable on the child's own
					// history and `check_task_status` still reads it there.
					try {
						const childTitle = provider.taskManager?.getManagedTask?.(task.taskId)?.name ?? task.taskId
						const now = Date.now()
						await provider.deliverToTask(task.parentTaskId, {
							id: randomUUID(),
							from: task.taskId,
							to: task.parentTaskId,
							kind: "notification",
							subject: `result: ${childTitle}`.slice(0, 120),
							body: cappedResult,
							deadline: now + MAILBOX_NOTIFICATION_TIMEOUT_SEC * 1000,
							wake: true,
							sent_at: now,
							plane: "local",
						})
					} catch (err) {
						taskLog.error(
							`[AttemptCompletionTool] Could not deliver the result of ${task.taskId} to parent ` +
								`${task.parentTaskId}: ${(err as Error)?.message ?? String(err)}`,
						)
					}

					this.emitTaskCompleted(task, effectiveRating)
					task.abort = true
					return
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
					taskLog.info(
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
					// Use the in-memory TaskManager state (set synchronously by the
					// TaskCompleted event emitted above in subtask paths, or about to
					// be emitted below) rather than the persisted HistoryItem snapshot
					// which can carry a stale taskState.
					const liveState = provider.taskManager?.getTaskState?.(task.taskId)
					if (liveState?.lifecycle !== "completed") {
						const fileStats = await computeFileChangeStats(task)
						// Only pass the fields we intend to update — do NOT spread
						// a stale historyItem snapshot and overwrite the taskState
						// that TaskManager.set/persistState() will set.
						await provider.updateTaskHistory({
							id: task.taskId,
							completionResultSummary: cappedResult,
							insertions: fileStats.insertions,
							deletions: fileStats.deletions,
						} as HistoryItem)
					}
				}
			} catch (err) {
				taskLog.error(
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
		const raw: unknown = block.params.result
		const command: string | undefined = block.params.command
		// Normalize to string for display (object result from contract schema → JSON)
		const result: string =
			typeof raw === "object" && raw !== null ? JSON.stringify(raw) : typeof raw === "string" ? raw : ""

		const lastMessage = task.shoferMessages.at(-1)

		if (command) {
			if (lastMessage && lastMessage.ask === "command") {
				await task.ask("command", command ?? "", block.partial).catch(() => {})
			} else {
				await task.say("completion_result", result, undefined, false)
				await task.ask("command", command ?? "", block.partial).catch(() => {})
			}
		} else {
			await task.say("completion_result", result, undefined, block.partial)
		}
	}

	private emitTaskCompleted(task: Task, rating: CompletionRating): void {
		emitTaskCompleted(task, rating)
	}
}

export const attemptCompletionTool = new AttemptCompletionTool()
