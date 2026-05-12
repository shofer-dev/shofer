import { useCallback, useEffect, useState } from "react"
import { GitBranch, ChevronDown, Plus } from "lucide-react"

import type { Worktree, WorktreeStatus } from "@roo-code/types"

import { cn } from "@/lib/utils"
import { useRooPortal } from "@/components/ui/hooks/useRooPortal"
import { Popover, PopoverContent, PopoverTrigger, StandardTooltip } from "@/components/ui"
import { useAppTranslation } from "@/i18n/TranslationContext"
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
	const [open, setOpen] = useState(false)
	const [modalOpen, setModalOpen] = useState(false)
	const [worktrees, setWorktrees] = useState<Worktree[]>([])
	const [status, setStatus] = useState<WorktreeStatus | null>(null)
	const [loading, setLoading] = useState(false)
	const portalContainer = useRooPortal("roo-portal")

	const currentWorktree = worktrees.find((w) => w.isCurrent)
	const otherWorktrees = worktrees.filter((w) => !w.isBare && !w.isCurrent)

	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			const message = event.data
			if (message.type === "worktreeList") {
				setWorktrees(message.worktrees || [])
			}
			if (message.type === "worktreeStatus") {
				setStatus(message.worktreeStatus)
				setLoading(false)
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

	const handleOpenChange = useCallback(
		(isOpen: boolean) => {
			setOpen(isOpen)
			if (isOpen) {
				refresh()
				setLoading(true)
				vscode.postMessage({ type: "getWorktreeStatus" })
			}
		},
		[refresh],
	)

	const handleSwitch = useCallback((wt: Worktree) => {
		setOpen(false)
		vscode.postMessage({
			type: "createParallelTask",
			worktreeDir: wt.path,
			taskName: `worktree: ${wt.branch || wt.path}`,
		})
	}, [])

	const handleCreate = useCallback(() => {
		setOpen(false)
		setModalOpen(true)
	}, [])

	return (
		<>
			<Popover open={open} onOpenChange={handleOpenChange}>
				<StandardTooltip content={t("worktreeStatus:tooltip")}>
					<PopoverTrigger
						className={cn(
							"inline-flex items-center gap-1 relative whitespace-nowrap px-1.5 py-1 text-xs",
							"bg-transparent border border-[rgba(255,255,255,0.08)] rounded-md text-vscode-foreground",
							"transition-all duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder focus-visible:ring-inset",
							"opacity-90 hover:opacity-100 hover:bg-[rgba(255,255,255,0.03)] hover:border-[rgba(255,255,255,0.15)] cursor-pointer",
						)}>
						<GitBranch className="w-3 h-3 shrink-0" />
						<ChevronDown className="size-2.5 shrink-0 opacity-70" />
					</PopoverTrigger>
				</StandardTooltip>
				<PopoverContent
					align="start"
					sideOffset={4}
					container={portalContainer}
					className="p-0 overflow-hidden min-w-72 max-w-80">
					<div className="flex flex-col w-full">
						{/* Header: current branch */}
						<div className="px-3 pt-3 pb-2">
							<h4 className="text-sm font-semibold m-0 flex items-center gap-2">
								<GitBranch className="w-3.5 h-3.5" />
								{currentWorktree?.branch || t("worktrees:noBranch")}
							</h4>
						</div>

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

						{/* (c) Switch — list other worktrees */}
						{otherWorktrees.length > 0 && (
							<>
								<div className="border-t border-vscode-dropdown-border" />
								<div className="px-3 pt-2 pb-1 text-[11px] font-semibold text-vscode-descriptionForeground uppercase tracking-wide">
									{t("worktreeStatus:otherWorktrees")}
								</div>
								<div className="max-h-48 overflow-y-auto pb-1">
									{otherWorktrees.map((wt) => (
										<button
											key={wt.path}
											type="button"
											onClick={() => handleSwitch(wt)}
											className={cn(
												"w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left",
												"bg-transparent border-none cursor-pointer",
												"text-vscode-foreground hover:bg-vscode-list-hoverBackground",
												"focus:outline-none focus-visible:bg-vscode-list-hoverBackground",
											)}>
											<GitBranch className="w-3.5 h-3.5 shrink-0 opacity-80" />
											<span className="truncate">{wt.branch || wt.path}</span>
										</button>
									))}
								</div>
							</>
						)}

						{/* (b) Create */}
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
					</div>
				</PopoverContent>
			</Popover>
			<CreateWorktreeModal
				open={modalOpen}
				onClose={() => setModalOpen(false)}
				onSuccess={refresh}
				openAfterCreate={true}
			/>
		</>
	)
}
