import type { ShoferMessage, ApiRequestFinishedPayload } from "@shofer/types"

/**
 * Shared active-time breakdown logic for the Stats views.
 *
 * `TaskStatsView` renders a single task's donut; `WorkflowStatsView` aggregates
 * the same breakdown across an entire task tree. Both compute per-category
 * non-overlapping totals by painting each request's spans onto a single
 * monotonic offset timeline and reading off the highest-priority covering
 * segment — see `breakdownFromPayloads`. Aggregation across tasks is a plain
 * sum of per-task breakdowns (`mergeBreakdowns`); offsets are per-task, so the
 * sweep must run per task before summing.
 */

export type CatKey = "llm" | "thinking" | "streaming" | "tool" | "mcp" | "waiting_subtask" | "sleeping"

export interface CatMeta {
	key: CatKey
	label: string
	color: string
	/** Paint priority — higher wins when spans overlap on the timeline. */
	prio: number
}

export const CATEGORIES: CatMeta[] = [
	{ key: "llm", label: "Waiting for model", color: "var(--vscode-charts-blue, #3b82f6)", prio: 1 },
	{ key: "thinking", label: "Thinking", color: "var(--vscode-charts-purple, #a855f7)", prio: 1 },
	{ key: "streaming", label: "Streaming response", color: "var(--vscode-charts-green, #16a34a)", prio: 1 },
	{ key: "tool", label: "Tool execution", color: "var(--vscode-charts-orange, #f97316)", prio: 2 },
	{ key: "mcp", label: "MCP calls", color: "var(--vscode-charts-indigo, #6366f1)", prio: 2 },
	{ key: "waiting_subtask", label: "Waiting for task", color: "var(--vscode-charts-cyan, #06b6d4)", prio: 2 },
	{ key: "sleeping", label: "Sleeping", color: "var(--vscode-charts-yellow, #eab308)", prio: 2 },
]

export const CAT_BY_KEY: Record<CatKey, CatMeta> = CATEGORIES.reduce(
	(acc, c) => {
		acc[c.key] = c
		return acc
	},
	{} as Record<CatKey, CatMeta>,
)

export const MCP_PREFIX = "mcp:" // MCP tool spans are named `mcp:<server>/<tool>`
const WAIT_FOR_TASK_TOOL = "wait_for_task"
const SLEEP_TOOL = "sleep"

