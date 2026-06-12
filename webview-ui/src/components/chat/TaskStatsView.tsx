import React, { useMemo, useState } from "react"
import type { ShoferMessage, ApiRequestFinishedPayload } from "@shofer/types"

/**
 * Stats view — a donut chart breaking down where a single task spent its time.
 *
 * Data source: the same `api_req_finished` ShoferSay messages that power the
 * Trace view. Each carries precise offsets (from `Task.timelineOriginMs`) for
 * the request span, its TTFB, and every nested tool span. Because all offsets
 * live on one monotonic axis we can *paint* them with priority and read off
 * non-overlapping per-category totals — no wall-clock/epoch alignment needed.
 *
 * The "running" lifecycle is subdivided into what the task was actually doing:
 *   • Waiting for model (TTFB)   • Streaming response   • Tool execution
 *   • Waiting on subtasks (wait_for_task)
 * Everything between request cycles (tool-approval waits, checkpointing,
 * context processing, user idle) falls into "Idle / waiting".
 */

// ── Categories ──

type CatKey = "llm" | "streaming" | "tool" | "waiting_subtask" | "idle"

interface CatMeta {
	key: CatKey
	label: string
	color: string
	/** Paint priority — higher wins when spans overlap on the timeline. */
	prio: number
}

const CATEGORIES: CatMeta[] = [
	{ key: "llm", label: "Waiting for model", color: "var(--vscode-charts-blue, #3b82f6)", prio: 1 },
	{ key: "streaming", label: "Streaming response", color: "var(--vscode-charts-green, #16a34a)", prio: 1 },
	{ key: "tool", label: "Tool execution", color: "var(--vscode-charts-orange, #f97316)", prio: 2 },
	{ key: "waiting_subtask", label: "Waiting on subtasks", color: "var(--vscode-charts-purple, #a855f7)", prio: 2 },
	{ key: "idle", label: "Idle / waiting for input", color: "var(--vscode-descriptionForeground)", prio: 0 },
]

const CAT_BY_KEY: Record<CatKey, CatMeta> = CATEGORIES.reduce(
	(acc, c) => {
		acc[c.key] = c
		return acc
	},
	{} as Record<CatKey, CatMeta>,
)

const WAIT_FOR_TASK_TOOL = "wait_for_task"

// ── Helpers ──

