import React, { useMemo, useRef, useState, useCallback, useEffect } from "react"
import type { ShoferMessage, ApiRequestFinishedPayload, ToolSpan } from "@shofer/types"

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
	toolBar: "var(--vscode-charts-orange, #f97316)",
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

function formatMs(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`
	return `${(ms / 1000).toFixed(1)}s`
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
	const [isPanning, setIsPanning] = useState(false)
	const panStart = useRef({ x: 0, y: 0, vbX: 0, vbY: 0 })

	// Compute total time range.
	const { minOffset, maxOffset } = useMemo(() => {
		if (rows.length === 0) return { minOffset: 0, maxOffset: 1 }
		let min = Infinity
		let max = -Infinity
		for (const r of rows) {
			if (r.startOffsetMs < min) min = r.startOffsetMs
			if (r.endOffsetMs > max) max = r.endOffsetMs
		}
		return { minOffset: min, maxOffset: max === min ? max + 1 : max }
	}, [rows])

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

	// Map offset → SVG X coordinate.
	const timeToX = useCallback(
		(offsetMs: number) => {
			const ratio = (offsetMs - minOffset) / (maxOffset - minOffset)
			return GUTTER_WIDTH + PADDING_X + ratio * (viewBox.w - GUTTER_WIDTH - PADDING_X * 2)
		},
		[minOffset, maxOffset, viewBox.w],
	)

	// Pan handlers.
	const handleMouseDown = useCallback(
		(e: React.MouseEvent<SVGSVGElement>) => {
			if ((e.target as Element).closest?.(".trace-bar, .tooltip-trigger")) return
			setIsPanning(true)
			panStart.current = { x: e.clientX, y: e.clientY, vbX: viewBox.x, vbY: viewBox.y }
		},
		[viewBox],
	)

	const handleMouseMove = useCallback(
		(e: React.MouseEvent<SVGSVGElement>) => {
			if (!isPanning) return
			const dx = e.clientX - panStart.current.x
			const dy = e.clientY - panStart.current.y
			setViewBox((vb) => ({
				...vb,
				x: panStart.current.vbX - dx,
				y: panStart.current.vbY - dy,
			}))
		},
		[isPanning],
	)

	const handleMouseUp = useCallback(() => setIsPanning(false), [])

	// Zoom via mousewheel.
	const handleWheel = useCallback((e: React.WheelEvent<SVGSVGElement>) => {
		e.preventDefault()
		const scale = e.deltaY > 0 ? 1.15 : 0.87
		setViewBox((vb) => {
			const cx = vb.x + vb.w / 2
			const cy = vb.y + vb.h / 2
			const nw = vb.w * scale
			const nh = vb.h * scale
			return {
				x: cx - nw / 2,
				y: cy - nh / 2,
				w: nw,
				h: nh,
			}
		})
	}, [])

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

	// Grid tick count.
	const rangeMs = maxOffset - minOffset
	const tickStep =
		rangeMs < 1000 ? 200 : rangeMs < 5000 ? 500 : rangeMs < 20000 ? 1000 : rangeMs < 60000 ? 5000 : 10000
	const ticks: number[] = []
	for (let t = Math.ceil(minOffset / tickStep) * tickStep; t <= maxOffset; t += tickStep) {
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
					onClick={() => setViewBox((vb) => ({ ...vb, w: vb.w * 0.8, h: vb.h * 0.8 }))}>
					+
				</button>
				<button
					type="button"
					className="px-2 py-0.5 text-xs rounded border"
					style={{ borderColor: COLOURS.border, color: COLOURS.fg, backgroundColor: COLOURS.bg }}
					onClick={() => setViewBox((vb) => ({ ...vb, w: vb.w * 1.25, h: vb.h * 1.25 }))}>
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
				onMouseDown={handleMouseDown}
				onMouseMove={handleMouseMove}
				onMouseUp={handleMouseUp}
				onMouseLeave={handleMouseUp}
				onWheel={handleWheel}>
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
						const x = timeToX(t)
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
									{formatMs(t - minOffset)}
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
									[{row.payload.requestIndex}] {row.payload.model}
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

							{/* Request bar */}
							<rect
								className="trace-bar"
								x={reqX}
								y={y + 4}
								width={reqW}
								height={12}
								rx={2}
								fill={
									isError ? COLOURS.requestBarError : isCancelled ? COLOURS.muted : COLOURS.requestBar
								}
								opacity={isError || isCancelled ? 0.7 : 1}
								style={{ cursor: "pointer" }}
								onMouseEnter={(e) => {
									const rect = svgRef.current?.getBoundingClientRect()
									if (!rect) return
									const scaleX = viewBox.w / rect.width
									setHoveredSpan({
										x: e.clientX,
										y: e.clientY,
										content: [
											`${row.payload.model} (${row.payload.apiProtocol})`,
											`Retry #${row.payload.retryAttempt}`,
											`TTFB: ${row.payload.ttfbMs != null ? formatMs(row.payload.ttfbMs) : "n/a"}`,
											`Duration: ${formatMs(row.payload.finishedAtOffsetMs - row.payload.startedAtOffsetMs)}`,
											`${row.payload.actualModel ? `Actual: ${row.payload.actualModel}` : ""}`,
											`${row.payload.attempts != null ? `Attempts: ${row.payload.attempts}` : ""}`,
											`${row.payload.responseError ? `Error: ${row.payload.responseError}` : ""}`,
											`${row.payload.error ? `Error: ${row.payload.error.message}` : ""}`,
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

								return (
									<rect
										key={ti}
										className="trace-bar"
										x={tX}
										y={toolY + 2}
										width={tW}
										height={TOOL_ROW_HEIGHT - 4}
										rx={2}
										fill={toolError ? COLOURS.toolBarError : COLOURS.toolBar}
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
