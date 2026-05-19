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
			// status "waiting" and the question text) and answers via
			// answer_subtask_question.
			const provider = task.providerRef.deref()
			if (provider && task.parentTaskId) {
				// Check if this subtask is a background child by inspecting
				// its persisted history item.
				let isBg = false
				try {
					const { historyItem } = await provider.getTaskWithId(task.taskId)
					isBg = historyItem?.isBackground === true
				} catch {
					// Fall through — if we can't read history, treat as foreground.
				}

				if (isBg) {
					// Store the question so answer_subtask_question can resolve it.
					;(task as any)._pendingParentQuestion = {
						question,
						suggestions: follow_up.map((s) => ({ answer: s.text, mode: s.mode })),
						resolve: null as ((answer: string) => void) | null,
					}

					// Block until the parent answers.
					const answer = await new Promise<string>((resolve) => {
						;(task as any)._pendingParentQuestion!.resolve = resolve
					})

					// Simulate the user feedback that normally comes from task.ask("followup", ...).
					await task.say("user_feedback", answer, undefined)
					pushToolResult(formatResponse.toolResult(`<user_message>\n${answer}\n</user_message>`))
					return
				}
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
