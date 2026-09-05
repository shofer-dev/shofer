/**
 * `send_message` — put an envelope in another task's mailbox.
 *
 * The one send verb. It replaces the sync/async split of the old peer-messaging
 * tool with a single non-blocking send whose only variable is whether the sender
 * expects an answer (`kind`), and it removes the BUSY GATE entirely: the
 * recipient's lifecycle is never consulted, because a mailbox is exactly the
 * thing that makes a recipient's state irrelevant to a sender.
 *
 * # Resolving `to`, in three steps and in this order
 *
 * 1. **A live instance on this host** (`TaskManager`) — always wins.
 * 2. **A registered mailbox transport** that claims the id. `shofer-mesh` claims
 *    ids the mesh directory says are registered on ANOTHER node, which is what
 *    lets one send verb address a peer in another pod.
 * 3. **A dormant local task**, rehydrated from history.
 *
 * **The transport is asked BEFORE history, and that ordering is a bug fix rather
 * than a preference.** Several hosts can share one task store — a worker pool on
 * one Postgres is the deployed case — and then a task running on a SIBLING pod
 * has a history row here too. A history-first order therefore read a remote peer
 * as a dormant local task and did two wrong things with it: it applied the
 * in-process ACL (refusing the send with "does not share your root task", which
 * is meaningless across pods), and on a `wake: true` delivery it would rehydrate
 * a SECOND live instance of a task another pod is already running. Only the
 * directory can tell those apart, so it is consulted first.
 *
 * **A transport that has not come up yet leaves the same trap one layer down.**
 * `canRoute` must answer `false` when it cannot establish an answer — otherwise a
 * local message goes off-node — so during the seconds before a transport can reach
 * its directory, step 3 runs anyway and refuses the remote peer with that same
 * scope sentence. Routing is right to be conservative there; the EXPLANATION is
 * not, because nothing distinguishes it from a real ACL decision. So before this
 * file states an in-process rule it asks `mailboxRoutingUnavailable`, and reports
 * the routing gap instead when there is one.
 *
 * The full contract, including the validation order this file implements, is
 * `docs/task_messaging.md` § "The three tools".
 */

import { randomUUID } from "crypto"

import { TelemetryService } from "@shofer/telemetry"

import {
	MAILBOX_NOTIFICATION_TIMEOUT_SEC,
	MAILBOX_REQUEST_TIMEOUT_SEC,
	deriveSubject,
	type Envelope,
	type MailboxPlane,
	type PluginMailboxTransport,
	type ToolUse,
} from "@shofer/types"

import { BaseTool, ToolCallbacks } from "./BaseTool.js"
import { getManagedTaskTitle } from "./helpers/managedTaskTitle.js"
import { Task } from "../task/Task.js"
import { formatResponse } from "../prompts/responses.js"

interface SendMessageParams {
	to: string
	body: string
	kind?: "notification" | "request" | null
	subject?: string | null
	timeout_sec?: number | null
	wake?: boolean | null
}