export function formatMs(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
	const totalSec = Math.round(ms / 1000)
	const mins = Math.floor(totalSec / 60)
	const secs = totalSec % 60
	if (mins < 60) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`
	const hrs = Math.floor(mins / 60)
	const remMin = mins % 60
	return remMin > 0 ? `${hrs}h ${remMin}m` : `${hrs}h`
}

export interface Breakdown {
	totals: Record<CatKey, number>
	/** Per-tool execution time + run/error counts (excludes wait/sleep), largest first. */
	toolTotals: Array<{ name: string; ms: number; count: number; errors: number }>
	/** Total running time: sum of all categories. Excludes idle/inter-prompt gaps. */
	totalMs: number
	requestCount: number
}

interface Segment {
	start: number
	end: number
	cat: CatKey
	prio: number
}

function zeroTotals(): Record<CatKey, number> {
	return { llm: 0, thinking: 0, streaming: 0, tool: 0, mcp: 0, waiting_subtask: 0, sleeping: 0 }
}

/** Compute a single task's breakdown from its `api_req_finished` payloads. */
export function breakdownFromPayloads(payloads: ApiRequestFinishedPayload[]): Breakdown | null {
	const segments: Segment[] = []
	const toolMap = new Map<string, { ms: number; count: number; errors: number }>()
	let minStart = Infinity
	let maxEnd = -Infinity
	let requestCount = 0

	for (const payload of payloads) {
		requestCount++
		const reqStart = payload.startedAtOffsetMs
		const reqEnd = Math.max(payload.finishedAtOffsetMs, reqStart)
		const reqDur = reqEnd - reqStart
		const ttfb = Math.min(Math.max(payload.ttfbMs ?? 0, 0), reqDur)
		const genStart =
			payload.genStartOffsetMs != null ? Math.min(Math.max(payload.genStartOffsetMs, ttfb), reqDur) : ttfb

		segments.push({ start: reqStart, end: reqStart + ttfb, cat: "llm", prio: 1 })
		segments.push({ start: reqStart + ttfb, end: reqStart + genStart, cat: "thinking", prio: 1 })
		segments.push({ start: reqStart + genStart, end: reqEnd, cat: "streaming", prio: 1 })
		minStart = Math.min(minStart, reqStart)
		maxEnd = Math.max(maxEnd, reqEnd)

		for (const span of payload.toolSpans) {
			const s = span.startedAtOffsetMs
			const e = Math.max(span.finishedAtOffsetMs, s)
			const isSleep = span.toolName === SLEEP_TOOL
			const isWait = !isSleep && (span.waitsForTask === true || span.toolName === WAIT_FOR_TASK_TOOL)
			const isMcp = !isSleep && !isWait && span.toolName.startsWith(MCP_PREFIX)
			const cat: CatKey = isSleep ? "sleeping" : isWait ? "waiting_subtask" : isMcp ? "mcp" : "tool"
			segments.push({ start: s, end: e, cat, prio: 2 })
			minStart = Math.min(minStart, s)
			maxEnd = Math.max(maxEnd, e)
			if (!isWait && !isSleep) {
				const cur = toolMap.get(span.toolName) ?? { ms: 0, count: 0, errors: 0 }
				cur.ms += e - s
				cur.count += 1
				if (span.isError) cur.errors += 1
				toolMap.set(span.toolName, cur)
			}
		}
	}

	if (requestCount === 0 || !isFinite(minStart) || maxEnd <= minStart) return null

	// Sweep: attribute each elementary interval to its highest-priority covering
	// segment; uncovered gaps are idle/between-prompt and dropped.
	const totals = zeroTotals()
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
				if (best.prio === 2) break
			}
		}
		if (best) totals[best.cat] += len
	}

	const toolTotals = Array.from(toolMap.entries())
		.map(([name, v]) => ({ name, ms: v.ms, count: v.count, errors: v.errors }))
		.sort((x, y) => y.ms - x.ms)

	const totalMs = CATEGORIES.reduce((sum, c) => sum + totals[c.key], 0)
	return { totals, toolTotals, totalMs, requestCount }
}

/** Parse `api_req_finished` payloads out of a task's ShoferMessages, then break down. */
export function computeBreakdown(messages: ShoferMessage[]): Breakdown | null {
	const payloads: ApiRequestFinishedPayload[] = []
	for (const msg of messages) {
		if (msg.type !== "say" || msg.say !== "api_req_finished" || !msg.text) continue
		try {
			payloads.push(JSON.parse(msg.text))
		} catch {
			/* skip malformed */
		}
	}
	return breakdownFromPayloads(payloads)
}

/** Sum a list of per-task breakdowns into one. Returns null when all are empty. */
export function mergeBreakdowns(list: Array<Breakdown | null>): Breakdown | null {
	const totals = zeroTotals()
	const toolMap = new Map<string, { ms: number; count: number; errors: number }>()
	let totalMs = 0
	let requestCount = 0
	let any = false
	for (const b of list) {
		if (!b) continue
		any = true
		for (const c of CATEGORIES) totals[c.key] += b.totals[c.key]
		totalMs += b.totalMs
		requestCount += b.requestCount
		for (const t of b.toolTotals) {
			const cur = toolMap.get(t.name) ?? { ms: 0, count: 0, errors: 0 }
			cur.ms += t.ms
			cur.count += t.count
			cur.errors += t.errors
			toolMap.set(t.name, cur)
		}
	}
	if (!any) return null
	const toolTotals = Array.from(toolMap.entries())
		.map(([name, v]) => ({ name, ms: v.ms, count: v.count, errors: v.errors }))
		.sort((x, y) => y.ms - x.ms)
	return { totals, toolTotals, totalMs, requestCount }
}

// ── Donut geometry ──

export const VB = 240
export const CENTER = VB / 2
export const R_OUTER = 104
export const R_INNER = 62

export function polar(radius: number, angle: number): [number, number] {
	return [CENTER + radius * Math.cos(angle), CENTER + radius * Math.sin(angle)]
}

export function arcPath(a0: number, a1: number, rOuter: number, rInner: number): string {
	const large = a1 - a0 > Math.PI ? 1 : 0
	const [x0o, y0o] = polar(rOuter, a0)
	const [x1o, y1o] = polar(rOuter, a1)
	const [x1i, y1i] = polar(rInner, a1)
	const [x0i, y0i] = polar(rInner, a0)
	return `M ${x0o} ${y0o} A ${rOuter} ${rOuter} 0 ${large} 1 ${x1o} ${y1o} L ${x1i} ${y1i} A ${rInner} ${rInner} 0 ${large} 0 ${x0i} ${y0i} Z`
}

export type SliceCat = { key: string; label: string; color: string }

export interface Slice {
	cat: SliceCat
	ms: number
	fraction: number
	a0: number
	a1: number
}

/** The active-but-unmeasured remainder (checkpointing, inter-request processing). */
export const OVERHEAD: SliceCat = { key: "overhead", label: "Overhead", color: "var(--vscode-descriptionForeground)" }

/**
 * Turn a breakdown into donut slices. `activeMs` (when > 0) is the total — the
 * spans subdivide it and any unmeasured remainder becomes an "Overhead" slice.
 */
export function buildSlices(breakdown: Breakdown, activeMs?: number): { slices: Slice[]; total: number } {
	const spanSum = breakdown.totalMs
	const displayTotal = activeMs != null && activeMs > 0 ? Math.max(activeMs, spanSum) : spanSum
	if (displayTotal <= 0) return { slices: [], total: 0 }
	let angle = -Math.PI / 2
	const out: Slice[] = []
	const push = (cat: SliceCat, ms: number) => {
		if (ms <= 0.5) return
		const fraction = ms / displayTotal
		const a0 = angle
		const a1 = angle + fraction * Math.PI * 2
		angle = a1
		out.push({ cat, ms, fraction, a0, a1 })
	}
	for (const cat of CATEGORIES) push(cat, breakdown.totals[cat.key])
	push(OVERHEAD, displayTotal - spanSum)
	return { slices: out, total: displayTotal }
}
