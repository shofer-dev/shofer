import type { ParamField } from "@shofer/types"

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
	follow_up?: Suggestion[] | null
	form?: ParamField[] | null
}

export class AskFollowupQuestionTool extends BaseTool<"ask_followup_question"> {
	readonly name = "ask_followup_question" as const

	async execute(params: AskFollowupQuestionParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { question, follow_up, form } = params
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

			const hasForm = Array.isArray(form) && form.length > 0
			// An array `follow_up` — even empty — is a valid answer channel: an empty
			// array asks the question with no canned buttons (free-text answer). Only
			// a missing/non-array follow_up with no form is invalid.
			const hasFollowUp = Array.isArray(follow_up)

			// A valid call must offer the user a way to answer: a follow_up list
			// (possibly empty) or a typed form. Report against `follow_up` (the
			// canonical answer channel) when neither is present.
			if (!hasForm && !hasFollowUp) {
				await recordMissingParamError("follow_up")
				return
			}

			task.consecutiveMistakeCount = 0

			// Background child tasks route their question to the parent agent (which
			// answers with free text via answer_subtask_question), so the typed form
			// UI never reaches an interactive user. For those, fall through to the
			// parent-routing path below and present the question as plain text.
			const isBackgroundChild = !!(task.providerRef?.deref() && task.parentTaskId && task.isBackgroundTask)

			// Form mode: render a typed input form (dropdown/radio/checkbox/slider/
			// number/text/boolean). The webview submits all answers at once as a
			// JSON object via the out-of-band objectResponse path; task.ask resolves
			// with that JSON string. We embed the answers back onto the question
			// message so it replays read-only after a reload, then hand the JSON to
			// the model as the tool result.
			if (hasForm && !isBackgroundChild) {
				const form_json = { question, paramForm: form }
				const { text, images } = await task.ask("followup", JSON.stringify(form_json), false)

				const answersText = text ?? ""
				try {
					const parsed = answersText ? JSON.parse(answersText) : {}
					if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
						await task.markFollowupFormAnswered(
							parsed as Record<string, string | number | boolean | string[]>,
						)
					}
				} catch {
					// Non-JSON answer (older client / plain-text reply): skip the
					// read-only replay write-back but still surface the raw answer.
				}

				pushToolResult(formatResponse.toolResult(`<user_input>\n${answersText}\n</user_input>`, images))
				return
			}

			// Transform follow_up suggestions to the format expected by task.ask.
			// follow_up may be null/empty when a background child used form mode —
			// the parent receives the bare question and answers in free text.
			const suggestions = (follow_up ?? []).map((s) => ({ answer: s.text, mode: s.mode }))
			const follow_up_json = {
				question,
				suggest: suggestions,
			}

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

				// Transition the child to "waiting" while blocked on the parent's
				// answer, matching WaitForTaskTool / WaitForMcpCallTool: the child
				// is blocked on a non-user external event (the parent agent
				// answering via answer_subtask_question), not actively processing.
				provider.taskManager.setState(task.taskId, { lifecycle: "waiting" })

				try {
					// Register the pending question on the child and wake any
					// wait_for_task currently blocked on this child.
					const answerPromise = task.setPendingParentQuestion({
						question,
						suggestions,
					})
					provider.taskManager.emit("managedTask:needs-parent-input", task.taskId, question)

					const answer = await answerPromise
					await task.say("user_feedback", answer, undefined)
					pushToolResult(formatResponse.toolResult(`<user_message>\n${answer}\n</user_message>`))
				} catch (rejectErr) {
					// The promise rejected because the task was aborted (or the
					// question was superseded). Surface a clean tool error rather
					// than letting the cast-style error leak up.
					pushToolResult(
						formatResponse.toolError(
							`ask_followup_question was cancelled before the parent answered: ${
								rejectErr instanceof Error ? rejectErr.message : String(rejectErr)
							}`,
						),
					)
				} finally {
					// The child is resuming — whether the parent answered, the wait
					// was aborted/superseded, or setup (setPendingParentQuestion /
					// emit) threw synchronously. Restore "running" and the parent's
					// handle view here so neither is stranded in
					// "waiting"/"waiting_for_parent". Mirrors the finally in
					// WaitForTaskTool / WaitForMcpCallTool.
					provider.taskManager.setState(task.taskId, { lifecycle: "running" })
					if (handleOnParent && handleOnParent.status === "waiting_for_parent") {
						handleOnParent.status = previousHandleStatus ?? "running"
					}
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