/** Collapse whitespace and clip for a Sequence-view arrow label. */
const vizTruncate = (value: string | undefined, max = 80): string => {
	const s = (value ?? "").replace(/\s+/g, " ").trim()
	return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

export class SendMessageTool extends BaseTool<"send_message"> {
	readonly name = "send_message" as const

	async execute(params: SendMessageParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { to, body } = params
		const { askApproval, handleError, pushToolResult } = callbacks

		try {
			const kind = params.kind ?? "notification"
			// Per-kind defaults (decision 5): a request expects an answer, so it
			// wakes and expires quickly; a notification does neither.
			const wake = params.wake ?? kind === "request"
			const timeoutSec =
				params.timeout_sec ??
				(kind === "request" ? MAILBOX_REQUEST_TIMEOUT_SEC : MAILBOX_NOTIFICATION_TIMEOUT_SEC)

			if (!to) {
				pushToolResult(formatResponse.toolError("Missing required parameter 'to'."))
				return
			}
			if (typeof body !== "string" || body.length === 0) {
				pushToolResult(formatResponse.toolError("Missing required parameter 'body'."))
				return
			}

			// --- Validation, in the documented order ---

			// 1. Not self. A task cannot mail itself: it would read its own message
			//    as if it came from somewhere, and no coordination exists to model.
			if (to === task.taskId) {
				pushToolResult(formatResponse.toolError("Cannot send a message to yourself."))
				return
			}

			const provider = task.providerRef.deref()
			if (!provider) {
				pushToolResult(formatResponse.toolError("Provider reference lost"))
				return
			}

			// 2. Resolve `to`: live instance → transport → dormant history.
			const effectiveRootId = task.rootTaskId ?? task.taskId
			const liveTarget = provider.taskManager.getManagedTaskInstance(to)
			let targetRootId: string | undefined
			let transport: PluginMailboxTransport | undefined
			if (liveTarget) {
				// A task running in THIS process. Nothing beats it, and no directory
				// call is made — the common case pays nothing for the rare one.
				targetRootId = liveTarget.rootTaskId ?? liveTarget.taskId
			} else {
				// Ask the mesh BEFORE history: on a pool sharing one task store, a
				// sibling pod's live task has a history row here, and only the
				// directory can tell it from a dormant local one.
				// The sender's own id: the transport authenticates its directory
				// lookup as this task, and asking as anyone else answers a question
				// about the wrong principal.
				transport = await provider.findMailboxTransport?.(to, task.taskId)
				if (!transport) {
					try {
						const { historyItem } = await provider.getTaskWithId(to)
						targetRootId = historyItem.rootTaskId ?? historyItem.id
					} catch {
						pushToolResult(
							formatResponse.toolError(
								`Task ${to} is not reachable from this host and no mesh transport claims it. ` +
									`Check the id with list_background_tasks(scope="peers"), or agents_discover ` +
									`for a peer on the mesh.`,
							),
						)
						return
					}
				}
			}

			// 3 & 4 are the IN-PROCESS gate, and they apply only to the LOCAL
			// branches (a live instance, or a dormant task rehydrated from history).
			// A remote peer shares no root task by construction and appears in
			// nobody's `knownPeers`, so applying either to a transport-routed
			// envelope would refuse every remote send there is — which is exactly
			// the defect the ordering above fixes. What gates a remote send instead
			// is the message-broker's A2A facet — badge, registration, policy
			// pairing, target liveness — a trusted gate, unlike this process
			// (`docs/messaging/a2a_messaging.md` §4.3).
			if (!transport) {
				// 3. Same tree. A root id is the boundary of a conversation.
				if (targetRootId !== effectiveRootId) {
					// …unless no transport was in a position to ANSWER. On a pool
					// sharing one task store, the row this branch just read may belong
					// to a task another pod is running right now, and only a transport
					// can tell — so while one is still coming up, "not in your tree" is
					// a sentence about the wrong question, and it is indistinguishable
					// from a real scope decision. Asking for the reason is confined to
					// this refusal path: a send that succeeds never pays for it, and a
					// transport with nothing to say leaves the scope refusal intact,
					// which is the honest answer once the mesh HAS looked.
					const unavailable = await provider.mailboxRoutingUnavailable?.(to, task.taskId)
					pushToolResult(
						formatResponse.toolError(
							unavailable
								? `Could not resolve ${to}: ${unavailable}`
								: `Task ${to} does not share your root task.`,
						),
					)
					return
				}

				// 4. The in-process ACL. The root is omnipotent inside its own tree; a
				//    sub-task may address only its granted peers.
				if (task.rootTaskId && (!task.knownPeers || !task.knownPeers.has(to))) {
					pushToolResult(formatResponse.toolError(`Task ${to} is not in your allowed peer set.`))
					return
				}
			}

			// NO BUSY GATE. The recipient's lifecycle decides only how the delivery
			// is announced (Task.deliver), never whether it is accepted.

			const subject = params.subject ? params.subject.slice(0, 120) : deriveSubject(body)
			const now = Date.now()
			// The plane is informational, but it is the ONLY record of which route an
			// envelope took — and `reply` reads it back to decide where the answer
			// goes, so it has to be right at the send.
			const plane: MailboxPlane = transport ? "a2a" : "local"
			const envelope: Envelope = {
				id: randomUUID(),
				from: task.taskId,
				to,
				kind,
				subject,
				body,
				deadline: now + Math.max(1, Math.round(timeoutSec)) * 1000,
				wake,
				sent_at: now,
				plane,
			}

			const completeMessage = JSON.stringify({
				tool: "sendMessage",
				task_id: to,
				task_title: getManagedTaskTitle(task, to),
				message: body,
				kind,
				subject,
				envelope_id: envelope.id,
				timeout_sec: timeoutSec,
			})
			const didApprove = await askApproval("tool", completeMessage)
			if (!didApprove) {
				return
			}

			// 5. The box itself — or the wire. `deliverToTask` hands to a live
			//    instance or rehydrates a dormant one; a transport hands the envelope
			//    to the far side. Both throw for a refusal (a full box, an errored
			//    task, a denied or undeliverable exchange), and every one of those is
			//    reported to the sender rather than swallowed.
			try {
				if (transport) {
					await transport.send(envelope)
				} else {
					await provider.deliverToTask(to, envelope)
				}
			} catch (error) {
				pushToolResult(
					formatResponse.toolError(
						`Could not deliver to ${transport ? "agent" : "task"} ${to}: ` +
							`${error instanceof Error ? error.message : String(error)}`,
					),
				)
				return
			}

			await task.emitTaskInteraction({
				fromTaskId: task.taskId,
				toTaskId: to,
				kind: "message",
				label: vizTruncate(subject),
				async: true,
			})

			try {
				TelemetryService.instance.captureMailboxSent(task.taskId, { kind, plane, wake })
			} catch {
				// non-fatal
			}

			const title = getManagedTaskTitle(task, to)
			pushToolResult(
				`Sent ${kind} ${envelope.id} to ${to}${title ? ` ("${title}")` : ""} ("${subject}")` +
					`${transport ? " over the agent mesh" : ""}; expires in ${timeoutSec}s.` +
					(kind === "request"
						? ` Call wait(in_reply_to="${envelope.id}") if you need the answer before you can continue.`
						: ""),
			)
		} catch (error) {
			await handleError("sending a message", error instanceof Error ? error : new Error(String(error)))
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"send_message">): Promise<void> {
		const partialMessage = JSON.stringify({
			tool: "sendMessage",
			task_id: block.params.to ?? "",
			message: block.params.body ?? "",
			kind: block.params.kind ?? "notification",
		})
		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const sendMessageTool = new SendMessageTool()
