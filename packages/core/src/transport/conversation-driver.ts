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
 */

/** The registered probe, or `undefined` on a host that is not remotely driven. */
let driverProbe: ((taskId: string) => boolean) | undefined

/**
 * Register (or clear, with `undefined`) the probe answering whether a task's
 * event stream currently has a subscriber. Called by the transport that owns
 * the subscriptions; calling it twice replaces the previous probe.
 */
export function setConversationDriverProbe(probe: ((taskId: string) => boolean) | undefined): void {
	driverProbe = probe
}

/**
 * Whether a remote driver is attached to `taskId`'s event stream.
 *
 * - `true`  — at least one subscriber would receive an ask published there.
 * - `false` — the host IS remotely driven and nobody is listening to this task.
 * - `undefined` — the host is not remotely driven; the question does not apply.
 */
export function isConversationDriverAttached(taskId: string): boolean | undefined {
	if (!driverProbe) return undefined
	return driverProbe(taskId)
}
