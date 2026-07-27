import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import * as HostReact from "react"
import * as HostReactDom from "react-dom"
import * as HostReactDomClient from "react-dom/client"
import * as HostJsxRuntime from "react/jsx-runtime"
import * as HostJsxDevRuntime from "react/jsx-dev-runtime"
import * as HostPluginUi from "./plugin-ui"

import "./index.css"
import App from "./App"
import ErrorBoundary from "./components/ErrorBoundary"
import "../node_modules/@vscode/codicons/dist/codicon.css"

import { getHighlighter } from "./utils/highlighter"
import { vscode } from "./utils/vscode"

// ---------------------------------------------------------------------------
// Shared-React boundary for external plugin UI bundles (design §6.8, P4).
//
// A third-party plugin's UI bundle is built with `react`/`react-dom`/
// `react/jsx-runtime` **externalized**, so its imports stay bare specifiers. The
// webview HTML injects an import map that resolves those specifiers to small shim
// modules under `plugin-host/` which re-export the globals published here — so a
// dynamically-imported plugin bundle reuses THIS running React instance instead of
// bundling its own (a second copy would break hooks/context). Published
// synchronously at module-eval time, well before any plugin bundle is imported.
//
// `@shofer/plugin-ui` rides the same boundary: the host's component kit and the
// per-plugin translation hook, so a plugin's UI is built from the real components
// rather than a look-alike (see `src/plugin-ui/index.ts`).
// ---------------------------------------------------------------------------
;(globalThis as unknown as Record<string, unknown>).__shoferHostReact = HostReact
;(globalThis as unknown as Record<string, unknown>).__shoferHostReactDom = HostReactDom
;(globalThis as unknown as Record<string, unknown>).__shoferHostReactDomClient = HostReactDomClient
;(globalThis as unknown as Record<string, unknown>).__shoferHostJsxRuntime = HostJsxRuntime
;(globalThis as unknown as Record<string, unknown>).__shoferHostJsxDevRuntime = HostJsxDevRuntime
;(globalThis as unknown as Record<string, unknown>).__shoferPluginUi = HostPluginUi

// ---------------------------------------------------------------------------
// Global error listeners — marshal uncaught exceptions back to the extension
// host so they can be logged to the output channel and so the host can
// auto-reset the webview when it crashes silently.
//
// IMPORTANT: `acquireVsCodeApi()` may only be invoked once per webview. We
// therefore route every post through the shared `vscode` singleton in
// `utils/vscode.ts` — never call `acquireVsCodeApi()` directly here. Doing so
// throws synchronously and prevents React from mounting (blank webview).
// ---------------------------------------------------------------------------
;(function installWebviewCrashGuard() {
	// 1. Uncaught synchronous errors
	window.addEventListener("error", (event: ErrorEvent) => {
		vscode.postMessage({
			type: "fatal_error",
			text: `Uncaught Error: ${event.message} at ${event.filename}:${event.lineno}:${event.colno}`,
		})
	})

	// 2. Unhandled Promise rejections
	window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
		let reason = ""
		if (event.reason instanceof Error) {
			reason = `${event.reason.message}\n${event.reason.stack ?? ""}`
		} else if (typeof event.reason === "string") {
			reason = event.reason
		} else {
			try {
				reason = JSON.stringify(event.reason)
			} catch {
				reason = String(event.reason)
			}
		}
		vscode.postMessage({
			type: "fatal_error",
			text: `Unhandled Promise Rejection: ${reason}`,
		})
	})

	// 3. Heartbeat pong responder — echo back to the host so it can detect
	//    silent process deaths (OOM, GPU crash, etc.)
	//
	//    Also maintains a small ring buffer of the last N ping timestamps
	//    (window.__shoferHeartbeat) so the webview's liveness can be inspected
	//    at runtime for diagnostics. The host can query this state via
	//    postMessage when it suspects the webview is lagging.
	;(window as any).__shoferHeartbeat = {
		pingCount: 0,
		pongCount: 0,
		lastPingTimestamps: [] as number[],
		MAX_TIMESTAMPS: 20,
	}
	window.addEventListener("message", (event: MessageEvent) => {
		const message = event.data
		if (message && message.type === "ping") {
			const hb = (window as any).__shoferHeartbeat
			hb.pingCount++
			hb.lastPingTimestamps.push(Date.now())
			if (hb.lastPingTimestamps.length > hb.MAX_TIMESTAMPS) {
				hb.lastPingTimestamps.shift()
			}
			hb.pongCount++
			vscode.postMessage({ type: "pong" })
		}
	})
})()

// Initialize Shiki early to hide initialization latency (async)
getHighlighter().catch((error: Error) => console.error("Failed to initialize Shiki highlighter:", error))

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<ErrorBoundary>
			<App />
		</ErrorBoundary>
	</StrictMode>,
)
