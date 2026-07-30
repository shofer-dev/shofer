/**
 * Second Brain — the chat-input toolbar badge (`chat-input-toolbar` bundle).
 *
 * A 🧠 glyph with a status dot: watching (green), muted (grey), needs-approval
 * (amber). The popover shows per-task passes, window fill, delivered advisories,
 * cost, and the last turn's verdicts — the model-free "is it watching, and what has
 * it cost?" surface. Subscribes to the `state` push the plugin sends over `ctx.ui`;
 * asks for one on mount.
 *
 * BUILD: compiled to `ui/badge.js` (esbuild, ESM, React externalized — see
 * `build-ui.mjs`).
 */

import { useEffect, useState } from "react"

interface PluginUIApi {
	postMessage(message: unknown): void
	onMessage(listener: (message: unknown) => void): () => void
	readonly context: { region: string; pluginName: string }
}

interface TaskStats {
	taskId: string
	passes: number
	windowChars: number
	advisoriesDelivered: number
	lastVerdicts?: { detector: string; verdict: string; note?: string }[]
	costUsd: number
}

interface Snapshot {
	updatedAt: number
	muted: boolean
	consent: boolean
	tasks: TaskStats[]
}

export default function SecondBrainBadge({ api }: { api: PluginUIApi }) {
	const [snapshot, setSnapshot] = useState<Snapshot | undefined>()
	const [open, setOpen] = useState(false)

	useEffect(() => {
		const off = api.onMessage((message) => {
			const m = message as { type?: string; snapshot?: Snapshot }
			if (m?.type === "state" && m.snapshot) setSnapshot(m.snapshot)
		})
		api.postMessage({ command: "getState" })
		return off
	}, [api])

	const dot = !snapshot?.consent
		? "var(--vscode-charts-yellow, #cca700)"
		: snapshot.muted
			? "var(--vscode-descriptionForeground)"
			: "var(--vscode-charts-green, #89d185)"
	const totalCost = snapshot?.tasks.reduce((sum, t) => sum + t.costUsd, 0) ?? 0
	const totalPasses = snapshot?.tasks.reduce((sum, t) => sum + t.passes, 0) ?? 0

	return (
		<span style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
			<button
				onClick={() => setOpen((v) => !v)}
				title={
					!snapshot?.consent
						? "Second Brain needs your billed-AI approval (Settings → Plugins)"
						: snapshot.muted
							? "Second Brain is muted"
							: `Second Brain watching · ${totalPasses} passes · $${totalCost.toFixed(2)}`
				}
				style={{
					background: "none",
					border: "none",
					cursor: "pointer",
					padding: "0 4px",
					display: "inline-flex",
					alignItems: "center",
					gap: 3,
					color: "var(--vscode-foreground)",
				}}>
				<span style={{ fontSize: "0.95em" }}>🧠</span>
				<span style={{ width: 6, height: 6, borderRadius: "50%", background: dot }} />
			</button>
			{open && snapshot && (
				<div
					style={{
						position: "absolute",
						bottom: "120%",
						right: 0,
						zIndex: 50,
						minWidth: 260,
						maxWidth: 380,
						padding: 10,
						borderRadius: 4,
						fontSize: "0.85em",
						background: "var(--vscode-editorWidget-background)",
						border: "1px solid var(--vscode-editorWidget-border, transparent)",
						color: "var(--vscode-foreground)",
						boxShadow: "0 2px 8px rgba(0,0,0,.3)",
					}}>
					<div style={{ fontWeight: 600, marginBottom: 6 }}>
						Second Brain{" "}
						{!snapshot.consent ? "· needs approval" : snapshot.muted ? "· muted" : "· watching"}
					</div>
					{snapshot.tasks.length === 0 && <div>No observed task yet.</div>}
					{snapshot.tasks.map((t) => (
						<div key={t.taskId} style={{ marginBottom: 6 }}>
							<div style={{ opacity: 0.8 }}>
								task {t.taskId.slice(0, 8)} · {t.passes} passes · {t.advisoriesDelivered} advisories · $
								{t.costUsd.toFixed(3)}
							</div>
							{t.lastVerdicts?.map((v) => (
								<div key={v.detector} style={{ paddingLeft: 8, opacity: 0.7 }}>
									{v.detector} → {v.verdict}
									{v.note ? ` ${v.note}` : ""}
								</div>
							))}
						</div>
					))}
				</div>
			)}
		</span>
	)
}
