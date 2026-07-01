/**
 * Minimal JSON-RPC 2.0 peer over newline-delimited JSON (v3 architecture §12 — ACP).
 *
 * ACP is JSON-RPC 2.0 framed as one JSON object per line on stdio. This is a small,
 * dependency-free implementation of that framing so `shofer acp` can run without the
 * upstream SDK (the environment's registry doesn't currently serve it); it is a drop-in
 * for `@zed-industries/agent-client-protocol`'s connection when that is available.
 *
 * The peer is transport-agnostic: it is constructed with a `write(line)` sink and fed
 * incoming messages via {@link JsonRpcPeer.receive}. A stdio wrapper (`runAcpAgent`)
 * connects it to real streams; tests drive it with in-memory arrays.
 */

export interface JsonRpcRequest {
	jsonrpc: "2.0"
	id: number | string
	method: string
	params?: unknown
}
export interface JsonRpcNotification {
	jsonrpc: "2.0"
	method: string
	params?: unknown
}
export interface JsonRpcResponse {
	jsonrpc: "2.0"
	id: number | string
	result?: unknown
	error?: { code: number; message: string; data?: unknown }
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse

export type RequestHandler = (params: unknown) => Promise<unknown> | unknown
export type NotificationHandler = (params: unknown) => void

const METHOD_NOT_FOUND = -32601
const INTERNAL_ERROR = -32603

/** A JSON-RPC 2.0 peer: dispatches inbound requests/notifications and issues outbound ones. */
export class JsonRpcPeer {
	private readonly requestHandlers = new Map<string, RequestHandler>()
	private readonly notificationHandlers = new Map<string, NotificationHandler>()
	private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
	private nextId = 1

	/** @param write sink for outbound frames (one JSON object, no trailing newline — the transport adds it). */
	constructor(private readonly write: (frame: string) => void) {}

	onRequest(method: string, handler: RequestHandler): void {
		this.requestHandlers.set(method, handler)
	}
	onNotification(method: string, handler: NotificationHandler): void {
		this.notificationHandlers.set(method, handler)
	}

	/** Send a notification (no response expected). */
	notify(method: string, params?: unknown): void {
		this.send({ jsonrpc: "2.0", method, params })
	}

	/** Send a request and resolve with its result (or reject on error). */
	request(method: string, params?: unknown): Promise<unknown> {
		const id = this.nextId++
		return new Promise<unknown>((resolve, reject) => {
			this.pending.set(id, { resolve, reject })
			this.send({ jsonrpc: "2.0", id, method, params })
		})
	}

	/** Feed one parsed inbound message. Resolves when any handler it triggers settles. */
	async receive(msg: JsonRpcMessage): Promise<void> {
		// Response to one of our outbound requests.
		if ("id" in msg && msg.id != null && !("method" in msg)) {
			const pend = this.pending.get(msg.id as number)
			if (!pend) return
			this.pending.delete(msg.id as number)
			const res = msg as JsonRpcResponse
			if (res.error) pend.reject(new Error(res.error.message))
			else pend.resolve(res.result)
			return
		}
		// Inbound request (has id + method).
		if ("id" in msg && "method" in msg) {
			const req = msg as JsonRpcRequest
			const handler = this.requestHandlers.get(req.method)
			if (!handler) {
				this.send({
					jsonrpc: "2.0",
					id: req.id,
					error: { code: METHOD_NOT_FOUND, message: `Method not found: ${req.method}` },
				})
				return
			}
			try {
				const result = await handler(req.params)
				this.send({ jsonrpc: "2.0", id: req.id, result: result ?? null })
			} catch (e) {
				this.send({
					jsonrpc: "2.0",
					id: req.id,
					error: { code: INTERNAL_ERROR, message: e instanceof Error ? e.message : String(e) },
				})
			}
			return
		}
		// Inbound notification (method, no id).
		if ("method" in msg) {
			this.notificationHandlers.get((msg as JsonRpcNotification).method)?.((msg as JsonRpcNotification).params)
		}
	}

	private send(msg: JsonRpcMessage): void {
		this.write(JSON.stringify(msg))
	}
}
