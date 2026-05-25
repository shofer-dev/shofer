import React from "react"
import type { HistoryItem } from "@shofer/types"
import { formatTimeAgo } from "@/utils/format"
import { CopyButton } from "./CopyButton"
import { ExportButton } from "./ExportButton"
import { DeleteButton } from "./DeleteButton"
import { StandardTooltip } from "../ui/standard-tooltip"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { Split } from "lucide-react"
import { resolveStateVisual } from "@src/components/chat/TaskSelector"
import { cn } from "@/lib/utils"

export interface TaskItemFooterProps {
	item: HistoryItem
	variant: "compact" | "full"
	isSelectionMode?: boolean
	isSubtask?: boolean
	onDelete?: (taskId: string) => void
}

const TaskItemFooter: React.FC<TaskItemFooterProps> = ({
	item,
	variant,
	isSelectionMode = false,
	isSubtask = false,
	onDelete,
}) => {
	const { t } = useAppTranslation()
	const taskState = item.taskState ?? { lifecycle: "idle" as const }
	const stateConfig = resolveStateVisual(taskState)

	return (
		<div className="text-xs text-vscode-descriptionForeground flex justify-between items-center">
			<div className="flex gap-1 items-center text-vscode-descriptionForeground/60">
				{/* Subtask tag */}
				{isSubtask && (
					<>
						<Split className="size-3" />
						<span>{t("history:subtaskTag")}</span>
						<span>·</span>
					</>
				)}
				{/* State icon (from TaskSelector) — icon alone communicates the state/rating */}
				{taskState.lifecycle !== "idle" && (
					<>
						<StandardTooltip content={stateConfig.label}>
							<span
								className={cn(
									"codicon flex-shrink-0 text-xs leading-none",
									stateConfig.icon,
									stateConfig.iconColor,
								)}
								aria-label={stateConfig.label}
							/>
						</StandardTooltip>
						<span>·</span>
					</>
				)}
				{/* Insertions/deletions (from TaskSelector) */}
				{(item.insertions !== undefined || item.deletions !== undefined) && (
					<>
						{item.insertions !== undefined && item.insertions > 0 && (
							<span className="text-[var(--vscode-charts-green,#16a34a)]">+{item.insertions}</span>
						)}
						{item.deletions !== undefined && item.deletions > 0 && (
							<span className="text-[var(--vscode-charts-red,#ef4444)] ml-0.5">-{item.deletions}</span>
						)}
						<span>·</span>
					</>
				)}
				{/* Datetime with time-ago format */}
				<StandardTooltip content={new Date(item.ts).toLocaleString()}>
					<span className="first-letter:uppercase">{formatTimeAgo(item.ts)}</span>
				</StandardTooltip>

				{/* Cost */}
				{!!item.totalCost && (
					<>
						<span>·</span>
						<span className="flex items-center" data-testid="cost-footer-compact">
							{"$" + item.totalCost.toFixed(2)}
						</span>
					</>
				)}
			</div>

			{/* Action Buttons for non-compact view */}
			{!isSelectionMode && (
				<div className="flex flex-row gap-0 -mx-1.5 items-center text-vscode-descriptionForeground/60 hover:text-vscode-descriptionForeground opacity-0 group-hover:opacity-100">
					<CopyButton itemTask={item.task} />
					{variant === "full" && <ExportButton itemId={item.id} />}
					{onDelete && <DeleteButton itemId={item.id} onDelete={onDelete} />}
				</div>
			)}
		</div>
	)
}

export default TaskItemFooter
