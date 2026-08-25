import type { ParamField } from "@shofer/types"

import { Task } from "../task/Task.js"
import { formatResponse } from "../prompts/responses.js"
import { type ToolUse } from "@shofer/types"
import { confirmNoConversationDriver } from "../transport/conversation-driver.js"

import { BaseTool, ToolCallbacks } from "./BaseTool.js"

/**
 * What the model is told when its question has no audience at all — a
 * synchronously spawned child on a remotely driven host whose conversation has
 * no subscriber. It must read as a refusal to ASK, never as an answer: the
 * platform's ask rule ("an ask with no reachable audience must fail fast rather
 * than block silently") is precisely about not fabricating one.
 */
const NO_AUDIENCE_MESSAGE =
	"No user is reachable to answer this question: this task was started by another task, " +
	"which is itself blocked waiting for you, and nobody is watching the conversation. " +
	"Do not ask again — decide with the information you have, state the assumption you made " +
	"in your result, or complete with attempt_completion explaining what you needed."

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

		const recordToolValidationError = (message: string): void => {
			task.consecutiveMistakeCount++
			task.recordToolError("ask_followup_question")
			task.didToolFailInCurrentTurn = true
			pushToolResult(formatResponse.toolError(message))
		}

		try {
			if (!question) {
				await recordMissingParamError("question")
				return
			}

			// `follow_up` and `form` are each OPTIONAL but MUTUALLY EXCLUSIVE — a
			// valid call offers EXACTLY ONE answer channel:
			//  - `form`: a non-empty typed-input form.
			//  - `follow_up`: a suggestion-button list. An *empty* array is also a
			//    valid follow_up channel — it asks the question with no buttons
			//    (free-text answer).
			const hasForm = Array.isArray(form) && form.length > 0
			const hasFollowUpChannel = Array.isArray(follow_up)
			const hasSuggestions = Array.isArray(follow_up) && follow_up.length > 0

			// Both a suggestion list AND a typed form is ambiguous — reject it so the
			// model picks one rather than silently dropping the other.
			if (hasForm && hasSuggestions) {
				recordToolValidationError(
					"ask_followup_question accepts EITHER `follow_up` (suggestion buttons) OR `form` (typed inputs), not both. Provide exactly one and set the other to null.",
				)
				return
			}

			// Neither channel present → the user has no way to answer. Report against
			// `follow_up` (the canonical answer channel).
			if (!hasForm && !hasFollowUpChannel) {
				await recordMissingParamError("follow_up")
				return
			}

			task.consecutiveMistakeCount = 0

			// Background child tasks route their question to BOTH the parent agent
			// (which answers with free text via answer_subtask_question) AND the
			// user (interactively, via the child's own followup ask UI). The
			// question is rendered in the child's chat using `task.ask("followup")`
			// — the same mechanism used for user-facing questions — so suggestion
			// buttons appear when the user views the child task. Either channel
			// can answer; whichever fires first resolves the ask.
			const isBackgroundChild = !!(task.providerRef?.deref() && task.parentTaskId && task.isBackgroundTask)

			// A SYNCHRONOUSLY spawned child (`new_task` without `is_background`) has
			// the opposite problem to a background one: its parent is the entity that
			// created it, but the parent cannot answer — it is suspended inside
			// `new_task` waiting for this child to finish. So the next hop backwards
			// is the human driving the ROOT conversation, and the question is
			// published on the ROOT task's event stream (by
			// `API.escalateFollowupToConversation`, carrying `sourceTaskId`) rather
			// than only on this child's, which no controller subscribes to. Both
			// answer shapes ride it — a suggestion list and a `paramForm`. The
			// blocking primitive below is unchanged: the child still parks on its own
			// `task.ask("followup")`, and the answer comes back through
			// `respondToAsk`'s conversation-wide askId lookup.
			//
			// Before parking, refuse outright when the question provably cannot reach
			// anyone: a remotely driven host with no subscriber on the root stream.
			// `undefined` means the host is not remotely driven (the VS Code webview,
			// a terminal `shofer` run), where the local ask surface IS the audience
			// and nothing changes.
			//
			// "Provably" is the whole weight of this branch, so the question is put
			// through `confirmNoConversationDriver` rather than sampled once: a
			// controller detaching and re-attaching is normal operation, and a single
			// sample turns a reconnect that lasts milliseconds into a permanent
			// refusal of a question a human WAS waiting for. It costs a bounded
			// in-line wait on the path that is about to give up, and nothing at all
			// on the path that asks.
			const rootTaskId = task.parentTaskId && !task.isBackgroundTask ? task.rootTaskId : undefined
			if (rootTaskId && (await confirmNoConversationDriver(rootTaskId))) {
				task.recordToolError("ask_followup_question")
				pushToolResult(formatResponse.toolError(NO_AUDIENCE_MESSAGE))
				return
			}

			// Form mode: render a typed input form (dropdown/radio/checkbox/slider/
			// number/text/boolean). The webview submits all answers at once as a
			// JSON object via the out-of-band objectResponse path; task.ask resolves
			// with that JSON string. We embed the answers back onto the question
			// message so it replays read-only after a reload, then hand the JSON to
			// the model as the tool result.
			//
			// Background children never use form mode — the parent answers in free
			// text via answer_subtask_question, and the form UI is designed for
			// interactive human input. Fall through to the followup-ask path below.
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

			// When this is a background child task, the question is rendered in
			// the child's own chat via `task.ask("followup", …)` — the same
			// mechanism used for user-facing questions. This means:
			//
			//   1. The question + suggestion buttons appear in the child's chat UI
			//      when the user views the child task, so the USER can answer
			//      interactively (click a suggestion or type a response).
			//   2. The parent agent can answer via `answer_subtask_question`, which
			//      resolves the pending ask by calling `handleWebviewAskResponse`.
			//   3. The `task.ask("followup")` emits `TaskInteractive` → the
			//      TaskManager adds a `needs_input` notification so the user knows
			//      a background child has a question.
			//
			// Whichever channel answers first resolves the ask; the other becomes
			// a no-op (the ask is no longer pending).
			const provider = task.providerRef?.deref()
			if (provider && task.parentTaskId && task.isBackgroundTask) {
				// Finalize the streaming "tool" ChatRow before presenting the
				// followup ask. This tool is in the "questions" group and
				// auto-approved for background children (which inherit
				// alwaysAllow* settings), so askApproval returns immediately
				// while rendering a ChatRow entry.
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
				try {
					// Store the question metadata so check_task_status / wait_for_task
					// can surface the question text and suggestions to the parent agent.
					task.setPendingParentQuestionInfo({ question, suggestions })

					// Wake any wait_for_task currently blocked on this child so the
					// parent agent can discover the question immediately.
					provider.taskManager.emit("managedTask:needs-parent-input", task.taskId, question)

					// Block on the followup ask. This renders the question (with
					// suggestion buttons) in the child's chat UI. The ask is
					// resolved when EITHER the parent answers (via
					// answer_subtask_question → handleWebviewAskResponse) OR the
					// user answers interactively (clicking a suggestion / typing
					// in the child's chat). The `followup` ask type is an
					// interactiveAsk, so TaskManager emits a `needs_input`
					// notification for background children — the user is alerted.
					const { text, images } = await task.ask("followup", JSON.stringify(follow_up_json), false)
					const answer = text ?? ""
					await task.say("user_feedback", answer, images)
					pushToolResult(formatResponse.toolResult(`<user_message>\n${answer}\n</user_message>`, images))
				} catch (askErr) {
					// The ask was aborted (AskIgnoredError) — the task was stopped
					// or superseded. Surface a clean tool error.
					pushToolResult(
						formatResponse.toolError(
							`ask_followup_question was cancelled before an answer was received: ${
								askErr instanceof Error ? askErr.message : String(askErr)
							}`,
						),
					)
				} finally {
					// The child is resuming — whether the parent answered, the user
					// answered, the wait was aborted, or setup threw. Clear the
					// pending question metadata and restore the parent's handle
					// view so neither is stranded in "waiting_for_parent".
					task.clearPendingParentQuestion()
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
