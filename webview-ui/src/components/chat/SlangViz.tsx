/**
 * SlangViz — renders the slang workflow visualization diagrams inside a
 * sandboxed iframe.  The host generates a self-contained HTML page and
 * pushes it via ExtensionState.workflowVizHtml.  An optional `initialView`
 * prop sets the starting diagram (topology|sequence|swimlane).
 */

import React, { useRef, useEffect } from "react"

export interface SlangVizProps {
	/** Self-contained HTML page produced by buildWorkflowVizHtml(). */
	html: string | undefined
	/** Which view to show initially. */
	initialView?: "topology" | "sequence" | "swimlane"
}

const SlangViz: React.FC<SlangVizProps> = ({ html, initialView }) => {
	const iframeRef = useRef<HTMLIFrameElement>(null)

	useEffect(() => {
		const iframe = iframeRef.current
		if (!iframe || !html) return

		// Patch the HTML to set the initial view before srcdoc.
		if (initialView && initialView !== "topology") {
			const patched = html.replace('var _currentView = "topology"', `var _currentView = "${initialView}"`)
			iframe.srcdoc = patched
		} else {
			iframe.srcdoc = html
		}
	}, [html, initialView])

	if (!html) return null

	return (
		<div style={{ width: "100%", flex: "1 1 0%", minHeight: 0 }}>
			<iframe
				ref={iframeRef}
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
