import { useState, useCallback, useEffect } from "react"
import { GitBranch, ChevronDown } from "lucide-react"

import type { Worktree, WorktreeStatus } from "@roo-code/types"

import { cn } from "@/lib/utils"
import { useRooPortal } from "@/components/ui/hooks/useRooPortal"
import { Popover, PopoverContent, PopoverTrigger, StandardTooltip } from "@/components/ui"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { vscode } from "@/utils/vscode"

/**
 * Shows the current worktree branch name in the chat input bar.
 * When clicked, requests detailed status and shows it in a popover.
 */
export const WorktreeStatusIndicator = () => {
	const { t } = useAppTranslation()
	const [open, setOpen] = useState(false)
	const [worktrees, setWorktrees] = useState<Worktree[]>([])
	const [status, setStatus] = useState<WorktreeStatus | null>(null)
	const [loading, setLoading] = useState(false)
	const portalContainer = useRooPortal("roo-portal")

	// Get current worktree from the worktree list
	const currentWorktree = worktrees.find((w) => w.isCurrent)

	// Listen for worktree list updates
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

	// Fetch initial worktree list
	useEffect(() => {
		vscode.postMessage({ type: "listWorktrees" })
	}, [])

	// When popover opens, request detailed status
	const handleOpenChange = useCallback((isOpen: boolean) => {
		setOpen(isOpen)
		if (isOpen) {
			setLoading(true)
			vscode.postMessage({ type: "getWorktreeStatus" })
		}
	}, [])

	// Don't render if not a git repo or only 1 worktree
	if (worktrees.length <= 1) {
		return null
	}

	return (
		<Popover open={open} onOpenChange={handleOpenChange}>
			<StandardTooltip content={t("worktreeStatus:tooltip")}>
				<PopoverTrigger
					className={cn(
						"inline-flex items-center gap-1 relative whitespace-nowrap px-3 py-1",
						"bg-transparent rounded-full text-vscode-foreground text-left text-sm",
						"transition-all duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder focus-visible:ring-inset",
						"opacity-90 hover:opacity-100 hover:bg-[rgba(255,255,255,0.03)] hover:border-[rgba(255,255,255,0.15)] cursor-pointer",
						"max-w-[140px]",
					)}>
					<GitBranch className="w-3 h-3 shrink-0" />
					<span className="truncate">{currentWorktree?.branch || t("worktrees:noBranch")}</span>
					<ChevronDown className="size-3 shrink-0" />
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
							<GitBranch className="w-3.5 h-3.5" />
							{currentWorktree?.branch || t("worktrees:noBranch")}
						</h4>
					</div>

					{loading ? (
						<div className="flex items-center justify-center py-6">
							<span className="codicon codicon-loading codicon-modifier-spin text-lg" />
						</div>
					) : status ? (
						<div className="max-h-[320px] overflow-y-auto px-3 pb-3 text-sm">
							{/* Last commit */}
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

							{/* Ahead/Behind */}
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

							{/* Files changed */}
							{!status.isBaseBranch && status.filesChanged > 0 && (
								<div className="mb-1 text-vscode-descriptionForeground">
									{status.filesChanged} {t("worktreeStatus:filesChanged")} ({status.insertions}+ /{" "}
									{status.deletions}-)
								</div>
							)}

							{/* Uncommitted changes */}
							{status.hasUncommittedChanges && (
								<div className="mb-1 text-amber-600 dark:text-amber-400">
									⚠ {status.uncommittedCount} {t("worktreeStatus:uncommittedChanges")}
								</div>
							)}

							{/* Merge readiness */}
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

							{/* Other worktrees */}
							{status.otherWorktrees.length > 0 && (
								<div className="mt-2 pt-2 border-t border-vscode-panel-border">
									<div className="text-xs font-semibold text-vscode-descriptionForeground mb-1">
										{t("worktreeStatus:otherWorktrees")}:
									</div>
									{status.otherWorktrees.map((wt) => (
										<div
											key={wt.path}
											className="text-xs text-vscode-descriptionForeground truncate">
											<GitBranch className="w-2.5 h-2.5 inline mr-1" />
											{wt.branch || "(detached)"}
										</div>
									))}
								</div>
							)}
						</div>
					) : (
						<div className="flex items-center justify-center py-6 text-sm text-vscode-descriptionForeground">
							{t("worktreeStatus:noData")}
						</div>
					)}
				</div>
			</PopoverContent>
		</Popover>
	)
}
