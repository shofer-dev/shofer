/**
 * Second Brain — the advisory chat row (`chat-message-addon` bundle).
 *
 * Renders the plugin's marker rows: `advisory` (the user half of "say it to both" —
 * the same words the agent received, at the same moment), `turn-report` (per-detector
 * verdicts, never shown to the agent) and `finish-gate`. Text only, deliberately: an
 * advisory is one ignorable paragraph, and the row should read like one.
 *
 * BUILD: compiled to `ui/advisory.js` (esbuild, ESM, React externalized —
 * see `build-ui.mjs`).
 */

interface PluginUIApi {
	readonly context: {
		region: string
		pluginName: string
		message?: { ts: number; text?: string; kind: string; data?: Record<string, unknown> }
	}
}

const KIND_BORDER: Record<string, string> = {
	advisory: "var(--vscode-charts-purple, #b180d7)",
	"turn-report": "var(--vscode-descriptionForeground)",
	"finish-gate": "var(--vscode-charts-orange, #d18616)",
}

export default function SecondBrainRow({ api }: { api: PluginUIApi }) {
	const marker = api.context.message
	if (!marker?.text) return null
	const border = KIND_BORDER[marker.kind] ?? KIND_BORDER["advisory"]
	const dim = marker.kind === "turn-report"
	return (
		<div
			style={{
				borderLeft: `2px solid ${border}`,
				padding: "4px 8px",
				margin: "4px 0",
				whiteSpace: "pre-wrap",
				fontSize: "0.9em",
				opacity: dim ? 0.75 : 1,
				color: "var(--vscode-foreground)",
			}}>
			{marker.text}
		</div>
	)
}
