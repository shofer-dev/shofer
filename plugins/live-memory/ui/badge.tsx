/**
 * Live Memory — chat-input toolbar status badge (`chat-input-toolbar` UI bundle).
 *
 * The plugin-native port of the built-in `LiveMemoryStatusBadge`
 * (`webview-ui/src/components/chat/LiveMemoryStatusBadge.tsx`, removed in the plugin
 * conversion): a small chat-bubble icon with a colored status dot shown in the chat
 * input bar, next to the IndexingStatusBadge. It subscribes to the SAME `state`
 * message the plugin pushes over `ctx.ui` (per-plugin channel — both this badge and
 * the sidebar panel receive it) and reflects the agent state (Standby / Initializing /
 * Ready / Busy / Error / Stopping) as a dot color, with context-fill / queue detail in
 * the tooltip.
 *
 * BUILD: compiled to `ui/badge.js` (esbuild, ESM, react externalized — see
 * `build-ui.mjs`) and shipped as a `contributes.ui` bundle. NOT typechecked by the
 * extension build (it is a webview asset served to the host's shared React instance).
 */

import { useEffect, useMemo, useState } from "react"

// Scoped UI API (mirrors @shofer/types PluginUIApi; local so the bundle has no external
// type dependency).
interface PluginUIApi {
	postMessage(message: unknown): void
	onMessage(listener: (message: unknown) => void): () => void
	readonly context: { region: string; pluginName: string; task?: unknown; config?: unknown; theme?: unknown }
}

interface ContextUsage {
	currentTokens: number
	maxTokens: number
	fillFraction: number
	isNearlyFull?: boolean
}

interface BadgeState {
	state: string
	stateMessage?: string
	contextUsage?: ContextUsage
	stats?: { observations: number; questions: number; pendingQuestions: number }
}

/** Dot color per agent state (mirrors the built-in badge's state→color map). */
const DOT_COLOR: Record<string, string> = {
	Standby: "var(--vscode-descriptionForeground)",
	Initializing: "var(--vscode-charts-yellow, #d7ba7d)",
	Ready: "var(--vscode-charts-green, #89d185)",
	Busy: "var(--vscode-charts-yellow, #d7ba7d)",
	Error: "var(--vscode-errorForeground, #f14c4c)",
	Stopping: "var(--vscode-charts-orange, #d18616)",
}

const PULSING = new Set(["Initializing", "Busy", "Stopping"])

export default function LiveMemoryBadge({ api }: { api: PluginUIApi }) {
	const [s, setS] = useState<BadgeState>({ state: "Standby" })

	useEffect(() => {
		const off = api.onMessage((raw) => {
			const m = raw as BadgeState & { type?: string }
			if (m && m.type === "state") {
				setS({ state: m.state, stateMessage: m.stateMessage, contextUsage: m.contextUsage, stats: m.stats })
			}
		})
		// Request an initial snapshot (the plugin's `ready` handler pushes state).
		api.postMessage({ type: "ready" })
		return off
	}, [api])

	const fillPct = useMemo(() => {
		const u = s.contextUsage
		return u && u.maxTokens > 0 ? Math.round(u.fillFraction * 100) : undefined
	}, [s.contextUsage])

	const tooltip = useMemo(() => {
		const lines = [`Live Memory: ${s.state}`]
		if (s.stateMessage) lines.push(s.stateMessage)
		if (fillPct !== undefined) lines.push(`Context: ${fillPct}% full`)
		if (s.stats?.pendingQuestions) lines.push(`Queue: ${s.stats.pendingQuestions} pending`)
		return lines.join("\n")
	}, [s, fillPct])

	const color = DOT_COLOR[s.state] ?? DOT_COLOR.Standby
	const pulse = PULSING.has(s.state)

	return (
		<span
			className="lm-badge"
			title={tooltip}
			aria-label={tooltip}
			role="img"
			style={{
				position: "relative",
				display: "inline-flex",
				alignItems: "center",
				justifyContent: "center",
				width: 20,
				height: 20,
				opacity: 0.85,
				color: "var(--vscode-foreground)",
			}}>
			<svg
				width="15"
				height="15"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
				aria-hidden="true">
				<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
			</svg>
			<span
				style={{
					position: "absolute",
					top: 1,
					right: 1,
					width: 6,
					height: 6,
					borderRadius: "50%",
					background: color,
					animation: pulse ? "lm-badge-pulse 1.2s ease-in-out infinite" : undefined,
				}}
			/>
			<style>{"@keyframes lm-badge-pulse{0%,100%{opacity:.35}50%{opacity:1}}"}</style>
		</span>
	)
}
