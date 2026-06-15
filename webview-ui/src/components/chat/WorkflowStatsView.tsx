import React, { useMemo } from "react"
import type { HistoryItem } from "@shofer/types"
import { getTaskDisplayName } from "./TaskSelector"

/**
 * "Stats" tab for a workflow. Accumulates the metrics of the *entire task tree*
 * rooted at the workflow — the root task plus every descendant agent task
 * (recursively) — into a single summary, plus a per-task breakdown.
 *
 * Pure presentational: it reads the same flat `taskHistory` the Tree tab uses
 * and walks the `parentTaskId` chain client-side; no new host messages. (This is
 * distinct from `TaskStatsView`, which is a single-task active-time donut shown
 * in the regular chat view.)
 */

interface WorkflowStatsViewProps {
	taskHistory: HistoryItem[]
	/** Root of the tree to aggregate (the workflow task). */
	rootTaskId: string | undefined
}

interface Totals {
	tasks: number
	tokensIn: number
	tokensOut: number
	cacheReads: number
	cacheWrites: number
	totalCost: number
	activeTimeMs: number
}

const EMPTY: Totals = {
	tasks: 0,
	tokensIn: 0,
	tokensOut: 0,
	cacheReads: 0,
	cacheWrites: 0,
	totalCost: 0,
	activeTimeMs: 0,
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
	if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
	return String(n)
}

