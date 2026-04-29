import { useState, useEffect } from "react"
import { Pencil } from "lucide-react"
import { cn } from "@src/lib/utils"
import { StandardTooltip, Button } from "@src/components/ui"

export interface BudgetLimitDialogProps {
	costLimit: { maxUsd: number; action: "pause" | "abort" | "kill" }
	spent: number
	onSave: (newLimit: { maxUsd: number; action: "pause" | "abort" | "kill" }) => void
}

/**
 * Inline popover for editing the per-root-task cost limit.
 * Triggered by clicking the pencil icon next to the limit display in TaskHeader.
 */
export const BudgetLimitDialog = ({ costLimit, spent, onSave }: BudgetLimitDialogProps) => {
	const [open, setOpen] = useState(false)
	const [maxUsd, setMaxUsd] = useState(String(costLimit.maxUsd))
	const [action, setAction] = useState(costLimit.action)

	useEffect(() => {
		setMaxUsd(String(costLimit.maxUsd))
		setAction(costLimit.action)
	}, [costLimit])

	const handleSave = () => {
		const parsed = parseFloat(maxUsd)
		if (!isNaN(parsed) && parsed > 0) {
			onSave({ maxUsd: parsed, action })
			setOpen(false)
		}
	}

	const overLimit = spent >= costLimit.maxUsd

	return (
		<span className="inline-flex items-center">
			<StandardTooltip content={open ? undefined : "Edit cost limit"} side="top">
				<button
					className={cn(
						"inline-flex items-center cursor-pointer ml-1 opacity-60 hover:opacity-100 transition-opacity",
						overLimit && "text-red-400 opacity-100",
					)}
					onClick={(e) => {
						e.stopPropagation()
						setOpen(!open)
					}}>
					<Pencil size={12} />
				</button>
			</StandardTooltip>
			{open && (
				<div
					className={cn(
						"absolute z-50 mt-1 p-3 rounded-lg shadow-lg border text-sm",
						"bg-vscode-dropdown-background border-vscode-focusBorder",
						"min-w-[200px]",
					)}
					style={{ top: "100%", left: 0 }}
					onClick={(e) => e.stopPropagation()}>
					<div className="flex flex-col gap-2">
						<label className="text-xs text-vscode-descriptionForeground">
							Max budget (USD)
							<input
								type="number"
								step="0.01"
								min="0.01"
								value={maxUsd}
								onChange={(e) => setMaxUsd(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") handleSave()
									if (e.key === "Escape") setOpen(false)
								}}
								autoFocus
								className={cn(
									"w-full mt-1 px-2 py-1 rounded text-sm",
									"bg-vscode-input-background text-vscode-input-foreground",
									"border border-vscode-input-border",
									"focus:outline-none focus:border-vscode-focusBorder",
								)}
							/>
						</label>
						<label className="text-xs text-vscode-descriptionForeground">
							When limit reached
							<select
								value={action}
								onChange={(e) => setAction(e.target.value as typeof action)}
								className={cn(
									"w-full mt-1 px-2 py-1 rounded text-sm",
									"bg-vscode-input-background text-vscode-input-foreground",
									"border border-vscode-input-border",
									"focus:outline-none focus:border-vscode-focusBorder",
								)}>
								<option value="pause">Pause & ask</option>
								<option value="abort">Abort task</option>
								<option value="kill">Kill (headless)</option>
							</select>
						</label>
						<div className="flex gap-2 mt-1">
							<Button size="sm" onClick={handleSave}>
								Save
							</Button>
							<Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
								Cancel
							</Button>
						</div>
						{overLimit && (
							<p className="text-xs text-red-400">Spent ${spent.toFixed(2)} — already over limit</p>
						)}
					</div>
				</div>
			)}
		</span>
	)
}
