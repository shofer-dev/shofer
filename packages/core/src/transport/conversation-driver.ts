/**
 * Is anyone DRIVING this conversation from outside the host?
 *
 * A host that is driven over the {@link ShoferApi} transport (`shofer serve`)
 * has no local user: its CLI ask dispatcher is started with
 * `brokerInteractiveAsks`, so every interactive ask is deliberately left
 * outstanding for the remote controller to answer via `respondToAsk`. That is
 * correct exactly while a controller is subscribed to the task's event stream —
 * and silently wrong when none is, because the ask then parks forever with
 * nobody who could ever see it.
 *
 * The transport is the only layer that knows the answer (it owns the SSE
 * subscriptions), and the agent loop is the only layer that can act on it, so
 * this module is the one-line seam between them. `serveHttpOverShoferApi`
 * registers a probe backed by the server's live subscriber census; every other
 * host — the VS Code extension, `shofer` on a terminal, the ACP bridge —
 * registers nothing, and {@link isConversationDriverAttached} answers
 * `undefined`, meaning "this host is not remotely driven; its own ask surface
 * is the audience".
 *
 * Three-valued on purpose. `false` is a positive statement that an ask raised
 * now would reach nobody, which is what licenses failing an ask fast rather
 * than blocking on it; `undefined` must never be read as `false`.
 *
 * ## `false` is a statement about an INTERVAL, not an instant
 *
 * A controller detaching and re-attaching is ordinary operation — an SSE
 * connection drops and the client re-subscribes, a proxy recycles an idle
 * stream, the controller rolls out — so a census sampled at one instant answers
 * "nobody is watching" for gaps of milliseconds that mean nothing. Reading that
 * as proof of no audience turns a transient into a permanent wrong refusal, and
 * did: a sync child was refused mid-turn while its controller was demonstrably
 * driving the conversation.
 *
 * So `false` here requires TWO independent things to hold, at two different
 * scales:
 *
 * 1. The census itself tolerates a recent detach — `mightReach`, governed by
 *    `SUBSCRIBER_REATTACH_GRACE_MS` in `http-server.ts`. That covers a
 *    controller that WAS attached and is coming back.
 * 2. A caller about to act on `false` re-asks once after
 *    {@link DRIVER_ATTACH_RECHECK_MS} via {@link confirmNoConversationDriver}.
 *    That covers the opposite case, which no grace window can: a controller
 *    that has never attached to this conversation YET because it is still
 *    opening the stream for a turn that has only just started.
 *
 * Neither is a timer that RESOLVES an ask — nothing is answered, approved or
 * denied when either window lapses. They bound only how confidently the host
 * may assert that a question reaches nobody.
 */

import delay from "delay"

/**
 * How long {@link confirmNoConversationDriver} waits before re-asking a probe
 * that answered `false`.
 *
 * 2 seconds: this covers the ATTACH-IN-PROGRESS race, whose whole span is one
 * network round-trip plus the controller's own scheduling — the controller has
 * already decided to subscribe and is mid-flight. It is deliberately far
 * shorter than the census's re-attach grace, because it is paid IN LINE by an
 * agent that is about to give up: every refusal costs it, and a longer wait
 * would buy no additional case (a controller that has not opened the stream two
 * seconds into being asked to is not "about to").
 */
export const DRIVER_ATTACH_RECHECK_MS = 2_000

/** The registered probe, or `undefined` on a host that is not remotely driven. */
let driverProbe: ((taskId: string) => boolean) | undefined

/**
 * Register (or clear, with `undefined`) the probe answering whether a task's
 * event stream currently has — or plausibly still has — a subscriber. Called by
 * the transport that owns the subscriptions; calling it twice replaces the
 * previous probe.
 */
export function setConversationDriverProbe(probe: ((taskId: string) => boolean) | undefined): void {
	driverProbe = probe
}

/**
 * Whether a remote driver is attached to `taskId`'s event stream.
 *
 * - `true`  — at least one subscriber would receive an ask published there, or
 *   one detached recently enough that a reconnect explains its absence.
 * - `false` — the host IS remotely driven and nobody is listening to this task.
 * - `undefined` — the host is not remotely driven; the question does not apply.
 */
export function isConversationDriverAttached(taskId: string): boolean | undefined {
	if (!driverProbe) return undefined
	return driverProbe(taskId)
}

/**
 * Settle whether a question raised on `taskId`'s conversation provably reaches
 * NOBODY — the only condition under which a caller may refuse to ask rather
 * than park.
 *
 * Returns `true` only when the probe answers `false` twice,
 * {@link DRIVER_ATTACH_RECHECK_MS} apart. Answers `false` immediately (no
 * delay) when a driver is attached or the host is not remotely driven, so the
 * cost is paid only on the path that is about to give up.
 */
export async function confirmNoConversationDriver(taskId: string): Promise<boolean> {
	if (isConversationDriverAttached(taskId) !== false) return false
	await delay(DRIVER_ATTACH_RECHECK_MS)
	return isConversationDriverAttached(taskId) === false
}
