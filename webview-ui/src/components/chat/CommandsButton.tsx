import { useState, useCallback, useMemo, useEffect } from "react"
import { Zap, ChevronDown, FolderGit2, Globe, Wrench } from "lucide-react"

import type { Command } from "@roo-code/types"

import { cn } from "@/lib/utils"
import { useRooPortal } from "@/components/ui/hooks/useRooPortal"
import { Popover, PopoverContent, PopoverTrigger, StandardTooltip } from "@/components/ui"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { vscode } from "@/utils/vscode"

/**
 * Source badge icon mapping for command groups.
 */
const SOURCE_ICONS: Record<Command["source"], React.ElementType> = {
	project: FolderGit2,
	global: Globe,
	"built-in": Wrench,
}

/**
 * Chip button in the chat input bar that opens a popover listing all
 * available slash commands grouped by source.
 *
 * Clicking a command appends `/command-name ` (or
 * `/command-name <argumentHint>`) to the chat text area via the
 * `insertTextIntoTextarea` IPC message.
 */
export const CommandsButton = () => {
	const { t } = useAppTranslation()
	const { commands } = useExtensionState()
	const [open, setOpen] = useState(false)
	const portalContainer = useRooPortal("roo-portal")

	// Request commands from the extension on mount (follows WorktreeStatusIndicator pattern)
	useEffect(() => {
		vscode.postMessage({ type: "requestCommands" })
	}, [])
	const handleOpenChange = useCallback((isOpen: boolean) => {
		setOpen(isOpen)
	}, [])

	// Group commands by source
	const grouped = useMemo(() => {
		const groups: { source: Command["source"]; label: string; items: Command[] }[] = []

		const projectCmds = commands.filter((c) => c.source === "project")
		const globalCmds = commands.filter((c) => c.source === "global")
		const builtInCmds = commands.filter((c) => c.source === "built-in")

		if (projectCmds.length > 0) {
			groups.push({ source: "project", label: t("quickAccess:commands.projectCommands"), items: projectCmds })
		}
		if (globalCmds.length > 0) {
			groups.push({ source: "global", label: t("quickAccess:commands.globalCommands"), items: globalCmds })
		}
		if (builtInCmds.length > 0) {
			groups.push({
				source: "built-in",
				label: t("quickAccess:commands.builtInCommands"),
				items: builtInCmds,
			})
		}

		return groups
	}, [commands, t])

	const handleCommandClick = useCallback((command: Command) => {
		const text = command.argumentHint ? `/${command.name} ${command.argumentHint}` : `/${command.name} `
		vscode.postMessage({ type: "insertTextIntoTextarea", text })
		setOpen(false)
	}, [])

	// Open settings when gear icon is clicked
	const handleOpenSettings = useCallback(() => {
		vscode.postMessage({
			type: "switchTab",
			tab: "settings",
			values: { section: "slashCommands" },
		})
		setOpen(false)
	}, [])

	// Hidden when no commands available
	if (commands.length === 0) {
		return null
	}

	return (
		<Popover open={open} onOpenChange={handleOpenChange}>
			<StandardTooltip content={t("quickAccess:commands.tooltip")}>
				<PopoverTrigger
					data-testid="commands-button-trigger"
					className={cn(
						"inline-flex items-center gap-1 relative whitespace-nowrap px-1.5 py-1 text-xs",
						"bg-transparent border border-[rgba(255,255,255,0.08)] rounded-md text-vscode-foreground",
						"transition-all duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder focus-visible:ring-inset",
						"opacity-90 hover:opacity-100 hover:bg-[rgba(255,255,255,0.03)] hover:border-[rgba(255,255,255,0.15)] cursor-pointer",
					)}>
					<Zap className="w-3 h-3 shrink-0" />
					<ChevronDown className="size-2.5 shrink-0 opacity-70" />
				</PopoverTrigger>
			</StandardTooltip>
			<PopoverContent
				align="start"
				sideOffset={4}
				container={portalContainer}
				className="p-0 overflow-hidden min-w-56 max-w-72">
				<div className="flex flex-col w-full max-h-[400px]">
					{/* Header */}
					<div className="flex items-center justify-between px-3 pt-3 pb-2">
						<h4 className="text-sm font-semibold m-0 flex items-center gap-2">
							<Zap className="w-3.5 h-3.5" />
							{t("quickAccess:commands.title")}
						</h4>
						<button
							aria-label={t("quickAccess:commands.settings")}
							onClick={handleOpenSettings}
							className={cn(
								"inline-flex items-center justify-center size-5 rounded-sm",
								"text-vscode-descriptionForeground hover:text-vscode-foreground",
								"hover:bg-[rgba(255,255,255,0.05)] transition-colors",
								"cursor-pointer",
							)}>
							<span className="codicon codicon-settings-gear text-xs" />
						</button>
					</div>

					{/* Scrollable list */}
					<div className="overflow-y-auto px-1 pb-1">
						{grouped.map((group) => {
							const SourceIcon = SOURCE_ICONS[group.source]
							return (
								<div key={group.source} className="mb-1">
									{/* Group header */}
									<div className="flex items-center gap-1.5 px-2 py-1 text-[11px] font-semibold text-vscode-descriptionForeground uppercase tracking-wide">
										<SourceIcon className="w-3 h-3 shrink-0" />
										{group.label}
									</div>
									{/* Group items */}
									{group.items.map((cmd) => (
										<button
											key={`${cmd.source}:${cmd.name}`}
											data-testid={`command-item-${cmd.name}`}
											onClick={() => handleCommandClick(cmd)}
											className={cn(
												"w-full text-left flex items-center gap-2 px-2 py-1.5 rounded-sm",
												"text-sm text-vscode-foreground",
												"hover:bg-vscode-list-activeSelectionBackground hover:text-vscode-list-activeSelectionForeground",
												"focus:bg-vscode-list-activeSelectionBackground focus:text-vscode-list-activeSelectionForeground focus:outline-none",
												"cursor-pointer transition-colors",
											)}>
											<span className="font-mono text-xs text-vscode-textLink-foreground shrink-0">
												/{cmd.name}
											</span>
											{cmd.description && (
												<span className="text-xs text-vscode-descriptionForeground truncate">
													{cmd.description}
												</span>
											)}
										</button>
									))}
								</div>
							)
						})}
					</div>
				</div>
			</PopoverContent>
		</Popover>
	)
}
