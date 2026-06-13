import { memo, useRef, useState, useCallback } from "react"
import { useTranslation } from "react-i18next"
import { ChevronUp, ChevronDown, ArrowLeft, Rocket } from "lucide-react"

import type { ShoferMessage, WorkflowVizMeta } from "@shofer/types"

import { formatLargeNumber, formatDuration } from "@src/utils/format"
import { cn } from "@src/lib/utils"
import { StandardTooltip, Button } from "@src/components/ui"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"

import Thumbnails from "../common/Thumbnails"

import { TaskActions } from "./TaskActions"
import { Mention } from "./Mention"
import { TodoListDisplay } from "./TodoListDisplay"
import { getTaskDisplayName, resolveStateVisual } from "./TaskSelector"
import { BudgetLimitDialog } from "./BudgetLimitDialog"

/**
 * WorkflowHeader — a fork of {@link TaskHeader} for the WorkflowTask surface.
 *
 * A WorkflowTask is a deterministic orchestrator: it makes no LLM calls itself,
 * so per-task notions like Context Length, context-window usage, Cache, and the
 * persisted message Size don't apply to it. Instead this header surfaces the
 * metrics that describe the whole run: **API Cost** and **Tokens** aggregated
 * across the entire task tree (the workflow + every agent it spawned). Those
 * aggregates are computed host-side (aggregateTaskCostsRecursive) and passed in.
 */
export interface WorkflowHeaderProps {
	task: ShoferMessage
	/** The workflow root's OWN cost/tokens — fallback only; normally ~0. */
	totalCost: number
	tokensIn: number
	tokensOut: number
	/** Whole-tree aggregates (workflow + all descendant agents). */
	aggregatedCost?: number
	aggregatedTokensIn?: number
	aggregatedTokensOut?: number
	buttonsDisabled: boolean
	/** Per-root cost cap (resolved in WorkflowView). */
	costLimit?: { maxUsd: number; action: "pause" | "abort" | "kill" }
	onUpdateCostLimit?: (next: { maxUsd: number; action: "pause" | "abort" | "kill" }) => void
	/** Accumulated active wall-clock time in ms (excludes idle/waiting/paused). */
	activeTimeMs?: number
	/** Flow metadata rendered natively (was in the srcdoc iframe header). */
	workflowVizMeta?: WorkflowVizMeta
	/** True while the workflow is actively running — applies the shimmer highlight. */
	isRunning?: boolean
	todos?: any[]
}

