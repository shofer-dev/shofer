import { memo, useState, useCallback, useMemo, useEffect } from "react"
import { useTranslation } from "react-i18next"
import type { TFunction } from "i18next"
import { Plus, Trash2, Pencil, Check, X, Archive, Pin, PinOff, ChevronRight, ChevronDown } from "lucide-react"

import type { HistoryItem } from "@shofer/types"

import { cn } from "@src/lib/utils"
import { StandardTooltip } from "@src/components/ui"
import { vscode } from "@src/utils/vscode"
import { formatTimeAgo } from "@src/utils/format"

/**
 * A node in the flattened task tree used for rendering.
 *
 * The tree is built from `taskHistory` using `parentTaskId`. Siblings are
 * ordered by creation time (`ts`). The flat list preserves DFS pre-order so
 * that the rendered rows appear in the expected top-to-bottom order.
 */
interface TaskTreeNode {
	item: HistoryItem
	/** Nesting depth (0 = root task). */
	depth: number
	/**
	 * Whether this node is the last sibling among its parent's children.
	 * Used to decide which tree connector to draw (└ vs ├).
	 */
	isLastSibling: boolean
	/**
	 * For each ancestor level, whether that ancestor was the last sibling.
	 * Used to decide whether to draw a vertical continuation line (│) for
	 * each ancestor column.
	 */
	ancestorIsLast: boolean[]
}

/**
 * Builds a flattened DFS-pre-order list of TaskTreeNode from a flat
 * HistoryItem array.  Tasks without a known parent (or whose parentTaskId
 * is not present in the list) are treated as roots.  Siblings are sorted
 * ascending by `ts` (creation time).
 */
function buildFlatTree(taskHistory: HistoryItem[]): TaskTreeNode[] {
	const byId = new Map(taskHistory.map((i) => [i.id, i]))

	const sortDesc = (a: HistoryItem, b: HistoryItem) => (b.createdAt ?? b.ts) - (a.createdAt ?? a.ts)

	const roots = taskHistory.filter((i) => !i.parentTaskId || !byId.has(i.parentTaskId)).sort(sortDesc)

	const result: TaskTreeNode[] = []

	function visit(item: HistoryItem, depth: number, isLastSibling: boolean, ancestorIsLast: boolean[]) {
		result.push({ item, depth, isLastSibling, ancestorIsLast })

		const children = taskHistory.filter((i) => i.parentTaskId === item.id).sort(sortDesc)

		children.forEach((child, ci) => {
			visit(child, depth + 1, ci === children.length - 1, [...ancestorIsLast, isLastSibling])
		})
	}

	roots.forEach((root, i) => visit(root, 0, i === roots.length - 1, []))

	return result
}

/**
 * Task state indicator colors and labels.
 *
 * `icon` is a codicon class name used for the leading status glyph in the
 * dropdown rows (matches the VS Code "Sessions" panel look). `dot` is the
 * legacy small colored dot used by external surfaces (e.g. TaskHeader title)
 * that need to render a compact runtime-state indicator.
 */
export const TASK_STATE_CONFIG: Record<
	string,
	{ dot: string; label: string; pulse: boolean; icon: string; iconColor: string }
> = {
	completed: {
		dot: "bg-[var(--vscode-charts-green,#16a34a)]",
		label: "Completed",
		pulse: false,
		icon: "codicon-check",
		iconColor: "text-[var(--vscode-charts-green,#16a34a)]",
	},
	idle: {
		dot: "bg-[var(--vscode-descriptionForeground)]",
		label: "Idle",
		pulse: false,
		icon: "codicon-circle-large-outline",
		iconColor: "text-[var(--vscode-descriptionForeground)]",
	},
	running: {
		dot: "bg-[var(--vscode-charts-green,#16a34a)]",
		label: "Running",
		pulse: true,
		icon: "codicon-sync codicon-modifier-spin",
		iconColor: "text-[var(--vscode-charts-blue,#3b82f6)]",
	},
	waiting_input: {
		dot: "bg-[var(--vscode-charts-yellow,#eab308)]",
		label: "Needs Input",
		pulse: true,
		icon: "codicon-question",
		iconColor: "text-[var(--vscode-charts-yellow,#eab308)]",
	},
	paused: {
		dot: "bg-[var(--vscode-charts-orange,#f97316)]",
		label: "Paused",
		pulse: false,
		icon: "codicon-debug-pause",
		iconColor: "text-[var(--vscode-charts-orange,#f97316)]",
	},
	error: {
		dot: "bg-[var(--vscode-errorForeground,#ef4444)]",
		label: "Failed",
		pulse: false,
		icon: "codicon-error",
		iconColor: "text-[var(--vscode-errorForeground,#ef4444)]",
	},
}