function formatDurationMs(ms: number): string {
	const totalSec = Math.round(ms / 1000)
	if (totalSec < 60) return `${totalSec}s`
	const mins = Math.floor(totalSec / 60)
	const secs = totalSec % 60
	if (mins < 60) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`
	const hrs = Math.floor(mins / 60)
	const remMin = mins % 60
	return remMin > 0 ? `${hrs}h ${remMin}m` : `${hrs}h`
}

/** Collect the subtree rooted at `rootId` (inclusive) from the flat history. */
function collectSubtree(taskHistory: HistoryItem[], rootId: string): HistoryItem[] {
	const byId = new Map(taskHistory.map((i) => [i.id, i]))
	const childrenByParent = new Map<string, HistoryItem[]>()
	for (const item of taskHistory) {
		if (item.parentTaskId) {
			const arr = childrenByParent.get(item.parentTaskId)
			if (arr) arr.push(item)
			else childrenByParent.set(item.parentTaskId, [item])
		}
	}
	const root = byId.get(rootId)
	if (!root) return []
	const out: HistoryItem[] = []
	const stack: HistoryItem[] = [root]
	const seen = new Set<string>()
	while (stack.length) {
		const node = stack.pop()!
		if (seen.has(node.id)) continue // guard against cycles
		seen.add(node.id)
		out.push(node)
		const kids = childrenByParent.get(node.id)
		if (kids) for (const k of kids) stack.push(k)
	}
	return out
}

const WorkflowStatsView: React.FC<WorkflowStatsViewProps> = ({ taskHistory, rootTaskId }) => {
	const { totals, perTask } = useMemo(() => {
		if (!rootTaskId) return { totals: EMPTY, perTask: [] as HistoryItem[] }
		const subtree = collectSubtree(taskHistory, rootTaskId)
		const t: Totals = { ...EMPTY, tasks: subtree.length }
		for (const item of subtree) {
			t.tokensIn += item.tokensIn || 0
			t.tokensOut += item.tokensOut || 0
			t.cacheReads += item.cacheReads || 0
			t.cacheWrites += item.cacheWrites || 0
			t.totalCost += item.totalCost || 0
			t.activeTimeMs += item.activeTimeMs || 0
		}
		// Per-task breakdown, biggest contributors first (by cost, then tokens).
		const ranked = [...subtree].sort((a, b) => {
			const c = (b.totalCost || 0) - (a.totalCost || 0)
			if (c !== 0) return c
			return (b.tokensIn + b.tokensOut || 0) - (a.tokensIn + a.tokensOut || 0)
		})
		return { totals: t, perTask: ranked }
	}, [taskHistory, rootTaskId])

	const hasCache = totals.cacheReads > 0 || totals.cacheWrites > 0

	if (!rootTaskId || totals.tasks === 0) {
		return (
			<div className="flex relative grow overflow-hidden">
				<div style={{ color: "var(--vscode-descriptionForeground, #888)", padding: 12, fontSize: 12 }}>
					No tasks in this tree yet.
				</div>
			</div>
		)
	}

	const cards: Array<{ label: string; value: string; sub?: string }> = [
		{ label: "Tasks", value: String(totals.tasks), sub: "whole tree" },
		{
			label: "Tokens",
			value: formatTokens(totals.tokensIn + totals.tokensOut),
			sub: `${formatTokens(totals.tokensIn)} in · ${formatTokens(totals.tokensOut)} out`,
		},
		...(hasCache
			? [
					{
						label: "Cache",
						value: formatTokens(totals.cacheReads + totals.cacheWrites),
						sub: `${formatTokens(totals.cacheReads)} read · ${formatTokens(totals.cacheWrites)} write`,
					},
				]
			: []),
		{ label: "Cost", value: `$${totals.totalCost.toFixed(totals.totalCost < 1 ? 4 : 2)}` },
		{ label: "Active time", value: formatDurationMs(totals.activeTimeMs) },
	]

	return (
		<div className="flex relative grow overflow-hidden">
			<div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "10px 12px", fontSize: 12 }}>
				{/* Summary cards (accumulated across the whole tree) */}
				<div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
					{cards.map((c) => (
						<div
							key={c.label}
							style={{
								flex: "1 1 120px",
								minWidth: 120,
								background: "var(--vscode-editorWidget-background, #252526)",
								border: "1px solid var(--vscode-widget-border, #3c3c3c)",
								borderRadius: 4,
								padding: "8px 10px",
							}}>
							<div
								style={{
									color: "var(--vscode-descriptionForeground, #888)",
									fontSize: 11,
									textTransform: "uppercase",
									letterSpacing: 0.4,
								}}>
								{c.label}
							</div>
							<div style={{ fontSize: 18, fontWeight: 600, color: "var(--vscode-foreground, #ccc)" }}>
								{c.value}
							</div>
							{c.sub && (
								<div style={{ color: "var(--vscode-descriptionForeground, #888)", fontSize: 11 }}>
									{c.sub}
								</div>
							)}
						</div>
					))}
				</div>

				{/* Per-task breakdown */}
				<div
					style={{
						marginTop: 14,
						color: "var(--vscode-descriptionForeground, #888)",
						fontSize: 11,
						textTransform: "uppercase",
						letterSpacing: 0.4,
					}}>
					Per task ({perTask.length})
				</div>
				<table style={{ width: "100%", borderCollapse: "collapse", marginTop: 4 }}>
					<thead>
						<tr style={{ color: "var(--vscode-descriptionForeground, #888)", textAlign: "right" }}>
							<th style={{ textAlign: "left", padding: "3px 6px", fontWeight: 500 }}>Task</th>
							<th style={{ padding: "3px 6px", fontWeight: 500 }}>Tokens</th>
							<th style={{ padding: "3px 6px", fontWeight: 500 }}>Cost</th>
							<th style={{ padding: "3px 6px", fontWeight: 500 }}>Time</th>
						</tr>
					</thead>
					<tbody>
						{perTask.map((item, idx) => (
							<tr
								key={item.id}
								style={{
									borderTop: "1px solid var(--vscode-widget-border, #3c3c3c)",
									textAlign: "right",
									color: "var(--vscode-foreground, #ccc)",
								}}>
								<td
									style={{
										textAlign: "left",
										padding: "3px 6px",
										maxWidth: 320,
										overflow: "hidden",
										textOverflow: "ellipsis",
										whiteSpace: "nowrap",
									}}
									title={getTaskDisplayName(item)}>
									{idx === 0 ? "★ " : ""}
									{getTaskDisplayName(item)}
								</td>
								<td style={{ padding: "3px 6px" }}>{formatTokens(item.tokensIn + item.tokensOut)}</td>
								<td style={{ padding: "3px 6px" }}>${(item.totalCost || 0).toFixed(2)}</td>
								<td style={{ padding: "3px 6px" }}>
									{item.activeTimeMs ? formatDurationMs(item.activeTimeMs) : "—"}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	)
}

export default WorkflowStatsView
