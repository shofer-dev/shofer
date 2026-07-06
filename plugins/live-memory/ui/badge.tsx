/**
 * Live Memory — chat-input toolbar status badge + popover (`chat-input-toolbar` bundle).
 *
 * The plugin-native port of the built-in `LiveMemoryStatusBadge` + `LiveMemoryPopover`
 * (removed in the plugin conversion). A clickable chat-bubble icon with a colored status
 * dot, shown next to the IndexingStatusBadge; clicking opens a popover that mirrors the
 * built-in 1:1 — State / Model / Context / Files / Turns / Cost info rows plus a 2×2
 * action grid (View Chat · Clear Context · Configure · Empty memory).
 *
 * It subscribes to the SAME `state` message the plugin pushes over `ctx.ui` (per-plugin
 * channel — this badge and the sidebar panel both receive it). Because a plugin UI bundle
 * may import only the host-shared React (not the host's UI kit / lucide), the popover,
 * icons and layout are reimplemented inline with VS Code theme variables so it looks
 * identical.
 *
 * BUILD: compiled to `ui/badge.js` (esbuild, ESM, react externalized — see `build-ui.mjs`,
 * run automatically by the extension bundle). NOT typechecked by the extension build.
 */

import { useEffect, useMemo, useRef, useState } from "react"

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

interface CostSnapshot {
	sessionEstimatedCostUSD?: number
	sessionInputTokens?: number
	sessionOutputTokens?: number
}

interface BadgeState {
	state: string
	stateMessage?: string
	modelId?: string
	contextUsage?: ContextUsage
	contextFiles?: string[]
	conversationTurnCount?: number
	costSnapshot?: CostSnapshot
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

// ─── Inline icons (lucide paths; the bundle can't import lucide-react) ───────────────
const P: Record<string, string[]> = {
	message: ["M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"],
	info: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z", "M12 16v-4", "M12 8h.01"],
	cpu: ["M4 4h16v16H4z", "M9 9h6v6H9z", "M9 2v2", "M15 2v2", "M9 20v2", "M15 20v2", "M2 9h2", "M2 15h2", "M20 9h2", "M20 15h2"],
	database: ["M12 8c4.97 0 9-1.34 9-3s-4.03-3-9-3-9 1.34-9 3 4.03 3 9 3z", "M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5", "M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3"],
	files: ["M7 3h7l5 5v9a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z", "M14 3v5h5"],
	turns: ["M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v5z", "M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"],
	card: ["M2 4h20a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z", "M1 10h22"],
	trash: ["M3 6h18", "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6", "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2", "M10 11v6", "M14 11v6"],
	settings: ["M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"],
	eraser: ["M12 8c4.97 0 9-1.34 9-3s-4.03-3-9-3-9 1.34-9 3 4.03 3 9 3z", "M3 5v6c0 1.66 4.03 3 9 3", "M3 12v6c0 1.66 4.03 3 9 3", "m16 16 5 5", "m21 16-5 5"],
}
function Icon({ name, size = 14 }: { name: keyof typeof P; size?: number }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			style={{ flexShrink: 0 }}>
			{P[name].map((d, i) => (
				<path key={i} d={d} />
			))}
		</svg>
	)
}

const V = {
	fg: "var(--vscode-foreground)",
	desc: "var(--vscode-descriptionForeground)",
	bg: "var(--vscode-editor-background)",
	border: "var(--vscode-panel-border)",
	hover: "rgba(128,128,128,0.15)",
	mono: "var(--vscode-editor-font-family, monospace)",
} as const

