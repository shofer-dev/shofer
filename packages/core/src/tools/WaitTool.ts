/**
 * `wait` — read this task's mailbox, parking until something arrives.
 *
 * Three properties, each load-bearing:
 *
 * - **It returns the WHOLE box.** `from` and `in_reply_to` are wake CONDITIONS,
 *   never filters on the result. Two tasks waiting on each other therefore
 *   cannot starve: the first delivery in either direction unparks its recipient
 *   with everything it has.
 * - **The timeout is mandatory and a timeout is not an error.** An empty box at
 *   the deadline returns an empty list and the agent keeps working. That is also
 *   what makes this tool the successor of `sleep`: a park that ends EARLY when
 *   mail arrives is what every polling loop actually wanted.
 * - **The park is cooperative.** An `AbortController` races
 *   `mailbox.once("delivered")` against the timer and the task's own
 *   `abortSignal`, so a Stop tears the listener and the timer down instead of
 *   leaking them (Cooperative Cancellation Rule).
 *
 * Entering the park puts the task in the `waiting` lifecycle and leaving it
 * restores `running` — the same mechanism, and the same `finally`, that
 * `wait_for_task` uses. See `docs/task_messaging.md` § "The three tools".
 */

import { TelemetryService } from "@shofer/telemetry"

import { MAILBOX_WAIT_TIMEOUT_SEC, type Envelope, type ToolUse } from "@shofer/types"

import { BaseTool, ToolCallbacks } from "./BaseTool.js"
import { getManagedTaskTitle } from "./helpers/managedTaskTitle.js"
import { Task } from "../task/Task.js"
import type { ReadEnvelope } from "../mailbox/Mailbox.js"

interface WaitParams {
	timeout_sec?: number | null
	from?: string[] | null
	in_reply_to?: string | null
}

/** Render one returned envelope for the tool result. */
function renderEnvelope(task: Task, env: ReadEnvelope): string {
	const title = getManagedTaskTitle(task, env.from)
	const header =
		`[${env.kind}${env.in_reply_to ? ` to ${env.in_reply_to}` : ""}] ${env.id} ` +
		`from ${env.from}${title ? ` ("${title}")` : ""} · "${env.subject}" · ${env.remaining_sec}s left`
	const footer =
		env.kind === "request" ? `\n(Answer with reply({ replies: [{ message_id: "${env.id}", body: "…" }] }).)` : ""
	return `${header}\n${env.body}${footer}`
}

export class WaitTool extends BaseTool<"wait"> {
	readonly name = "wait" as const

	async execute(params: WaitParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { askApproval, handleError, pushToolResult } = callbacks

		try {
			const timeoutSec = Math.max(0, params.timeout_sec ?? MAILBOX_WAIT_TIMEOUT_SEC)
			const fromFilter = Array.isArray(params.from) ? params.from.filter((id) => typeof id === "string") : []
			const inReplyTo = params.in_reply_to ?? undefined

			const completeMessage = JSON.stringify({
				tool: "wait",
				timeout_sec: timeoutSec,
				from_ids: fromFilter.length > 0 ? fromFilter : undefined,
				in_reply_to: inReplyTo,
			})
			const didApprove = await askApproval("tool", completeMessage)
			if (!didApprove) {
				return
			}

			await task.mailboxReady

			/** Does anything currently in the box satisfy the wake condition? */
			const wakeConditionMet = (): boolean => {
				const pending = task.mailbox.pending()
				if (pending.length === 0) {
					return false
				}
				if (fromFilter.length === 0 && !inReplyTo) {
					return true
				}
				return pending.some(
					(env) =>
						(fromFilter.length > 0 && fromFilter.includes(env.from)) ||
						(!!inReplyTo && env.in_reply_to === inReplyTo),
				)
			}

			if (!wakeConditionMet() && timeoutSec > 0) {
				const provider = task.providerRef.deref()
				// `waiting` is not `idle`: the task has live work elsewhere, it is
				// simply not advancing its own loop. Restored in the `finally` so an
				// exception cannot strand it here forever.
				provider?.taskManager?.setState(task.taskId, { lifecycle: "waiting" })
				try {
					await new Promise<void>((resolve) => {
						const controller = new AbortController()
						let settled = false

						const cleanup = () => {
							if (settled) return
							settled = true
							task.mailbox.off("delivered", onDelivered)
							task.abortSignal?.removeEventListener("abort", onAbort)
							clearTimeout(timer)
						}

						const finish = () => {
							cleanup()
							resolve()
						}

						const onDelivered = () => {
							// Every delivery re-evaluates the condition; one that does not
							// match leaves the park in place rather than returning early.
							if (wakeConditionMet()) {
								finish()
							}
						}

						const onAbort = () => {
							controller.abort()
							finish()
						}

						const timer = setTimeout(finish, timeoutSec * 1000)

						task.mailbox.on("delivered", onDelivered)

						if (task.abortSignal?.aborted) {
							onAbort()
						} else {
							task.abortSignal?.addEventListener("abort", onAbort, { once: true })
						}

						// Close the race between the check above and the listener being
						// attached: an envelope delivered in between would otherwise park
						// a task whose condition is already satisfied.
						if (wakeConditionMet()) {
							finish()
						}
					})
				} finally {
					// Only resurrect a task that is still alive — a Stop must not come
					// back as `running`.
					if (!task.abort && !task.abandoned) {
						provider?.taskManager?.setState(task.taskId, { lifecycle: "running" })
					}
				}

				if (task.abort || task.abandoned) {
					return
				}
			}

			const envelopes = await task.mailbox.drain()

			// Surface every envelope in the chat at the moment the agent read it, so
			// the human sees the inbound side of a conversation between tasks and not
			// just the outbound sends.
			for (const env of envelopes) {
				await task.say(
					"peer_message",
					JSON.stringify({
						senderTaskId: env.from,
						senderTitle: getManagedTaskTitle(task, env.from) ?? env.from,
						message: env.body,
						timestamp: env.sent_at,
						id: env.id,
						kind: env.kind,
						subject: env.subject,
						in_reply_to: env.in_reply_to,
					}),
				)
			}

			try {
				TelemetryService.instance.captureMailboxRead(task.taskId, { count: envelopes.length })
			} catch {
				// non-fatal
			}

			if (envelopes.length === 0) {
				pushToolResult(
					`No mail after ${timeoutSec}s. Your mailbox is empty — carry on with your work, or end your ` +
						`turn if there is nothing left to do (a message sent with wake will restart you).`,
				)
				return
			}

			const requests = envelopes.filter((env: Envelope) => env.kind === "request").length
			const header =
				`${envelopes.length} message(s) in your mailbox` +
				(requests > 0 ? ` (${requests} awaiting your reply)` : "") +
				":"
			pushToolResult(`${header}\n\n${envelopes.map((env) => renderEnvelope(task, env)).join("\n\n")}`)
		} catch (error) {
			await handleError("waiting for mail", error instanceof Error ? error : new Error(String(error)))
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"wait">): Promise<void> {
		const partialMessage = JSON.stringify({
			tool: "wait",
			timeout_sec: block.nativeArgs?.timeout_sec ?? undefined,
		})
		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const waitTool = new WaitTool()
