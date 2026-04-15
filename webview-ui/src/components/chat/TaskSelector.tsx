import { memo, useState, useCallback, useMemo } from "react"
import { useTranslation } from "react-i18next"
import { ChevronDown, Plus, Pause, Play, Square, Trash2, Pencil, Check, X } from "lucide-react"

import type { HistoryItem } from "@roo-code/types"

import { cn } from "@src/lib/utils"
import { StandardTooltip } from "@src/components/ui"
import { vscode } from "@src/utils/vscode"

/**
 * Task state indicator colors and labels.
 */
const TASK_STATE_CONFIG: Record<string, { color: string; label: string; pulse: boolean }> = {
	idle: { color: "bg-gray-400", label: "Idle", pulse: false },
	running: { color: "bg-green-500", label: "Running", pulse: true },
	waiting_input: { color: "bg-yellow-500", label: "Needs Input", pulse: true },
	paused: { color: "bg-orange-500", label: "Paused", pulse: false },
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
	notificationCount: number
}

/**
 * Returns the display name for a history item, preferring the user-set name
 * then falling back to the first 60 chars of the task text (same as HistoryView).
 */
function getTaskDisplayName(item: HistoryItem): string {
	if (item.name) return item.name
	if (item.task) {
		const trimmed = item.task.trim()
		return trimmed.length > 60 ? trimmed.slice(0, 60) + "…" : trimmed
	}
	return `Task ${item.number}`
}

/**
 * TaskSelector provides a dropdown for switching between all tasks in history.
 *
 * LLM hint: Uses taskHistory (same data as HistoryView) as the authoritative task
 * list. parallelTasks overlays runtime state (running/paused/etc.) for tasks that
 * have a live instance in the current session. currentTaskId identifies the task
 * currently shown in the chat panel.
 */