function InfoRow({ icon, label, value, sub }: { icon: keyof typeof P; label: string; value: string; sub?: string }) {
	return (
		<div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
			<span style={{ marginTop: 2, opacity: 0.7 }}>
				<Icon name={icon} size={13} />
			</span>
			<div style={{ flex: 1, minWidth: 0 }}>
				<div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
					<span style={{ opacity: 0.7 }}>{label}</span>
					<span style={{ fontFamily: V.mono, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
						{value}
					</span>
				</div>
				{sub ? <div style={{ fontSize: 10, opacity: 0.6 }}>{sub}</div> : null}
			</div>
		</div>
	)
}

function ActionButton({ icon, label, onClick }: { icon: keyof typeof P; label: string; onClick: () => void }) {
	const [hover, setHover] = useState(false)
	return (
		<button
			type="button"
			onClick={onClick}
			onMouseEnter={() => setHover(true)}
			onMouseLeave={() => setHover(false)}
			style={{
				display: "flex",
				alignItems: "center",
				gap: 6,
				height: 28,
				padding: "0 8px",
				fontSize: 12,
				color: V.fg,
				background: hover ? V.hover : "transparent",
				border: "none",
				borderRadius: 4,
				cursor: "pointer",
				textAlign: "left",
			}}>
			<Icon name={icon} size={13} />
			<span>{label}</span>
		</button>
	)
}

export default function LiveMemoryBadge({ api }: { api: PluginUIApi }) {
	const [s, setS] = useState<BadgeState>({ state: "Standby" })
	const [open, setOpen] = useState(false)
	const wrapRef = useRef<HTMLSpanElement>(null)

	useEffect(() => {
		const off = api.onMessage((raw) => {
			const m = raw as BadgeState & { type?: string }
			if (m && m.type === "state") {
				setS({
					state: m.state,
					stateMessage: m.stateMessage,
					modelId: m.modelId,
					contextUsage: m.contextUsage,
					contextFiles: m.contextFiles,
					conversationTurnCount: m.conversationTurnCount,
					costSnapshot: m.costSnapshot,
					stats: m.stats,
				})
			}
		})
		api.postMessage({ type: "ready" })
		return off
	}, [api])

	// Close the popover on outside-click / Escape.
	useEffect(() => {
		if (!open) return
		const onDown = (e: MouseEvent) => {
			if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
		}
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false)
		document.addEventListener("mousedown", onDown)
		document.addEventListener("keydown", onKey)
		return () => {
			document.removeEventListener("mousedown", onDown)
			document.removeEventListener("keydown", onKey)
		}
	}, [open])

	const usage = s.contextUsage
	const fillPct = usage ? (usage.fillFraction * 100).toFixed(1) : "0.0"
	const color = DOT_COLOR[s.state] ?? DOT_COLOR.Standby
	const pulse = PULSING.has(s.state)

	const tooltip = useMemo(() => {
		const lines = [`Live Memory: ${s.state}`]
		if (s.stateMessage) lines.push(s.stateMessage)
		return lines.join("\n")
	}, [s])

	// ── Actions (mirror the built-in popover; adapted to the plugin model) ──
	const act = (fn: () => void) => () => {
		fn()
		setOpen(false)
	}
	// "View Chat" asks the plugin to open its chat bundle in a standalone editor panel
	// (WebviewPanel) via ctx.ui.showPanel — matching the built-in's separate chat panel.
	const viewChat = act(() => api.postMessage({ type: "showChat" }))
	const clearContext = act(() => api.postMessage({ type: "clear" }))
	const emptyMemory = act(() => api.postMessage({ type: "empty" }))
	const configure = act(() =>
		window.postMessage({ type: "action", action: "settingsButtonClicked", values: { section: "plugins" } }, "*"),
	)

	return (
		<span ref={wrapRef} style={{ position: "relative", display: "inline-flex" }}>
			<button
				type="button"
				title={tooltip}
				aria-label={tooltip}
				aria-haspopup="dialog"
				aria-expanded={open}
				onClick={() => setOpen((o) => !o)}
				style={{
					position: "relative",
					display: "inline-flex",
					alignItems: "center",
					justifyContent: "center",
					width: 20,
					height: 20,
					padding: 0,
					background: "transparent",
					border: "none",
					borderRadius: 4,
					cursor: "pointer",
					color: V.fg,
					opacity: 0.85,
				}}>
				<Icon name="message" size={15} />
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
			</button>

			{open && (
				<div
					role="dialog"
					aria-label="Live Memory"
					style={{
						position: "absolute",
						bottom: "calc(100% + 6px)",
						right: 0,
						width: 320,
						zIndex: 1000,
						background: V.bg,
						border: `1px solid ${V.border}`,
						borderRadius: 6,
						boxShadow: "0 2px 12px rgba(0,0,0,0.35)",
						color: V.fg,
						fontSize: 12,
					}}>
					<div style={{ padding: "8px 12px", borderBottom: `1px solid ${V.border}`, display: "flex", alignItems: "center", gap: 8, fontWeight: 600 }}>
						<Icon name="message" size={15} />
						<span>Live Memory</span>
					</div>

					<div style={{ padding: "8px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
						<InfoRow icon="info" label="State" value={s.state} sub={s.stateMessage} />
						{s.modelId ? <InfoRow icon="cpu" label="Model" value={s.modelId} /> : null}
						{usage ? (
							<InfoRow
								icon="database"
								label="Context"
								value={`${usage.currentTokens.toLocaleString()} / ${usage.maxTokens.toLocaleString()} (${fillPct}%)`}
								sub={usage.isNearlyFull ? "⚠ Nearly full" : undefined}
							/>
						) : null}
						<InfoRow icon="files" label="Files in context" value={String(s.contextFiles?.length ?? 0)} />
						<InfoRow
							icon="turns"
							label="Conversation turns"
							value={String(s.conversationTurnCount ?? 0)}
							sub={s.stats?.pendingQuestions ? `${s.stats.pendingQuestions} question(s) queued` : undefined}
						/>
						{s.costSnapshot ? (
							<InfoRow
								icon="card"
								label="Session cost"
								value={`$${(s.costSnapshot.sessionEstimatedCostUSD ?? 0).toFixed(6)}`}
								sub={
									s.costSnapshot.sessionInputTokens !== undefined && s.costSnapshot.sessionOutputTokens !== undefined
										? `${s.costSnapshot.sessionInputTokens.toLocaleString()} in + ${s.costSnapshot.sessionOutputTokens.toLocaleString()} out`
										: undefined
								}
							/>
						) : null}
					</div>

					<div style={{ padding: 8, borderTop: `1px solid ${V.border}`, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
						<ActionButton icon="message" label="View Chat" onClick={viewChat} />
						<ActionButton icon="trash" label="Clear Context" onClick={clearContext} />
						<ActionButton icon="settings" label="Configure" onClick={configure} />
						<ActionButton icon="eraser" label="Empty memory" onClick={emptyMemory} />
					</div>
				</div>
			)}
			<style>{"@keyframes lm-badge-pulse{0%,100%{opacity:.35}50%{opacity:1}}"}</style>
		</span>
	)
}
