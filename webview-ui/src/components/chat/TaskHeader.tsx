import { memo, useRef, useState, useMemo, useCallback } from "react"
import { useTranslation } from "react-i18next"
import { ChevronUp, ChevronDown, HardDriveDownload, HardDriveUpload, FoldVertical, ArrowLeft, Rocket } from "lucide-react"
import prettyBytes from "pretty-bytes"

import type { ShoferMessage, WorkflowVizMeta } from "@shofer/types"

import { getModelMaxOutputTokens } from "@shofer/shared/api"

import { formatLargeNumber, formatDuration } from "@src/utils/format"
import { cn } from "@src/lib/utils"
import { StandardTooltip, Button, Table, TableBody, TableRow, TableCell, CircularProgress } from "@src/components/ui"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { useSelectedModel } from "@/components/ui/hooks/useSelectedModel"
import { vscode } from "@src/utils/vscode"

import Thumbnails from "../common/Thumbnails"

import { TaskActions } from "./TaskActions"
import { ContextWindowProgress } from "./ContextWindowProgress"
import { Mention } from "./Mention"
import { TodoListDisplay } from "./TodoListDisplay"
import { LucideIconButton } from "./LucideIconButton"
import { getTaskDisplayName, resolveStateVisual } from "./TaskSelector"
import { BudgetLimitDialog } from "./BudgetLimitDialog"

export interface TaskHeaderProps {
	task: ShoferMessage
	tokensIn: number
	tokensOut: number
	cacheWrites?: number
	cacheReads?: number
	totalCost: number
	aggregatedCost?: number
	hasSubtasks?: boolean
	parentTaskId?: string
	costBreakdown?: string
	contextTokens: number
	buttonsDisabled: boolean
	handleCondenseContext: (taskId: string) => void
	todos?: any[]
	/** Per-root-task cost cap (resolved on the parent in ChatView). */
	costLimit?: { maxUsd: number; action: "pause" | "abort" | "kill" }
	/** Live-update the cap; ChatView owns the actual postMessage call. */
	onUpdateCostLimit?: (next: { maxUsd: number; action: "pause" | "abort" | "kill" }) => void
	/** Accumulated active wall-clock time in ms (excludes idle, waiting, paused). */
	activeTimeMs?: number
	/** Workflow flow metadata rendered natively (was in the srcdoc iframe header). */
	workflowVizMeta?: WorkflowVizMeta
}

