import React, { useEffect, useMemo, useState } from "react"
import { useEvent } from "react-use"
import type { HistoryItem, ExtensionMessage, ApiRequestFinishedPayload } from "@shofer/types"
import { getTaskDisplayName } from "./TaskSelector"
import { vscode } from "@src/utils/vscode"
import {
	type Breakdown,
	breakdownFromPayloads,
	mergeBreakdowns,
	buildSlices,
	arcPath,
	formatMs,
	CAT_BY_KEY,
	MCP_PREFIX,
	VB,
	CENTER,
	R_OUTER,
	R_INNER,
} from "./taskStats"

/**
 * "Stats" tab for a workflow. Accumulates the metrics of the *entire task tree*
 * rooted at the workflow — the root task plus every descendant agent task
 * (recursively) — into a single summary, a per-task breakdown, and (like the
 * single-task TaskView Stats tab) an active-time donut + per-tool breakdown
 * aggregated across the whole tree.
 *
 * Token/cost/time totals come from `taskHistory` (already in the webview). The
 * donut needs each task's `api_req_finished` timing payloads, which aren't in
 * the webview for non-focused tasks, so they're fetched once via
 * `requestWorkflowStats` and aggregated client-side. (Distinct from
 * `TaskStatsView`, the single-task donut.)
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
	const { totals, perTask, subtreeIds } = useMemo(() => {
		if (!rootTaskId) return { totals: EMPTY, perTask: [] as HistoryItem[], subtreeIds: [] as string[] }
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
		return { totals: t, perTask: ranked, subtreeIds: subtree.map((s) => s.id) }
	}, [taskHistory, rootTaskId])

	// Active-time breakdown across the tree. The per-task `api_req_finished`
	// timing payloads aren't in the webview, so fetch them once and aggregate.
	const subtreeKey = subtreeIds.join(",")
	const [breakdown, setBreakdown] = useState<Breakdown | null>(null)
	useEffect(() => {
		setBreakdown(null)
		if (rootTaskId && subtreeIds.length > 0) {
			vscode.postMessage({ type: "requestWorkflowStats", taskId: rootTaskId, workflowStatsTaskIds: subtreeIds })
		}
		// subtreeKey captures the id set; subtreeIds is derived from it.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [rootTaskId, subtreeKey])

	useEvent("message", (event: MessageEvent) => {
		const message: ExtensionMessage = event.data
		if (message.type !== "workflowStats" || message.workflowStatsRootId !== rootTaskId) return
		const requests = message.workflowStatsRequests ?? {}
		const perTaskBreakdowns = Object.values(requests).map((texts) => {
			const payloads: ApiRequestFinishedPayload[] = []
			for (const text of texts) {
				try {
					payloads.push(JSON.parse(text))
				} catch {
					/* skip malformed */
				}
			}
			return breakdownFromPayloads(payloads)
		})
		setBreakdown(mergeBreakdowns(perTaskBreakdowns))
	})

	const hasCache = totals.cacheReads > 0 || totals.cacheWrites > 0
	const donut = useMemo(
		() => (breakdown ? buildSlices(breakdown, totals.activeTimeMs) : null),
		[breakdown, totals.activeTimeMs],
	)
	const maxToolMs = breakdown && breakdown.toolTotals.length > 0 ? breakdown.toolTotals[0].ms : 0

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
		{
			label: "Active time (tree total)",
			value: formatDurationMs(totals.activeTimeMs),
			sub: `summed across ${totals.tasks} ${totals.tasks === 1 ? "task" : "tasks"}`,
		},
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

				{/* Active-time breakdown donut (aggregated across the tree) */}
				<div
					style={{
						marginTop: 16,
						color: "var(--vscode-descriptionForeground, #888)",
						fontSize: 11,
						textTransform: "uppercase",
						letterSpacing: 0.4,
					}}>
					Active-time breakdown
					{breakdown ? ` · ${breakdown.requestCount} request${breakdown.requestCount === 1 ? "" : "s"}` : ""}
				</div>
				{!donut || donut.slices.length === 0 ? (
					<div style={{ color: "var(--vscode-descriptionForeground, #888)", padding: "8px 0" }}>
						{breakdown === null ? "Loading timing data…" : "No timing data recorded yet for this tree."}
					</div>
				) : (
					<div style={{ display: "flex", flexWrap: "wrap", gap: 20, alignItems: "flex-start", marginTop: 6 }}>
						<svg viewBox={`0 0 ${VB} ${VB}`} style={{ width: 180, height: 180, flexShrink: 0 }}>
							{donut.slices.map((slice) => (
								<path
									key={slice.cat.key}
									d={arcPath(slice.a0, slice.a1, R_OUTER, R_INNER)}
									fill={slice.cat.color}
									stroke="var(--vscode-editor-background)"
									strokeWidth={1.5}
								/>
							))}
							<text
								x={CENTER}
								y={CENTER - 4}
								textAnchor="middle"
								fill="var(--vscode-foreground)"
								fontSize={20}
								fontWeight={600}>
								{formatMs(donut.total)}
							</text>
							<text
								x={CENTER}
								y={CENTER + 16}
								textAnchor="middle"
								fill="var(--vscode-descriptionForeground)"
								fontSize={11}>
								active
							</text>
						</svg>
						<div style={{ flex: 1, minWidth: 180 }}>
							{donut.slices.map((slice) => (
								<div
									key={slice.cat.key}
									style={{ display: "flex", alignItems: "center", gap: 8, padding: "2px 0" }}>
									<span
										style={{
											width: 10,
											height: 10,
											borderRadius: 2,
											flexShrink: 0,
											background: slice.cat.color,
										}}
									/>
									<span style={{ flex: 1, color: "var(--vscode-foreground, #ccc)" }}>
										{slice.cat.label}
									</span>
									<span style={{ color: "var(--vscode-descriptionForeground, #888)" }}>
										{formatMs(slice.ms)}
									</span>
									<span
										style={{
											width: 48,
											textAlign: "right",
											color: "var(--vscode-descriptionForeground, #888)",
										}}>
										{(slice.fraction * 100).toFixed(1)}%
									</span>
								</div>
							))}
						</div>
					</div>
				)}

				{/* Per-tool sub-breakdown (aggregated) */}
				{breakdown && breakdown.toolTotals.length > 0 && (
					<>
						<div
							style={{
								marginTop: 14,
								color: "var(--vscode-descriptionForeground, #888)",
								fontSize: 11,
								textTransform: "uppercase",
								letterSpacing: 0.4,
							}}>
							Tool &amp; MCP calls by tool
						</div>
						<div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4 }}>
							{breakdown.toolTotals.map((tool) => (
								<div key={tool.name} style={{ display: "flex", alignItems: "center", gap: 8 }}>
									<span
										style={{
											width: 150,
											overflow: "hidden",
											textOverflow: "ellipsis",
											whiteSpace: "nowrap",
											fontFamily: "var(--vscode-editor-font-family, monospace)",
											color: "var(--vscode-foreground, #ccc)",
										}}
										title={tool.name}>
										{tool.name}
									</span>
									<span
										style={{
											flex: 1,
											height: 8,
											borderRadius: 2,
											overflow: "hidden",
											background: "var(--vscode-input-background, #3c3c3c)",
										}}>
										<span
											style={{
												display: "block",
												height: "100%",
												width: `${maxToolMs > 0 ? (tool.ms / maxToolMs) * 100 : 0}%`,
												background: tool.name.startsWith(MCP_PREFIX)
													? CAT_BY_KEY.mcp.color
													: CAT_BY_KEY.tool.color,
											}}
										/>
									</span>
									<span
										style={{
											width: 70,
											textAlign: "right",
											color: "var(--vscode-descriptionForeground, #888)",
										}}
										title={`${tool.count} run${tool.count === 1 ? "" : "s"}, ${tool.errors} failed`}>
										{tool.count}× {Math.round(((tool.count - tool.errors) / tool.count) * 100)}%
									</span>
									<span
										style={{
											width: 56,
											textAlign: "right",
											color: "var(--vscode-descriptionForeground, #888)",
										}}>
										{formatMs(tool.ms)}
									</span>
								</div>
							))}
						</div>
					</>
				)}

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
