import type { ReactNode } from "react"
import { MessageSquarePlus, Rocket } from "lucide-react"

import { Popover, PopoverAnchor, PopoverContent } from "@src/components/ui"
import { useShoferPortal } from "@src/components/ui/hooks/useShoferPortal"

type Stage = "task" | "workflow"

interface LauncherMenuProps {
	/** Whether the menu is open. Controlled by App (opened by the `+` button). */
	open: boolean
	onOpenChange: (open: boolean) => void
	/** Invoked with the chosen stage; the menu closes itself first. */
	onPick: (stage: Stage) => void
}

const ITEMS: { stage: Stage; icon: ReactNode; title: string; subtitle: string }[] = [
	{
		stage: "task",
		icon: <MessageSquarePlus className="size-5" />,
		title: "New Task",
		subtitle: "Spawn one or more agents to tackle a specific prompt",
	},
	{
		stage: "workflow",
		icon: <Rocket className="size-5" />,
		title: "New Workflow",
		subtitle: "A Workflow enforces a formal collaboration pattern among agents",
	},
]

/**
 * LauncherMenu — a small popover anchored to the top-right of the webview,
 * directly under the native "+" title-bar button. Replaces the native
 * QuickPick (which always opens at the command-palette location and can't be
 * anchored to a view/title button) with an in-webview chooser so we can render
 * per-item icons and a one-line description. Picking an item opens
 * `LauncherView` at the corresponding stage.
 */
export const LauncherMenu = ({ open, onOpenChange, onPick }: LauncherMenuProps) => {
	const portalContainer = useShoferPortal("shofer-portal")

	return (
		<Popover open={open} onOpenChange={onOpenChange}>
			{/* Zero-size anchor pinned at the sidebar's top-right, beneath the
			    native "+" button. The popover opens downward (align="end"). */}
			<PopoverAnchor asChild>
				<div className="fixed right-2 top-0 h-0 w-0" aria-hidden />
			</PopoverAnchor>
			<PopoverContent align="end" sideOffset={6} container={portalContainer} className="w-64 p-1">
				<div className="flex flex-col gap-0.5">
					{ITEMS.map((item) => (
						<button
							key={item.stage}
							type="button"
							onClick={() => onPick(item.stage)}
							className="flex w-full items-start gap-3 rounded-sm p-2.5 text-left transition-colors hover:bg-vscode-list-hoverBackground focus:outline-none focus-visible:bg-vscode-list-hoverBackground">
							<span className="mt-0.5 shrink-0 text-vscode-foreground/80">{item.icon}</span>
							<span className="flex min-w-0 flex-col">
								<span className="truncate font-medium text-vscode-foreground">{item.title}</span>
								<span className="mt-0.5 line-clamp-2 text-xs text-vscode-descriptionForeground">
									{item.subtitle}
								</span>
							</span>
						</button>
					))}
				</div>
			</PopoverContent>
		</Popover>
	)
}