/**
 * Date-bucket definitions used to group tasks in the dropdown the same way
 * VS Code groups sessions (Today / Yesterday / Last 7 Days / Older).
 *
 * Each bucket keeps the original DFS pre-order ordering of nodes so that the
 * tree connectors (├ / └) still render correctly within the bucket.
 */
type DateBucketKey = "today" | "yesterday" | "last7" | "older"

const DATE_BUCKET_ORDER: DateBucketKey[] = ["today", "yesterday", "last7", "older"]

const DATE_BUCKET_LABELS: Record<DateBucketKey, { key: string; fallback: string }> = {
	today: { key: "chat:taskSelector.groups.today", fallback: "Today" },
	yesterday: { key: "chat:taskSelector.groups.yesterday", fallback: "Yesterday" },
	last7: { key: "chat:taskSelector.groups.last7", fallback: "Last 7 Days" },
	older: { key: "chat:taskSelector.groups.older", fallback: "Older" },
}

/**
 * Bucketize a timestamp into one of the date groups. Uses the local-day
 * boundary (midnight) so "Today" / "Yesterday" match the user's wall clock.
 */
function bucketForTimestamp(ts: number, now: number): DateBucketKey {
	const startOfToday = new Date(now)
	startOfToday.setHours(0, 0, 0, 0)
	const todayMs = startOfToday.getTime()
	const dayMs = 24 * 60 * 60 * 1000

	if (ts >= todayMs) return "today"
	if (ts >= todayMs - dayMs) return "yesterday"
	if (ts >= todayMs - 7 * dayMs) return "last7"
	return "older"
}

/**
 * Returns true when a HistoryItem has at least one child subtask.
 * Uses the `childIds` array populated during task delegation.
 */
function hasChildren(item: HistoryItem): boolean {
	return !!(item.childIds && item.childIds.length > 0)
}

/**
 * Builds a Set of node IDs that should be visible after collapsing.
 *
 * Walks the flat DFS-pre-order tree; when a collapsed parent is encountered,
 * all descendants at greater depth are skipped until a node at the same or
 * shallower depth appears.
 */
function computeVisibleNodeIds(tree: TaskTreeNode[], collapsedNodes: Set<string>): Set<string> {
	const ids = new Set<string>()
	let skipDepth: number | null = null
	for (const node of tree) {
		if (skipDepth !== null && node.depth > skipDepth) {
			continue // skip descendants of a collapsed parent
		}
		skipDepth = null
		ids.add(node.item.id)
		if (collapsedNodes.has(node.item.id) && hasChildren(node.item)) {
			skipDepth = node.depth
		}
	}
	return ids
}

/**
 * ManagedTask holds the runtime execution state for tasks that have a live
 * Task instance (i.e. tasks that were started in this session and haven't been
 * stopped). It is used as a read-only overlay on top of HistoryItem, never as
 * the authoritative task list.
 */
export interface ManagedTask {
	id: string
	name: string
	taskId: string
	workspace: string
	createdAt: number
	lastActiveAt: number
	state: string
}

export interface TaskSelectorProps {
	/** Full task history — single source of truth for the task list. */
	taskHistory: HistoryItem[]
	/** Runtime state overlay indexed by task id. Empty when no parallel tasks are active. */
	parallelTasks: ManagedTask[]
	/** ID of the task currently displayed in the chat panel. */
	currentTaskId: string | undefined
}

/**
 * Returns the display name for a history item, preferring the user-set name
 * then falling back to the first 60 chars of the task text (same as HistoryView).
 */
export function getTaskDisplayName(item: HistoryItem): string {
	if (item.name) return item.name
	if (item.task) {
		const trimmed = item.task.trim()
		return trimmed.length > 60 ? trimmed.slice(0, 60) + "…" : trimmed
	}
	return `Task ${item.number}`
}

/**
 * Props for the row renderer factored out of the dropdown body.
 *
 * Keeping this as a free function (rather than a sub-component) lets each row
 * stay a plain JSX node — Virtuoso isn't used here and the dropdown is small,
 * so React's reconciliation cost is negligible compared to the readability win
 * of pulling 100+ lines of nested JSX out of the main return.
 */
