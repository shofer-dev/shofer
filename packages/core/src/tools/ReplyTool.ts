/**
 * `reply` — answer requests sitting in this task's mailbox.
 *
 * A batch: each item discharges one request and reports its own outcome, so an
 * id that expired while the agent was thinking fails that item alone.
 *
 * **Deliver first, resolve second.** The reply envelope is delivered into the
 * asker's box BEFORE the request is removed from this task's box. The reverse
 * order loses the question on a refused delivery — a full asker box, a
 * rehydration failure — leaving the replier with nothing to answer and the
 * asker with nothing answered. This way a refused delivery fails the item and
 * the request stays answerable.
 *
 * **A reply goes back the way the question came.** A request that arrived over
 * the A2A mesh is answered through the mailbox transport that carries that
 * plane, not through the local box — the asker is in another pod and has no
 * local box here. The request's own `plane` is what records which, which is why
 * `send_message` sets it at the send rather than leaving it implicit.
 *
 * Replying is not terminal (that is the whole point of the verb existing:
 * `attempt_completion` used to be the only way to answer, and it ended the
 * replier). See `docs/task_messaging.md` § "The three tools".
 */

import { randomUUID } from "crypto"

import { TelemetryService } from "@shofer/telemetry"

import { MAILBOX_REPLY_TIMEOUT_SEC, type Envelope, type ToolUse } from "@shofer/types"

import { BaseTool, ToolCallbacks } from "./BaseTool.js"
import { Task } from "../task/Task.js"
import { formatResponse } from "../prompts/responses.js"

interface ReplyItem {
	message_id: string
	body: string
}

interface ReplyParams {
	replies: ReplyItem[]
}

/** Collapse whitespace and clip for a Sequence-view arrow label. */
const vizTruncate = (value: string | undefined, max = 80): string => {
	const s = (value ?? "").replace(/\s+/g, " ").trim()
	return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

export class ReplyTool extends BaseTool<"reply"> {
	readonly name = "reply" as const

	async execute(params: ReplyParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { askApproval, handleError, pushToolResult } = callbacks

		try {
			const items = Array.isArray(params.replies) ? params.replies : []
			if (items.length === 0) {
				pushToolResult(
					formatResponse.toolError("Missing required parameter 'replies' (expected a non-empty array)."),
				)
				return
			}

			const completeMessage = JSON.stringify({
				tool: "reply",
				replies: items.map((item) => ({ message_id: item.message_id, body: item.body })),
			})
			const didApprove = await askApproval("tool", completeMessage)
			if (!didApprove) {
				return
			}

			const provider = task.providerRef.deref()
			if (!provider) {
				pushToolResult(formatResponse.toolError("Provider reference lost"))
				return
			}

			await task.mailboxReady

			const lines: string[] = []
			for (const item of items) {
				const messageId = item?.message_id
				if (!messageId || typeof item?.body !== "string") {
					lines.push(`- ${messageId ?? "(no id)"}: failed — each reply needs a message_id and a body.`)
					continue
				}

				// Look the request up WITHOUT consuming it. `resolveRequest` removes,
				// and removal must not happen until the answer is safely delivered.
				const now = Date.now()
				const request = task.mailbox.byKind("request", now).find((env) => env.id === messageId)
				if (!request) {
					lines.push(
						`- ${messageId}: failed — no such request in your mailbox (it may have expired or already been answered).`,
					)
					continue
				}

				const envelope: Envelope = {
					id: randomUUID(),
					from: task.taskId,
					to: request.from,
					kind: "reply",
					in_reply_to: request.id,
					subject: `re: ${request.subject}`.slice(0, 120),
					body: item.body,
					// A reply must outlive the question it answers, or a slow answer
					// expires in transit and the asker learns nothing.
					deadline: Math.max(request.deadline, now + MAILBOX_REPLY_TIMEOUT_SEC * 1000),
					// A reply always wakes: somebody asked and is entitled to the answer
					// even if they ended their turn in the meantime (decision 5).
					wake: true,
					sent_at: now,
					// The answer travels the plane the question arrived on.
					plane: request.plane === "a2a" ? "a2a" : "local",
				}

				// Remote-routing block: a request that came over the mesh is answered
				// over the mesh. Only an `a2a` request is offered to a transport — a
				// local id must always be delivered locally, and `bus`/`temporal` are
				// inbound-only planes that are never a reply target.
				const transport = request.plane === "a2a" ? provider.findMailboxTransport?.(request.from) : undefined
				try {
					if (transport) {
						await transport.send(envelope)
					} else {
						await provider.deliverToTask(request.from, envelope)
					}
				} catch (error) {
					lines.push(
						`- ${messageId}: failed — could not deliver to ${request.from}: ` +
							`${error instanceof Error ? error.message : String(error)}. The request is still in your mailbox.`,
					)
					continue
				}

				// Delivered: only now discharge the request.
				try {
					await task.mailbox.resolveRequest(messageId, now)
				} catch (error) {
					// The window is tiny (an expiry between the lookup and here), and the
					// answer HAS landed — so this is reported, not treated as a failure.
					lines.push(
						`- ${messageId}: answered ${request.from}, but the request could not be cleared from your ` +
							`mailbox: ${error instanceof Error ? error.message : String(error)}.`,
					)
					continue
				}

				// ── Child-question unpark (step 3) ──────────────────────────────
				// A child that asked via `ask_followup_question` is parked on an ASK,
				// not on its mailbox, so the reply envelope alone would not reach it
				// until something else woke it. Answer the parked ask through the same
				// `handleWebviewAskResponse` path the webview uses. `answerForwardedQuestion`
				// no-ops unless that child is parked on exactly this request, so a human
				// who answered in the child's chat first still wins, and a remote sender
				// (no local instance) simply has nothing to unpark.
				try {
					const child = provider.taskManager?.getManagedTaskInstance?.(request.from)
					child?.answerForwardedQuestion(request.id, item.body)
				} catch {
					// Best-effort: the reply envelope has already been delivered.
				}

				await task.emitTaskInteraction({
					fromTaskId: task.taskId,
					toTaskId: request.from,
					kind: "answer",
					label: vizTruncate(item.body),
					async: true,
				})

				try {
					TelemetryService.instance.captureMailboxSent(task.taskId, {
						kind: "reply",
						plane: envelope.plane,
						wake: true,
					})
				} catch {
					// non-fatal
				}

				lines.push(`- ${messageId}: answered ${request.from} (reply ${envelope.id}).`)
			}

			pushToolResult(`Replied to ${items.length} request(s):\n${lines.join("\n")}`)
		} catch (error) {
			await handleError("replying to a request", error instanceof Error ? error : new Error(String(error)))
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"reply">): Promise<void> {
		const partialMessage = JSON.stringify({ tool: "reply", replies: block.nativeArgs?.replies ?? [] })
		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const replyTool = new ReplyTool()
