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
 *
 * View switches from the React tab bar are forwarded into the iframe as
 * `{type:"switchView", view}` postMessages so the diagram updates without
 * an srcdoc reload (preserving zoom/pan state).
 *
 * THEME INHERITANCE: The srcdoc iframe is an isolated document — it does NOT
 * inherit CSS custom properties from the parent webview. We read the live
 * VSCode theme variable values from the parent's computed style and inject them
 * as a second <style> block into the srcdoc so the diagrams follow the current
 * theme (light or dark).
 */

import React, { useRef, useEffect, useCallback } from "react"

export interface SlangVizProps {
	/** Self-contained HTML page produced by buildWorkflowVizHtml() (pushed once). */
	html: string | undefined
	/** Serialized FlowState pushed on each round/step for in-place overlays. */
	runState?: Record<string, unknown>
	/** Active view tab — forwarded via postMessage so iframe updates in-place.
	 *  ("topology" is no longer a WorkflowView tab; the iframe still defaults to
	 *  it internally, so we only ever switch it to sequence/swimlane.) */
	view?: "sequence" | "swimlane"
}

/** Read the CSP nonce the host exposed so srcdoc scripts satisfy the policy. */
function getCspNonce(): string {
	return (window as unknown as { __shofer_csp_nonce__?: string }).__shofer_csp_nonce__ ?? ""
}

/**
 * Read VSCode theme CSS custom properties from the parent document and
 * return a `<style>` block that sets them on the srcdoc's `:root` so the
 * diagrams follow the active theme (light/dark).
 *
 * The srcdoc iframe is an isolated document — `var(--vscode-*)` references
 * inside it do NOT resolve against the parent's stylesheet. We must
 * materialize the current values and inject them explicitly.
 */
function getThemeStyleBlock(): string {
	const style = getComputedStyle(document.documentElement)
	const vars: Record<string, string> = {
		"--vscode-editor-background": style.getPropertyValue("--vscode-editor-background").trim(),
		"--vscode-foreground": style.getPropertyValue("--vscode-foreground").trim(),
		"--vscode-descriptionForeground": style.getPropertyValue("--vscode-descriptionForeground").trim(),
		"--vscode-editorWidget-background": style.getPropertyValue("--vscode-editorWidget-background").trim(),
		"--vscode-widget-border": style.getPropertyValue("--vscode-widget-border").trim(),
		"--vscode-textCodeBlock-background": style.getPropertyValue("--vscode-textCodeBlock-background").trim(),
		"--vscode-charts-blue": style.getPropertyValue("--vscode-charts-blue").trim(),
		"--vscode-charts-green": style.getPropertyValue("--vscode-charts-green").trim(),
		"--vscode-charts-orange": style.getPropertyValue("--vscode-charts-orange").trim(),
		"--vscode-charts-purple": style.getPropertyValue("--vscode-charts-purple").trim(),
		"--vscode-charts-cyan": style.getPropertyValue("--vscode-charts-cyan").trim(),
		"--vscode-charts-yellow": style.getPropertyValue("--vscode-charts-yellow").trim(),
		"--vscode-errorForeground": style.getPropertyValue("--vscode-errorForeground").trim(),
		"--vscode-font-family": style.getPropertyValue("--vscode-font-family").trim(),
		"--vscode-font-size": style.getPropertyValue("--vscode-font-size").trim(),
		"--vscode-editor-font-family": style.getPropertyValue("--vscode-editor-font-family").trim(),
	}
	const lines = Object.entries(vars)
		.filter(([, v]) => v)
		.map(([k, v]) => `${k}: ${v};`)
	return `<style>:root { ${lines.join(" ")} }</style>`
}

const SlangViz: React.FC<SlangVizProps> = ({ html, runState, view }) => {
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

		// Inject theme variables and CSP nonce before assigning srcdoc.
		let patched = html.replace(/\{\{CSP_NONCE\}\}/g, getCspNonce())
		// Insert the theme <style> right after the existing render-CSS
		// </style> so the :root block comes before diagram content.
		patched = patched.replace("</style>", "</style>" + getThemeStyleBlock())
		loadedRef.current = false
		iframe.srcdoc = patched
	}, [html])

	// Forward runtime state to the loaded iframe for in-place overlay updates.
	useEffect(() => {
		runStateRef.current = runState
		if (loadedRef.current) postRunState()
	}, [runState, postRunState])

	// Forward view switches to the iframe without reload.
	useEffect(() => {
		const win = iframeRef.current?.contentWindow
		if (!win || !view || !loadedRef.current) return
		win.postMessage({ type: "switchView", view }, "*")
	}, [view])

	const onLoad = useCallback(() => {
		loadedRef.current = true
		// Set initial view before pushing runState. The iframe defaults to its
		// topology view internally; we only ever switch it to sequence/swimlane.
		const win = iframeRef.current?.contentWindow
		if (win && view) {
			win.postMessage({ type: "switchView", view }, "*")
		}
		postRunState()
	}, [postRunState, view])

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