function formatMs(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
	const totalSec = Math.round(ms / 1000)
	const mins = Math.floor(totalSec / 60)
	const secs = totalSec % 60
	return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`
}

interface Breakdown {
	totals: Record<CatKey, number>
	/** Per-tool execution time (excludes wait_for_task), largest first. */
	toolTotals: Array<{ name: string; ms: number }>
	totalSpan: number
	requestCount: number
}

/** One labelled, priority-tagged interval on the offset timeline. */
interface Segment {
	start: number
	end: number
	cat: CatKey
	prio: number
}

/**
 * Parses `api_req_finished` payloads and paints their request/tool spans onto a
 * single timeline, returning non-overlapping per-category totals.
 */
function computeBreakdown(messages: ShoferMessage[]): Breakdown | null {
	const segments: Segment[] = []
	const toolMap = new Map<string, number>()
	let minStart = Infinity
	let maxEnd = -Infinity
	let requestCount = 0

	for (const msg of messages) {
		if (msg.type !== "say" || msg.say !== "api_req_finished" || !msg.text) continue

		let payload: ApiRequestFinishedPayload
		try {
			payload = JSON.parse(msg.text)
		} catch {
			continue
		}
		requestCount++

		const reqStart = payload.startedAtOffsetMs
		const reqEnd = Math.max(payload.finishedAtOffsetMs, reqStart)
		// TTFB is a duration relative to request start; clamp into the span.
		const ttfb = Math.min(Math.max(payload.ttfbMs ?? 0, 0), reqEnd - reqStart)

		segments.push({ start: reqStart, end: reqStart + ttfb, cat: "llm", prio: 1 })
		segments.push({ start: reqStart + ttfb, end: reqEnd, cat: "streaming", prio: 1 })
		minStart = Math.min(minStart, reqStart)
		maxEnd = Math.max(maxEnd, reqEnd)

		for (const span of payload.toolSpans) {
			const s = span.startedAtOffsetMs
			const e = Math.max(span.finishedAtOffsetMs, s)
			const isWait = span.toolName === WAIT_FOR_TASK_TOOL
			segments.push({ start: s, end: e, cat: isWait ? "waiting_subtask" : "tool", prio: 2 })
			minStart = Math.min(minStart, s)
			maxEnd = Math.max(maxEnd, e)
			if (!isWait) {
				toolMap.set(span.toolName, (toolMap.get(span.toolName) ?? 0) + (e - s))
			}
		}
	}

	if (requestCount === 0 || !isFinite(minStart) || maxEnd <= minStart) return null

	// Sweep: for each elementary interval between segment boundaries, attribute
	// its length to the highest-priority covering segment (or idle if none).
	const totals: Record<CatKey, number> = { llm: 0, streaming: 0, tool: 0, waiting_subtask: 0, idle: 0 }
	const points = Array.from(new Set([minStart, maxEnd, ...segments.flatMap((s) => [s.start, s.end])])).sort(
		(a, b) => a - b,
	)

	for (let i = 0; i < points.length - 1; i++) {
		const a = points[i]
		const b = points[i + 1]
		const len = b - a
		if (len <= 0) continue
		const mid = a + len / 2
		let best: Segment | null = null
		for (const s of segments) {
			if (s.start <= mid && mid < s.end && (!best || s.prio > best.prio)) {
				best = s
				if (best.prio === 2) break // max priority — can't be beaten
			}
		}
		totals[best ? best.cat : "idle"] += len
	}

	const toolTotals = Array.from(toolMap.entries())
		.map(([name, ms]) => ({ name, ms }))
		.sort((x, y) => y.ms - x.ms)

	return { totals, toolTotals, totalSpan: maxEnd - minStart, requestCount }
}

// ── Donut geometry ──

const VB = 240
const CENTER = VB / 2
const R_OUTER = 104
const R_INNER = 62

function polar(radius: number, angle: number): [number, number] {
	return [CENTER + radius * Math.cos(angle), CENTER + radius * Math.sin(angle)]
}

function arcPath(a0: number, a1: number, rOuter: number, rInner: number): string {
	const large = a1 - a0 > Math.PI ? 1 : 0
	const [x0o, y0o] = polar(rOuter, a0)
	const [x1o, y1o] = polar(rOuter, a1)
	const [x1i, y1i] = polar(rInner, a1)
	const [x0i, y0i] = polar(rInner, a0)
	return `M ${x0o} ${y0o} A ${rOuter} ${rOuter} 0 ${large} 1 ${x1o} ${y1o} L ${x1i} ${y1i} A ${rInner} ${rInner} 0 ${large} 0 ${x0i} ${y0i} Z`
}

interface Slice {
	cat: CatMeta
	ms: number
	fraction: number
	a0: number
	a1: number
}

interface TaskStatsViewProps {
	/** All ShoferMessages for the currently focused task. */
	messages: ShoferMessage[]
}

/**
 * Donut chart + legend showing where a single task's time went.
 */
const TaskStatsView: React.FC<TaskStatsViewProps> = ({ messages }) => {
	const breakdown = useMemo(() => computeBreakdown(messages), [messages])
	const [hovered, setHovered] = useState<CatKey | null>(null)

	const slices = useMemo<Slice[]>(() => {
		if (!breakdown) return []
		const total = breakdown.totalSpan
		if (total <= 0) return []
		let angle = -Math.PI / 2
		const out: Slice[] = []
		for (const cat of CATEGORIES) {
			const ms = breakdown.totals[cat.key]
			if (ms <= 0) continue
			const fraction = ms / total
			const a0 = angle
			const a1 = angle + fraction * Math.PI * 2
			angle = a1
			out.push({ cat, ms, fraction, a0, a1 })
		}
		return out
	}, [breakdown])

	if (!breakdown || slices.length === 0) {
		return (
			<div className="flex items-center justify-center h-full p-6">
				<p className="text-sm text-[var(--vscode-descriptionForeground)]">
					No timing data recorded yet. Run the task to see where its time goes.
				</p>
			</div>
		)
	}

	const total = breakdown.totalSpan
	const isSingle = slices.length === 1
	const maxToolMs = breakdown.toolTotals.length > 0 ? breakdown.toolTotals[0].ms : 0

	return (
		<div className="h-full w-full overflow-y-auto p-4">
			<div className="flex items-center justify-between mb-3">
				<span className="text-xs font-medium text-[var(--vscode-foreground)]">Time breakdown</span>
				<span className="text-[10px] text-[var(--vscode-descriptionForeground)]">
					{breakdown.requestCount} request{breakdown.requestCount === 1 ? "" : "s"} · {formatMs(total)}{" "}
					tracked
				</span>
			</div>

			<div className="flex flex-wrap gap-5 items-start">
				{/* Donut */}
				<svg viewBox={`0 0 ${VB} ${VB}`} className="w-[200px] h-[200px] flex-shrink-0">
					{isSingle ? (
						<circle
							cx={CENTER}
							cy={CENTER}
							r={(R_OUTER + R_INNER) / 2}
							fill="none"
							stroke={slices[0].cat.color}
							strokeWidth={R_OUTER - R_INNER}
							opacity={hovered && hovered !== slices[0].cat.key ? 0.35 : 1}
							onMouseEnter={() => setHovered(slices[0].cat.key)}
							onMouseLeave={() => setHovered(null)}
						/>
					) : (
						slices.map((slice) => {
							const dim = hovered !== null && hovered !== slice.cat.key
							return (
								<path
									key={slice.cat.key}
									d={arcPath(slice.a0, slice.a1, R_OUTER, R_INNER)}
									fill={slice.cat.color}
									stroke="var(--vscode-editor-background)"
									strokeWidth={1.5}
									opacity={dim ? 0.35 : 1}
									style={{ cursor: "pointer", transition: "opacity 0.1s" }}
									onMouseEnter={() => setHovered(slice.cat.key)}
									onMouseLeave={() => setHovered(null)}
								/>
							)
						})
					)}

					{/* Center label */}
					<text
						x={CENTER}
						y={CENTER - 4}
						textAnchor="middle"
						fill="var(--vscode-foreground)"
						fontSize={20}
						fontWeight={600}>
						{hovered ? `${Math.round((breakdown.totals[hovered] / total) * 100)}%` : formatMs(total)}
					</text>
					<text
						x={CENTER}
						y={CENTER + 16}
						textAnchor="middle"
						fill="var(--vscode-descriptionForeground)"
						fontSize={11}>
						{hovered ? CAT_BY_KEY[hovered].label : "total"}
					</text>
				</svg>

				{/* Legend */}
				<div className="flex-1 min-w-[180px]">
					{slices.map((slice) => {
						const pct = (slice.fraction * 100).toFixed(1)
						const active = hovered === slice.cat.key
						return (
							<div
								key={slice.cat.key}
								className="flex items-center gap-2 py-1 text-xs rounded px-1 -mx-1 cursor-pointer"
								style={{ backgroundColor: active ? "var(--vscode-list-hoverBackground)" : undefined }}
								onMouseEnter={() => setHovered(slice.cat.key)}
								onMouseLeave={() => setHovered(null)}>
								<span
									className="inline-block w-2.5 h-2.5 rounded-sm flex-shrink-0"
									style={{ backgroundColor: slice.cat.color }}
								/>
								<span
									className="flex-1 truncate"
									style={{
										color: "var(--vscode-foreground)",
										fontWeight: active ? 600 : 400,
									}}>
									{slice.cat.label}
								</span>
								<span className="tabular-nums text-[var(--vscode-descriptionForeground)] flex-shrink-0">
									{formatMs(slice.ms)}
								</span>
								<span className="tabular-nums text-[var(--vscode-descriptionForeground)] w-12 text-right flex-shrink-0">
									{pct}%
								</span>
							</div>
						)
					})}
				</div>
			</div>

			{/* Per-tool sub-breakdown of the "Tool execution" slice */}
			{breakdown.toolTotals.length > 0 && (
				<div className="mt-5">
					<div className="text-[10px] uppercase tracking-wide text-[var(--vscode-descriptionForeground)] mb-1.5">
						Tool execution by tool
					</div>
					<div className="flex flex-col gap-1">
						{breakdown.toolTotals.map((tool) => (
							<div key={tool.name} className="flex items-center gap-2 text-xs">
								<span
									className="w-40 truncate font-mono text-[var(--vscode-foreground)]"
									title={tool.name}>
									{tool.name}
								</span>
								<span className="flex-1 h-2 rounded-sm overflow-hidden bg-[var(--vscode-input-background)]">
									<span
										className="block h-full rounded-sm"
										style={{
											width: `${maxToolMs > 0 ? (tool.ms / maxToolMs) * 100 : 0}%`,
											backgroundColor: CAT_BY_KEY.tool.color,
										}}
									/>
								</span>
								<span className="tabular-nums text-[var(--vscode-descriptionForeground)] w-16 text-right flex-shrink-0">
									{formatMs(tool.ms)}
								</span>
							</div>
						))}
					</div>
				</div>
			)}

			<p className="mt-5 text-[10px] leading-relaxed text-[var(--vscode-descriptionForeground)]">
				Measured from the first API request to the last recorded activity. “Idle / waiting” covers everything
				between request cycles — tool-approval prompts, checkpointing, context processing, and time spent
				waiting on you.
			</p>
		</div>
	)
}

export default TaskStatsView
