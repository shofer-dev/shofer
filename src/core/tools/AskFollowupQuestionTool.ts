import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import type { ToolUse } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface Suggestion {
	text: string
	mode?: string
}

interface AskFollowupQuestionParams {
	question: string
	follow_up: Suggestion[]
}

export class AskFollowupQuestionTool extends BaseTool<"ask_followup_question"> {
	readonly name = "ask_followup_question" as const

	async execute(params: AskFollowupQuestionParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { question, follow_up } = params
		const { handleError, pushToolResult } = callbacks

		const recordMissingParamError = async (paramName: string): Promise<void> => {
			task.consecutiveMistakeCount++
			task.recordToolError("ask_followup_question")
			task.didToolFailInCurrentTurn = true
			pushToolResult(await task.sayAndCreateMissingParamError("ask_followup_question", paramName))
		}

		try {
			if (!question) {
				await recordMissingParamError("question")
				return
			}

			if (!follow_up || !Array.isArray(follow_up)) {
				await recordMissingParamError("follow_up")
				return
			}

			// Transform follow_up suggestions to the format expected by task.ask
			const follow_up_json = {
				question,
				suggest: follow_up.map((s) => ({ answer: s.text, mode: s.mode })),
			}

			task.consecutiveMistakeCount = 0

			// When this is a background child task, route the question to the
			// parent instead of blocking on user input. The parent discovers
			// the question via check_task_status / wait_for_task (which show
			// status "waiting_for_parent" and the question text) and answers
			// via answer_subtask_question.
			const provider = task.providerRef?.deref()
			if (provider && task.parentTaskId && task.isBackgroundTask) {
				// Finalize the streaming "tool" ChatRow before routing to the
				// parent. This tool is in the "questions" group and auto-approved
				// for background children (which inherit alwaysAllow* settings),
				// so askApproval returns immediately while rendering a ChatRow entry.
				const completeMessage = JSON.stringify({
					tool: "askFollowupQuestion",
					question,
				})
				const didApprove = await callbacks.askApproval("tool", completeMessage)
				if (!didApprove) {
					return
				}

				// Flip the parent's view of this child to "waiting_for_parent"
				// so check_task_status / list_background_tasks reflect reality.
				const parentInstance = provider.taskManager.getManagedTaskInstance(task.parentTaskId)
				const handleOnParent = parentInstance?.backgroundChildren.get(task.taskId)
				const previousHandleStatus = handleOnParent?.status
				if (handleOnParent) {
					handleOnParent.status = "waiting_for_parent"
				}

				// Register the pending question on the child and wake any
				// wait_for_task currently blocked on this child.
				const answerPromise = task.setPendingParentQuestion({
					question,
					suggestions: follow_up.map((s) => ({ answer: s.text, mode: s.mode })),
				})
				provider.taskManager.emit("managedTask:needs-parent-input", task.taskId, question)

				try {
					const answer = await answerPromise
					// Restore parent handle status — the child is about to resume.
					if (handleOnParent && handleOnParent.status === "waiting_for_parent") {
						handleOnParent.status = previousHandleStatus ?? "running"
					}
					await task.say("user_feedback", answer, undefined)
					pushToolResult(formatResponse.toolResult(`<user_message>\n${answer}\n</user_message>`))
				} catch (rejectErr) {
					// The promise rejected because the task was aborted (or the
					// question was superseded). Surface a clean tool error
					// rather than letting the cast-style error leak up.
					if (handleOnParent && handleOnParent.status === "waiting_for_parent") {
						handleOnParent.status = previousHandleStatus ?? "running"
					}
					pushToolResult(
						formatResponse.toolError(
							`ask_followup_question was cancelled before the parent answered: ${
								rejectErr instanceof Error ? rejectErr.message : String(rejectErr)
							}`,
						),
					)
				}
				return
			}

			const { text, images } = await task.ask("followup", JSON.stringify(follow_up_json), false)
			await task.say("user_feedback", text ?? "", images)
			pushToolResult(formatResponse.toolResult(`<user_message>\n${text}\n</user_message>`, images))
		} catch (error) {
			await handleError("asking question", error as Error)
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"ask_followup_question">): Promise<void> {
		const question: string | undefined = block.nativeArgs?.question ?? block.params.question

		// During partial streaming, only show the question to avoid displaying raw JSON
		// The full JSON with suggestions will be sent when the tool call is complete (!block.partial)
		await task.ask("followup", question ?? "", block.partial).catch(() => {})
	}
}

export const askFollowupQuestionTool = new AskFollowupQuestionTool()