interface TaskRowParams {
	node: TaskTreeNode
	runtimeStateMap: Map<string, ManagedTask>
	currentTaskId: string | undefined
	editingTaskId: string | null
	editName: string
	setEditName: (v: string) => void
	handleFocusTask: (taskId: string) => void
	handleDeleteTask: (taskId: string, e: React.MouseEvent) => void
	handleArchiveTask: (taskId: string, e: React.MouseEvent) => void
	handleUnarchiveTask: (taskId: string, e: React.MouseEvent) => void
	handlePinTask: (taskId: string, e: React.MouseEvent) => void
	handleUnpinTask: (taskId: string, e: React.MouseEvent) => void
	handleStartRename: (taskId: string, currentName: string, e: React.MouseEvent) => void
	handleConfirmRename: (taskId: string, e: React.MouseEvent) => void
	handleCancelRename: (e: React.MouseEvent) => void
	collapsedNodes: Set<string>
	handleToggleCollapse: (taskId: string, e: React.MouseEvent) => void
	t: TFunction
}

/**
 * Renders a single task row in the dropdown.
 *
 * Layout (left → right):
 *   [tree-gutter] [status-icon] [title \n state · time] [hover actions]
 *
 * The tree-gutter draws ├ / └ / │ connectors so subtasks visually nest under
 * their parent within a date bucket.
 */
