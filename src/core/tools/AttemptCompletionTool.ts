import * as vscode from "vscode"

import { RooCodeEventName, type HistoryItem } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { Package } from "../../shared/package"
import type { ToolUse } from "../../shared/tools"
import { t } from "../../i18n"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface AttemptCompletionParams {
	result: string
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

export class AttemptCompletionTool extends BaseTool<"attempt_completion"> {
	readonly name = "attempt_completion" as const

	async execute(params: AttemptCompletionParams, task: Task, callbacks: AttemptCompletionCallbacks): Promise<void> {
		const { result } = params
		const { handleError, pushToolResult, askFinishSubTaskApproval } = callbacks

		console.log(
			`[AttemptCompletionTool.execute] START taskId=${task.taskId}, parentTaskId=${task.parentTaskId ?? "none"}, result=${result?.substring(0, 100)}`,
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

			task.consecutiveMistakeCount = 0

			await task.say("completion_result", result, undefined, false)

			console.log(
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
							completionResult: result,
						})
						if (blockingHandled) {
							console.log(
								`[AttemptCompletionTool.execute] Blocking foreground path handled taskId=${task.taskId}`,
							)
							pushToolResult("")
							this.emitTaskCompleted(task)
							task.abort = true
							return
						}

						const { historyItem } = await provider.getTaskWithId(task.taskId)

						if (historyItem?.isBackground) {
							// Background child completion path. The parent is the focused
							// task and is running concurrently; we MUST NOT call
							// removeClineFromStack on the parent or fire the blocking
							// parent resolver (which is only for foreground subtasks).
							//
							// Instead: persist completion status on the child's own
							// history, update the parent's in-memory backgroundChildren
							// handle, emit TaskCompleted, and abort the child cleanly.
							console.log(
								`[AttemptCompletionTool.execute] Background child completed, skipping delegation taskId=${task.taskId}`,
							)

							pushToolResult("")

							try {
								await provider.updateTaskHistory({
									...historyItem,
									status: "completed",
									completionResultSummary: result,
								})
							} catch (err) {
								console.error(
									`[AttemptCompletionTool] Failed to persist background child completion for ${task.taskId}: ${(err as Error)?.message ?? String(err)}`,
								)
							}

							const parentInstance = provider.taskManager?.getManagedTaskInstance?.(task.parentTaskId)
							const handle = parentInstance?.backgroundChildren.get(task.taskId)
							if (handle) {
								handle.status = "completed"
							}

							this.emitTaskCompleted(task)
							task.abort = true
							return
						}
					} catch (err) {
						// If we can't get the history, log error and skip delegation
						console.error(
							`[AttemptCompletionTool] Failed to get history for task ${task.taskId}: ${(err as Error)?.message ?? String(err)}. ` +
								`Skipping delegation.`,
						)
						// Fall through to normal completion ask flow
					}
				}
			}

			console.log(`[AttemptCompletionTool.execute] Showing completion ask to user, taskId=${task.taskId}`)
			const { response, text, images } = await task.ask("completion_result", "", false)

			if (response === "yesButtonClicked") {
				console.log(
					`[AttemptCompletionTool.execute] User approved completion, emitting TaskCompleted, taskId=${task.taskId}`,
				)
				// Persist `status: "completed"` so the Task Selector renders the green
				// check icon for this task even after a code-server restart (when the
				// live runtime overlay is gone). Mirrors the background-child branch
				// above. Failure is non-fatal — the in-flight UI still updates via the
				// TaskCompleted event.
				try {
					const provider = task.providerRef.deref() as DelegationProvider | undefined
					if (provider) {
						const { historyItem } = await provider.getTaskWithId(task.taskId)
						if (historyItem && historyItem.status !== "completed") {
							await provider.updateTaskHistory({ ...historyItem, status: "completed" })
						}
					}
				} catch (err) {
					console.error(
						`[AttemptCompletionTool] Failed to persist completed status for ${task.taskId}: ${(err as Error)?.message ?? String(err)}`,
					)
				}
				this.emitTaskCompleted(task)
				// Set abort to stop the task loop from continuing after completion
				task.abort = true
				console.log(
					`[AttemptCompletionTool.execute] Set abort=true and RETURNING after TaskCompleted, taskId=${task.taskId}`,
				)
				return
			}

			console.log(
				`[AttemptCompletionTool.execute] User provided feedback, continuing task, taskId=${task.taskId}`,
			)
			// User provided feedback - push tool result to continue the conversation
			await task.say("user_feedback", text ?? "", images)
			const feedbackText = `<user_message>\n${text}\n</user_message>`
			pushToolResult(formatResponse.toolResult(feedbackText, images))
		} catch (error) {
			await handleError("inspecting site", error as Error)
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"attempt_completion">): Promise<void> {
		const result: string | undefined = block.params.result
		const command: string | undefined = block.params.command

		const lastMessage = task.clineMessages.at(-1)

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

	private emitTaskCompleted(task: Task): void {
		console.log(`[AttemptCompletionTool.emitTaskCompleted] Emitting TaskCompleted event, taskId=${task.taskId}`)
		// Force final token usage update before emitting TaskCompleted.
		// This ensures the latest stats are captured regardless of throttle timer.
		task.emitFinalTokenUsageUpdate()

		TelemetryService.instance.captureTaskCompleted(task.taskId)
		task.emit(RooCodeEventName.TaskCompleted, task.taskId, task.getTokenUsage(), task.toolUsage)
		console.log(`[AttemptCompletionTool.emitTaskCompleted] TaskCompleted event emitted, taskId=${task.taskId}`)
	}
}

export const attemptCompletionTool = new AttemptCompletionTool()
