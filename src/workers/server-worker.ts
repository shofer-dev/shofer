/**
 * Server Worker — WebSocket + MessageChannel bridge for the multi-threaded architecture.
 *
 * Runs as its own `worker_thread`. Creates a WebSocket server on a dynamic port,
 * reports the port to the main thread, and routes messages between:
 *   - The Webview (via WebSocket)
 *   - Agent Workers (via `MessageChannel` ports)
 *
 * Key responsibilities (Phase 1):
 *   1. Accept one WebSocket connection from the Webview.
 *   2. Report the allocated port to the main thread via `parentPort`.
 *   3. Maintain a `Map<taskId, MessagePort>` for future Agent Worker routing
 *      (unused at this stage — just the data structure).
 *
 * Phase 1 routes zero production traffic — this is infrastructure only.
 * The `MessageChannel` routing is exercised in unit tests.
 */

import { parentPort } from "worker_threads"
import { WebSocketServer, WebSocket } from "ws"

/** Discriminant for server-to-main-thread IPC messages. */
const SERVER_PORT_TYPE = "server_port" as const

/** Message sent from the Server Worker to the main thread reporting the allocated port. */
interface ServerPortMessage {
	type: typeof SERVER_PORT_TYPE
	port: number
}

/**
 * Thin wrapper around a `MessagePort` so it conforms to the narrow `IpcPort`
 * interface consumed by `WorkerExtensionHost` and the vscode-shim IPC layer.
 */
interface IpcPortShim {
	postMessage(value: unknown): void
	on(event: "message", listener: (value: unknown) => void): void
}

/** Creates an IpcPortShim from a worker_threads MessagePort. */
function toIpcPortShim(port: {
	postMessage(value: unknown): void
	on(event: "message", listener: (value: unknown) => void): void
}): IpcPortShim {
	return port
}

/** Global state for the bridge (single-connection in Phase 1). */
const activeAgents = new Map<string, IpcPortShim>()
let webviewSocket: WebSocket | null = null

/**
 * Start the WebSocket server on a dynamic port and report the port to the main thread.
 */
export function startServer(): WebSocketServer {
	const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 })

	wss.on("listening", () => {
		const addr = wss.address()
		if (addr && typeof addr === "object") {
			const port = addr.port
			const msg: ServerPortMessage = { type: SERVER_PORT_TYPE, port }
			parentPort?.postMessage(msg)
		}
	})

	wss.on("connection", (socket: WebSocket, _request) => {
		// Phase 1: accept a single WebSocket connection.
		webviewSocket = socket

		socket.on("message", (raw) => {
			// Future: deserialize and route to the correct Agent Worker.
			// Phase 1: no-op — no production traffic.
		})

		socket.on("close", () => {
			webviewSocket = null
		})

		socket.on("error", () => {
			webviewSocket = null
		})
	})

	wss.on("error", (err) => {
		// Log to stderr so it appears in test output; Phase 1 has no
		// output-channel logger wired yet.
		console.error("[server-worker] WebSocket server error:", err)
	})

	return wss
}

/**
 * Register an Agent Worker's `MessagePort` for future routing.
 *
 * @param taskId   The task ID associated with this worker.
 * @param port     The MessagePort from the MessageChannel connected to the Agent Worker.
 */
export function registerAgent(taskId: string, port: IpcPortShim): void {
	activeAgents.set(taskId, toIpcPortShim(port))
}

/**
 * Unregister an Agent Worker (called on task completion / cancellation).
 */
export function unregisterAgent(taskId: string): boolean {
	return activeAgents.delete(taskId)
}

/**
 * Send a message to the Webview (if connected).
 */
export function sendToWebview(message: unknown): void {
	if (webviewSocket && webviewSocket.readyState === WebSocket.OPEN) {
		webviewSocket.send(JSON.stringify(message))
	}
}

/**
 * Send a message to a specific Agent Worker.
 */
export function sendToAgent(taskId: string, message: unknown): void {
	const port = activeAgents.get(taskId)
	if (port) {
		port.postMessage(message)
	}
}

/**
 * Number of currently-connected Agent Workers (Phase 1: always 0).
 */
export function agentCount(): number {
	return activeAgents.size
}

/**
 * Whether the Webview is currently connected.
 */
export function isWebviewConnected(): boolean {
	return webviewSocket !== null && webviewSocket.readyState === WebSocket.OPEN
}

/**
 * Reset all module-scoped state. For use by tests only — production code
 * always tears down via `shutdownServer` with the wss handle.
 */
export function resetState(): void {
	activeAgents.clear()
	if (webviewSocket) {
		webviewSocket.close()
		webviewSocket = null
	}
}

/**
 * Graceful shutdown: close all connections and clear state.
 */
export function shutdownServer(wss: WebSocketServer): void {
	resetState()
	wss.close()
}

// ── Auto-start when loaded as a worker_thread entry point ──────────────
// In Phase 1 this module is also import-tested without being spawned as a
// worker. The auto-start guard prevents the server from starting during
// unit tests that import the module for the exported functions.
if (parentPort) {
	startServer()
}
