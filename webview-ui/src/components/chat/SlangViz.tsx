/**
 * SlangViz — renders the three slang workflow visualization diagrams
 * (topology, sequence, swimlane) inside a sandboxed iframe.
 *
 * The host side (WorkflowTask) generates a fully self-contained HTML page
 * and pushes it via ExtensionState.workflowVizHtml. This component renders
 * that HTML in a sandboxed iframe via srcdoc. No inter-frame communication
 * is needed — each round's new flowState triggers a fresh HTML bundle.
 *
 * The containing WorkflowView.tsx is responsible for reading
 * `workflowVizHtml` from ExtensionState and passing it as a prop.
 */

import React, { useRef, useEffect } from "react"

export interface SlangVizProps {
	/** Self-contained HTML page produced by buildWorkflowVizHtml(). */
	html: string | undefined
}

/**
 * A sandboxed iframe that renders the slang visualization HTML.
 * The iframe is styled to fill its parent and has no border or padding.
 */
const SlangViz: React.FC<SlangVizProps> = ({ html }) => {
	const iframeRef = useRef<HTMLIFrameElement>(null)

	useEffect(() => {
		const iframe = iframeRef.current
		if (!iframe || !html) return

		// Write srcdoc to trigger a full re-render. Using srcdoc is
		// simpler than blobs and works in all modern browsers (including
		// the VS Code webview which is Chromium-based).
		iframe.srcdoc = html
	}, [html])

	// When there's no viz content, render nothing (not even an empty
	// iframe) to avoid wasted space in non-workflow tasks.
	if (!html) return null

	return (
		<iframe
			ref={iframeRef}
			sandbox="allow-scripts" // allow dagre CDN + inline render script
			style={{
				width: "100%",
				height: "480px",
				border: "none",
				background: "var(--vscode-editor-background, #1e1e1e)",
			}}
			title="Slang Workflow Visualization"
		/>
	)
}

export default SlangViz
