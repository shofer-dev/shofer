import { useState, useCallback, useMemo, useEffect } from "react"
import { GraduationCap, ChevronDown, Globe, FolderGit2 } from "lucide-react"

import type { SkillMetadata } from "@roo-code/types"

import { cn } from "@/lib/utils"
import { useRooPortal } from "@/components/ui/hooks/useRooPortal"
import { Popover, PopoverContent, PopoverTrigger, StandardTooltip } from "@/components/ui"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { vscode } from "@/utils/vscode"

/**
 * Source badge icon mapping for skill groups.
 */
const SOURCE_ICONS: Record<SkillMetadata["source"], React.ElementType> = {
	project: FolderGit2,
	global: Globe,
}

/**
 * Chip button in the chat input bar that opens a popover listing all
 * available skills grouped by mode restriction.
 *
 * Clicking a skill appends a natural-language instruction (e.g.
 * "Use the <skill-name> skill") to the chat text area via the
 * `insertTextIntoTextarea` IPC message, so the model can then invoke
 * the `skill_load` tool.
 */
export const SkillsButton = () => {
	const { t } = useAppTranslation()
	const { skills, customModes } = useExtensionState()
	const [open, setOpen] = useState(false)
	const portalContainer = useRooPortal("roo-portal")

	// Request skills from the extension on mount (follows WorktreeStatusIndicator pattern)
	useEffect(() => {
		vscode.postMessage({ type: "requestSkills" })
	}, [])
	const handleOpenChange = useCallback((isOpen: boolean) => {
		setOpen(isOpen)
	}, [])

	// Build a mode name lookup from customModes
	const modeNameMap = useMemo(() => {
		const map: Record<string, string> = {}
		for (const m of customModes || []) {
			map[m.slug] = m.name
		}
		return map
	}, [customModes])

	// Group skills by mode restriction
	const grouped = useMemo(() => {
		const items = skills ?? []

		// "All Modes" skills: no modeSlugs or empty array
		const allModesSkills = items.filter((s) => !s.modeSlugs || s.modeSlugs.length === 0)

		// Per-mode skills: group by each modeSlug
		const modeMap = new Map<string, SkillMetadata[]>()
		for (const skill of items) {
			if (skill.modeSlugs && skill.modeSlugs.length > 0) {
				for (const slug of skill.modeSlugs) {
					if (!modeMap.has(slug)) {
						modeMap.set(slug, [])
					}
					modeMap.get(slug)!.push(skill)
				}
			}
		}

		const groups: { key: string; label: string; items: SkillMetadata[] }[] = []

		if (allModesSkills.length > 0) {
			groups.push({ key: "all", label: t("quickAccess:skills.allModes"), items: allModesSkills })
		}

		const sortedModes = Array.from(modeMap.entries()).sort(([a], [b]) => a.localeCompare(b))
		for (const [slug, items] of sortedModes) {
			const name = modeNameMap[slug] || slug
			groups.push({ key: slug, label: name, items })
		}

		return groups
	}, [skills, t, modeNameMap])

	const handleSkillClick = useCallback((skill: SkillMetadata) => {
		// Fallback: no `use_skill` slash command exists, so insert
		// a natural-language instruction for the model to load the skill.
		const text = `Use the ${skill.name} skill`
		vscode.postMessage({ type: "insertTextIntoTextarea", text })
		setOpen(false)
	}, [])

	// Open settings when gear icon is clicked
	const handleOpenSettings = useCallback(() => {
		vscode.postMessage({
			type: "switchTab",
			tab: "settings",
			values: { section: "skills" },
		})
		setOpen(false)
	}, [])

	// Hidden when no skills available
	if (!skills || skills.length === 0) {
		return null
	}

	return (
		<Popover open={open} onOpenChange={handleOpenChange}>
			<StandardTooltip content={t("quickAccess:skills.tooltip")}>
				<PopoverTrigger
					data-testid="skills-button-trigger"
					className={cn(
						"inline-flex items-center gap-1 relative whitespace-nowrap px-1.5 py-1 text-xs",
						"bg-transparent border border-[rgba(255,255,255,0.08)] rounded-md text-vscode-foreground",
						"transition-all duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder focus-visible:ring-inset",
						"opacity-90 hover:opacity-100 hover:bg-[rgba(255,255,255,0.03)] hover:border-[rgba(255,255,255,0.15)] cursor-pointer",
					)}>
					<GraduationCap className="w-3 h-3 shrink-0" />
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
							<GraduationCap className="w-3.5 h-3.5" />
							{t("quickAccess:skills.title")}
						</h4>
						<button
							aria-label={t("quickAccess:skills.settings")}
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
							// Use Globe for "All Modes", FolderGit2 for mode-specific
							const IconComponent = group.key === "all" ? Globe : FolderGit2

							return (
								<div key={group.key} className="mb-1">
									{/* Group header */}
									<div className="flex items-center gap-1.5 px-2 py-1 text-[11px] font-semibold text-vscode-descriptionForeground uppercase tracking-wide">
										<IconComponent className="w-3 h-3 shrink-0" />
										{group.label}
									</div>
									{/* Group items */}
									{group.items.map((skill) => (
										<button
											key={`${skill.source}:${skill.name}`}
											data-testid={`skill-item-${skill.name}`}
											onClick={() => handleSkillClick(skill)}
											className={cn(
												"w-full text-left flex items-center gap-2 px-2 py-1.5 rounded-sm",
												"text-sm text-vscode-foreground",
												"hover:bg-vscode-list-activeSelectionBackground hover:text-vscode-list-activeSelectionForeground",
												"focus:bg-vscode-list-activeSelectionBackground focus:text-vscode-list-activeSelectionForeground focus:outline-none",
												"cursor-pointer transition-colors",
											)}>
											{/* Source badge */}
											{(() => {
												const SrcIcon = SOURCE_ICONS[skill.source]
												return (
													<SrcIcon className="w-3 h-3 shrink-0 text-vscode-descriptionForeground" />
												)
											})()}
											<span className="font-medium truncate">{skill.name}</span>
											{skill.description && (
												<span className="text-xs text-vscode-descriptionForeground truncate ml-auto">
													{skill.description}
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
