import { useCallback, useEffect, useMemo, useState } from "react"
import { GitBranch, ChevronDown, Plus, Check } from "lucide-react"

import type { Worktree, WorktreeStatus } from "@shofer/types"

import { cn } from "@/lib/utils"
import { useShoferPortal } from "@/components/ui/hooks/useShoferPortal"
import { Popover, PopoverContent, PopoverTrigger, StandardTooltip } from "@/components/ui"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { vscode } from "@/utils/vscode"
import { CreateWorktreeModal } from "@/components/worktrees/CreateWorktreeModal"

/**
 * WorktreeIndicator
 *
 * Single chat-input-bar entry point for everything worktree-related:
 *   (a) status — ahead/behind/uncommitted/merge-readiness for the current
 *       worktree (same data as the previous WorktreeStatusIndicator);
 *   (b) create — opens CreateWorktreeModal (openAfterCreate=true) so a new
 *       parallel task is spawned in the new worktree;
 *   (c) switch — clicking another worktree spawns a parallel task with
 *       that worktree's directory as `cwd`.
 *
 * Replaces the previous separate WorktreeStatusIndicator + NewWorktreeTaskButton
 * pair so the input bar carries one consistent worktree control.
 */
export const WorktreeIndicator = () => {
	const { t } = useAppTranslation()
	const {
		shoferMessages,
		currentTaskItem,
		pendingWorktreeDir,
		setPendingWorktreeDir,
		pendingWorkflowName,
		setPendingWorkflowName,
	} = useExtensionState()
	const [open, setOpen] = useState(false)
	const [modalOpen, setModalOpen] = useState(false)
	const [worktrees, setWorktrees] = useState<Worktree[]>([])
	const [status, setStatus] = useState<WorktreeStatus | null>(null)
	const [loading, setLoading] = useState(false)
	// Step-by-step progress during worktree creation.
	const [creationSteps, setCreationSteps] = useState<{ step: string; detail?: string; completed: boolean }[]>([])
	// Backend reports why worktrees may be unavailable (no folder open, not a
	// git repo, multi-root, subfolder of a repo). We capture it so the chip
	// can render in a disabled state instead of opening an empty popover.
	const [availability, setAvailability] = useState<{
		isGitRepo: boolean
		isMultiRoot: boolean
		isSubfolder: boolean
		hasWorkspaceFolder: boolean
	}>({ isGitRepo: true, isMultiRoot: false, isSubfolder: false, hasWorkspaceFolder: true })
	const portalContainer = useShoferPortal("shofer-portal")

	// A task is active once the backend has pushed any shoferMessages for it.
	// Switching/creating worktrees is only allowed before that point.
	const hasActiveTask = (shoferMessages?.length ?? 0) > 0

	// Workflows are a limited exception: a WorkflowTask makes no filesystem
	// changes itself, so its worktree stays editable WHILE it is still collecting
	// flow params / the initial questions — before the slang loop starts spawning
	// agents. Once started (flowState.started), subtasks exist and their cwd is
	// locked, so the control becomes read-only like an ordinary task.
	const isWorkflowTask = currentTaskItem?.isWorkflow === true
	const workflowStarted = (currentTaskItem?.flowState as { started?: boolean } | undefined)?.started === true
	const isEditableWorkflow = isWorkflowTask && !workflowStarted

	// Read-only for ordinary running tasks, and for workflows once they've started.
	const locked = hasActiveTask && !isEditableWorkflow

	// The "current" worktree from the list reflects the workspace's git
	// checkout (always master in the embedded model). Once a task is active,
	// derive what to display from the task's cwd (currentTaskItem.cwd) so the
	// chip names the worktree the task is actually running in. Pre-task,
	// prefer the user's pending selection.
	const workspaceCurrent = worktrees.find((w) => w.isCurrent)
	const selectedWorktree = useMemo<Worktree | undefined>(() => {
		if (hasActiveTask && currentTaskItem?.cwd) {
			return worktrees.find((w) => w.path === currentTaskItem.cwd) ?? workspaceCurrent
		}
		if (pendingWorktreeDir) {
			return worktrees.find((w) => w.path === pendingWorktreeDir) ?? workspaceCurrent
		}
		return workspaceCurrent
	}, [hasActiveTask, currentTaskItem?.cwd, pendingWorktreeDir, worktrees, workspaceCurrent])

	const selectableWorktrees = worktrees.filter((w) => !w.isBare)

	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			const message = event.data
			if (message.type === "worktreeList") {
				setWorktrees(message.worktrees || [])
				setAvailability({
					isGitRepo: message.isGitRepo !== false,
					isMultiRoot: message.isMultiRoot === true,
					isSubfolder: message.isSubfolder === true,
					// gitRootPath is empty only when no workspace folder was open.
					hasWorkspaceFolder: !(message.gitRootPath === "" && message.isGitRepo === false),
				})
			}
			if (message.type === "worktreeStatus") {
				setStatus(message.worktreeStatus)
				setLoading(false)
			}
			if (message.type === "worktreeCreationStep") {
				const step = (message as any).worktreeCreationStep as string
				const detail = (message as any).worktreeCreationStepDetail as string | undefined
				setCreationSteps((prev) => {
					// "done" / "skipped" / "failed" — mark the matching step complete.
					if (detail === "done" || detail === "skipped" || detail?.startsWith("failed")) {
						return prev.map((s) => (s.step === step ? { ...s, detail, completed: true } : s))
					}
					// New step starting.
					const exists = prev.some((s) => s.step === step)
					if (!exists) {
						return [...prev, { step, detail, completed: false }]
					}
					return prev
				})
			}
			if (message.type === "worktreeResult") {
				// Worktree creation finished — clear steps.
				setCreationSteps([])
			}
		}
		window.addEventListener("message", handleMessage)
		return () => window.removeEventListener("message", handleMessage)
	}, [])

	const refresh = useCallback(() => {
		vscode.postMessage({ type: "listWorktrees" })
	}, [])

	useEffect(() => {
		refresh()
	}, [refresh])

	// Worktrees are usable only in a single-root, non-subfolder git repo.
	const isAvailable =
		availability.hasWorkspaceFolder &&
		availability.isGitRepo &&
		!availability.isMultiRoot &&
		!availability.isSubfolder

	// When no task is active and no worktree is pending, the chip shows the
	// current git branch. The user can opt into "New worktree" via the popover.
	const showNewWorktreeDefault = false

	// When a workflow is being launched (worktree creation in progress), clear
	// pendingWorkflowName as soon as we detect a task is active (the workflow
	// has landed in the webview).
	useEffect(() => {
		if (pendingWorkflowName && (hasActiveTask || currentTaskItem)) {
			setPendingWorkflowName(null)
		}
	}, [pendingWorkflowName, hasActiveTask, currentTaskItem, setPendingWorkflowName])

	const disabledTooltip = !availability.hasWorkspaceFolder
		? t("worktreeStatus:disabledNoFolder")
		: availability.isMultiRoot
			? t("worktreeStatus:disabledMultiRoot")
			: !availability.isGitRepo
				? t("worktreeStatus:disabledNotGitRepo")
				: availability.isSubfolder
					? t("worktreeStatus:disabledSubfolder")
					: ""

	const handleOpenChange = useCallback(
		(isOpen: boolean) => {
			if (isOpen && !isAvailable) {
				// Defensive: trigger is disabled in this state, but suppress just
				// in case Radix surfaces an open via keyboard.
				return
			}
			setOpen(isOpen)
			if (isOpen) {
				refresh()
				setLoading(true)
				// Scope the status to the worktree the chip is currently
				// surfacing (active task's cwd or the user's pending pick),
				// not the workspace cwd which is always the main worktree.
				vscode.postMessage({
					type: "getWorktreeStatus",
					worktreeDir: selectedWorktree?.path,
				})
			}
		},
		[refresh, selectedWorktree?.path, isAvailable],
	)

	const handleSelect = useCallback(
		(wt: Worktree) => {
			setOpen(false)
			if (locked) {
				// Worktree is locked once an ordinary task is running; no-op.
				return
			}
			if (hasActiveTask && isEditableWorkflow) {
				// Not-yet-started workflow: re-point it (and the agents it will
				// spawn) at this worktree. Send a concrete path even for the current
				// worktree (its path is the repo root).
				vscode.postMessage({ type: "setWorkflowWorktree", worktreeDir: wt.path })
				return
			}
			// Pre-task: just record the selection. The worktreeDir is forwarded
			// when the user submits the first message / launches a workflow.
			if (wt.isCurrent) {
				setPendingWorktreeDir(null)
			} else {
				setPendingWorktreeDir(wt.path)
			}
		},
		[locked, hasActiveTask, isEditableWorkflow, setPendingWorktreeDir],
	)

	const handleCreate = useCallback(() => {
		setOpen(false)
		setModalOpen(true)
	}, [])

	// After worktree creation, auto-select it and refresh the list.
	const handleCreateSuccess = useCallback(
		(createdPath?: string) => {
			refresh()
			if (createdPath) {
				if (hasActiveTask && isEditableWorkflow) {
					// Not-yet-started workflow: re-point it at the new worktree.
					vscode.postMessage({ type: "setWorkflowWorktree", worktreeDir: createdPath })
				} else {
					setPendingWorktreeDir(createdPath)
				}
			}
		},
		[refresh, hasActiveTask, isEditableWorkflow, setPendingWorktreeDir],
	)

	return (
		<>
			<Popover open={open} onOpenChange={handleOpenChange}>
				<StandardTooltip content={isAvailable ? t("worktreeStatus:tooltip") : disabledTooltip}>
					<PopoverTrigger
						disabled={!isAvailable}
						aria-disabled={!isAvailable}
						className={cn(
							"inline-flex items-center gap-1 relative whitespace-nowrap px-1.5 py-1 text-xs",
							"bg-transparent border border-[rgba(255,255,255,0.08)] rounded-md text-vscode-foreground",
							"transition-all duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder focus-visible:ring-inset",
							"max-w-[160px]",
							isAvailable
								? "opacity-90 hover:opacity-100 hover:bg-[rgba(255,255,255,0.03)] hover:border-[rgba(255,255,255,0.15)] cursor-pointer"
								: "opacity-40 cursor-not-allowed",
						)}>
						<GitBranch className="w-3 h-3 shrink-0" />
						<span className="truncate">
							{pendingWorkflowName
								? `starting ${pendingWorkflowName}…`
								: showNewWorktreeDefault
									? t("worktreeStatus:defaultNewWorktree")
									: selectedWorktree?.branch || t("worktrees:noBranch")}
						</span>
						<ChevronDown className="size-2.5 shrink-0 opacity-70" />
					</PopoverTrigger>
				</StandardTooltip>
				<PopoverContent
					align="start"
					sideOffset={4}
					container={portalContainer}
					className="p-0 overflow-hidden min-w-72 max-w-80">
					<div className="flex flex-col w-full">
						{/* Header: selected branch */}
						<div className="px-3 pt-3 pb-2">
							<h4 className="text-sm font-semibold m-0 flex items-center gap-2">
								<GitBranch className="w-3.5 h-3.5" />
								{pendingWorkflowName
									? `starting ${pendingWorkflowName}…`
									: showNewWorktreeDefault
										? t("worktreeStatus:defaultNewWorktree")
										: selectedWorktree?.branch || t("worktrees:noBranch")}
							</h4>
						</div>

						{/* Creation progress steps */}
						{creationSteps.length > 0 && (
							<div className="px-3 pb-2">
								{creationSteps.map((s, i) => {
									const done = s.completed
									const failed = s.detail?.startsWith("failed")
									return (
										<div
											key={i}
											className="flex items-center gap-2 py-0.5 text-xs text-vscode-descriptionForeground">
											<span
												className={cn(
													"codicon w-3.5 h-3.5 shrink-0",
													done && !failed
														? "codicon-check text-green-600 dark:text-green-400"
														: failed
															? "codicon-error text-red-600 dark:text-red-400"
															: "codicon-loading codicon-modifier-spin",
												)}
											/>
											<span className="truncate">{s.step}</span>
											{done && !failed && (
												<span className="text-green-600 dark:text-green-400 ml-auto shrink-0">
													{s.detail}
												</span>
											)}
											{failed && (
												<span className="text-red-600 dark:text-red-400 ml-auto shrink-0">
													{s.detail}
												</span>
											)}
										</div>
									)
								})}
							</div>
						)}

						{/* (a) Status */}
						{loading ? (
							<div className="flex items-center justify-center py-6">
								<span className="codicon codicon-loading codicon-modifier-spin text-lg" />
							</div>
						) : status ? (
							<div className="max-h-[260px] overflow-y-auto px-3 pb-3 text-sm">
								{status.lastCommit && (
									<div className="mb-2">
										<span className="text-vscode-descriptionForeground">
											{t("worktreeStatus:lastCommit")}:
										</span>{" "}
										<span className="font-mono text-xs">{status.lastCommit.hash}</span>{" "}
										<span className="text-vscode-descriptionForeground">
											{status.lastCommit.subject}
										</span>
										<div className="text-xs text-vscode-descriptionForeground mt-0.5">
											{status.lastCommit.relativeTime} — {status.lastCommit.author}
										</div>
									</div>
								)}

								{!status.isBaseBranch && (
									<div className="flex gap-3 mb-2">
										{status.commitsAhead > 0 && (
											<span className="text-green-600 dark:text-green-400">
												▲ {status.commitsAhead} {t("worktreeStatus:ahead")}
											</span>
										)}
										{status.commitsBehind > 0 && (
											<span className="text-amber-600 dark:text-amber-400">
												▼ {status.commitsBehind} {t("worktreeStatus:behind")}
											</span>
										)}
										{status.commitsAhead === 0 && status.commitsBehind === 0 && (
											<span className="text-vscode-descriptionForeground">
												{t("worktreeStatus:upToDate")}
											</span>
										)}
									</div>
								)}

								{!status.isBaseBranch && status.filesChanged > 0 && (
									<div className="mb-1 text-vscode-descriptionForeground">
										{status.filesChanged} {t("worktreeStatus:filesChanged")} ({status.insertions}+ /{" "}
										{status.deletions}-)
									</div>
								)}

								{status.hasUncommittedChanges && (
									<div className="mb-1 text-amber-600 dark:text-amber-400">
										⚠ {status.uncommittedCount} {t("worktreeStatus:uncommittedChanges")}
									</div>
								)}

								{!status.isBaseBranch && status.mergeReadiness.hasConflicts !== null && (
									<div
										className={cn(
											"mb-1 flex items-center gap-1",
											status.mergeReadiness.hasConflicts
												? "text-red-600 dark:text-red-400"
												: "text-green-600 dark:text-green-400",
										)}>
										{status.mergeReadiness.hasConflicts
											? `⚠ ${t("worktreeStatus:conflictsDetected", { count: status.mergeReadiness.conflictedFiles.length })}`
											: `✅ ${t("worktreeStatus:safeToMerge")}`}
									</div>
								)}
							</div>
						) : (
							<div className="px-3 pb-3 text-sm text-vscode-descriptionForeground">
								{t("worktreeStatus:noData")}
							</div>
						)}

						{/* "New worktree" option (editable pre-task and on a running workflow) */}
						{!locked && (
							<>
								<div className="border-t border-vscode-dropdown-border" />
								<button
									type="button"
									onClick={handleCreate}
									className={cn(
										"w-full flex items-center gap-2 px-3 py-2 text-sm text-left",
										"bg-transparent border-none cursor-pointer",
										"text-vscode-foreground hover:bg-vscode-list-hoverBackground",
										"focus:outline-none focus-visible:bg-vscode-list-hoverBackground",
									)}>
									<Plus className="w-3.5 h-3.5 shrink-0" />
									<span>{t("worktreeStatus:createNew")}</span>
								</button>
							</>
						)}

						{/* (c) Select another worktree (editable pre-task and on a running workflow) */}
						{!locked && selectableWorktrees.length > 1 && (
							<>
								<div className="border-t border-vscode-dropdown-border" />
								<div className="px-3 pt-2 pb-1 text-[11px] font-semibold text-vscode-descriptionForeground uppercase tracking-wide">
									{t("worktreeStatus:selectWorktree")}
								</div>
								<div className="max-h-48 overflow-y-auto pb-1">
									{selectableWorktrees.map((wt) => {
										const isSelected = selectedWorktree?.path === wt.path
										return (
											<button
												key={wt.path}
												type="button"
												onClick={() => handleSelect(wt)}
												className={cn(
													"w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left",
													"bg-transparent border-none cursor-pointer",
													"text-vscode-foreground hover:bg-vscode-list-hoverBackground",
													"focus:outline-none focus-visible:bg-vscode-list-hoverBackground",
												)}>
												<GitBranch className="w-3.5 h-3.5 shrink-0 opacity-80" />
												<span className="truncate flex-1">{wt.branch || wt.path}</span>
												{isSelected && <Check className="w-3.5 h-3.5 shrink-0 opacity-80" />}
											</button>
										)
									})}
								</div>
							</>
						)}
					</div>
				</PopoverContent>
			</Popover>
			<CreateWorktreeModal
				open={modalOpen}
				onClose={() => setModalOpen(false)}
				onSuccess={handleCreateSuccess}
				openAfterCreate={true}
			/>
		</>
	)
}