const TaskHeader = ({
	task,
	tokensIn,
	tokensOut,
	cacheWrites,
	cacheReads,
	totalCost,
	aggregatedCost,
	hasSubtasks,
	parentTaskId,
	costBreakdown,
	contextTokens,
	buttonsDisabled,
	handleCondenseContext,
	todos,
	costLimit,
	onUpdateCostLimit,
	activeTimeMs,
	workflowVizMeta,
}: TaskHeaderProps) => {
	const { t } = useTranslation()
	const { apiConfiguration, currentTaskItem, parallelTasks } = useExtensionState()
	const wfMeta = workflowVizMeta
	const { id: modelId, info: model } = useSelectedModel(apiConfiguration)
	const [isTaskExpanded, setIsTaskExpanded] = useState(false)

	const textContainerRef = useRef<HTMLDivElement>(null)
	const textRef = useRef<HTMLDivElement>(null)
	const contextWindow = model?.contextWindow || 1

	// Calculate maxTokens (reserved for output) once for reuse in percentage and tooltip
	const maxTokens = useMemo(
		() =>
			model
				? getModelMaxOutputTokens({
						modelId,
						model,
						settings: apiConfiguration,
					})
				: 0,
		[model, modelId, apiConfiguration],
	)
	const reservedForOutput = maxTokens || 0

	const condenseButton = (
		<LucideIconButton
			title={t("chat:task.condenseContext")}
			icon={FoldVertical}
			disabled={buttonsDisabled}
			onClick={() => currentTaskItem && handleCondenseContext(currentTaskItem.id)}
		/>
	)

	const hasTodos = todos && Array.isArray(todos) && todos.length > 0

	// Determine if this is a subtask (has a parent)
	const isSubtask = !!parentTaskId

	const handleBackToParent = () => {
		if (parentTaskId) {
			vscode.postMessage({ type: "showTaskWithId", text: parentTaskId })
		}
	}

	const handleCostLimitSave = useCallback(
		(newLimit: { maxUsd: number; action: "pause" | "abort" | "kill" }) => {
			onUpdateCostLimit?.(newLimit)
		},
		[onUpdateCostLimit],
	)

	// Resolve the runtime state of the currently-shown task so the in-chat
	// title can render a small status dot mirroring the drawer's row icons.
	// Live runtime overlay wins over persisted state; rating is read from the
	// (lifecycle, rating) tuple on the history item when no live overlay exists.
	const currentTitle = currentTaskItem ? getTaskDisplayName(currentTaskItem) : ""
	const currentRuntime = currentTaskItem ? parallelTasks?.find((p) => p.id === currentTaskItem.id) : undefined
	const currentState = currentRuntime?.state ?? currentTaskItem?.taskState ?? { lifecycle: "idle" as const }
	const currentStateConfig = resolveStateVisual(currentState)

	return (
		<div className="group pt-2 pb-0 px-3">
			{/*
			 * Top strip: shows the current task's title + runtime-state dot in
			 * the spot where the in-webview Tasks trigger used to live. The
			 * actual trigger has been promoted to the VS Code view title bar
			 * (`shofer.tasksButtonClicked`); the drawer is mounted below
			 * and listens for the global toggle event the action dispatches.
			 */}
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
				)}
				onClick={(e) => {
					// Don't expand if clicking on todos section
					if (e.target instanceof Element && e.target.closest("[data-todo-list]")) {
						return
					}

					// Don't expand if clicking on buttons or interactive elements
					if (
						e.target instanceof Element &&
						(e.target.closest("button") ||
							e.target.closest('[role="button"]') ||
							e.target.closest(".share-button") ||
							e.target.closest("[data-radix-popper-content-wrapper]") ||
							e.target.closest("img") ||
							e.target.tagName === "IMG")
					) {
						return
					}

					// Don't expand/collapse if user is selecting text
					const selection = window.getSelection()
					if (selection && selection.toString().length > 0) {
						return
					}

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
				{!isTaskExpanded && contextWindow > 0 && (
					<div
						className="flex items-center justify-between text-sm text-muted-foreground/70"
						onClick={(e) => e.stopPropagation()}>
						<div className="flex items-center gap-2">
							<StandardTooltip
								content={(() => {
									const availableSpace = contextWindow - (contextTokens || 0) - reservedForOutput

									return (
										<Table className="text-base ml-1.5">
											<TableBody>
												<TableRow>
													<TableCell className="font-medium whitespace-nowrap">
														{t("chat:tokenProgress.tokensUsedLabel")}
													</TableCell>
													<TableCell className="text-right text-[0.9em] font-mono">
														{formatLargeNumber(contextTokens || 0)} /{" "}
														{formatLargeNumber(contextWindow)}
													</TableCell>
												</TableRow>
												{reservedForOutput > 0 && (
													<TableRow>
														<TableCell className="font-medium whitespace-nowrap">
															{t("chat:tokenProgress.reservedForResponseLabel")}
														</TableCell>
														<TableCell className="text-right text-[0.9em] font-mono">
															{formatLargeNumber(reservedForOutput)}
														</TableCell>
													</TableRow>
												)}
												{availableSpace > 0 && (
													<TableRow>
														<TableCell className="font-medium whitespace-nowrap">
															{t("chat:tokenProgress.availableSpaceLabel")}
														</TableCell>
														<TableCell className="text-right text-[0.9em] font-mono">
															{formatLargeNumber(availableSpace)}
														</TableCell>
													</TableRow>
												)}
											</TableBody>
										</Table>
									)
								})()}
								side="top"
								sideOffset={8}>
								<span className="flex items-center gap-1.5">
									{(() => {
										// Calculate percentage of available input space used
										// Available input space = context window - reserved for output
										const availableInputSpace = contextWindow - reservedForOutput
										const percentage =
											availableInputSpace > 0
												? Math.round(((contextTokens || 0) / availableInputSpace) * 100)
												: 0
										return (
											<>
												<CircularProgress percentage={percentage} />
												<span>{percentage}%</span>
											</>
										)
									})()}
								</span>
							</StandardTooltip>
							{!!totalCost && (
								<>
									<span>·</span>
									<StandardTooltip
										content={
											hasSubtasks ? (
												<div>
													<div>
														{t("chat:costs.totalWithSubtasks", {
															cost: (aggregatedCost ?? totalCost).toFixed(2),
														})}
													</div>
													{costBreakdown && (
														<div className="text-xs mt-1">{costBreakdown}</div>
													)}
												</div>
											) : (
												<div>{t("chat:costs.total", { cost: totalCost.toFixed(2) })}</div>
											)
										}
										side="top"
										sideOffset={8}>
										<>
											<span>
												${(aggregatedCost ?? totalCost).toFixed(2)}
												{hasSubtasks && (
													<span
														className="text-xs ml-1"
														title={t("chat:costs.includesSubtasks")}>
														*
													</span>
												)}
											</span>
										</>
									</StandardTooltip>
								</>
							)}
						</div>
					</div>
				)}
				{/* Expanded state: Show task text and images */}
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
										flow "{wfMeta.flowName}"
									</div>
								)}
								{wfMeta.description && (
									<div className="text-xs text-vscode-descriptionForeground mb-2 whitespace-pre-wrap leading-relaxed">
										{wfMeta.description}
									</div>
								)}
								{wfMeta.params && wfMeta.params.length > 0 && (
									<div className="text-[0.72em] text-vscode-descriptionForeground mb-1.5">
										Params:{" "}
										{Object.entries(
											wfMeta.params.reduce<Record<string, { type: string; description?: string }[]>>(
												(acc, p) => {
													if (!acc[p.name]) acc[p.name] = []
													acc[p.name].push({ type: p.type, description: p.description })
													return acc
												},
												{},
											),
										).map(([name, entries], i, arr) => (
											<span key={name}>
												<code className="bg-vscode-textCodeBlock-background px-1.5 py-0.5 rounded text-[1.05em]">
													{name}: {entries.map((e) => `"${e.type}"`).join(" | ")}
												</code>
												{i < arr.length - 1 ? ", " : ""}
											</span>
										))}
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
									{contextWindow > 0 && (
										<tr>
											<th
												className="font-medium text-left align-top w-1 whitespace-nowrap pr-3 h-[24px]"
												data-testid="context-window-label">
												{t("chat:task.contextWindow")}
											</th>
											<td className="font-light align-top">
												<div className={`max-w-md -mt-1.5 flex flex-nowrap gap-1`}>
													<ContextWindowProgress
														contextWindow={contextWindow}
														contextTokens={contextTokens || 0}
														maxTokens={maxTokens || undefined}
													/>
													{condenseButton}
												</div>
											</td>
										</tr>
									)}

									<tr>
										<th className="font-medium text-left align-top w-1 whitespace-nowrap pr-3 h-[24px]">
											{t("chat:task.tokens")}
										</th>
										<td className="font-light align-top">
											<div className="flex items-center gap-1 flex-wrap">
												{typeof tokensIn === "number" && tokensIn > 0 && (
													<span>↑ {formatLargeNumber(tokensIn)}</span>
												)}
												{typeof tokensOut === "number" && tokensOut > 0 && (
													<span>↓ {formatLargeNumber(tokensOut)}</span>
												)}
											</div>
										</td>
									</tr>

									{((typeof cacheReads === "number" && cacheReads > 0) ||
										(typeof cacheWrites === "number" && cacheWrites > 0)) && (
										<tr>
											<th className="font-medium text-left align-top w-1 whitespace-nowrap pr-3 h-[24px]">
												{t("chat:task.cache")}
											</th>
											<td className="font-light align-top">
												<div className="flex items-center gap-1 flex-wrap">
													{typeof cacheWrites === "number" && cacheWrites > 0 && (
														<>
															<HardDriveDownload className="size-2.5" />
															<span>{formatLargeNumber(cacheWrites)}</span>
														</>
													)}
													{typeof cacheReads === "number" && cacheReads > 0 && (
														<>
															<HardDriveUpload className="size-2.5" />
															<span>{formatLargeNumber(cacheReads)}</span>
														</>
													)}
												</div>
											</td>
										</tr>
									)}

									{(!!totalCost || !!currentTaskItem) && (
										<tr>
											<th className="font-medium text-left align-top w-1 whitespace-nowrap pr-3 h-[24px]">
												{t("chat:task.apiCost")}
											</th>
											<td className="font-light align-top">
												<StandardTooltip
													content={
														hasSubtasks ? (
															<div>
																<div>
																	{t("chat:costs.totalWithSubtasks", {
																		cost: (aggregatedCost ?? totalCost).toFixed(2),
																	})}
																</div>
																{costBreakdown && (
																	<div className="text-xs mt-1">{costBreakdown}</div>
																)}
															</div>
														) : (
															<div>
																{t("chat:costs.total", { cost: totalCost.toFixed(2) })}
															</div>
														)
													}
													side="top"
													sideOffset={8}>
													<span>
														${(aggregatedCost ?? totalCost).toFixed(2)}
														{hasSubtasks && (
															<span
																className="text-xs ml-1"
																title={t("chat:costs.includesSubtasks")}>
																*
															</span>
														)}
														{costLimit && costLimit.maxUsd > 0 ? (
															<>
																<span className="text-xs text-vscode-descriptionForeground ml-1">
																	/ ${costLimit.maxUsd.toFixed(2)} limit
																</span>
																<BudgetLimitDialog
																	costLimit={costLimit}
																	spent={aggregatedCost ?? totalCost}
																	onSave={handleCostLimitSave}
																/>
															</>
														) : (
															<BudgetLimitDialog
																spent={aggregatedCost ?? totalCost}
																onSave={handleCostLimitSave}
															/>
														)}
													</span>
												</StandardTooltip>
											</td>
										</tr>
									)}

									{/* Active time display */}
									{typeof activeTimeMs === "number" && activeTimeMs > 0 && (
										<tr>
											<th className="font-medium text-left align-top w-1 whitespace-nowrap pr-3 h-[24px]">
												{t("chat:task.activeTime")}
											</th>
											<td className="font-light align-top">{formatDuration(activeTimeMs)}</td>
										</tr>
									)}

									{/* Size display */}
									{!!currentTaskItem?.size && currentTaskItem.size > 0 && (
										<tr>
											<th className="font-medium text-left align-top w-1 whitespace-nowrap pr-2 h-[20px]">
												{t("chat:task.size")}
											</th>
											<td className="font-light align-top">
												{prettyBytes(currentTaskItem.size)}
											</td>
										</tr>
									)}
								</tbody>
							</table>
						</div>
					</>
				)}
				{/* Todo list - always shown at bottom when todos exist */}
				{hasTodos && <TodoListDisplay todos={todos ?? (task as any)?.tool?.todos ?? []} />}
			</div>
		</div>
	)
}

export default memo(TaskHeader)