const WorkflowHeader = ({
	task,
	totalCost,
	tokensIn,
	tokensOut,
	aggregatedCost,
	aggregatedTokensIn,
	aggregatedTokensOut,
	buttonsDisabled,
	costLimit,
	onUpdateCostLimit,
	activeTimeMs,
	workflowVizMeta,
	isRunning = false,
	todos,
}: WorkflowHeaderProps) => {
	const { t } = useTranslation()
	const { currentTaskItem, parallelTasks } = useExtensionState()
	const wfMeta = workflowVizMeta
	const [isTaskExpanded, setIsTaskExpanded] = useState(false)

	const textContainerRef = useRef<HTMLDivElement>(null)
	const textRef = useRef<HTMLDivElement>(null)

	// Whole-tree totals (own + all agents); fall back to the root's own values.
	const cost = aggregatedCost ?? totalCost
	const tokIn = aggregatedTokensIn ?? tokensIn
	const tokOut = aggregatedTokensOut ?? tokensOut

	const hasTodos = todos && Array.isArray(todos) && todos.length > 0
	const isSubtask = !!currentTaskItem?.parentTaskId

	const handleBackToParent = () => {
		if (currentTaskItem?.parentTaskId) {
			vscode.postMessage({ type: "showTaskWithId", text: currentTaskItem.parentTaskId })
		}
	}

	const handleCostLimitSave = useCallback(
		(newLimit: { maxUsd: number; action: "pause" | "abort" | "kill" }) => {
			onUpdateCostLimit?.(newLimit)
		},
		[onUpdateCostLimit],
	)

	const currentTitle = currentTaskItem ? getTaskDisplayName(currentTaskItem) : ""
	const currentRuntime = currentTaskItem ? parallelTasks?.find((p) => p.id === currentTaskItem.id) : undefined
	const currentState = currentRuntime?.state ?? currentTaskItem?.taskState ?? { lifecycle: "idle" as const }
	const currentStateConfig = resolveStateVisual(currentState)

	// Cost is whole-tree by definition for a workflow → always note "all agents".
	const costTooltip = <div>{t("chat:costs.totalWithSubtasks", { cost: cost.toFixed(2) })}</div>

	return (
		<div className="group pt-2 pb-0 px-3">
			<div className="mb-2 flex items-center justify-between gap-2">
				<div className="flex items-center gap-2 min-w-0 flex-1">
					{currentTaskItem && (
						<span
							aria-hidden
							className={cn(
								"w-2 h-2 rounded-full flex-shrink-0",
								currentStateConfig.dot,
								currentStateConfig.pulse && "animate-pulse",
							)}
						/>
					)}
					<StandardTooltip content={currentTitle || t("chat:task.title")}>
						<span className="truncate text-sm font-medium text-vscode-foreground">
							{currentTitle || t("chat:task.title")}
						</span>
					</StandardTooltip>
				</div>
				{isSubtask && (
					<Button
						variant="ghost"
						size="sm"
						onClick={handleBackToParent}
						className="flex items-center gap-1.5 text-xs text-vscode-descriptionForeground hover:text-vscode-foreground">
						<ArrowLeft className="size-3" />
						{t("chat:task.backToParentTask")}
					</Button>
				)}
			</div>
			<div
				className={cn(
					"px-3 pt-2.5 pb-2 flex flex-col gap-1.5 relative z-1 cursor-pointer",
					"bg-vscode-input-background hover:bg-vscode-input-background/90",
					"text-vscode-foreground/80 hover:text-vscode-foreground",
					"shadow-lg shadow-vscode-sideBar-background/50 rounded-xl",
					hasTodos && "border-b-0",
					isRunning && "task-header-shimmer",
				)}
				onClick={(e) => {
					if (e.target instanceof Element && e.target.closest("[data-todo-list]")) return
					if (
						e.target instanceof Element &&
						(e.target.closest("button") ||
							e.target.closest('[role="button"]') ||
							e.target.closest("[data-radix-popper-content-wrapper]") ||
							e.target.closest("img") ||
							e.target.tagName === "IMG")
					) {
						return
					}
					const selection = window.getSelection()
					if (selection && selection.toString().length > 0) return
					setIsTaskExpanded(!isTaskExpanded)
				}}>
				<div className="flex justify-between items-center gap-0">
					<div className="flex items-center select-none grow min-w-0">
						<div className="grow min-w-0">
							{isTaskExpanded && <span className="font-bold">{t("chat:task.title")}</span>}
							{!isTaskExpanded && (
								<div className="flex items-center gap-2 whitespace-nowrap overflow-hidden text-ellipsis">
									<Mention text={task.text} />
								</div>
							)}
						</div>
						<div className="flex items-center shrink-0 ml-2" onClick={(e) => e.stopPropagation()}>
							<StandardTooltip content={isTaskExpanded ? t("chat:task.collapse") : t("chat:task.expand")}>
								<button
									onClick={() => setIsTaskExpanded(!isTaskExpanded)}
									className="shrink-0 min-h-[20px] min-w-[20px] p-[2px] cursor-pointer opacity-85 hover:opacity-100 bg-transparent border-none rounded-md">
									{isTaskExpanded ? (
										<ChevronUp size={16} />
									) : (
										<ChevronDown size={16} className="opacity-0 group-hover:opacity-100" />
									)}
								</button>
							</StandardTooltip>
						</div>
					</div>
				</div>
				{/* Collapsed: just the whole-tree cost (no context length / size). */}
				{!isTaskExpanded && !!cost && (
					<div
						className="flex items-center gap-2 text-sm text-muted-foreground/70"
						onClick={(e) => e.stopPropagation()}>
						<StandardTooltip content={costTooltip} side="top" sideOffset={8}>
							<span>${cost.toFixed(2)}</span>
						</StandardTooltip>
					</div>
				)}
				{/* Expanded: task text, images, flow meta, actions, metrics. */}
				{isTaskExpanded && (
					<>
						<div
							ref={textContainerRef}
							className="text-vscode-font-size overflow-y-auto break-words break-anywhere relative">
							<div
								ref={textRef}
								className="overflow-auto max-h-80 whitespace-pre-wrap break-words break-anywhere cursor-text py-0.5"
								style={{
									display: "-webkit-box",
									WebkitLineClamp: "unset",
									WebkitBoxOrient: "vertical",
								}}>
								<Mention text={task.text} />
							</div>
						</div>
						{task.images && task.images.length > 0 && <Thumbnails images={task.images} />}

						{/* Flow metadata rendered natively (was srcdoc iframe header) */}
						{wfMeta && (
							<div className="mt-2 p-3 rounded-md border-l-4 border-l-vscode-charts-blue bg-vscode-editorWidget-background/40">
								<h3 className="text-sm font-semibold flex items-center gap-2 mb-1 text-vscode-foreground">
									<Rocket className="size-3.5 text-vscode-charts-blue" />
									{wfMeta.displayTitle}
								</h3>
								{wfMeta.flowName && (
									<div className="text-[0.72em] text-vscode-descriptionForeground mb-1 font-mono">
										flow &quot;{wfMeta.flowName}&quot;
									</div>
								)}
								{wfMeta.description && (
									<div className="text-xs text-vscode-descriptionForeground mb-2 whitespace-pre-wrap leading-relaxed">
										{wfMeta.description}
									</div>
								)}
								{(wfMeta.convergeCondition || wfMeta.budgets) && (
									<div className="text-[0.72em] text-vscode-descriptionForeground flex flex-wrap gap-x-4 gap-y-1">
										{wfMeta.convergeCondition ? (
											<span>
												🎯 Converge when:{" "}
												<code className="bg-vscode-textCodeBlock-background px-1.5 py-0.5 rounded font-mono">
													{wfMeta.convergeCondition}
												</code>
											</span>
										) : (
											<span className="opacity-50">No converge statement</span>
										)}
										{wfMeta.budgets ? (
											wfMeta.budgets.map((b) => (
												<span key={b.kind}>
													💰 {b.kind}:{" "}
													<code className="bg-vscode-textCodeBlock-background px-1.5 py-0.5 rounded font-mono">
														{b.value}
													</code>
												</span>
											))
										) : (
											<span className="opacity-50">No budget (unlimited)</span>
										)}
									</div>
								)}
							</div>
						)}

						<div onClick={(e) => e.stopPropagation()}>
							<TaskActions item={currentTaskItem} buttonsDisabled={buttonsDisabled} />
						</div>

						<div className="pt-3 mt-2 -mx-2.5 px-2.5 border-t border-vscode-sideBar-background">
							<table className="w-full text-sm">
								<tbody>
									{/* Tokens — aggregated across the whole tree. */}
									<tr>
										<th className="font-medium text-left align-top w-1 whitespace-nowrap pr-3 h-[24px]">
											{t("chat:task.tokens")}
										</th>
										<td className="font-light align-top">
											<div className="flex items-center gap-1 flex-wrap">
												{tokIn > 0 && <span>↑ {formatLargeNumber(tokIn)}</span>}
												{tokOut > 0 && <span>↓ {formatLargeNumber(tokOut)}</span>}
												{tokIn === 0 && tokOut === 0 && <span className="opacity-50">—</span>}
											</div>
										</td>
									</tr>

									{/* API Cost — aggregated across the whole tree. */}
									<tr>
										<th className="font-medium text-left align-top w-1 whitespace-nowrap pr-3 h-[24px]">
											{t("chat:task.apiCost")}
										</th>
										<td className="font-light align-top">
											<StandardTooltip content={costTooltip} side="top" sideOffset={8}>
												<span>
													${cost.toFixed(2)}
													{costLimit && costLimit.maxUsd > 0 ? (
														<>
															<span className="text-xs text-vscode-descriptionForeground ml-1">
																/ ${costLimit.maxUsd.toFixed(2)} limit
															</span>
															<BudgetLimitDialog
																costLimit={costLimit}
																spent={cost}
																onSave={handleCostLimitSave}
															/>
														</>
													) : (
														<BudgetLimitDialog spent={cost} onSave={handleCostLimitSave} />
													)}
												</span>
											</StandardTooltip>
										</td>
									</tr>

									{/* Active time */}
									{typeof activeTimeMs === "number" && activeTimeMs > 0 && (
										<tr>
											<th className="font-medium text-left align-top w-1 whitespace-nowrap pr-3 h-[24px]">
												{t("chat:task.activeTime")}
											</th>
											<td className="font-light align-top">{formatDuration(activeTimeMs)}</td>
										</tr>
									)}
								</tbody>
							</table>
						</div>
					</>
				)}
				{hasTodos && <TodoListDisplay todos={todos ?? (task as any)?.tool?.todos ?? []} />}
			</div>
		</div>
	)
}

export default memo(WorkflowHeader)
