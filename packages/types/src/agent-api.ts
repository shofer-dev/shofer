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

/** The agent control plane a transport drives. */
export interface AgentApi {
	createTask(input: { prompt: string; taskId?: string }): Promise<{ taskId: string }>
	sendMessage(taskId: string, message: string): Promise<void>
	cancelTask(taskId: string): Promise<void>
	/** Subscribe to the agent event stream; returns an unsubscribe fn. */
	subscribe(listener: (event: ServerEvent) => void): () => void
}
