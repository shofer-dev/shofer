/**
 * The worktree chip in the chat input (`chat-input-toolbar`).
 *
 * One control for everything a task's checkout needs:
 *
 *  - **status** — ahead/behind, uncommitted changes and merge readiness for the
 *    worktree the current task is in;
 *  - **create** — a new worktree, which becomes the selection for the next task;
 *  - **switch** — pick which worktree the next task runs in, or re-point a workflow
 *    that has not started its agents yet.
 *
 * The selection is *plugin* state, not webview state: core asks the plugin where a task
 * should run (`resolve-task-cwd`) at creation time, so the answer has to live on the
 * side that will be asked. Picking nothing means a fresh worktree — parallel tasks
 * never collide by default, which is the whole point of the feature.
 *
 * BUILD: `ui/indicator.js` (esbuild ESM; React and `@shofer/plugin-ui` external).
 */

import { useCallback, useEffect, useMemo, useState } from "react"

import {
	Popover,
	PopoverContent,
	PopoverTrigger,
	StandardTooltip,
	cn,
	usePluginTranslation,
	useShoferPortal,
} from "@shofer/plugin-ui"

import type { WorktreeStatus } from "../src/types.js"

import {
	CreateWorktreeDialog,
	ask,
	useCreationProgress,
	useWorktreeList,
	worktreeLabel,
	type PluginUIApi,
	type Worktree,
} from "./shared.js"

