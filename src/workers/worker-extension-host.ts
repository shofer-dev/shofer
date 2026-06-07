/**
 * WorkerExtensionHost — IExtensionHost implementation for Agent Workers.
 *
 * Routes the same two events that the CLI's ExtensionHost bridges:
 * - `"extensionWebviewMessage"` → serverPort (MessageChannel) → Server Worker → Webview
 * - `"webviewMessage"`          ← serverPort (MessageChannel) ← Server Worker ← Webview
 *
 * vscode API calls that need the real editor surface (createTerminal,
 * showTextDocument, executeCommand, etc.) are NOT routed through this host
 * — they go through the IpcDemuxer on parentPort, which is wired inside
 * `createVSCodeAPIMock` when a `parentPort` is provided.
 *
 * Each Agent Worker is a separate V8 isolate (§1.2), so setting
 * `global.__extensionHost` in the worker bootstrap is safe.
 */

import type { IExtensionHost, ExtensionHostEventMap } from "@shofer/vscode-shim"
import type { WebviewViewProvider } from "@shofer/vscode-shim/src/interfaces/webview.js"

/**
 * Minimal IPC port interface matching the subset of `worker_threads.MessagePort`
 * and `MessageChannel` ports that this host needs.
 */
interface WorkerIpcPort {
	postMessage(value: unknown): void
	on(event: "message", listener: (value: unknown) => void): void
}

/**
 * WorkerExtensionHost bridges the extension running inside an Agent Worker
 * to the outside world through two ports:
 *
 * - `serverPort` — routes extension→webview and webview→extension messages
 *   through the Server Worker's WebSocket bridge.
 * - `parentPort` — used for vscode API calls that need the real editor
 *   surface (handled by the IpcDemuxer inside the vscode-shim, not by this class).
 */
export class WorkerExtensionHost implements IExtensionHost<ExtensionHostEventMap> {
	private _serverPort: WorkerIpcPort
	/** Reserved for Phase 2 — vscode API calls route through IpcDemuxer, not this host. */
	private _parentPort: WorkerIpcPort | null
	private _ready = false
	private _providers = new Map<string, WebviewViewProvider>()

	constructor(serverPort: WorkerIpcPort, parentPort?: WorkerIpcPort | null) {
		this._serverPort = serverPort
		this._parentPort = parentPort ?? null
	}

	// ── IExtensionHost implementation ────────────────────────────────

	registerWebviewProvider(viewId: string, provider: WebviewViewProvider): void {
		this._providers.set(viewId, provider)
	}

	unregisterWebviewProvider(viewId: string): void {
		this._providers.delete(viewId)
	}

	isInInitialSetup(): boolean {
		return !this._ready
	}

	markWebviewReady(): void {
		this._ready = true
	}

	emit<K extends keyof ExtensionHostEventMap>(event: K, message: ExtensionHostEventMap[K]): boolean {
		if (event === "extensionWebviewMessage") {
			// Extension → Webview: route through Server Worker via MessageChannel.
			this._serverPort.postMessage(message)
			return true
		}

		// "webviewMessage" is not emitted in the worker model — UI→extension
		// messages arrive via serverPort.on("message") (registered by on()).
		// This branch is intentionally unreachable.

		return false
	}

	on<K extends keyof ExtensionHostEventMap>(event: K, listener: (message: ExtensionHostEventMap[K]) => void): this {
		if (event === "webviewMessage") {
			// Messages from the Webview arrive on the serverPort.
			this._serverPort.on("message", listener as (value: unknown) => void)
		}
		// "extensionWebviewMessage" is intentionally a no-op here — the emit()
		// side routes outbound messages directly to serverPort.postMessage(),
		// so there is no listener registration needed on the extension side.
		// The bidirectional use of one serverPort (outbound postMessage for
		// extensionWebviewMessage, inbound on("message") for webviewMessage)
		// is correct MessageChannel semantics.
		return this
	}

	// ── Lifecycle ────────────────────────────────────────────────────

	/**
	 * Clean up resources. Called during worker shutdown.
	 */
	dispose(): void {
		this._providers.clear()
		this._ready = false
	}
}
