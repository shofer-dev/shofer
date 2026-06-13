import React, { useMemo } from "react"
import type { HistoryItem, TaskState, TaskLifecycle, CompletionRating } from "@shofer/types"
import { LIFECYCLE_VISUAL, RATING_VISUAL, getTaskDisplayName } from "./TaskSelector"
import { cn } from "@src/lib/utils"
import { vscode } from "@src/utils/vscode"

/**
 * A node in the flattened task tree used for rendering.
 *
 * Mirrors the same structure in TaskSelector.tsx so the tree view is
 * visually consistent with the dropdown hierarchy.
 */
interface TaskTreeNode {
	item: HistoryItem
	depth: number
	isLastSibling: boolean
	ancestorIsLast: boolean[]
}

/**
 * Builds a flattened DFS-pre-order list of TaskTreeNode from a flat
 * HistoryItem array. Siblings are sorted descending by creation time
 * (newest first), matching TaskSelector's ordering.
 */
function buildFlatTree(taskHistory: HistoryItem[]): TaskTreeNode[] {
	const byId = new Map(taskHistory.map((i) => [i.id, i]))

	const sortDesc = (a: HistoryItem, b: HistoryItem) => (b.createdAt ?? b.ts) - (a.createdAt ?? a.ts)

	// Bucket children by parent id in a single O(n) pass instead of re-scanning
	// the whole array for every node, which made construction O(n²). [perf H28]
	const childrenByParent = new Map<string, HistoryItem[]>()
	const roots: HistoryItem[] = []
	for (const item of taskHistory) {
		if (item.parentTaskId && byId.has(item.parentTaskId)) {
			const siblings = childrenByParent.get(item.parentTaskId)
			if (siblings) {
				siblings.push(item)
			} else {
				childrenByParent.set(item.parentTaskId, [item])
			}
		} else {
			roots.push(item)
		}
	}

	roots.sort(sortDesc)
	for (const siblings of childrenByParent.values()) {
		siblings.sort(sortDesc)
	}

	const result: TaskTreeNode[] = []

	function visit(item: HistoryItem, depth: number, isLastSibling: boolean, ancestorIsLast: boolean[]) {
		result.push({ item, depth, isLastSibling, ancestorIsLast })

		const children = childrenByParent.get(item.id) ?? []

		children.forEach((child, ci) => {
			visit(child, depth + 1, ci === children.length - 1, [...ancestorIsLast, isLastSibling])
		})
	}

	roots.forEach((root, i) => visit(root, 0, i === roots.length - 1, []))

	return result
}

/**
 * Resolves the visual icon and color for a given task state.
 */
function resolveStateVisual(state: TaskState | undefined): {
	icon: string
	iconColor: string
	pulse: boolean
} {
	const lifecycle: TaskLifecycle = state?.lifecycle ?? "idle"
	const rating: CompletionRating | undefined = state?.rating

	// Completed with rating: use the rating overlay icon.
	if (lifecycle === "completed" && rating) {
		const ratingVis = RATING_VISUAL[rating]
		if (ratingVis) {
			return { icon: ratingVis.icon, iconColor: ratingVis.iconColor, pulse: false }
		}
	}

	// Fall back to lifecycle visual.
	const lifecycleVis = LIFECYCLE_VISUAL[lifecycle]
	return {
		icon: lifecycleVis?.icon ?? "codicon-circle-large-outline",
		iconColor: lifecycleVis?.iconColor ?? "text-[var(--vscode-descriptionForeground)]",
		pulse: lifecycleVis?.pulse ?? false,
	}
}

/**
 * Formats a duration in milliseconds into a human-readable string.
 */
