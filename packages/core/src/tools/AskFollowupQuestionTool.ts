import type { ParamField } from "@shofer/types"

import { randomUUID } from "crypto"

import { MAILBOX_CHILD_QUESTION_TIMEOUT_SEC } from "@shofer/types"

import { Task } from "../task/Task.js"
import { taskLog } from "../logging/subsystems.js"
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

			// A CHILD's question is dual-channel: it goes to the parent's MAILBOX as
			// a `request` AND is rendered in the child's own chat with
			// `task.ask("followup")`, the same mechanism a user-facing question
			// uses, so suggestion buttons appear when a human views the child.
			// Either channel may answer and the first answer wins.
			const isChildWithParent = !!(task.providerRef?.deref() && task.parentTaskId && task.isBackgroundTask)

			// A child whose parent is NOT concurrent has the opposite problem: its
			// parent is the entity that created it, but cannot answer, because it is
			// suspended waiting for this child to finish. `new_task` no longer
			// produces such a task — every child is concurrent — but a host can still
			// construct one directly, so the escalation stays. The next hop backwards
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
			// A child never uses form mode — the parent answers in free text with
			// `reply`, and the form UI is designed for interactive human input.
			// Fall through to the followup-ask path below.
			if (hasForm && !isChildWithParent) {
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
			// follow_up may be null/empty when a child used form mode — the parent
			// receives the bare question and answers in free text.
			const suggestions = (follow_up ?? []).map((s) => ({ answer: s.text, mode: s.mode }))
			const follow_up_json = {
				question,
				suggest: suggestions,
			}

			// A CHILD's question, on both channels at once.
			//
			//   1. It is delivered to the parent's mailbox as a `request`, so the
			//      parent sees it in its digest and answers with `reply`.
			//   2. It is raised as an ordinary `followup` ask in the child's own
			//      chat, so a human who opens the child can answer it there.
			//
			// Whichever answers first wins: a parent's `reply` resolves the ask
			// through `answerForwardedQuestion`, and a human's answer resolves the
			// ask directly — after which the now-pointless request is withdrawn from
			// the parent's box in the `finally` below. The child sits in
			// `waiting_input` throughout: it is parked on an ANSWER, not on mail.
			const provider = task.providerRef?.deref()
			if (provider && task.parentTaskId && task.isBackgroundTask) {
				// Finalize the streaming "tool" ChatRow before presenting the
				// followup ask. This tool is in the "questions" group and
				// auto-approved for children, so askApproval returns immediately
				// while rendering a ChatRow entry.
				const completeMessage = JSON.stringify({
					tool: "askFollowupQuestion",
					question,
				})
				const didApprove = await callbacks.askApproval("tool", completeMessage)
				if (!didApprove) {
					return
				}

				// Flip the parent's view of this child so check_task_status and
				// list_background_tasks reflect reality.
				const parentInstance = provider.taskManager.getManagedTaskInstance(task.parentTaskId)
				const handleOnParent = parentInstance?.backgroundChildren.get(task.taskId)
				const previousHandleStatus = handleOnParent?.status
				if (handleOnParent) {
					handleOnParent.status = "waiting_for_parent"
				}

				const now = Date.now()
				const deadline = now + MAILBOX_CHILD_QUESTION_TIMEOUT_SEC * 1000
				const envelopeId = randomUUID()
				const suggestionLines =
					suggestions.length > 0
						? `\n\nSuggested answers:\n${suggestions.map((sg) => `- ${sg.answer}`).join("\n")}`
						: ""

				let expiryTimer: ReturnType<typeof setTimeout> | undefined
				try {
					// Deliver FIRST, so the child never parks on a question its parent
					// was never told about. A refused delivery (parent gone, box full)
					// is not fatal: the human channel is still live, so the question is
					// asked anyway and only the parent's copy is lost.
					try {
						await provider.deliverToTask(task.parentTaskId, {
							id: envelopeId,
							from: task.taskId,
							to: task.parentTaskId,
							kind: "request",
							subject: `question: ${question.split("\n")[0] ?? question}`.slice(0, 120),
							body: `${question}${suggestionLines}`,
							deadline,
							wake: true,
							sent_at: now,
							plane: "local",
						})
					} catch (deliverErr) {
						taskLog.error(
							`[AskFollowupQuestionTool] Could not deliver ${task.taskId}'s question to parent ` +
								`${task.parentTaskId}: ${deliverErr instanceof Error ? deliverErr.message : String(deliverErr)}`,
						)
					}

					// Record the correlation so a parent `reply` can find this ask, and
					// so check_task_status / the notification suppression can see that
					// the child is waiting on an answer.
					task.setForwardedQuestion({ envelopeId, question })

					// Arm the child's own expiry. The mailbox never sweeps on a timer —
					// expiry there is lazy, at read — but a child parked on an ask has
					// nobody to read anything, so without this it would wait forever for
					// a request that has already lapsed out of its parent's box. The
					// synthesized answer restores the child's liveness rather than
					// failing its turn: it is a decision the child can act on.
					expiryTimer = setTimeout(() => {
						task.answerForwardedQuestion(
							envelopeId,
							`Your question to the parent expired unanswered after ` +
								`${MAILBOX_CHILD_QUESTION_TIMEOUT_SEC}s. Decide yourself, or ask again.`,
						)
					}, deadline - Date.now())

					// Park. Resolved by whichever channel answers first.
					const { text, images } = await task.ask("followup", JSON.stringify(follow_up_json), false)
					const answer = text ?? ""
					await task.say("user_feedback", answer, images)
					pushToolResult(formatResponse.toolResult(`<user_message>\n${answer}\n</user_message>`, images))
				} catch (askErr) {
					// The ask was aborted (AskIgnoredError) — the task was stopped or
					// superseded. Surface a clean tool error.
					pushToolResult(
						formatResponse.toolError(
							`ask_followup_question was cancelled before an answer was received: ${
								askErr instanceof Error ? askErr.message : String(askErr)
							}`,
						),
					)
				} finally {
					if (expiryTimer) {
						clearTimeout(expiryTimer)
					}
					task.clearForwardedQuestion()
					if (handleOnParent && handleOnParent.status === "waiting_for_parent") {
						handleOnParent.status = previousHandleStatus ?? "running"
					}
					// Withdraw the request from the parent's box. When the PARENT
					// answered, `reply` already removed it and this is a no-op; when the
					// HUMAN answered (or the ask was aborted), this is what stops the
					// parent's digest showing a question nobody is waiting on any more.
					try {
						await parentInstance?.mailbox.resolveRequest(envelopeId)
					} catch {
						// Already resolved, expired, or the parent is not live here.
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
