import { useState, useEffect } from "react"
import { Pencil, Wallet } from "lucide-react"
import { cn } from "@src/lib/utils"
import { StandardTooltip, Button } from "@src/components/ui"

export type BudgetAction = "pause" | "abort" | "kill"

export interface BudgetLimit {
	maxUsd: number
	action: BudgetAction
}

export interface BudgetLimitDialogProps {
	/**
	 * Current per-root cost cap. When undefined, the trigger renders as a
	 * "Set budget" affordance (wallet icon) instead of the pencil-edit
	 * affordance, and the popover opens with sensible defaults.
	 */
	costLimit?: BudgetLimit
	/** Aggregated spend so far. Used to flag "already over limit" state. */
	spent: number
	onSave: (newLimit: BudgetLimit) => void
	/** Visual size override for the trigger icon. */
	iconSize?: number
	/** Override the default trigger tooltip copy. */
	triggerLabel?: string
}

const DEFAULT_INITIAL_LIMIT_USD = 5
const DEFAULT_INITIAL_ACTION: BudgetAction = "pause"

/**
 * Inline popover for editing the per-root-task cost limit.
 *
 * Two modes:
 * - **Edit mode** (`costLimit` provided): pencil-icon trigger, opens with
 *   the current values pre-filled.
 * - **Set mode** (`costLimit` undefined): wallet-icon trigger, opens with
 *   `$5` / `pause` defaults so the user only has to confirm to opt in.
 */
export const BudgetLimitDialog = ({
	costLimit,
	spent,
	onSave,
	iconSize = 12,
	triggerLabel,
}: BudgetLimitDialogProps) => {
	const [open, setOpen] = useState(false)
	const [maxUsd, setMaxUsd] = useState(String(costLimit?.maxUsd ?? DEFAULT_INITIAL_LIMIT_USD))
	const [action, setAction] = useState<BudgetAction>(costLimit?.action ?? DEFAULT_INITIAL_ACTION)

	useEffect(() => {
		setMaxUsd(String(costLimit?.maxUsd ?? DEFAULT_INITIAL_LIMIT_USD))
		setAction(costLimit?.action ?? DEFAULT_INITIAL_ACTION)
	}, [costLimit])

	const handleSave = () => {
		const parsed = parseFloat(maxUsd)
		if (!isNaN(parsed) && parsed > 0) {
			onSave({ maxUsd: parsed, action })
			setOpen(false)
		}
	}

	const overLimit = costLimit ? spent >= costLimit.maxUsd : false
	const isSetMode = !costLimit
	const tooltip = open ? undefined : (triggerLabel ?? (isSetMode ? "Set cost limit" : "Edit cost limit"))
	const TriggerIcon = isSetMode ? Wallet : Pencil

	return (
		<span className="inline-flex items-center">
			<StandardTooltip content={tooltip} side="top">
				<button
					className={cn(
						"inline-flex items-center cursor-pointer ml-1 transition-opacity",
						isSetMode
							? "opacity-50 hover:opacity-100 text-vscode-descriptionForeground"
							: "opacity-60 hover:opacity-100",
						overLimit && "text-red-400 opacity-100",
					)}
					onClick={(e) => {
						e.stopPropagation()
						setOpen(!open)
					}}>
					<TriggerIcon size={iconSize} />
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
