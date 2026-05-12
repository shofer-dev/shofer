import { useState } from "react"
import { GitBranchPlus } from "lucide-react"

import { cn } from "@/lib/utils"
import { StandardTooltip } from "@/components/ui"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { CreateWorktreeModal } from "@/components/worktrees/CreateWorktreeModal"

/**
 * NewWorktreeTaskButton
 *
 * Phase 5 of the embedded-worktree revamp: a one-click entry point in the
 * chat input bar to create an embedded git worktree AND spawn a task
 * scoped to it (`createParallelTask` with `worktreeDir` set).  Hosts the
 * `CreateWorktreeModal` locally so ChatTextArea doesn't have to track
 * modal state.
 */
export const NewWorktreeTaskButton = () => {
	const { t } = useAppTranslation()
	const [open, setOpen] = useState(false)

	return (
		<>
			<StandardTooltip content={t("chat:newWorktreeTask", "New worktree task")}>
				<button
					type="button"
					aria-label={t("chat:newWorktreeTask", "New worktree task")}
					onClick={() => setOpen(true)}
					className={cn(
						"relative inline-flex items-center justify-center",
						"bg-transparent border-none p-1.5",
						"rounded-md min-w-[28px] min-h-[28px]",
						"text-vscode-foreground opacity-85",
						"transition-all duration-150",
						"hover:opacity-100 hover:bg-[rgba(255,255,255,0.03)] hover:border-[rgba(255,255,255,0.15)]",
						"focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder",
						"active:bg-[rgba(255,255,255,0.1)]",
						"cursor-pointer",
					)}>
					<GitBranchPlus className="w-4 h-4" />
				</button>
			</StandardTooltip>
			<CreateWorktreeModal open={open} onClose={() => setOpen(false)} openAfterCreate={true} />
		</>
	)
}
