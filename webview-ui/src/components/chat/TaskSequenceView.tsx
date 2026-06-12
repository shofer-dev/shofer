import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { HistoryItem, TaskInteractionPayload } from "@shofer/types"
import { vscode } from "@src/utils/vscode"
import { useSvgPanZoom, type ViewBox } from "@src/hooks/useSvgPanZoom"
import { getTaskDisplayName } from "./TaskSelector"

/**
 * Sequence view — a lifeline diagram of inter-task communication across every
 * task sharing one root, analogous to the Workflow Sequence tab.
 *
 * Each task is a vertical lifeline; each `task_interaction` event (spawn,
 * message, await, answer, cancel, question) is a horizontal arrow between two
 * lifelines, drawn in chronological order. Failed interactions render as dashed
 * red arrows.
 *
 * Data is aggregated host-side (it lives in every task's ui_messages.json, not
 * just the focused task) via the `getTaskInteractions` request, keyed by root.
 */

// ── Interaction kinds → colour + arrowhead ──

const KIND_META: Record<TaskInteractionPayload["kind"], { label: string; color: string }> = {
	spawn: { label: "spawn", color: "var(--vscode-charts-orange, #f97316)" },
	message: { label: "message", color: "var(--vscode-charts-blue, #3b82f6)" },
	await: { label: "await", color: "var(--vscode-charts-purple, #a855f7)" },
	answer: { label: "answer", color: "var(--vscode-charts-cyan, #06b6d4)" },
	cancel: { label: "cancel", color: "var(--vscode-errorForeground, #ef4444)" },
	question: { label: "question", color: "var(--vscode-charts-yellow, #eab308)" },
}

// ── Layout ──

const COL_WIDTH = 150
const LEFT_PAD = 24
const HEADER_H = 56
const ROW_H = 42
const BOTTOM_PAD = 20
/** Padding around the content when fitting the pan/zoom viewBox. */
const VIEW_PAD = 16

interface TaskSequenceViewProps {
	/** Effective root task id whose tree's interactions are shown. */
	rootTaskId?: string
	/** All tasks (used to resolve lifeline titles and tree membership). */
	taskHistory: HistoryItem[]
}

