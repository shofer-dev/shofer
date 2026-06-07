/**
 * IPC interface types for routing vscode API calls from workers to the main thread.
 *
 * These types define the message protocol between the vscode-shim (running in
 * an Agent Worker) and the main Extension Host thread. They are used by
 * WindowAPI, CommandsAPI, and other shim components when a `parentPort` is
 * provided at shim-creation time.
 *
 * In the default (main-thread) code path these are dormant — no parentPort,
 * no IPC messages. When a worker bootstrap wires a parentPort, the shim
 * transparently forwards vscode API calls through it.
 */

/** Unique identifier for correlating vscode API requests with responses. */
export type VscodeApiRequestId = string

/** Discriminant for vscode API IPC messages. */
export const VSCODE_API_IPC_TYPE = "vscode_api" as const

/** Discriminant for vscode API response IPC messages. */
export const VSCODE_API_RESULT_TYPE = "vscode_api_result" as const

/**
 * Request message sent from the worker's vscode-shim to the main thread
 * when a vscode API method needs the real VS Code extension host.
 */
export interface VscodeApiRequest {
	type: typeof VSCODE_API_IPC_TYPE
	/** Name of the vscode API method being called (e.g. "createTerminal", "executeCommand"). */
	method: string
	/** Positional arguments for the method call. */
	args: unknown[]
	/** Correlation ID for matching the response. */
	requestId: VscodeApiRequestId
}

/**
 * Response message sent from the main thread back to the worker
 * after executing a vscode API call.
 */
export interface VscodeApiResponse {
	type: typeof VSCODE_API_RESULT_TYPE
	/** Correlation ID matching the original request. */
	requestId: VscodeApiRequestId
	/** The result of the API call, or undefined on error. */
	result?: unknown
	/** Error message if the call failed. */
	error?: string
}

/**
 * Minimal IPC port interface compatible with `worker_threads.MessagePort`.
 *
 * Represents one end of a communication pipe — either `parentPort` in a
 * worker or a port from a `MessageChannel`. The interface is intentionally
 * narrow: only the two operations the shim needs (post + listen).
 */
export interface IpcPort {
	/** Send a message through the port (structured clone). */
	postMessage(value: unknown): void
	/** Register a listener for incoming messages. */
	on(event: "message", listener: (value: unknown) => void): void
}

/** Default timeout for IPC requests (30 seconds). */
export const DEFAULT_IPC_TIMEOUT_MS = 30_000

/**
 * Canonical signature for the listener stored by `IpcDemuxer`.
 * Exported for testing.
 */
export interface PendingIpcEntry {
	resolve: (value: unknown) => void
	reject: (err: Error) => void
	timer: ReturnType<typeof setTimeout>
}

/**
 * Single-owner demultiplexer for vscode API IPC over a shared port.
 *
 * The design document routes all vscode API calls through a single
 * `parentPort`. If multiple consumers (`WindowAPI`, `CommandsAPI`) each
 * registered their own `port.on("message", …)` listener, every response
 * would be delivered to all of them — the non-owning consumer would see
 * a `VscodeApiResponse` with an unknown `requestId` and log a spurious
 * warning.
 *
 * `IpcDemuxer` solves this: it registers **one** listener on the port and
 * dispatches incoming responses by `requestId`. Callers share a single
 * demuxer instance (created in `createVSCodeAPIMock`), so there is exactly
 * one listener regardless of how many APIs consume the port.
 *
 * Each request also carries a configurable timeout; when it expires the
 * pending entry is cleaned up and the promise rejects.
 */
export class IpcDemuxer {
	private _pendingRequests = new Map<string, PendingIpcEntry>()
	private _port: IpcPort
	private _defaultTimeoutMs: number

	constructor(port: IpcPort, defaultTimeoutMs = DEFAULT_IPC_TIMEOUT_MS) {
		this._port = port
		this._defaultTimeoutMs = defaultTimeoutMs

		// Single listener on the shared port — prevents duplicate-delivery warnings.
		port.on("message", (msg: unknown) => {
			if (!isVscodeApiResponse(msg)) {
				return
			}
			const entry = this._pendingRequests.get(msg.requestId)
			if (!entry) {
				// Cross-API delivery is expected when multiple consumers share the
				// port — the response arrived for a different consumer's requestId.
				// No warning here; each consumer receives responses meant for it only.
				return
			}
			this._pendingRequests.delete(msg.requestId)
			clearTimeout(entry.timer)
			if (msg.error) {
				entry.reject(new Error(msg.error))
			} else {
				entry.resolve(msg.result)
			}
		})
	}

	/**
	 * Dispatches a vscode API call through the shared port and returns a promise
	 * that resolves with the main-thread result.
	 *
	 * @param method  The vscode API method name (e.g. "createTerminal").
	 * @param args    Positional arguments for the method call.
	 * @param timeoutMs  Per-call timeout override (falls back to constructor default).
	 */
	dispatchRequest(method: string, args: unknown[], timeoutMs?: number): Promise<unknown> {
		const requestId = generateRequestId()
		const timeout = timeoutMs ?? this._defaultTimeoutMs

		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this._pendingRequests.delete(requestId)
				reject(new Error(`vscode API "${method}" timed out after ${timeout}ms`))
			}, timeout)

			this._pendingRequests.set(requestId, { resolve, reject, timer })
			this._port.postMessage({
				type: VSCODE_API_IPC_TYPE,
				method,
				args,
				requestId,
			})
		})
	}

	/**
	 * Number of currently-pending requests. Exposed for testing.
	 */
	public get pendingCount(): number {
		return this._pendingRequests.size
	}

	/**
	 * Clears all pending requests, rejecting them with the given reason.
	 * Called during worker shutdown.
	 */
	dispose(reason = "IpcDemuxer disposed"): void {
		for (const [id, entry] of this._pendingRequests) {
			clearTimeout(entry.timer)
			entry.reject(new Error(reason))
			this._pendingRequests.delete(id)
		}
	}
}

/** Generates a unique request ID for vscode API call correlation. */
let _requestCounter = 0
export function generateRequestId(): VscodeApiRequestId {
	return `vscode-api-${Date.now()}-${++_requestCounter}`
}

/**
 * Type guard for `VscodeApiResponse` messages received on the IPC port.
 */
export function isVscodeApiResponse(msg: unknown): msg is VscodeApiResponse {
	return typeof msg === "object" && msg !== null && (msg as Record<string, unknown>).type === VSCODE_API_RESULT_TYPE
}
