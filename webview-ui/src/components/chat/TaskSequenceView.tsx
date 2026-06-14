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
	// Neutral grey, not the failure-red: a cancel is a deliberate stop, and red
	// is reserved for errored interactions (`isError`) so the two stay distinct.
	cancel: { label: "cancel", color: "var(--vscode-descriptionForeground, #9ca3af)" },
	question: { label: "question", color: "var(--vscode-charts-yellow, #eab308)" },
}

// ── Layout ──

const COL_WIDTH = 200
const LEFT_PAD = 30
const HEADER_H = 64
const ROW_H = 48
const BOTTOM_PAD = 28
const HBOX_W = COL_WIDTH - 48 // lifeline header box width
const ACT_W = 8 // activation box width
const ACT_H = 30 // activation box height
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

function formatMs(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`
	const s = ms / 1000
	if (s < 60) return `${s.toFixed(1)}s`
	return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`
}

const TaskSequenceView: React.FC<TaskSequenceViewProps> = ({ rootTaskId, taskHistory }) => {
	const [interactions, setInteractions] = useState<TaskInteractionPayload[]>([])
	const [loading, setLoading] = useState(true)
	const [tooltip, setTooltip] = useState<{ x: number; y: number; content: string } | null>(null)

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

	// Build the ordered set of lifelines: ordered by task *creation* time, root
	// leftmost and the newest task rightmost (like a software sequence diagram).
	//
	// Ordering must use a stable creation signal. `HistoryItem.ts` tracks *last
	// activity*, not creation, so it changes every time a task is touched or the
	// tab is revisited — keying on it reordered the lifelines between visits.
	// We key on `createdAt`; when a task lacks a stored `createdAt` (or isn't in
	// history at all), we fall back to an immutable proxy: the root's creation
	// time plus the earliest `rootOffsetMs` the task appears at in the (sorted,
	// session-stable) interaction stream — i.e. roughly its spawn moment.
	const { lifelines, columnOf, titleOf } = useMemo(() => {
		const inRoot = taskHistory.filter((i) => (i.rootTaskId ?? i.id) === rootTaskId)

		const createdAtOf = new Map<string, number>()
		const title = new Map<string, string>()
		for (const item of inRoot) {
			if (item.createdAt != null) createdAtOf.set(item.id, item.createdAt)
			title.set(item.id, getTaskDisplayName(item))
		}

		const rootItem = inRoot.find((i) => i.id === rootTaskId)
		const rootCreatedAt = rootItem?.createdAt ?? rootItem?.ts ?? 0
		const birthOffset = new Map<string, number>()
		for (const ix of interactions) {
			for (const id of [ix.fromTaskId, ix.toTaskId]) {
				if (!id) continue
				const prev = birthOffset.get(id)
				if (prev === undefined || ix.rootOffsetMs < prev) birthOffset.set(id, ix.rootOffsetMs)
			}
		}

		const allIds = new Set<string>()
		for (const item of inRoot) allIds.add(item.id)
		for (const ix of interactions) {
			if (ix.fromTaskId) allIds.add(ix.fromTaskId)
			if (ix.toTaskId) allIds.add(ix.toTaskId)
		}

		// Creation key on a single epoch-ms scale.
		const keyOf = (id: string): number => {
			const c = createdAtOf.get(id)
			if (c != null) return c
			const b = birthOffset.get(id)
			if (b != null) return rootCreatedAt + b
			return Number.MAX_SAFE_INTEGER // unknown creation → park on the right
		}

		const ids = Array.from(allIds).sort((a, b) => {
			if (a === rootTaskId) return -1
			if (b === rootTaskId) return 1
			// `id` breaks exact-time ties so the order is fully deterministic.
			return keyOf(a) - keyOf(b) || (a < b ? -1 : a > b ? 1 : 0)
		})

		for (const id of ids) if (!title.has(id)) title.set(id, id.slice(0, 8))
		const col = new Map<string, number>()
		ids.forEach((id, i) => col.set(id, i))
		return { lifelines: ids, columnOf: col, titleOf: title }
	}, [taskHistory, rootTaskId, interactions])

	// Arrows run top→bottom in chronological order (newest at the bottom). Sort a
	// copy by the immutable `rootOffsetMs` so the order is stable across visits
	// regardless of the order the host returned them in.
	const orderedInteractions = useMemo(
		() => [...interactions].sort((a, b) => a.rootOffsetMs - b.rootOffsetMs),
		[interactions],
	)

	const colX = (id: string | undefined): number | null => {
		if (!id) return null
		const i = columnOf.get(id)
		return i === undefined ? null : LEFT_PAD + i * COL_WIDTH + COL_WIDTH / 2
	}

	const width = Math.max(lifelines.length * COL_WIDTH + LEFT_PAD * 2, 240)
	const height = HEADER_H + orderedInteractions.length * ROW_H + BOTTOM_PAD

	// Drag-to-pan + cursor-anchored wheel zoom (shared with the Trace view). The
	// viewBox starts fitted to the content and refits when the content box changes.
	const svgRef = useRef<SVGSVGElement>(null)
	const fitBox = useCallback(
		(): ViewBox => ({ x: -VIEW_PAD, y: -VIEW_PAD, w: width + VIEW_PAD * 2, h: height + VIEW_PAD * 2 }),
		[width, height],
	)
	const [viewBox, setViewBox] = useState<ViewBox>(fitBox)
	useEffect(() => setViewBox(fitBox()), [fitBox])
	const { isPanning, zoomBy, handlers } = useSvgPanZoom(svgRef, viewBox, setViewBox, {
		noPanSelector: ".seq-arrow",
	})

	if (!rootTaskId || loading || interactions.length === 0) {
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
			{/* Legend — arrow kinds (colour) plus the two line-style encodings. */}
			<div className="flex flex-wrap gap-x-3 gap-y-1 px-2 py-1.5 text-[10px] flex-shrink-0">
				{Object.values(KIND_META).map((m) => (
					<span key={m.label} className="flex items-center gap-1 text-[var(--vscode-descriptionForeground)]">
						<span className="inline-block w-2.5 h-0.5" style={{ backgroundColor: m.color }} />
						{m.label}
					</span>
				))}
				<span className="flex items-center gap-1 text-[var(--vscode-descriptionForeground)]">
					<span
						className="inline-block w-2.5 h-0 border-t border-dotted"
						style={{ borderColor: "var(--vscode-widget-border)" }}
					/>
					Lifeline (task)
				</span>
				<span className="flex items-center gap-1 text-[var(--vscode-descriptionForeground)]">
					<span
						className="inline-block w-2.5 h-0 border-t border-dashed"
						style={{ borderColor: "var(--vscode-descriptionForeground)" }}
					/>
					Async
				</span>
				<span className="flex items-center gap-1 text-[var(--vscode-descriptionForeground)]">
					<span
						className="inline-block w-2.5 h-0.5"
						style={{ backgroundColor: "var(--vscode-errorForeground, #ef4444)" }}
					/>
					Failed
				</span>
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
					{/* Arrowhead markers — one per kind colour, plus error. */}
					<defs>
						{Object.entries(KIND_META).map(([key, m]) => (
							<marker
								key={key}
								id={`seqah-${key}`}
								markerWidth={10}
								markerHeight={10}
								refX={8}
								refY={5}
								orient="auto"
								markerUnits="userSpaceOnUse">
								<path d="M0,1 L9,5 L0,9 Z" fill={m.color} />
							</marker>
						))}
						<marker
							id="seqah-error"
							markerWidth={10}
							markerHeight={10}
							refX={8}
							refY={5}
							orient="auto"
							markerUnits="userSpaceOnUse">
							<path d="M0,1 L9,5 L0,9 Z" fill="var(--vscode-errorForeground, #ef4444)" />
						</marker>
					</defs>

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
									stroke="var(--vscode-widget-border)"
									strokeWidth={1.5}
									strokeDasharray="4 4"
								/>
								<rect
									x={x - HBOX_W / 2}
									y={18}
									width={HBOX_W}
									height={30}
									rx={5}
									fill="var(--vscode-editorWidget-background)"
									stroke="var(--vscode-widget-border)"
								/>
								<text
									x={x}
									y={37}
									textAnchor="middle"
									fontSize={11}
									fontWeight={600}
									fill="var(--vscode-foreground)">
									<title>{titleOf.get(id)}</title>
									{truncate(titleOf.get(id) ?? id, 24)}
								</text>
							</g>
						)
					})}

					{/* Interaction arrows */}
					{orderedInteractions.map((ix, i) => {
						const meta = KIND_META[ix.kind]
						const y = HEADER_H + i * ROW_H + ROW_H / 2
						const fromX = colX(ix.fromTaskId)
						const toX = colX(ix.toTaskId)
						// Colour encodes outcome (red = failed); dashing encodes async
						// (a non-blocking call the caller didn't wait on).
						const color = ix.isError ? "var(--vscode-errorForeground, #ef4444)" : meta.color
						const markerId = ix.isError ? "seqah-error" : `seqah-${ix.kind}`
						const dash = ix.async ? "5 3" : undefined
						const label = truncate(`${meta.label}${ix.label ? ": " + ix.label : ""}`, 34)

						// Hover metadata (like the Trace tooltip): kind, endpoints, the
						// time it occurred (elapsed from the root task's start), sync/async
						// and failure state.
						const fromName = titleOf.get(ix.fromTaskId) ?? ix.fromTaskId.slice(0, 8)
						const toName = ix.toTaskId ? (titleOf.get(ix.toTaskId) ?? ix.toTaskId.slice(0, 8)) : null
						const tip = [
							`${meta.label}${ix.async ? " · async" : " · sync"}${ix.isError ? " · failed" : ""}`,
							`From: ${fromName}`,
							toName ? `To: ${toName}` : null,
							`Time: t+${formatMs(ix.rootOffsetMs)}`,
							ix.label ? `Detail: ${ix.label}` : null,
						]
							.filter(Boolean)
							.join("\n")
						const hover = {
							onMouseEnter: (e: React.MouseEvent) =>
								setTooltip({ x: e.clientX, y: e.clientY, content: tip }),
							onMouseMove: (e: React.MouseEvent) =>
								setTooltip({ x: e.clientX, y: e.clientY, content: tip }),
							onMouseLeave: () => setTooltip(null),
						}

						// Self / unresolved target → a short stub on the source lifeline.
						if (fromX === null || toX === null || fromX === toX) {
							const x = fromX ?? toX
							if (x === null) return null
							return (
								<g key={i}>
									<rect
										x={x - ACT_W / 2}
										y={y - ACT_H / 2}
										width={ACT_W}
										height={ACT_H}
										rx={2}
										fill={color}
										opacity={0.16}
									/>
									<line
										x1={x}
										y1={y}
										x2={x + 30}
										y2={y}
										stroke={color}
										strokeWidth={2}
										strokeLinecap="round"
										strokeDasharray={dash}
										markerEnd={`url(#${markerId})`}
									/>
									<text x={x + 36} y={y + 3.5} fontSize={10} fill={color}>
										{label}
									</text>
									{/* Wide transparent hit area for hover. */}
									<line
										className="seq-arrow"
										x1={x}
										y1={y}
										x2={x + 30}
										y2={y}
										stroke="transparent"
										strokeWidth={16}
										style={{ cursor: "pointer" }}
										{...hover}
									/>
								</g>
							)
						}

						const midX = (fromX + toX) / 2
						return (
							<g key={i}>
								{/* Activation boxes on both lifelines */}
								<rect
									x={fromX - ACT_W / 2}
									y={y - ACT_H / 2}
									width={ACT_W}
									height={ACT_H}
									rx={2}
									fill={color}
									opacity={0.16}
								/>
								<rect
									x={toX - ACT_W / 2}
									y={y - ACT_H / 2}
									width={ACT_W}
									height={ACT_H}
									rx={2}
									fill={color}
									opacity={0.16}
								/>
								<line
									x1={fromX}
									y1={y}
									x2={toX}
									y2={y}
									stroke={color}
									strokeWidth={2}
									strokeLinecap="round"
									strokeDasharray={dash}
									markerEnd={`url(#${markerId})`}
								/>
								<text
									x={midX}
									y={y - 7}
									textAnchor="middle"
									fontSize={10}
									fontWeight={500}
									fill={color}>
									{label}
								</text>
								{/* Wide transparent hit area for hover. */}
								<line
									className="seq-arrow"
									x1={fromX}
									y1={y}
									x2={toX}
									y2={y}
									stroke="transparent"
									strokeWidth={16}
									style={{ cursor: "pointer" }}
									{...hover}
								/>
							</g>
						)
					})}
				</svg>

				{/* Hover tooltip (mirrors the Trace view). */}
				{tooltip && (
					<div
						className="fixed z-50 px-2 py-1 text-xs rounded shadow-lg pointer-events-none whitespace-pre"
						style={{
							left: tooltip.x + 10,
							top: tooltip.y - 10,
							backgroundColor: "var(--vscode-editorWidget-background)",
							border: "1px solid var(--vscode-widget-border)",
							color: "var(--vscode-foreground)",
						}}>
						{tooltip.content}
					</div>
				)}
			</div>
		</div>
	)
}

export default TaskSequenceView
