/**
 * Second Brain — the why/stats sidebar panel (`sidebar-panel` bundle).
 *
 * The inspectable record: per-task stats and uptake, the recent advisories with
 * their evidence and adjudicated verdicts, and the gate's refusals with reasons —
 * the gate's decisions must be inspectable or nobody will trust the channel.
 * Read-only; refreshed via `handleRequest` on mount and on demand.
 *
 * BUILD: compiled to `ui/panel.js` (esbuild, ESM, React externalized — see
 * `build-ui.mjs`).
 */

import { useCallback, useEffect, useState } from "react"

interface PluginUIApi {
	request(method: string, params?: unknown, opts?: { mutates?: boolean }): Promise<unknown>
	readonly context: { region: string; pluginName: string }
}

interface Advisory {
	id: string
	detector: string
	headline: string
	body: string
	confidence: number
	evidence: string[]
	humanOnly: boolean
	deliveredAt?: number
	outcome?: { verdict: string; at: number }
}

interface Drop {
	at: number
	detector: string
	headline: string
	reason: string
}

interface WhyEntry {
	taskId: string
	advisories: Advisory[]
	drops: Drop[]
}

interface StatsResult {
	consent: boolean
	muted: boolean
	cataloguePath: string
	tasks: {
		taskId: string
		passes: number
		windowChars: number
		spoolChars: number
		advisoriesDelivered: number
		costUsd: number
		uptake: Record<string, { delivered: number; adopted: number }>
	}[]
}

const box: React.CSSProperties = {
	border: "1px solid var(--vscode-editorWidget-border, transparent)",
	borderRadius: 4,
	padding: 8,
	marginBottom: 8,
}

export default function SecondBrainPanel({ api }: { api: PluginUIApi }) {
	const [stats, setStats] = useState<StatsResult | undefined>()
	const [why, setWhy] = useState<WhyEntry[]>([])
	const [error, setError] = useState<string | undefined>()

	const refresh = useCallback(() => {
		void api
			.request("stats")
			.then((s) => setStats(s as StatsResult))
			.catch((e) => setError(String(e)))
		void api
			.request("why")
			.then((w) => setWhy(w as WhyEntry[]))
			.catch(() => {})
	}, [api])

	useEffect(refresh, [refresh])

	return (
		<div style={{ padding: 10, fontSize: "0.9em", color: "var(--vscode-foreground)" }}>
			<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
				<b>🧠 Second Brain</b>
				<button onClick={refresh} style={{ cursor: "pointer" }}>
					refresh
				</button>
			</div>
			{error && <div style={{ color: "var(--vscode-errorForeground)" }}>{error}</div>}
			{stats && (
				<div style={box}>
					<div>{!stats.consent ? "needs billed-AI approval" : stats.muted ? "muted" : "watching"}</div>
					{stats.tasks.map((t) => (
						<div key={t.taskId} style={{ marginTop: 6 }}>
							<div>
								task {t.taskId.slice(0, 8)} — {t.passes} passes · window{" "}
								{Math.round(t.windowChars / 1000)}k chars · observed {Math.round(t.spoolChars / 1000)}k
								· {t.advisoriesDelivered} advisories · ${t.costUsd.toFixed(3)}
							</div>
							{Object.entries(t.uptake).map(([detector, u]) => (
								<div key={detector} style={{ paddingLeft: 10, opacity: 0.75 }}>
									{detector}: {u.adopted}/{u.delivered} adopted
								</div>
							))}
						</div>
					))}
					<div style={{ marginTop: 6, opacity: 0.6 }}>overrides: {stats.cataloguePath}</div>
				</div>
			)}
			{why.map((entry) => (
				<div key={entry.taskId} style={box}>
					<div style={{ fontWeight: 600 }}>task {entry.taskId.slice(0, 8)}</div>
					{entry.advisories.length === 0 && entry.drops.length === 0 && (
						<div style={{ opacity: 0.7 }}>all silent so far</div>
					)}
					{entry.advisories.map((a) => (
						<div key={a.id} style={{ marginTop: 6 }}>
							<div>
								[{a.detector} {a.confidence.toFixed(2)}
								{a.humanOnly ? " · you only" : ""}] {a.headline}
								{a.outcome ? ` → ${a.outcome.verdict}` : " → open"}
							</div>
							<div style={{ opacity: 0.75, whiteSpace: "pre-wrap" }}>{a.body}</div>
							{a.evidence.length > 0 && (
								<div style={{ opacity: 0.6 }}>evidence: {a.evidence.join("; ")}</div>
							)}
						</div>
					))}
					{entry.drops.map((d, i) => (
						<div key={i} style={{ marginTop: 4, opacity: 0.6 }}>
							gated [{d.detector}] “{d.headline}” — {d.reason}
						</div>
					))}
				</div>
			))}
		</div>
	)
}