export const TaskSelector = memo(
	({ taskHistory, parallelTasks, currentTaskId, notificationCount }: TaskSelectorProps) => {
		const { t } = useTranslation()
		const [isOpen, setIsOpen] = useState(false)
		const [editingTaskId, setEditingTaskId] = useState<string | null>(null)
		const [editName, setEditName] = useState("")

		// Build a fast O(1) lookup map from parallelTasks for runtime state overlay.
		const runtimeStateMap = useMemo(() => new Map(parallelTasks.map((t) => [t.id, t])), [parallelTasks])

		const currentItem = taskHistory.find((i) => i.id === currentTaskId)
		const currentRuntime = currentTaskId ? runtimeStateMap.get(currentTaskId) : undefined
		const currentState = currentRuntime?.state ?? "idle"

		const handleCreateTask = useCallback(() => {
			vscode.postMessage({ type: "createParallelTask" })
			setIsOpen(false)
		}, [])

		const handleFocusTask = useCallback((taskId: string) => {
			vscode.postMessage({ type: "focusParallelTask", taskId })
			setIsOpen(false)
		}, [])

		const handleStartTask = useCallback((taskId: string, e: React.MouseEvent) => {
			e.stopPropagation()
			vscode.postMessage({ type: "startParallelTask", taskId })
		}, [])

		const handlePauseTask = useCallback((taskId: string, e: React.MouseEvent) => {
			e.stopPropagation()
			vscode.postMessage({ type: "pauseParallelTask", taskId })
		}, [])

		const handleStopTask = useCallback((taskId: string, e: React.MouseEvent) => {
			e.stopPropagation()
			vscode.postMessage({ type: "stopParallelTask", taskId })
		}, [])

		const handleDeleteTask = useCallback((taskId: string, e: React.MouseEvent) => {
			e.stopPropagation()
			vscode.postMessage({ type: "deleteParallelTask", taskId })
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

		return (
			<div className="relative">
				{/* Task selector button */}
				<button
					onClick={() => setIsOpen(!isOpen)}
					className={cn(
						"flex items-center gap-2 px-3 py-1.5 rounded-md text-sm",
						"bg-[var(--vscode-editorWidget-background,#252526)] border border-[var(--vscode-editorWidget-border,#454545)]",
						"hover:bg-[var(--vscode-list-hoverBackground,#2a2d2e)] transition-colors",
						"focus:outline-none focus:ring-2 focus:ring-[var(--vscode-focusBorder,#007fd4)]",
					)}>
					{/* State indicator for currently shown task */}
					{currentItem && (
						<span
							className={cn(
								"w-2 h-2 rounded-full",
								TASK_STATE_CONFIG[currentState]?.color || "bg-gray-400",
								TASK_STATE_CONFIG[currentState]?.pulse && "animate-pulse",
							)}
						/>
					)}

					{/* Task name */}
					<span className="max-w-[150px] truncate">
						{currentItem ? getTaskDisplayName(currentItem) : t("chat:taskSelector.noTask", "No Task")}
					</span>

					{/* Notification badge */}
					{notificationCount > 0 && (
						<span className="flex items-center justify-center w-5 h-5 text-xs font-medium rounded-full bg-yellow-500 text-black">
							{notificationCount}
						</span>
					)}

					<ChevronDown className={cn("w-4 h-4 transition-transform", isOpen && "rotate-180")} />
				</button>

				{/* Dropdown */}
				{isOpen && (
					<div
						className={cn(
							"absolute top-full left-0 mt-1 w-72 z-50",
							"bg-[var(--vscode-editorWidget-background,#252526)] border border-[var(--vscode-editorWidget-border,#454545)] rounded-md shadow-lg",
							"max-h-[400px] overflow-y-auto",
						)}>
						{/* Create new task button */}
						<button
							onClick={handleCreateTask}
							className={cn(
								"flex items-center gap-2 w-full px-3 py-2 text-sm",
								"hover:bg-[var(--vscode-list-hoverBackground,#2a2d2e)] transition-colors",
								"border-b border-[var(--vscode-editorWidget-border,#454545)]",
							)}>
							<Plus className="w-4 h-4" />
							<span>{t("chat:taskSelector.newTask", "New Task")}</span>
						</button>

						{/* Task list — mirrors History, same data source (taskHistory) */}
						{taskHistory.length === 0 ? (
							<div className="px-3 py-4 text-sm text-[var(--vscode-descriptionForeground,#8b8b8b)] text-center">
								{t("chat:taskSelector.noTasks", "No tasks yet")}
							</div>
						) : (
							<div className="py-1">
								{taskHistory.map((item) => {
									const runtime = runtimeStateMap.get(item.id)
									const state = runtime?.state ?? "idle"
									const stateConfig = TASK_STATE_CONFIG[state] || TASK_STATE_CONFIG.idle
									const isCurrent = item.id === currentTaskId
									const isEditing = editingTaskId === item.id
									const displayName = getTaskDisplayName(item)

									return (
										<div
											key={item.id}
											onClick={() => !isEditing && handleFocusTask(item.id)}
											className={cn(
												"flex items-center gap-2 px-3 py-2 text-sm cursor-pointer group",
												"hover:bg-[var(--vscode-list-hoverBackground,#2a2d2e)] transition-colors",
												isCurrent &&
													"bg-[var(--vscode-list-activeSelectionBackground,#094771)]",
											)}>
											{/* Runtime state indicator — gray dot for idle (non-parallel) tasks */}
											<span
												className={cn(
													"w-2 h-2 rounded-full flex-shrink-0",
													stateConfig.color,
													stateConfig.pulse && "animate-pulse",
												)}
											/>

											{/* Task name (editable inline) */}
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
												<>
													<span className="flex-1 min-w-0 truncate">{displayName}</span>

													{/* Task actions — runtime controls only shown for active parallel tasks */}
													<div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
														{state === "running" && (
															<StandardTooltip
																content={t("chat:taskSelector.pause", "Pause")}>
																<button
																	onClick={(e) => handlePauseTask(item.id, e)}
																	className="p-1 hover:bg-[var(--vscode-toolbar-hoverBackground,#5a5d5e)] rounded">
																	<Pause className="w-3 h-3" />
																</button>
															</StandardTooltip>
														)}
														{(state === "paused" || state === "idle") && runtime && (
															<StandardTooltip
																content={t("chat:taskSelector.start", "Start")}>
																<button
																	onClick={(e) => handleStartTask(item.id, e)}
																	className="p-1 hover:bg-[var(--vscode-toolbar-hoverBackground,#5a5d5e)] rounded">
																	<Play className="w-3 h-3" />
																</button>
															</StandardTooltip>
														)}
														{state === "waiting_input" && (
															<StandardTooltip
																content={t("chat:taskSelector.stop", "Stop")}>
																<button
																	onClick={(e) => handleStopTask(item.id, e)}
																	className="p-1 hover:bg-[var(--vscode-toolbar-hoverBackground,#5a5d5e)] rounded">
																	<Square className="w-3 h-3" />
																</button>
															</StandardTooltip>
														)}
														<StandardTooltip
															content={t("chat:taskSelector.rename", "Rename")}>
															<button
																onClick={(e) =>
																	handleStartRename(item.id, displayName, e)
																}
																className="p-1 hover:bg-[var(--vscode-toolbar-hoverBackground,#5a5d5e)] rounded">
																<Pencil className="w-3 h-3" />
															</button>
														</StandardTooltip>
														<StandardTooltip
															content={t("chat:taskSelector.delete", "Delete")}>
															<button
																onClick={(e) => handleDeleteTask(item.id, e)}
																className="p-1 hover:bg-[var(--vscode-toolbar-hoverBackground,#5a5d5e)] rounded text-red-400">
																<Trash2 className="w-3 h-3" />
															</button>
														</StandardTooltip>
													</div>
												</>
											)}

											{/* Current-task indicator */}
											{isCurrent && !isEditing && (
												<span className="text-[var(--vscode-descriptionForeground,#8b8b8b)] text-xs">
													✓
												</span>
											)}
										</div>
									)
								})}
							</div>
						)}

						{/* View all tasks link */}
						<div className="border-t border-[var(--vscode-editorWidget-border,#454545)]">
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
					</div>
				)}

				{/* Click outside to close */}
				{isOpen && <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />}
			</div>
		)
	},
)

TaskSelector.displayName = "TaskSelector"
