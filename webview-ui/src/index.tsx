import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "./index.css"
import App from "./App"
import ErrorBoundary from "./components/ErrorBoundary"
import "../node_modules/@vscode/codicons/dist/codicon.css"

import { getHighlighter } from "./utils/highlighter"

// ---------------------------------------------------------------------------
// Global error listeners — marshal uncaught exceptions back to the extension
// host so they can be logged to the output channel and so the host can
// auto-reset the webview when it crashes silently.
// ---------------------------------------------------------------------------
;(function installWebviewCrashGuard() {
	// acquireVsCodeApi may not be available in a browser-side dev server.
	const api = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null

	if (!api) {
		return
	}

	// 1. Uncaught synchronous errors
	window.addEventListener("error", (event: ErrorEvent) => {
		api.postMessage({
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
		api.postMessage({
			type: "fatal_error",
			text: `Unhandled Promise Rejection: ${reason}`,
		})
	})

	// 3. Heartbeat pong responder — echo back to the host so it can detect
	//    silent process deaths (OOM, GPU crash, etc.)
	window.addEventListener("message", (event: MessageEvent) => {
		const message = event.data
		if (message && message.type === "ping") {
			api.postMessage({ type: "pong" })
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