function renderTaskRow({
	node,
	runtimeStateMap,
	currentTaskId,
	editingTaskId,
	editName,
	setEditName,
	handleFocusTask,
	handleDeleteTask,
	handleArchiveTask,
	handleUnarchiveTask,
	handlePinTask,
	handleUnpinTask,
	handleStartRename,
	handleConfirmRename,
	handleCancelRename,
	collapsedNodes,
	handleToggleCollapse,
	t,
}: TaskRowParams) {
	const { item, depth, isLastSibling, ancestorIsLast } = node
	const runtime = runtimeStateMap.get(item.id)
	const state = item.status === "completed" ? "completed" : (runtime?.state ?? item.taskExecutionState ?? "idle")
	const stateConfig = TASK_STATE_CONFIG[state] || TASK_STATE_CONFIG.idle
	const isCurrent = item.id === currentTaskId
	const isEditing = editingTaskId === item.id
	const displayName = getTaskDisplayName(item)
	const showChevron = hasChildren(item)
	const isCollapsed = collapsedNodes.has(item.id)

	return (
		<div
			key={item.id}
			onClick={() => !isEditing && handleFocusTask(item.id)}
			className={cn(
				"flex items-center gap-2 pl-2 pr-2 py-1.5 cursor-pointer group",
				"hover:bg-[var(--vscode-list-hoverBackground,#2a2d2e)] transition-colors",
				isCurrent && "bg-[var(--vscode-list-activeSelectionBackground,#094771)]",
			)}>
			{/* Tree connector gutter */}
			{(depth > 0 || showChevron) && (
				<span className="flex items-center flex-shrink-0 select-none" aria-hidden>
					{ancestorIsLast.slice(showChevron ? 0 : 1).map((anc, ai) => (
						<span
							key={ai}
							className="inline-flex items-center justify-center w-3 text-[var(--vscode-editorIndentGuide-background,#404040)]">
							{anc ? "\u00a0" : "│"}
						</span>
					))}
					{showChevron ? (
						<button
							className="inline-flex items-center justify-center w-3 text-[var(--vscode-editorIndentGuide-background,#404040)] hover:text-[var(--vscode-foreground)] cursor-pointer"
							onClick={(e) => handleToggleCollapse(item.id, e)}
							aria-label={isCollapsed ? "Expand subtasks" : "Collapse subtasks"}>
							{isCollapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
						</button>
					) : (
						<span className="inline-flex items-center justify-center w-3 text-[var(--vscode-editorIndentGuide-background,#404040)]">
							{isLastSibling ? "└" : "├"}
						</span>
					)}
				</span>
			)}

			{/* Leading status icon (codicon) — matches VS Code Sessions panel look */}
			<StandardTooltip content={stateConfig.label}>
				<span
					className={cn(
						"codicon flex-shrink-0 text-base leading-none",
						stateConfig.icon,
						stateConfig.iconColor,
					)}
				/>
			</StandardTooltip>

			{/* Title + subtitle column */}
			{isEditing ? (
				<div className="flex items-center gap-1 flex-1 min-w-0">
					<input
						type="text"
						value={editName}
						onChange={(e) => setEditName(e.target.value)}
						onClick={(e) => e.stopPropagation()}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								handleConfirmRename(item.id, e as any)
							} else if (e.key === "Escape") {
								handleCancelRename(e as any)
							}
						}}
						className={cn(
							"flex-1 min-w-0 px-1 py-0.5 text-sm",
							"bg-[var(--vscode-input-background,#3c3c3c)] border border-[var(--vscode-input-border,#3c3c3c)] rounded",
							"focus:outline-none focus:ring-1 focus:ring-[var(--vscode-focusBorder,#007fd4)]",
						)}
						autoFocus
					/>
					<button
						onClick={(e) => handleConfirmRename(item.id, e)}
						className="p-0.5 hover:bg-[var(--vscode-toolbar-hoverBackground,#5a5d5e)] rounded">
						<Check className="w-3 h-3" />
					</button>
					<button
						onClick={handleCancelRename}
						className="p-0.5 hover:bg-[var(--vscode-toolbar-hoverBackground,#5a5d5e)] rounded">
						<X className="w-3 h-3" />
					</button>
				</div>
			) : (
				<div className="flex-1 min-w-0 flex flex-col">
					<div className="flex items-center gap-1.5 min-w-0">
						<span className="truncate text-sm leading-tight">{displayName}</span>
					</div>
					<span className="truncate text-[11px] leading-tight text-[var(--vscode-descriptionForeground)]">
						{state !== "idle" && (
							<>
								<span>{stateConfig.label}</span>
								<span className="mx-1">·</span>
							</>
						)}
						{(item.insertions !== undefined || item.deletions !== undefined) && (
							<>
								{item.insertions !== undefined && item.insertions > 0 && (
									<span className="text-[var(--vscode-charts-green,#16a34a)]">
										+{item.insertions}
									</span>
								)}
								{item.deletions !== undefined && item.deletions > 0 && (
									<span className="text-[var(--vscode-charts-red,#ef4444)] ml-1">
										-{item.deletions}
									</span>
								)}
								<span className="mx-1">·</span>
							</>
						)}
						<span>{formatTimeAgo(item.ts)}</span>
					</span>
				</div>
			)}

			{!isEditing && (
				<>
					{/* Hover actions */}
					<div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
						{item.pinned ? (
							<StandardTooltip content={t("chat:taskSelector.unpin", "Unpin")}>
								<button
									onClick={(e) => handleUnpinTask(item.id, e)}
									className="p-1 hover:bg-[var(--vscode-toolbar-hoverBackground,#5a5d5e)] rounded">
									<PinOff className="w-3 h-3" />
								</button>
							</StandardTooltip>
						) : (
							<StandardTooltip content={t("chat:taskSelector.pin", "Pin")}>
								<button
									onClick={(e) => handlePinTask(item.id, e)}
									className="p-1 hover:bg-[var(--vscode-toolbar-hoverBackground,#5a5d5e)] rounded">
									<Pin className="w-3 h-3" />
								</button>
							</StandardTooltip>
						)}
						{item.archived ? (
							<StandardTooltip content={t("chat:taskSelector.unarchive", "Unarchive")}>
								<button
									onClick={(e) => handleUnarchiveTask(item.id, e)}
									className="p-1 hover:bg-[var(--vscode-toolbar-hoverBackground,#5a5d5e)] rounded">
									<Archive className="w-3 h-3" />
								</button>
							</StandardTooltip>
						) : (
							<StandardTooltip content={t("chat:taskSelector.archive", "Archive")}>
								<button
									onClick={(e) => handleArchiveTask(item.id, e)}
									className="p-1 hover:bg-[var(--vscode-toolbar-hoverBackground,#5a5d5e)] rounded">
									<Archive className="w-3 h-3" />
								</button>
							</StandardTooltip>
						)}
						<StandardTooltip content={t("chat:taskSelector.rename", "Rename")}>
							<button
								onClick={(e) => handleStartRename(item.id, displayName, e)}
								className="p-1 hover:bg-[var(--vscode-toolbar-hoverBackground,#5a5d5e)] rounded">
								<Pencil className="w-3 h-3" />
							</button>
						</StandardTooltip>
						<StandardTooltip content={t("chat:taskSelector.delete", "Delete")}>
							<button
								onClick={(e) => handleDeleteTask(item.id, e)}
								className="p-1 hover:bg-[var(--vscode-toolbar-hoverBackground,#5a5d5e)] rounded text-red-400">
								<Trash2 className="w-3 h-3" />
							</button>
						</StandardTooltip>
					</div>
				</>
			)}
		</div>
	)
}

