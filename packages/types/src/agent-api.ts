/**
 * The transport-agnostic agent surface (v3 architecture §11).
 *
 * `AgentApi` is the minimal control plane a front-end/transport drives: create a
 * task, send follow-up messages, cancel, and subscribe to the event stream. Every
 * transport (HTTP/SSE, ACP over stdio, the controller↔executor session protocol)
 * is implemented over this one interface, and the live in-process implementation
 * (`ShoferApiAgent`) backs it with the extension's `ShoferAPI`.
 *
 * Lives in `@shofer/types` (vscode-free) so both the core-side implementations and
 * the wire-protocol modules (`session-transport.ts`) can share it.
 */

/** A streamed agent event. `type` is the event name; other fields are event-specific. */
export interface ServerEvent {
	type: string
	[key: string]: unknown
}

/** A reply to an outstanding `ask` (interactive tool approval / follow-up). */
export interface AskResponse {
	/** The ask-response verb (e.g. `yesButtonClicked`, `noButtonClicked`, `messageResponse`). */
	askResponse: string
	/** Optional free-text the user typed alongside the response. */
	text?: string
	/** Optional image data URIs attached to the response. */
	images?: string[]
	/** The id of the ask being answered (routes to the correct outstanding ask). */
	askId?: string
}

/** The agent control plane a transport drives. */
export interface AgentApi {
	createTask(input: { prompt: string; taskId?: string }): Promise<{ taskId: string }>
	sendMessage(taskId: string, message: string): Promise<void>
	cancelTask(taskId: string): Promise<void>
	/**
	 * Answer a task's outstanding `ask` (interactive tool approval / follow-up).
	 * This is the reverse of the `ask` events streamed via {@link subscribe}: the
	 * front-end drives an approval back to the owning executor, so a remote task's
	 * approvals round-trip exactly like a local task's.
	 */
	respondToAsk(taskId: string, response: AskResponse): Promise<void>
	/** Subscribe to the agent event stream; returns an unsubscribe fn. */
	subscribe(listener: (event: ServerEvent) => void): () => void
}
