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
	reopenParentFromDelegation(params: {
		parentTaskId: string
		childTaskId: string
		completionResultSummary: string
	}): Promise<void>
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
						const { historyItem } = await provider.getTaskWithId(task.taskId)
						const status = historyItem?.status

						if (historyItem?.isBackground) {
							// Background child completion path. The parent is the focused
							// task and is running concurrently; we MUST NOT trigger the
							// synchronous delegation flow (reopenParentFromDelegation),
							// which would call removeClineFromStack on the parent and set
							// parent.abort=true.
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

						if (status === "completed") {
							console.log(
								`[AttemptCompletionTool.execute] Child task already completed, skipping delegation taskId=${task.taskId}`,
							)
							// Subtask already completed - skip delegation flow entirely
							// Fall through to normal completion ask flow below (outside this if block)
							// This shows the user the completion result and waits for acceptance
							// without injecting another tool_result to the parent
						} else if (status === "active") {
							console.log(
								`[AttemptCompletionTool.execute] Child task active, starting delegation taskId=${task.taskId}`,
							)
							// Normal subtask completion - do delegation
							const delegation = await this.delegateToParent(
								task,
								result,
								provider,
								askFinishSubTaskApproval,
								pushToolResult,
							)
							console.log(
								`[AttemptCompletionTool.execute] Delegation returned: ${delegation}, taskId=${task.taskId}`,
							)
							if (delegation !== "continue") return
						} else {
							// Unexpected status (undefined or "delegated") - log error and skip delegation
							// undefined indicates a bug in status persistence during child creation
							// "delegated" would mean this child has its own grandchild pending (shouldn't reach attempt_completion)
							console.error(
								`[AttemptCompletionTool] Unexpected child task status "${status}" for task ${task.taskId}. ` +
									`Expected "active" or "completed". Skipping delegation to prevent data corruption.`,
							)
							// Fall through to normal completion ask flow
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

	/**
	 * Handles the common delegation flow when a subtask completes.
	 * Returns:
	 * - "delegated" when completion was approved and parent resumed
	 * - "denied" when user denied finishing the subtask
	 * - "continue" when caller should fall through to normal completion ask flow
	 */
	private async delegateToParent(
		task: Task,
		result: string,
		provider: DelegationProvider,
		askFinishSubTaskApproval: () => Promise<boolean>,
		pushToolResult: (result: string) => void,
	): Promise<"delegated" | "denied" | "continue"> {
		console.log(
			`[AttemptCompletionTool.delegateToParent] START childTaskId=${task.taskId}, parentTaskId=${task.parentTaskId}`,
		)
		const didApprove = await askFinishSubTaskApproval()

		if (!didApprove) {
			pushToolResult(formatResponse.toolDenied())
			return "denied"
		}

		pushToolResult("")

		// Emit completion BEFORE delegation cleanup. The delegation reopen flow may
		// abort/remove the child task instance as part of cleanup; emitting after
		// that point can miss TaskManager listeners and leave runtime state stale.
		this.emitTaskCompleted(task)

		// Set abort to stop the child task loop from continuing after completion
		task.abort = true

		console.log(
			`[AttemptCompletionTool.delegateToParent] Calling reopenParentFromDelegation parentTaskId=${task.parentTaskId}, childTaskId=${task.taskId}`,
		)
		await provider.reopenParentFromDelegation({
			parentTaskId: task.parentTaskId!,
			childTaskId: task.taskId,
			completionResultSummary: result,
		})

		console.log(
			`[AttemptCompletionTool.delegateToParent] COMPLETED delegation parentTaskId=${task.parentTaskId}, childTaskId=${task.taskId}`,
		)
		return "delegated"
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