function formatDurationMs(ms: number): string {
	const totalSec = Math.round(ms / 1000)
	if (totalSec < 60) return `${totalSec}s`
	const mins = Math.floor(totalSec / 60)
	const secs = totalSec % 60
	return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`
}

/**
 * Formats token count compactly.
 */
function formatTokens(n: number): string {
	if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
	return String(n)
}

const STATE_DOT_COLORS: Record<string, string> = {
	running: "bg-[var(--vscode-charts-blue,#3b82f6)]",
	waiting_input: "bg-[var(--vscode-charts-yellow,#eab308)]",
	waiting: "bg-[var(--vscode-charts-blue,#3b82f6)]",
	completed: "bg-[var(--vscode-charts-green,#16a34a)]",
	error: "bg-[var(--vscode-errorForeground,#ef4444)]",
	paused: "bg-[var(--vscode-charts-orange,#f97316)]",
	idle: "bg-[var(--vscode-descriptionForeground)]",
}

/**
 * A single row in the task tree.
 */
function TaskTreeRow({ node }: { node: TaskTreeNode }) {
	const { item, depth, isLastSibling, ancestorIsLast } = node
	const state = resolveStateVisual(item.taskState)
	const dotColor = STATE_DOT_COLORS[item.taskState?.lifecycle ?? "idle"] ?? STATE_DOT_COLORS.idle

	const treeConnectors: React.ReactNode[] = []

	// Draw ancestor continuation lines (│).
	for (let i = 0; i < depth; i++) {
		const showLine = !ancestorIsLast[i]
		treeConnectors.push(
			<span
				key={`line-${i}`}
				className="inline-block text-[var(--vscode-descriptionForeground)] opacity-30 select-none w-4 text-center">
				{showLine ? "│" : " "}
			</span>,
		)
	}

	// Draw the branch connector for this node.
	if (depth > 0) {
		const connector = isLastSibling ? "└─" : "├─"
		treeConnectors.push(
			<span
				key="branch"
				className="inline-block text-[var(--vscode-descriptionForeground)] opacity-40 select-none w-4 text-center">
				{connector}
			</span>,
		)
	}

	return (
		<div
			className="flex items-center gap-1.5 py-1 px-2 text-xs hover:bg-[var(--vscode-list-hoverBackground)] rounded-sm select-none cursor-pointer"
			style={{ paddingLeft: `${depth === 0 ? 4 : 0}px` }}
			onClick={() => vscode.postMessage({ type: "focusParallelTask", taskId: item.id })}>
			{/* Tree connectors */}
			{treeConnectors.length > 0 && (
				<span className="inline-flex items-center whitespace-pre font-mono text-[10px] leading-none">
					{treeConnectors}
				</span>
			)}

			{/* State dot */}
			<span
				className={cn(
					"inline-block w-2 h-2 rounded-full flex-shrink-0",
					dotColor,
					state.pulse && "animate-pulse",
				)}
			/>

			{/* Task title (set_task_title / name, falling back to the prompt) */}
			<span className="truncate font-medium text-[var(--vscode-foreground)]" title={item.task}>
				{getTaskDisplayName(item)}
			</span>

			{/* Mode badge */}
			{item.mode && (
				<span className="text-[10px] px-1 py-px rounded bg-[var(--vscode-badge-background)] text-[var(--vscode-badge-foreground)] opacity-70 flex-shrink-0">
					{item.mode}
				</span>
			)}

			{/* Spacer */}
			<span className="flex-1" />

			{/* Active time */}
			{item.activeTimeMs !== undefined && item.activeTimeMs > 0 && (
				<span className="text-[var(--vscode-descriptionForeground)] opacity-60 flex-shrink-0">
					{formatDurationMs(item.activeTimeMs)}
				</span>
			)}

			{/* Tokens */}
			{(item.tokensIn > 0 || item.tokensOut > 0) && (
				<span className="text-[var(--vscode-descriptionForeground)] opacity-50 flex-shrink-0 tabular-nums">
					{formatTokens(item.tokensIn + item.tokensOut)} tok
				</span>
			)}

			{/* Cost */}
			{item.totalCost > 0 && (
				<span className="text-[var(--vscode-descriptionForeground)] opacity-50 flex-shrink-0 tabular-nums">
					${item.totalCost.toFixed(2)}
				</span>
			)}
		</div>
	)
}

export interface TaskTreeViewProps {
	taskHistory: HistoryItem[]
	/**
	 * Effective root task id of the currently focused task. When provided, the
	 * tree is scoped to the tasks sharing this root (the design's "all tasks
	 * under the same rootTaskId"). When omitted, the full forest is rendered.
	 */
	rootTaskId?: string
}

/**
 * Tree view showing all tasks sharing a common root, rendering the same
 * parent-child hierarchy as TaskSelector's dropdown. Read-only — no task
 * switching, pinning, or archiving.
 *
 * Rows show: state dot, [number], title, mode badge, active time, tokens, cost.
 */
const TaskTreeView: React.FC<TaskTreeViewProps> = ({ taskHistory, rootTaskId }) => {
	// Scope to the focused task's tree: keep items whose effective root
	// (rootTaskId, falling back to the item's own id for root tasks) matches.
	const scoped = useMemo(() => {
		if (!rootTaskId) return taskHistory
		return taskHistory.filter((i) => (i.rootTaskId ?? i.id) === rootTaskId)
	}, [taskHistory, rootTaskId])

	const tree = useMemo(() => buildFlatTree(scoped), [scoped])

	if (tree.length === 0) {
		return (
			<div className="flex items-center justify-center h-full p-6">
				<p className="text-sm text-[var(--vscode-descriptionForeground)]">No tasks in history.</p>
			</div>
		)
	}

	return (
		<div className="h-full overflow-y-auto py-2 font-mono">
			{tree.map((node) => (
				<TaskTreeRow key={node.item.id} node={node} />
			))}
		</div>
	)
}

export default TaskTreeView
