import React, { useMemo, useRef, useState, useCallback, useEffect } from "react"
import type { ShoferMessage, ApiRequestFinishedPayload, ToolSpan } from "@shofer/types"
import { useSvgPanZoom } from "@src/hooks/useSvgPanZoom"

/**
 * Waterfall timeline view for a single task, showing every API request and its
 * nested tool spans on a shared horizontal time axis.
 *
 * Data source: `api_req_finished` ShoferSay messages in the task's
 * `shoferMessages` array. Each carries a JSON `ApiRequestFinishedPayload`
 * with offsets from `Task.timelineOriginMs`.
 */

/** Represents a single API request row rendered in the waterfall. */
interface TraceRow {
	payload: ApiRequestFinishedPayload
	/** Earliest offset across the request span and all its tool spans. */
	startOffsetMs: number
	/** Latest offset across the request span and all its tool spans. */
	endOffsetMs: number
}

/** Parses TraceRows from ShoferMessages containing api_req_finished payloads. */
function parseTraceRows(messages: ShoferMessage[]): TraceRow[] {
	const rows: TraceRow[] = []

	for (const msg of messages) {
		if (msg.type !== "say" || msg.say !== "api_req_finished" || !msg.text) continue

		try {
			const payload: ApiRequestFinishedPayload = JSON.parse(msg.text)
			let start = payload.startedAtOffsetMs
			let end = payload.finishedAtOffsetMs

			for (const ts of payload.toolSpans) {
				if (ts.startedAtOffsetMs < start) start = ts.startedAtOffsetMs
				if (ts.finishedAtOffsetMs > end) end = ts.finishedAtOffsetMs
			}

			rows.push({ payload, startOffsetMs: start, endOffsetMs: end })
		} catch {
			// Skip malformed payloads.
		}
	}

	return rows
}

// ── Colour constants ──

const COLOURS = {
	bg: "var(--vscode-editor-background)",
	fg: "var(--vscode-foreground)",
	muted: "var(--vscode-descriptionForeground)",
	border: "var(--vscode-panel-border)",
	rowHover: "var(--vscode-list-hoverBackground)",

	requestBar: "var(--vscode-charts-blue, #3b82f6)",
	requestBarError: "var(--vscode-errorForeground, #ef4444)",
	// Shared phase palette (kept in sync with TaskStatsView).
	phaseWaiting: "var(--vscode-charts-blue, #3b82f6)",
	phaseThinking: "var(--vscode-charts-purple, #a855f7)",
	phaseStreaming: "var(--vscode-charts-green, #16a34a)",
	toolBar: "var(--vscode-charts-orange, #f97316)",
	toolBarWait: "var(--vscode-charts-cyan, #06b6d4)",
	toolBarSleep: "var(--vscode-charts-yellow, #eab308)",
	toolBarMcp: "var(--vscode-charts-indigo, #6366f1)",
	toolBarError: "var(--vscode-charts-red, #dc2626)",
	toolBarSkipped: "var(--vscode-descriptionForeground)",

	ttfb: "rgba(59, 130, 246, 0.25)",
	streaming: "rgba(34, 197, 94, 0.25)",
	gridLine: "var(--vscode-panel-border)",
}

// ── Layout constants ──

const ROW_HEIGHT = 40
const TOOL_ROW_HEIGHT = 18
const GUTTER_WIDTH = 200
const HEADER_HEIGHT = 30
const PADDING_X = 20
const PADDING_Y = 10

/** Idle gaps at least this long get a dashed "skipped" marker on the axis. */
const GAP_LABEL_THRESHOLD_MS = 1000

