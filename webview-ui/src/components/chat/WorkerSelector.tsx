import { useCallback, useMemo, useState } from "react"
import { Server } from "lucide-react"

import type { ShoferWorkerView } from "@shofer/types"

import { cn } from "@/lib/utils"
import { useShoferPortal } from "@/components/ui/hooks/useShoferPortal"
import { Popover, PopoverContent, PopoverTrigger, StandardTooltip } from "@/components/ui"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { useExtensionState } from "@/context/ExtensionStateContext"

/**
 * A worker is a valid target for a NEW task when it is up and enabled: the Local
 * worker is always assignable; a remote must be `connected` and not disabled.
 * Mirrors the host's `WorkerRegistry.routeNewTask` acceptance of `preferredWorkerId`
 * (enabled + assignable), so the picker never offers a worker the host would
 * reject and silently fall back to round-robin for.
 */
const isSelectable = (n: ShoferWorkerView) => !n.disabled && (n.kind === "local" || n.status === "connected")

interface WorkerSelectorProps {
	triggerClassName?: string
}

/**
 * Compact chat-composer picker choosing which Shofer Worker runs the NEXT new
 * task. "Auto" (the default) means round-robin — the `newTask` post omits
 * `preferredWorkerId`. Selecting a specific worker sets it. Only rendered when at
 * least one remote worker is configured (Local-only setups gain nothing from it),
 * matching how {@link WorkerStatus} conditionally renders. Selection is sticky
 * across tasks, consistent with the neighbouring mode/API-config selectors.
 */
export const WorkerSelector = ({ triggerClassName = "" }: WorkerSelectorProps) => {
	const { t } = useAppTranslation()
	const { shoferWorkers, preferredWorkerId, setPreferredNodeId } = useExtensionState()
	const [open, setOpen] = useState(false)
	const portalContainer = useShoferPortal("shofer-portal")

	const workers = useMemo<ShoferWorkerView[]>(() => shoferWorkers?.workers ?? [], [shoferWorkers])

	// Only surface the picker once a remote exists — Local-only routing is trivial.
	const hasRemotes = useMemo(() => workers.some((n) => n.kind === "remote"), [workers])

	// The currently-picked worker, resolved against the live list. If the previously
	// picked worker is gone or no longer selectable, fall back to the Auto label so
	// the trigger never advertises a target the host would reject.
	const selected = useMemo(
		() => (preferredWorkerId ? workers.find((n) => n.id === preferredWorkerId && isSelectable(n)) : undefined),
		[workers, preferredWorkerId],
	)

	const handleSelect = useCallback(
		(id: string | undefined) => {
			setPreferredNodeId(id)
			setOpen(false)
		},
		[setPreferredNodeId],
	)

	if (!hasRemotes) return null

	const displayName = selected ? selected.label : t("chat:nodeSelector.auto")

	const renderRow = (
		key: string,
		label: string,
		sublabel: string | undefined,
		isActive: boolean,
		selectable: boolean,
		onClick: (() => void) | undefined,
	) => (
		<div
			key={key}
			onClick={selectable ? onClick : undefined}
			className={cn(
				"px-3 py-1.5 text-sm flex items-center gap-2",
				selectable ? "cursor-pointer hover:bg-vscode-list-hoverBackground" : "opacity-50 cursor-not-allowed",
				isActive && "bg-vscode-list-activeSelectionBackground text-vscode-list-activeSelectionForeground",
			)}>
			<div className="flex-1 min-w-0 flex flex-col">
				<span className="truncate">{label}</span>
				{sublabel && <span className="text-xs text-vscode-descriptionForeground truncate">{sublabel}</span>}
			</div>
			{isActive && <span className="codicon codicon-check text-xs flex-shrink-0" />}
		</div>
	)

	return (
		<Popover open={open} onOpenChange={setOpen} data-testid="worker-selector-root">
			<StandardTooltip content={t("chat:selectWorker")}>
				<PopoverTrigger
					data-testid="worker-selector-trigger"
					className={cn(
						"min-w-0 inline-flex items-center gap-1 relative whitespace-nowrap px-1.5 py-1 text-xs",
						"bg-transparent border border-[rgba(255,255,255,0.08)] rounded-md text-vscode-foreground",
						"transition-all duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder focus-visible:ring-inset",
						"opacity-90 hover:opacity-100 hover:bg-[rgba(255,255,255,0.03)] hover:border-[rgba(255,255,255,0.15)] cursor-pointer",
						triggerClassName,
					)}>
					<Server className="w-3 h-3 flex-shrink-0 opacity-70" />
					<span className="truncate">{displayName}</span>
				</PopoverTrigger>
			</StandardTooltip>
			<PopoverContent
				align="start"
				sideOffset={4}
				container={portalContainer}
				className="p-0 overflow-hidden w-[260px]">
				<div className="flex flex-col w-full">
					<div className="px-3 py-2 border-b border-vscode-dropdown-border text-xs font-medium uppercase tracking-wide text-vscode-descriptionForeground">
						{t("chat:nodeSelector.title")}
					</div>
					<div className="max-h-[300px] overflow-y-auto py-1">
						{/* Auto (round-robin) — the default, omits preferredWorkerId. */}
						{renderRow(
							"__auto__",
							t("chat:nodeSelector.auto"),
							t("chat:nodeSelector.autoDescription"),
							!selected,
							true,
							() => handleSelect(undefined),
						)}
						{workers.map((n) => {
							const selectable = isSelectable(n)
							const sublabel = n.disabled
								? "disabled"
								: !selectable
									? t("chat:nodeSelector.unavailable")
									: undefined
							return renderRow(n.id, n.label, sublabel, selected?.id === n.id, selectable, () =>
								handleSelect(n.id),
							)
						})}
					</div>
				</div>
			</PopoverContent>
		</Popover>
	)
}