/**
 * TaskSelector renders a right-side sidebar drawer for switching between all
 * tasks in history. The drawer is opened by the VS Code view-title-bar
 * `shofer.tasksButtonClicked` command, which the extension forwards to the
 * webview as an action message; the webview re-emits a DOM event
 * (`TASK_SIDEBAR_TOGGLE_EVENT`) that this component listens for.
 *
 * The drawer shows the parent-child delegation tree, grouped by date bucket,
 * matching VS Code Copilot's "Sessions" sidebar layout.
 *
 * LLM hint: This component used to render its own toolbar trigger; the trigger
 * has been promoted to the VS Code view title bar (next to the New Task pencil)
 * so the chat header can show the current task's title in its place. Open state
 * is intentionally kept local — the trigger is a one-shot toggle event.
 *
 * Layout: sticky header with task count + close button, full-width "New Task"
 * button, date-bucketed sections (Today / Yesterday / Last 7 Days / Older),
 * and a footer link to the full history view. Slides in from the right with
 * a transparent backdrop for click-outside dismissal; Escape also closes it.
 */
export const TASK_SIDEBAR_TOGGLE_EVENT = "shofer.taskSidebarToggle"

export const TaskSelector = memo(({ taskHistory, parallelTasks, currentTaskId }: TaskSelectorProps) => {
	const { t } = useTranslation()
	const [isOpen, setIsOpen] = useState(false)
	const [editingTaskId, setEditingTaskId] = useState<string | null>(null)
	const [editName, setEditName] = useState("")

	// Collapse state for parent-child subtree expansion in the tree.
	// All subtrees start collapsed by default — we seed the set with every
	// parent task ID.  The initial value is lazy-initialized so the
	// computation only runs on first render.
	const [collapsedNodes, setCollapsedNodes] = useState<Set<string>>(() => {
		const ids = new Set<string>()
		for (const item of taskHistory) {
			if (item.childIds && item.childIds.length > 0) {
				ids.add(item.id)
			}
		}
		return ids
	})

	// Build a fast O(1) lookup map from parallelTasks for runtime state overlay.
	const runtimeStateMap = useMemo(() => new Map(parallelTasks.map((t) => [t.id, t])), [parallelTasks])

	// Build the flattened DFS tree once per taskHistory change.
	const flatTree = useMemo(() => buildFlatTree(taskHistory), [taskHistory])

	const handleCreateTask = useCallback(() => {
		vscode.postMessage({ type: "createParallelTask" })
		setIsOpen(false)
	}, [])

	const handleFocusTask = useCallback((taskId: string) => {
		vscode.postMessage({ type: "focusParallelTask", taskId })
		setIsOpen(false)
	}, [])

	const handleDeleteTask = useCallback((taskId: string, e: React.MouseEvent) => {
		e.stopPropagation()
		vscode.postMessage({ type: "deleteParallelTask", taskId })
	}, [])

	const handlePinTask = useCallback((taskId: string, e: React.MouseEvent) => {
		e.stopPropagation()
		vscode.postMessage({ type: "pinParallelTask", taskId })
	}, [])

	const handleUnpinTask = useCallback((taskId: string, e: React.MouseEvent) => {
		e.stopPropagation()
		vscode.postMessage({ type: "unpinParallelTask", taskId })
	}, [])

	const handleArchiveTask = useCallback((taskId: string, e: React.MouseEvent) => {
		e.stopPropagation()
		vscode.postMessage({ type: "archiveParallelTask", taskId })
	}, [])

	const handleUnarchiveTask = useCallback((taskId: string, e: React.MouseEvent) => {
		e.stopPropagation()
		vscode.postMessage({ type: "unarchiveParallelTask", taskId })
	}, [])

	const handleStartRename = useCallback((taskId: string, currentName: string, e: React.MouseEvent) => {
		e.stopPropagation()
		setEditingTaskId(taskId)
		setEditName(currentName)
	}, [])

	const handleConfirmRename = useCallback(
		(taskId: string, e: React.MouseEvent) => {
			e.stopPropagation()
			if (editName.trim()) {
				vscode.postMessage({ type: "renameParallelTask", taskId, text: editName.trim() })
			}
			setEditingTaskId(null)
			setEditName("")
		},
		[editName],
	)

	const handleCancelRename = useCallback((e: React.MouseEvent) => {
		e.stopPropagation()
		setEditingTaskId(null)
		setEditName("")
	}, [])

	const handleToggleCollapse = useCallback((taskId: string, e: React.MouseEvent) => {
		e.stopPropagation() // don't trigger parent focus
		setCollapsedNodes((prev) => {
			const next = new Set(prev)
			if (next.has(taskId)) {
				next.delete(taskId)
			} else {
				next.add(taskId)
			}
			return next
		})
	}, [])

	/**
	 * Split flatTree into pinned, active, and archived subtrees.
	 * - Pinned roots (and their descendants) go to pinnedTree, shown first.
	 * - Archived roots (and their descendants) go to archivedTree, collapsed.
	 * - Everything else stays in activeTree, grouped by date bucket.
	 */
	const { pinnedTree, activeTree, archivedTree } = useMemo(() => {
		const pinned: TaskTreeNode[] = []
		const active: TaskTreeNode[] = []
		const archived: TaskTreeNode[] = []
		const archivedRootIds = new Set(flatTree.filter((n) => n.depth === 0 && n.item.archived).map((n) => n.item.id))
		const pinnedRootIds = new Set(
			flatTree.filter((n) => n.depth === 0 && n.item.pinned && !n.item.archived).map((n) => n.item.id),
		)
		let inPinned = false
		let inArchived = false
		for (const node of flatTree) {
			if (node.depth === 0) {
				inPinned = !!node.item.pinned && !node.item.archived
				inArchived = !!node.item.archived
			}
			if (inArchived || archivedRootIds.has(node.item.parentTaskId ?? "")) {
				archived.push(node)
			} else if (inPinned || pinnedRootIds.has(node.item.parentTaskId ?? "")) {
				pinned.push(node)
			} else {
				active.push(node)
			}
		}
		return { pinnedTree: pinned, activeTree: active, archivedTree: archived }
	}, [flatTree])

	const pinnedCount = pinnedTree.length

	/**
	 * Group nodes by date bucket while preserving DFS pre-order within
	 * each bucket. We bucket by the root task's timestamp so that a
	 * subtask is shown together with (and immediately after) its parent
	 * even if its own ts would land it in a different bucket.
	 *
	 * Only non-archived (active) tasks are grouped here; archived tasks
	 * appear in their own collapsible section.
	 */
	const groupedTree = useMemo(() => {
		const now = Date.now()
		const groups: Record<DateBucketKey, TaskTreeNode[]> = {
			today: [],
			yesterday: [],
			last7: [],
			older: [],
		}
		let currentBucket: DateBucketKey | null = null
		for (const node of activeTree) {
			if (node.depth === 0) {
				currentBucket = bucketForTimestamp(node.item.ts, now)
			}
			if (currentBucket) {
				groups[currentBucket].push(node)
			}
		}
		return groups
	}, [activeTree])

	const totalTaskCount = activeTree.length
	const archivedCount = archivedTree.length

	// Compute which node IDs are visible after applying subtree collapse.
	// Each tree is in DFS pre-order, so the skipDepth single-pass algorithm
	// correctly hides all descendants of a collapsed parent.
	const visiblePinnedNodeIds = useMemo(
		() => computeVisibleNodeIds(pinnedTree, collapsedNodes),
		[pinnedTree, collapsedNodes],
	)
	const visibleActiveNodeIds = useMemo(
		() => computeVisibleNodeIds(activeTree, collapsedNodes),
		[activeTree, collapsedNodes],
	)
	const visibleArchivedNodeIds = useMemo(
		() => computeVisibleNodeIds(archivedTree, collapsedNodes),
		[archivedTree, collapsedNodes],
	)

	/** Collapsed/expanded state for the "Archived" section. Collapsed by default. */
	const [isArchivedExpanded, setIsArchivedExpanded] = useState(false)

	// Listen for the global toggle event dispatched by the action handler when
	// the user clicks the VS Code view-title-bar Tasks button.
	useEffect(() => {
		const onToggle = () => setIsOpen((v) => !v)
		window.addEventListener(TASK_SIDEBAR_TOGGLE_EVENT, onToggle)
		return () => window.removeEventListener(TASK_SIDEBAR_TOGGLE_EVENT, onToggle)
	}, [])

	// Close the drawer on Escape, matching standard panel UX.
	useEffect(() => {
		if (!isOpen) return
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setIsOpen(false)
		}
		window.addEventListener("keydown", onKey)
		return () => window.removeEventListener("keydown", onKey)
	}, [isOpen])

	return (
		<>
			{/*
			 * Sidebar drawer. Renders as a fixed-position right-side panel
			 * spanning the full webview height — visually equivalent to
			 * Copilot's "Sessions" sidebar that slides in over the chat.
			 *
			 * The backdrop is a transparent click-catcher that lets the user
			 * dismiss by clicking outside. Animation is a CSS translate-x
			 * transition so the panel slides in/out smoothly.
			 */}
			{/* Backdrop (click-outside) */}
			<div
				onClick={() => setIsOpen(false)}
				className={cn(
					"fixed inset-0 z-40 transition-opacity",
					isOpen ? "opacity-100" : "opacity-0 pointer-events-none",
				)}
				aria-hidden
			/>

			{/* Drawer */}
			<aside
				role="complementary"
				aria-label={t("chat:taskSelector.title", "Tasks")}
				className={cn(
					"fixed top-0 right-0 bottom-0 z-50 flex flex-col w-[22rem] max-w-[85vw]",
					"bg-[var(--vscode-sideBar-background,var(--vscode-editorWidget-background,#252526))]",
					"border-l border-[var(--vscode-sideBar-border,var(--vscode-editorWidget-border,#454545))]",
					"shadow-2xl",
					"transition-transform duration-200 ease-out",
					isOpen ? "translate-x-0" : "translate-x-full",
				)}>
				{/* Header */}
				<div
					className={cn(
						"flex items-center justify-between px-3 py-2 flex-shrink-0",
						"text-xs font-semibold uppercase tracking-wide",
						"text-[var(--vscode-sideBarSectionHeader-foreground,var(--vscode-foreground))]",
						"bg-[var(--vscode-sideBarSectionHeader-background,transparent)]",
						"border-b border-[var(--vscode-sideBar-border,var(--vscode-editorWidget-border,#454545))]",
					)}>
					<div className="flex items-center gap-2">
						<span>{t("chat:taskSelector.title", "Tasks")}</span>
						<span className="text-[var(--vscode-descriptionForeground)] font-normal normal-case">
							{totalTaskCount}
						</span>
					</div>
					<StandardTooltip content={t("chat:taskSelector.close", "Close")}>
						<button
							onClick={() => setIsOpen(false)}
							aria-label={t("chat:taskSelector.close", "Close")}
							className="p-1 rounded hover:bg-[var(--vscode-toolbar-hoverBackground,#5a5d5e)]">
							<X className="w-4 h-4" />
						</button>
					</StandardTooltip>
				</div>

				{/* New task button — full-width pill, like VS Code's "New Session" */}
				<div className="px-2 pt-2 pb-2 flex-shrink-0">
					<button
						onClick={handleCreateTask}
						className={cn(
							"flex items-center justify-center gap-2 w-full px-3 py-1.5 text-sm rounded",
							"bg-[var(--vscode-button-secondaryBackground,var(--vscode-button-background))]",
							"text-[var(--vscode-button-secondaryForeground,var(--vscode-button-foreground))]",
							"hover:bg-[var(--vscode-button-secondaryHoverBackground,var(--vscode-button-hoverBackground))]",
							"transition-colors",
						)}>
						<Plus className="w-4 h-4" />
						<span>{t("chat:taskSelector.newTask", "New Task")}</span>
					</button>
				</div>

				{/* Scrollable list area */}
				<div className="flex-1 overflow-y-auto">
					{totalTaskCount === 0 && pinnedCount === 0 && archivedCount === 0 ? (
						<div className="px-3 py-6 text-sm text-[var(--vscode-descriptionForeground)] text-center">
							{t("chat:taskSelector.noTasks", "No tasks yet")}
						</div>
					) : (
						<>
							{/* Pinned tasks — always shown first, before date buckets */}
							{pinnedCount > 0 &&
								(() => {
									const visiblePinned = pinnedTree.filter((n) => visiblePinnedNodeIds.has(n.item.id))
									if (visiblePinned.length === 0) return null
									return (
										<div className="mb-1">
											<div
												className={cn(
													"flex items-center justify-between px-3 py-1",
													"text-[11px] font-semibold uppercase tracking-wide",
													"text-[var(--vscode-descriptionForeground)]",
												)}>
												<div className="flex items-center gap-1.5">
													<Pin className="w-3 h-3" />
													<span>{t("chat:taskSelector.groups.pinned", "Pinned")}</span>
												</div>
												<span className="font-normal">{visiblePinned.length}</span>
											</div>
											{visiblePinned.map((node) =>
												renderTaskRow({
													node,
													runtimeStateMap,
													currentTaskId,
													editingTaskId,
													editName,
													setEditName,
													handleFocusTask,
													handleDeleteTask,
													handleArchiveTask,
													handleUnarchiveTask,
													handlePinTask,
													handleUnpinTask,
													handleStartRename,
													handleConfirmRename,
													handleCancelRename,
													collapsedNodes,
													handleToggleCollapse,
													t,
												}),
											)}
										</div>
									)
								})()}
							{DATE_BUCKET_ORDER.map((bucket) => {
								const nodes = groupedTree[bucket]
								const visibleNodes = nodes.filter((n) => visibleActiveNodeIds.has(n.item.id))
								if (visibleNodes.length === 0) return null
								const label = DATE_BUCKET_LABELS[bucket]
								return (
									<div key={bucket} className="mb-1">
										{/* Section header */}
										<div
											className={cn(
												"flex items-center justify-between px-3 py-1",
												"text-[11px] font-semibold uppercase tracking-wide",
												"text-[var(--vscode-descriptionForeground)]",
											)}>
											<span>{t(label.key, label.fallback)}</span>
											<span className="font-normal">{visibleNodes.length}</span>
										</div>

										{visibleNodes.map((node) =>
											renderTaskRow({
												node,
												runtimeStateMap,
												currentTaskId,
												editingTaskId,
												editName,
												setEditName,
												handleFocusTask,
												handleDeleteTask,
												handleArchiveTask,
												handleUnarchiveTask,
												handlePinTask,
												handleUnpinTask,
												handleStartRename,
												handleConfirmRename,
												handleCancelRename,
												collapsedNodes,
												handleToggleCollapse,
												t,
											}),
										)}
									</div>
								)
							})}
						</>
					)}

					{/* Archived tasks — collapsible section */}
					{archivedCount > 0 && (
						<div className="mb-1">
							<button
								onClick={() => setIsArchivedExpanded((v) => !v)}
								className={cn(
									"flex items-center justify-between w-full px-3 py-1",
									"text-[11px] font-semibold uppercase tracking-wide",
									"text-[var(--vscode-descriptionForeground)]",
									"hover:bg-[var(--vscode-list-hoverBackground,#2a2d2e)] transition-colors",
								)}>
								<div className="flex items-center gap-1.5">
									<Archive className="w-3 h-3" />
									<span>{t("chat:taskSelector.groups.archived", "Archived")}</span>
								</div>
								<span className="font-normal">{archivedCount}</span>
							</button>
							{isArchivedExpanded &&
								archivedTree
									.filter((n) => visibleArchivedNodeIds.has(n.item.id))
									.map((node) =>
										renderTaskRow({
											node,
											runtimeStateMap,
											currentTaskId,
											editingTaskId,
											editName,
											setEditName,
											handleFocusTask,
											handleDeleteTask,
											handleArchiveTask,
											handleUnarchiveTask,
											handlePinTask,
											handleUnpinTask,
											handleStartRename,
											handleConfirmRename,
											handleCancelRename,
											collapsedNodes,
											handleToggleCollapse,
											t,
										}),
									)}
						</div>
					)}
				</div>

				{/* Footer: View all tasks link */}
				<div className="border-t border-[var(--vscode-sideBar-border,var(--vscode-editorWidget-border,#454545))] flex-shrink-0">
					<button
						onClick={() => {
							vscode.postMessage({ type: "switchTab", tab: "history" })
							setIsOpen(false)
						}}
						className={cn(
							"w-full px-3 py-2 text-sm text-center",
							"hover:bg-[var(--vscode-list-hoverBackground,#2a2d2e)] transition-colors",
							"text-[var(--vscode-textLink-foreground,#3794ff)]",
						)}>
						{t("chat:taskSelector.viewAll", "View All Tasks")}
					</button>
				</div>
			</aside>
		</>
	)
})

TaskSelector.displayName = "TaskSelector"