function truncate(text: string, max = 26): string {
	const t = text.replace(/\s+/g, " ").trim()
	return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

const TaskSequenceView: React.FC<TaskSequenceViewProps> = ({ rootTaskId, taskHistory }) => {
	const [interactions, setInteractions] = useState<TaskInteractionPayload[]>([])
	const [loading, setLoading] = useState(true)

	// Request the aggregated interactions for this root, and refresh when the
	// focused root changes. Ignore responses for a stale root.
	useEffect(() => {
		if (!rootTaskId) {
			setInteractions([])
			setLoading(false)
			return
		}
		setLoading(true)
		const handler = (e: MessageEvent) => {
			const msg = e.data
			if (msg?.type === "taskInteractions" && msg.text === rootTaskId) {
				setInteractions(Array.isArray(msg.taskInteractions) ? msg.taskInteractions : [])
				setLoading(false)
			}
		}
		window.addEventListener("message", handler)
		vscode.postMessage({ type: "getTaskInteractions", text: rootTaskId })
		return () => window.removeEventListener("message", handler)
	}, [rootTaskId])

	// Build the ordered set of lifelines: tasks under this root (oldest first),
	// plus any interaction endpoint not present in history (appended).
	const { lifelines, columnOf, titleOf } = useMemo(() => {
		const inRoot = taskHistory
			.filter((i) => (i.rootTaskId ?? i.id) === rootTaskId)
			.sort((a, b) => (a.createdAt ?? a.ts) - (b.createdAt ?? b.ts))

		const ids: string[] = []
		const title = new Map<string, string>()
		for (const item of inRoot) {
			ids.push(item.id)
			title.set(item.id, `[${item.number}] ${getTaskDisplayName(item)}`)
		}
		for (const ix of interactions) {
			for (const id of [ix.fromTaskId, ix.toTaskId]) {
				if (id && !title.has(id)) {
					ids.push(id)
					title.set(id, id.slice(0, 8))
				}
			}
		}
		const col = new Map<string, number>()
		ids.forEach((id, i) => col.set(id, i))
		return { lifelines: ids, columnOf: col, titleOf: title }
	}, [taskHistory, rootTaskId, interactions])

	const colX = (id: string | undefined): number | null => {
		if (!id) return null
		const i = columnOf.get(id)
		return i === undefined ? null : LEFT_PAD + i * COL_WIDTH + COL_WIDTH / 2
	}

	const width = Math.max(lifelines.length * COL_WIDTH + LEFT_PAD * 2, 240)
	const height = HEADER_H + interactions.length * ROW_H + BOTTOM_PAD

	// Drag-to-pan + cursor-anchored wheel zoom (shared with the Trace view). The
	// viewBox starts fitted to the content and refits when the content box changes.
	const svgRef = useRef<SVGSVGElement>(null)
	const fitBox = useCallback(
		(): ViewBox => ({ x: -VIEW_PAD, y: -VIEW_PAD, w: width + VIEW_PAD * 2, h: height + VIEW_PAD * 2 }),
		[width, height],
	)
	const [viewBox, setViewBox] = useState<ViewBox>(fitBox)
	useEffect(() => setViewBox(fitBox()), [fitBox])
	const { isPanning, zoomBy, handlers } = useSvgPanZoom(svgRef, viewBox, setViewBox)

	if (!rootTaskId || (!loading && interactions.length === 0)) {
		return (
			<div className="flex items-center justify-center h-full p-6">
				<p className="text-sm text-[var(--vscode-descriptionForeground)]">
					{loading ? "Loading…" : "No inter-task interactions recorded for this task tree yet."}
				</p>
			</div>
		)
	}

	return (
		<div className="h-full w-full flex flex-col relative overflow-hidden">
			{/* Legend */}
			<div className="flex flex-wrap gap-x-3 gap-y-1 px-2 py-1.5 text-[10px] flex-shrink-0">
				{Object.values(KIND_META).map((m) => (
					<span key={m.label} className="flex items-center gap-1 text-[var(--vscode-descriptionForeground)]">
						<span className="inline-block w-2.5 h-0.5" style={{ backgroundColor: m.color }} />
						{m.label}
					</span>
				))}
			</div>

			{/* Pan/zoom canvas */}
			<div className="relative grow overflow-hidden">
				<div className="absolute top-2 right-3 z-10 flex gap-1">
					<button
						type="button"
						className="px-2 py-0.5 text-xs rounded border border-[var(--vscode-panel-border)] text-[var(--vscode-foreground)] bg-[var(--vscode-editor-background)]"
						onClick={() => zoomBy(0.8)}>
						+
					</button>
					<button
						type="button"
						className="px-2 py-0.5 text-xs rounded border border-[var(--vscode-panel-border)] text-[var(--vscode-foreground)] bg-[var(--vscode-editor-background)]"
						onClick={() => zoomBy(1.25)}>
						−
					</button>
					<button
						type="button"
						className="px-2 py-0.5 text-xs rounded border border-[var(--vscode-panel-border)] text-[var(--vscode-foreground)] bg-[var(--vscode-editor-background)]"
						onClick={() => setViewBox(fitBox())}>
						Fit
					</button>
				</div>

				<svg
					ref={svgRef}
					viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
					className="w-full h-full cursor-grab"
					style={{ cursor: isPanning ? "grabbing" : undefined }}
					{...handlers}>
					{/* Lifelines */}
					{lifelines.map((id) => {
						const x = colX(id)!
						return (
							<g key={id}>
								<line
									x1={x}
									y1={HEADER_H}
									x2={x}
									y2={height - BOTTOM_PAD}
									stroke="var(--vscode-panel-border)"
									strokeWidth={1}
									strokeDasharray="2 3"
								/>
								<rect
									x={x - COL_WIDTH / 2 + 6}
									y={8}
									width={COL_WIDTH - 12}
									height={HEADER_H - 18}
									rx={4}
									fill="var(--vscode-editorWidget-background)"
									stroke="var(--vscode-widget-border)"
								/>
								<text
									x={x}
									y={HEADER_H - 22}
									textAnchor="middle"
									fontSize={10}
									fill="var(--vscode-foreground)">
									<title>{titleOf.get(id)}</title>
									{truncate(titleOf.get(id) ?? id, 20)}
								</text>
							</g>
						)
					})}

					{/* Interaction arrows */}
					{interactions.map((ix, i) => {
						const meta = KIND_META[ix.kind]
						const y = HEADER_H + i * ROW_H + ROW_H / 2
						const fromX = colX(ix.fromTaskId)
						const toX = colX(ix.toTaskId)
						const color = ix.isError ? "var(--vscode-errorForeground, #ef4444)" : meta.color
						const dash = ix.isError ? "4 3" : undefined
						const label = truncate(`${meta.label}${ix.label ? ": " + ix.label : ""}`, 30)

						// Self / unresolved target → a short stub on the source lifeline.
						if (fromX === null || toX === null || fromX === toX) {
							const x = fromX ?? toX
							if (x === null) return null
							return (
								<g key={i}>
									<line
										x1={x}
										y1={y}
										x2={x + 26}
										y2={y}
										stroke={color}
										strokeWidth={1.5}
										strokeDasharray={dash}
									/>
									<circle cx={x} cy={y} r={2.5} fill={color} />
									<text x={x + 30} y={y + 3} fontSize={9} fill="var(--vscode-foreground)">
										{label}
									</text>
								</g>
							)
						}

						const dir = toX > fromX ? 1 : -1
						const midX = (fromX + toX) / 2
						return (
							<g key={i}>
								<line
									x1={fromX}
									y1={y}
									x2={toX}
									y2={y}
									stroke={color}
									strokeWidth={1.5}
									strokeDasharray={dash}
								/>
								{/* arrowhead */}
								<polygon
									points={`${toX},${y} ${toX - dir * 7},${y - 4} ${toX - dir * 7},${y + 4}`}
									fill={color}
								/>
								<text
									x={midX}
									y={y - 5}
									textAnchor="middle"
									fontSize={9}
									fill="var(--vscode-descriptionForeground)">
									<title>{ix.label || meta.label}</title>
									{label}
								</text>
							</g>
						)
					})}
				</svg>
			</div>
		</div>
	)
}

export default TaskSequenceView
