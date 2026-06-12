/**
 * SlangViz — renders the slang workflow visualization diagrams inside a
 * sandboxed iframe.
 *
 * The host (WorkflowTask) generates a self-contained HTML page once and pushes
 * it via ExtensionState.workflowVizHtml. The page's <script> tags carry a
 * `{{CSP_NONCE}}` placeholder; we stamp it with the live webview nonce (exposed
 * as `window.__shofer_csp_nonce__`) before assigning srcdoc, so the scripts run
 * under the parent webview's inherited Content-Security-Policy.
 *
 * Per-round/per-step runtime updates arrive via ExtensionState.workflowVizRunState
 * and are forwarded to the already-loaded iframe as a `runtimeState` postMessage,
 * which the render engine patches in-place — no reload, preserving the active
 * view, zoom and pan.
 */

import React, { useRef, useEffect, useCallback } from "react"

export interface SlangVizProps {
	/** Self-contained HTML page produced by buildWorkflowVizHtml() (pushed once). */
	html: string | undefined
	/** Serialized FlowState pushed on each round/step for in-place overlays. */
	runState?: Record<string, unknown>
	/** Which view to show initially. */
	initialView?: "topology" | "sequence" | "swimlane"
}

/** Read the CSP nonce the host exposed so srcdoc scripts satisfy the policy. */
function getCspNonce(): string {
	return (window as unknown as { __shofer_csp_nonce__?: string }).__shofer_csp_nonce__ ?? ""
}

const SlangViz: React.FC<SlangVizProps> = ({ html, runState, initialView }) => {
	const iframeRef = useRef<HTMLIFrameElement>(null)
	// Latest runState, so we can flush it once the iframe finishes loading
	// (the runState update can race ahead of the iframe's load event).
	const runStateRef = useRef<Record<string, unknown> | undefined>(runState)
	const loadedRef = useRef(false)

	const postRunState = useCallback(() => {
		const win = iframeRef.current?.contentWindow
		const rs = runStateRef.current
		if (!win || !rs) return
		win.postMessage({ type: "runtimeState", runState: rs }, "*")
	}, [])

	// (Re)load the iframe whenever the static HTML changes.
	useEffect(() => {
		const iframe = iframeRef.current
		if (!iframe || !html) return

		let patched = html.replace(/\{\{CSP_NONCE\}\}/g, getCspNonce())
		if (initialView && initialView !== "topology") {
			patched = patched.replace('var _currentView = "topology"', `var _currentView = "${initialView}"`)
		}
		loadedRef.current = false
		iframe.srcdoc = patched
	}, [html, initialView])

	// Forward runtime state to the loaded iframe for in-place overlay updates.
	useEffect(() => {
		runStateRef.current = runState
		if (loadedRef.current) postRunState()
	}, [runState, postRunState])

	const onLoad = useCallback(() => {
		loadedRef.current = true
		postRunState()
	}, [postRunState])

	if (!html) return null

	return (
		<div style={{ width: "100%", flex: "1 1 0%", minHeight: 0 }}>
			<iframe
				ref={iframeRef}
				onLoad={onLoad}
				sandbox="allow-scripts"
				style={{
					width: "100%",
					height: "100%",
					border: "none",
					background: "var(--vscode-editor-background, #1e1e1e)",
				}}
				title="Slang Workflow Visualization"
			/>
		</div>
	)
}

export default SlangViz