export default function WorktreeIndicator({ api }: { api: PluginUIApi }): React.JSX.Element | null {
	const t = usePluginTranslation()
	const portalContainer = useShoferPortal()
	const { listing, refresh } = useWorktreeList(api)
	const { steps, reset } = useCreationProgress(api)

	const [open, setOpen] = useState(false)
	const [modalOpen, setModalOpen] = useState(false)
	const [status, setStatus] = useState<WorktreeStatus | null>(null)
	const [loading, setLoading] = useState(false)
	const [pendingCwd, setPendingCwd] = useState<string | null | undefined>(undefined)
	const [actionError, setActionError] = useState<string | null>(null)

	const task = api.context.task
	// A task is active once the host has pushed any timeline rows for it.
	const hasActiveTask = (task?.messageCount ?? 0) > 0
	// The host says whether it would still accept a re-point: true before a task starts,
	// and for a workflow that is still collecting its parameters (no agents on disk yet).
	const canRepoint = task?.cwdMutable !== false
	const locked = hasActiveTask && !canRepoint

	const worktrees = useMemo(() => listing?.worktrees ?? [], [listing])
	const selectable = worktrees.filter((w) => !w.isBare)
	const workspaceCurrent = worktrees.find((w) => w.isCurrent)

	// Once a task exists, the chip must name the worktree that task is IN — the workspace
	// checkout is always the main one, so `isCurrent` would be a lie there.
	const selected = useMemo<Worktree | undefined>(() => {
		if (hasActiveTask && task?.cwd) return worktrees.find((w) => w.path === task.cwd) ?? workspaceCurrent
		if (pendingCwd) return worktrees.find((w) => w.path === pendingCwd) ?? workspaceCurrent
		return workspaceCurrent
	}, [hasActiveTask, task?.cwd, pendingCwd, worktrees, workspaceCurrent])

	// The pending pick lives in the plugin, so re-read it rather than assume this mount
	// made it (a second window, or a re-mount after a tab switch, has the same state).
	useEffect(() => {
		void ask<{ cwd?: string; optedOut?: boolean }>(api, "selection")
			.then((selection) => setPendingCwd(selection.optedOut ? null : selection.cwd))
			.catch(() => undefined)
	}, [api])

	const available =
		listing !== null &&
		listing.isGitRepo &&
		!listing.isMultiRoot &&
		!listing.isSubfolder &&
		listing.gitRootPath !== ""

	const disabledTooltip =
		listing === null
			? ""
			: listing.gitRootPath === "" && !listing.isGitRepo
				? t("picker.disabledNoFolder")
				: listing.isMultiRoot
					? t("picker.disabledMultiRoot")
					: !listing.isGitRepo
						? t("picker.disabledNotGitRepo")
						: listing.isSubfolder
							? t("picker.disabledSubfolder")
							: ""

	const handleOpenChange = useCallback(
		(isOpen: boolean) => {
			// Defensive: the trigger is disabled in this state, but Radix can still open
			// via the keyboard.
			if (isOpen && !available) return
			setOpen(isOpen)
			if (!isOpen) return
			refresh()
			setLoading(true)
			void ask<WorktreeStatus>(api, "status", { cwd: selected?.path })
				.then(setStatus)
				.catch(() => setStatus(null))
				.finally(() => setLoading(false))
		},
		[api, available, refresh, selected?.path],
	)

	/** Point the next task — or a not-yet-started workflow — at `cwd`. */
	const choose = useCallback(
		async (cwd: string | null) => {
			setActionError(null)
			try {
				if (hasActiveTask && canRepoint && cwd) {
					await ask(api, "set-task-cwd", { cwd, taskId: task?.taskId }, true)
					return
				}
				await ask(api, "select", { cwd })
				setPendingCwd(cwd)
			} catch (error) {
				setActionError(error instanceof Error ? error.message : String(error))
			}
		},
		[api, hasActiveTask, canRepoint, task?.taskId],
	)

	const handleSelect = useCallback(
		(worktree: Worktree) => {
			setOpen(false)
			if (locked) return
			// The workspace checkout is the opt-out: run on the current branch, no worktree.
			void choose(worktree.isCurrent ? null : worktree.path)
		},
		[locked, choose],
	)

	/**
	 * A worktree created from the chat input is a place to work, so open a task in it —
	 * the same thing the built-in control did. On a workflow that has not started, there
	 * is already a task to move, so re-point that one instead of opening a second.
	 */
	const handleCreated = useCallback(
		async (createdPath: string, branch: string) => {
			reset()
			refresh()
			if (hasActiveTask) {
				await choose(createdPath)
				return
			}
			setActionError(null)
			try {
				await ask(api, "open-task", { cwd: createdPath, name: `worktree: ${branch}` }, true)
			} catch (error) {
				setActionError(error instanceof Error ? error.message : String(error))
			}
		},
		[api, reset, refresh, choose, hasActiveTask],
	)

	return (
		<>
			<Popover open={open} onOpenChange={handleOpenChange}>
				<StandardTooltip content={available ? t("picker.tooltip") : disabledTooltip}>
					<PopoverTrigger
						disabled={!available}
						aria-disabled={!available}
						className={cn(
							"inline-flex items-center gap-1 relative whitespace-nowrap px-1.5 py-1 text-xs",
							"bg-transparent border border-[rgba(255,255,255,0.08)] rounded-md text-vscode-foreground",
							"transition-all duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder focus-visible:ring-inset",
							"max-w-[160px]",
							available
								? "opacity-90 hover:opacity-100 hover:bg-[rgba(255,255,255,0.03)] hover:border-[rgba(255,255,255,0.15)] cursor-pointer"
								: "opacity-40 cursor-not-allowed",
						)}>
						<span className="codicon codicon-git-branch shrink-0" />
						<span className="truncate">{selected ? worktreeLabel(selected, t) : t("view.noBranch")}</span>
						<span className="codicon codicon-chevron-down shrink-0 opacity-70" />
					</PopoverTrigger>
				</StandardTooltip>

				<PopoverContent
					align="start"
					sideOffset={4}
					container={portalContainer}
					className="p-0 overflow-hidden min-w-72 max-w-80">
					<div className="flex flex-col w-full">
						<div className="px-3 pt-3 pb-2">
							<h4 className="text-sm font-semibold m-0 flex items-center gap-2">
								<span className="codicon codicon-git-branch" />
								{selected ? worktreeLabel(selected, t) : t("view.noBranch")}
							</h4>
						</div>

						{steps.length > 0 && (
							<div className="px-3 pb-2">
								{steps.map((s) => {
									const failed = s.detail?.startsWith("failed")
									return (
										<div
											key={s.step}
											className="flex items-center gap-2 py-0.5 text-xs text-vscode-descriptionForeground">
											<span
												className={cn(
													"codicon shrink-0",
													s.completed && !failed
														? "codicon-check text-vscode-charts-green"
														: failed
															? "codicon-error text-vscode-errorForeground"
															: "codicon-loading codicon-modifier-spin",
												)}
											/>
											<span className="truncate">{t(`step.${s.step}`)}</span>
											{s.completed && (
												<span
													className={cn(
														"ml-auto shrink-0",
														failed
															? "text-vscode-errorForeground"
															: "text-vscode-charts-green",
													)}>
													{s.detail}
												</span>
											)}
										</div>
									)
								})}
							</div>
						)}

						{loading ? (
							<div className="flex items-center justify-center py-6">
								<span className="codicon codicon-loading codicon-modifier-spin text-lg" />
							</div>
						) : status ? (
							<div className="max-h-[260px] overflow-y-auto px-3 pb-3 text-sm">
								{status.lastCommit && (
									<div className="mb-2">
										<span className="text-vscode-descriptionForeground">
											{t("status.lastCommit")}:
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
											<span className="text-vscode-charts-green">
												▲ {status.commitsAhead} {t("status.ahead")}
											</span>
										)}
										{status.commitsBehind > 0 && (
											<span className="text-vscode-charts-yellow">
												▼ {status.commitsBehind} {t("status.behind")}
											</span>
										)}
										{status.commitsAhead === 0 && status.commitsBehind === 0 && (
											<span className="text-vscode-descriptionForeground">
												{t("status.upToDate")}
											</span>
										)}
									</div>
								)}

								{!status.isBaseBranch && status.filesChanged > 0 && (
									<div className="mb-1 text-vscode-descriptionForeground">
										{status.filesChanged} {t("status.filesChanged")} ({status.insertions}+ /{" "}
										{status.deletions}-)
									</div>
								)}

								{status.hasUncommittedChanges && (
									<div className="mb-1 text-vscode-charts-yellow">
										⚠ {status.uncommittedCount} {t("status.uncommittedChanges")}
									</div>
								)}

								{!status.isBaseBranch && status.mergeReadiness.hasConflicts !== null && (
									<div
										className={cn(
											"mb-1 flex items-center gap-1",
											status.mergeReadiness.hasConflicts
												? "text-vscode-errorForeground"
												: "text-vscode-charts-green",
										)}>
										{status.mergeReadiness.hasConflicts
											? `⚠ ${t("status.conflictsDetected", { count: status.mergeReadiness.conflictedFiles.length })}`
											: `✅ ${t("status.safeToMerge")}`}
									</div>
								)}
							</div>
						) : (
							<div className="px-3 pb-3 text-sm text-vscode-descriptionForeground">
								{t("status.noData")}
							</div>
						)}

						{actionError && (
							<div className="px-3 pb-2 text-sm text-vscode-errorForeground">{actionError}</div>
						)}

						{!locked && (
							<>
								<div className="border-t border-vscode-dropdown-border" />
								<button
									type="button"
									onClick={() => {
										setOpen(false)
										setModalOpen(true)
									}}
									className={cn(
										"w-full flex items-center gap-2 px-3 py-2 text-sm text-left",
										"bg-transparent border-none cursor-pointer",
										"text-vscode-foreground hover:bg-vscode-list-hoverBackground",
										"focus:outline-none focus-visible:bg-vscode-list-hoverBackground",
									)}>
									<span className="codicon codicon-add shrink-0" />
									<span>{t("picker.createNew")}</span>
								</button>
							</>
						)}

						{!locked && selectable.length > 1 && (
							<>
								<div className="border-t border-vscode-dropdown-border" />
								<div className="px-3 pt-2 pb-1 text-[11px] font-semibold text-vscode-descriptionForeground uppercase tracking-wide">
									{t("picker.selectWorktree")}
								</div>
								<div className="max-h-48 overflow-y-auto pb-1">
									{selectable.map((worktree) => (
										<button
											key={worktree.path}
											type="button"
											onClick={() => handleSelect(worktree)}
											className={cn(
												"w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left",
												"bg-transparent border-none cursor-pointer",
												"text-vscode-foreground hover:bg-vscode-list-hoverBackground",
												"focus:outline-none focus-visible:bg-vscode-list-hoverBackground",
											)}>
											<span className="codicon codicon-git-branch shrink-0 opacity-80" />
											<span className="truncate flex-1">{worktree.branch || worktree.path}</span>
											{selected?.path === worktree.path && (
												<span className="codicon codicon-check shrink-0 opacity-80" />
											)}
										</button>
									))}
								</div>
							</>
						)}
					</div>
				</PopoverContent>
			</Popover>

			<CreateWorktreeDialog
				api={api}
				open={modalOpen}
				onClose={() => setModalOpen(false)}
				onCreated={(createdPath, branch) => void handleCreated(createdPath, branch)}
			/>
		</>
	)
}