function formatMs(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`
	return `${(ms / 1000).toFixed(1)}s`
}

/** Round up to the nearest "nice" axis step (1/2/2.5/5 × 10ⁿ ms). */
function niceTimeStep(raw: number): number {
	if (!(raw > 0)) return 1000
	const pow = Math.pow(10, Math.floor(Math.log10(raw)))
	const norm = raw / pow
	const mult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10
	return mult * pow
}

function formatTokens(n: number): string {
	if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
	return String(n)
}

interface TaskTraceViewProps {
	/** All ShoferMessages for the currently focused task. */
	messages: ShoferMessage[]
}

/**
 * SVG waterfall timeline showing API requests and nested tool executions
 * for a single task.
 *
 * Each API request renders as a horizontal bar with nested tool sub-bars.
 * Colours distinguish success (blue/orange) from errors (red/maroon).
 * Hover reveals a tooltip with full metadata.
 *
 * Pan: drag on background. Zoom: mousewheel.
 */
const TaskTraceView: React.FC<TaskTraceViewProps> = ({ messages }) => {
	const rows = useMemo(() => parseTraceRows(messages), [messages])

	const svgRef = useRef<SVGSVGElement>(null)
	const [hoveredSpan, setHoveredSpan] = useState<{
		x: number
		y: number
		content: string
	} | null>(null)
	const [viewBox, setViewBox] = useState({ x: 0, y: 0, w: 800, h: 400 })

	// Collapsed-time model: a task is only "running" while a request cycle (the
	// request span + its tool spans) is active. The idle gaps between cycles —
	// approval waits, and especially the long pauses between re-prompts of the
	// same task — carry no information and dominate the axis, so we remove them.
	// Each row's [startOffsetMs, endOffsetMs] is one active interval; we merge
	// overlaps and lay the intervals end-to-end on a compressed axis whose length
	// is the total running time. Gaps above a threshold get a dashed marker.
	const timeline = useMemo(() => {
		const raw = rows.map((r) => ({ start: r.startOffsetMs, end: r.endOffsetMs })).sort((a, b) => a.start - b.start)
		const merged: { start: number; end: number }[] = []
		for (const iv of raw) {
			const last = merged[merged.length - 1]
			if (last && iv.start <= last.end) {
				last.end = Math.max(last.end, iv.end)
			} else {
				merged.push({ start: iv.start, end: iv.end })
			}
		}
		let cum = 0
		const intervals = merged.map((iv) => {
			const compStart = cum
			cum += iv.end - iv.start
			return { start: iv.start, end: iv.end, compStart }
		})
		const gaps: { comp: number; skippedMs: number }[] = []
		for (let i = 0; i < merged.length - 1; i++) {
			const skipped = merged[i + 1].start - merged[i].end
			if (skipped >= GAP_LABEL_THRESHOLD_MS) {
				gaps.push({ comp: intervals[i].compStart + (merged[i].end - merged[i].start), skippedMs: skipped })
			}
		}
		return { intervals, totalActive: cum > 0 ? cum : 1, gaps }
	}, [rows])

	// Map a raw offset onto the compressed (running-only) axis.
	const compress = useCallback(
		(offset: number) => {
			const ivs = timeline.intervals
			if (ivs.length === 0) return 0
			for (const iv of ivs) {
				if (offset < iv.start) return iv.compStart // in a collapsed gap
				if (offset <= iv.end) return iv.compStart + (offset - iv.start)
			}
			const last = ivs[ivs.length - 1]
			return last.compStart + (last.end - last.start)
		},
		[timeline],
	)

	const totalHeight = useMemo(() => {
		let h = HEADER_HEIGHT
		for (const r of rows) {
			h += ROW_HEIGHT + r.payload.toolSpans.length * TOOL_ROW_HEIGHT
		}
		return h + PADDING_Y * 2
	}, [rows])

	// Fit viewBox when data changes.
	useEffect(() => {
		const w = svgRef.current?.clientWidth ?? 800
		setViewBox({ x: -PADDING_X, y: 0, w: w, h: Math.max(400, totalHeight + PADDING_Y) })
	}, [totalHeight])

	// Map a compressed-axis value → SVG X coordinate.
	const compToX = useCallback(
		(comp: number) => {
			const ratio = comp / timeline.totalActive
			return GUTTER_WIDTH + PADDING_X + ratio * (viewBox.w - GUTTER_WIDTH - PADDING_X * 2)
		},
		[timeline.totalActive, viewBox.w],
	)

	// Map a raw offset → SVG X coordinate (through the collapsed axis).
	const timeToX = useCallback((offsetMs: number) => compToX(compress(offsetMs)), [compToX, compress])

	// Drag-to-pan + cursor-anchored wheel zoom (shared with the Sequence view).
	const { isPanning, zoomBy, handlers } = useSvgPanZoom(svgRef, viewBox, setViewBox, {
		noPanSelector: ".trace-bar, .tooltip-trigger",
	})

	const fitToView = useCallback(() => {
		const w = svgRef.current?.clientWidth ?? 800
		setViewBox({ x: -PADDING_X, y: 0, w, h: Math.max(400, totalHeight + PADDING_Y) })
	}, [totalHeight])

	if (rows.length === 0) {
		return (
			<div className="flex items-center justify-center h-full p-6">
				<p className="text-sm" style={{ color: COLOURS.muted }}>
					No API requests recorded yet. Start a task to see the waterfall.
				</p>
			</div>
		)
	}

	// Compute Y positions.
	let yCursor = HEADER_HEIGHT
	const rowY: number[] = []
	for (const r of rows) {
		rowY.push(yCursor)
		yCursor += ROW_HEIGHT + r.payload.toolSpans.length * TOOL_ROW_HEIGHT
	}

	// Axis ticks live on the compressed (running-only) axis and are labelled with
	// elapsed running time, so 0 → totalActive regardless of wall-clock gaps.
	// Step is pixel-aware: pick the smallest "nice" step (1/2/2.5/5 × 10ⁿ) that
	// keeps tick labels at least ~MIN_TICK_PX apart, so they never overlap.
	const rangeMs = timeline.totalActive
	const plotW = Math.max(1, viewBox.w - GUTTER_WIDTH - PADDING_X * 2)
	const MIN_TICK_PX = 76
	const maxTicks = Math.max(2, Math.floor(plotW / MIN_TICK_PX))
	const tickStep = niceTimeStep(rangeMs / maxTicks)
	const ticks: number[] = []
	for (let t = 0; t <= rangeMs + 0.5; t += tickStep) {
		ticks.push(t)
	}

	return (
		<div className="h-full flex flex-col relative overflow-hidden" style={{ backgroundColor: COLOURS.bg }}>
			{/* Zoom controls */}
			<div className="absolute top-2 right-3 z-10 flex gap-1">
				<button
					type="button"
					className="px-2 py-0.5 text-xs rounded border"
					style={{ borderColor: COLOURS.border, color: COLOURS.fg, backgroundColor: COLOURS.bg }}
					onClick={() => zoomBy(0.8)}>
					+
				</button>
				<button
					type="button"
					className="px-2 py-0.5 text-xs rounded border"
					style={{ borderColor: COLOURS.border, color: COLOURS.fg, backgroundColor: COLOURS.bg }}
					onClick={() => zoomBy(1.25)}>
					−
				</button>
				<button
					type="button"
					className="px-2 py-0.5 text-xs rounded border"
					style={{ borderColor: COLOURS.border, color: COLOURS.fg, backgroundColor: COLOURS.bg }}
					onClick={fitToView}>
					Fit
				</button>
			</div>

			<svg
				ref={svgRef}
				viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
				className="w-full h-full cursor-grab"
				style={{ cursor: isPanning ? "grabbing" : undefined }}
				{...handlers}>
				{/* Time axis */}
				<g>
					<line
						x1={GUTTER_WIDTH}
						y1={HEADER_HEIGHT}
						x2={viewBox.w - PADDING_X}
						y2={HEADER_HEIGHT}
						stroke={COLOURS.border}
						strokeWidth={1}
					/>
					{ticks.map((t) => {
						const x = compToX(t)
						return (
							<g key={t}>
								<line
									x1={x}
									y1={HEADER_HEIGHT - 4}
									x2={x}
									y2={HEADER_HEIGHT}
									stroke={COLOURS.border}
									strokeWidth={1}
								/>
								<text
									x={x}
									y={HEADER_HEIGHT - 8}
									textAnchor="middle"
									fill={COLOURS.muted}
									fontSize={10}>
									{formatMs(t)}
								</text>
							</g>
						)
					})}
					{/* Collapsed-gap markers: dashed line + skipped idle duration. */}
					{timeline.gaps.map((gap, gi) => {
						const x = compToX(gap.comp)
						return (
							<g key={`gap-${gi}`}>
								<line
									x1={x}
									y1={HEADER_HEIGHT}
									x2={x}
									y2={viewBox.h}
									stroke={COLOURS.muted}
									strokeWidth={1}
									strokeDasharray="2 3"
									opacity={0.5}
								/>
								<text
									x={x}
									y={HEADER_HEIGHT - 8}
									textAnchor="middle"
									fill={COLOURS.muted}
									fontSize={9}
									opacity={0.8}>
									⋯ {formatMs(gap.skippedMs)}
								</text>
							</g>
						)
					})}
				</g>

				{/* Rows */}
				{rows.map((row, ri) => {
					const y = rowY[ri]
					const reqX = timeToX(row.payload.startedAtOffsetMs)
					const reqW = Math.max(timeToX(row.payload.finishedAtOffsetMs) - reqX, 4)
					const isError = row.payload.status === "error"
					const isCancelled = row.payload.status === "cancelled"

					// Phase boundaries: waiting (TTFB) → thinking (reasoning) → streaming.
					const p = row.payload
					const reqDur = Math.max(p.finishedAtOffsetMs - p.startedAtOffsetMs, 0)
					const ttfb = Math.min(Math.max(p.ttfbMs ?? 0, 0), reqDur)
					const genStart =
						p.genStartOffsetMs != null ? Math.min(Math.max(p.genStartOffsetMs, ttfb), reqDur) : ttfb
					const xTtfb = timeToX(p.startedAtOffsetMs + ttfb)
					const xGen = timeToX(p.startedAtOffsetMs + genStart)
					const xEnd = Math.max(timeToX(p.finishedAtOffsetMs), reqX + 4)
					const thinkingMs = genStart - ttfb

					return (
						<g key={ri}>
							{/* Row background */}
							<rect
								x={0}
								y={y}
								width={viewBox.w}
								height={ROW_HEIGHT + row.payload.toolSpans.length * TOOL_ROW_HEIGHT}
								fill={ri % 2 === 0 ? "transparent" : "rgba(128,128,128,0.03)"}
							/>

							{/* Gutter */}
							<g>
								<rect x={0} y={y} width={GUTTER_WIDTH} height={ROW_HEIGHT} fill="transparent" />
								<text x={4} y={y + 14} fill={COLOURS.fg} fontSize={11} fontFamily="monospace">
									{row.payload.model}
								</text>
								<text x={4} y={y + 28} fill={COLOURS.muted} fontSize={10}>
									{formatTokens(row.payload.tokensIn)}↑ {formatTokens(row.payload.tokensOut)}↓ · $
									{row.payload.cost.toFixed(3)}
								</text>
								{isError && (
									<text
										x={GUTTER_WIDTH - 4}
										y={y + 14}
										fill={COLOURS.requestBarError}
										fontSize={10}
										textAnchor="end">
										ERR
									</text>
								)}
								{isCancelled && (
									<text
										x={GUTTER_WIDTH - 4}
										y={y + 14}
										fill={COLOURS.muted}
										fontSize={10}
										textAnchor="end">
										⨯
									</text>
								)}
							</g>

							{/* Request bar — phase segments (waiting / thinking / streaming) */}
							{isError || isCancelled ? (
								<rect
									x={reqX}
									y={y + 4}
									width={reqW}
									height={12}
									rx={2}
									fill={isError ? COLOURS.requestBarError : COLOURS.muted}
									opacity={0.7}
								/>
							) : (
								<>
									{xTtfb > reqX + 0.3 && (
										<rect
											x={reqX}
											y={y + 4}
											width={xTtfb - reqX}
											height={12}
											fill={COLOURS.phaseWaiting}
										/>
									)}
									{xGen > xTtfb + 0.3 && (
										<rect
											x={xTtfb}
											y={y + 4}
											width={xGen - xTtfb}
											height={12}
											fill={COLOURS.phaseThinking}
										/>
									)}
									{xEnd > xGen + 0.3 && (
										<rect
											x={xGen}
											y={y + 4}
											width={xEnd - xGen}
											height={12}
											fill={COLOURS.phaseStreaming}
										/>
									)}
								</>
							)}
							{/* Transparent hover target spanning the whole request bar */}
							<rect
								className="trace-bar"
								x={reqX}
								y={y + 4}
								width={reqW}
								height={12}
								rx={2}
								fill="transparent"
								style={{ cursor: "pointer" }}
								onMouseEnter={(e) => {
									const rect = svgRef.current?.getBoundingClientRect()
									if (!rect) return
									setHoveredSpan({
										x: e.clientX,
										y: e.clientY,
										content: [
											`Request #${p.requestIndex} — ${p.model} (${p.apiProtocol})`,
											`Retry #${p.retryAttempt}`,
											`TTFB: ${p.ttfbMs != null ? formatMs(p.ttfbMs) : "n/a"}`,
											`${thinkingMs > 1 ? `Thinking: ${formatMs(thinkingMs)}` : ""}`,
											`Duration: ${formatMs(p.finishedAtOffsetMs - p.startedAtOffsetMs)}`,
											`${p.actualModel ? `Model: ${p.actualModel}` : ""}`,
											`${p.attempts != null ? `Attempts: ${p.attempts}` : ""}`,
											`${p.responseError ? `Error: ${p.responseError}` : ""}`,
											`${p.error ? `Error: ${p.error.message}` : ""}`,
										]
											.filter(Boolean)
											.join("\n"),
									})
								}}
								onMouseLeave={() => setHoveredSpan(null)}
							/>

							{/* Tool sub-bars */}
							{row.payload.toolSpans.map((ts: ToolSpan, ti: number) => {
								const toolY = y + ROW_HEIGHT + ti * TOOL_ROW_HEIGHT
								const tX = timeToX(ts.startedAtOffsetMs)
								const tW = Math.max(timeToX(ts.finishedAtOffsetMs) - tX, 3)
								const toolError = ts.isError
								// sleep → "Sleeping" (yellow); blocking inter-task tools →
								// "Waiting for task" (cyan); everything else → tool exec (orange).
								const toolSleeps = ts.toolName === "sleep"
								const toolWaits =
									!toolSleeps && (ts.waitsForTask === true || ts.toolName === "wait_for_task")
								const toolMcp = !toolSleeps && !toolWaits && ts.toolName.startsWith("mcp:")
								const toolFill = toolError
									? COLOURS.toolBarError
									: toolSleeps
										? COLOURS.toolBarSleep
										: toolWaits
											? COLOURS.toolBarWait
											: toolMcp
												? COLOURS.toolBarMcp
												: COLOURS.toolBar

								return (
									<g key={ti}>
										{/* Tool name in the gutter — the action taken in this lane */}
										<text
											x={20}
											y={toolY + TOOL_ROW_HEIGHT / 2 + 3}
											fill={toolError ? COLOURS.toolBarError : COLOURS.muted}
											fontSize={9}
											fontFamily="monospace">
											<title>{ts.toolName}</title>
											{ts.toolName.length > 24 ? `${ts.toolName.slice(0, 23)}…` : ts.toolName}
										</text>
										<rect
											className="trace-bar"
											x={tX}
											y={toolY + 2}
											width={tW}
											height={TOOL_ROW_HEIGHT - 4}
											rx={2}
											fill={toolFill}
											opacity={0.8}
											style={{ cursor: "pointer" }}
											onMouseEnter={(e) => {
												const rect = svgRef.current?.getBoundingClientRect()
												if (!rect) return
												setHoveredSpan({
													x: e.clientX,
													y: e.clientY,
													content: [
														ts.toolName,
														`Duration: ${formatMs(ts.finishedAtOffsetMs - ts.startedAtOffsetMs)}`,
														`${ts.resultSizeChars != null ? `Result: ${ts.resultSizeChars} chars` : ""}`,
														`${ts.spawnedTaskId ? `→ ${ts.spawnedTaskId}` : ""}`,
														`${toolError ? "ERROR" : ""}`,
													]
														.filter(Boolean)
														.join("\n"),
												})
											}}
											onMouseLeave={() => setHoveredSpan(null)}
										/>
									</g>
								)
							})}

							{/* Request label on bar */}
							<text
								x={reqX + 4}
								y={y + 13}
								fill="white"
								fontSize={9}
								fontFamily="monospace"
								opacity={0.9}>
								{formatMs(row.payload.finishedAtOffsetMs - row.payload.startedAtOffsetMs)}
							</text>
						</g>
					)
				})}
			</svg>

			{/* Tooltip */}
			{hoveredSpan && (
				<div
					className="fixed z-50 px-2 py-1 text-xs rounded shadow-lg pointer-events-none whitespace-pre font-mono"
					style={{
						left: hoveredSpan.x + 10,
						top: hoveredSpan.y - 10,
						backgroundColor: "var(--vscode-editorWidget-background)",
						border: "1px solid var(--vscode-widget-border)",
						color: "var(--vscode-foreground)",
					}}>
					{hoveredSpan.content}
				</div>
			)}
		</div>
	)
}

export default TaskTraceView
