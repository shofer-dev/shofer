import { useState, useCallback, useMemo, useEffect } from "react"
import { GraduationCap, ChevronDown, Globe, FolderGit2, ExternalLink, Check } from "lucide-react"

import type { SkillMetadata } from "@shofer/types"

import { cn } from "@/lib/utils"
import { useShoferPortal } from "@/components/ui/hooks/useShoferPortal"
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
 * the `skills` tool.
 */
export const SkillsButton = () => {
	const { t } = useAppTranslation()
	const { skills, customModes, loadedSkills } = useExtensionState()
	const [open, setOpen] = useState(false)
	const portalContainer = useShoferPortal("shofer-portal")

	// Fetch skills on mount so the button appears
	useEffect(() => {
		vscode.postMessage({ type: "requestSkills" })
	}, [])

	// Re-request skills from the extension every time the popover opens
	// to reflect loaded/unloaded state changes from skills invocations.
	const handleOpenChange = useCallback((isOpen: boolean) => {
		setOpen(isOpen)
		if (isOpen) {
			vscode.postMessage({ type: "requestSkills" })
		}
	}, [])

	// Build a mode name lookup from customModes
	const modeNameMap = useMemo(() => {
		const map: Record<string, string> = {}
		for (const m of customModes || []) {
			map[m.slug] = m.name
		}
		return map
	}, [customModes])

	// Resolve loaded skills from metadata — only show loaded skills that still exist
	const loadedSkillsSet = useMemo(() => new Set(Object.keys(loadedSkills ?? {})), [loadedSkills])

	// Split skills into loaded and unloaded
	const loadedSkillsList = useMemo(() => {
		const items = skills ?? []
		return items.filter((s) => loadedSkillsSet.has(s.name)).sort((a, b) => a.name.localeCompare(b.name))
	}, [skills, loadedSkillsSet])

	// Group unloaded skills by mode restriction, sorted alphabetically
	const grouped = useMemo(() => {
		const items = (skills ?? []).filter((s) => !loadedSkillsSet.has(s.name))

		// "All Modes" unloaded skills: no modeSlugs or empty array
		const allModesSkills = items
			.filter((s) => !s.modeSlugs || s.modeSlugs.length === 0)
			.sort((a, b) => a.name.localeCompare(b.name))

		// Per-mode unloaded skills: group by each modeSlug, sorted alphabetically
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

		// Sort each mode's items alphabetically
		for (const [, modeItems] of modeMap) {
			modeItems.sort((a, b) => a.name.localeCompare(b.name))
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
	}, [skills, t, modeNameMap, loadedSkillsSet])

	const handleSkillClick = useCallback((skill: SkillMetadata) => {
		// Fallback: no `use_skill` slash command exists, so insert
		// a natural-language instruction for the model to load the skill.
		const text = `Use the ${skill.name} skill`
		vscode.postMessage({ type: "insertTextIntoTextarea", text })
		setOpen(false)
	}, [])

	const handleOpenFile = useCallback((e: React.MouseEvent, path: string) => {
		e.stopPropagation()
		vscode.postMessage({ type: "openFile", text: path })
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
				className="p-0 overflow-hidden min-w-72 max-w-96">
				<div className="flex flex-col w-full max-h-[400px]">
					{/* Header */}
					<div className="flex items-center justify-between px-3 pt-3 pb-2">
						<h4 className="text-sm font-semibold m-0 flex items-center gap-2">
							<GraduationCap className="w-3.5 h-3.5" />
							{t("quickAccess:skills.title")}
						</h4>
						<div className="flex items-center gap-1">
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
					</div>

					{/* Scrollable list */}
					<div className="overflow-y-auto px-1 pb-1">
						{/* Loaded skills section */}
						{loadedSkillsList.length > 0 && (
							<div className="mb-1">
								<div className="flex items-center gap-1.5 px-2 py-1 text-[11px] font-semibold text-vscode-descriptionForeground uppercase tracking-wide">
									<Check className="w-3 h-3 shrink-0" />
									{t("quickAccess:skills.loaded")}
								</div>
								{loadedSkillsList.map((skill) => (
									<button
										key={`loaded:${skill.source}:${skill.name}`}
										data-testid={`skill-item-${skill.name}`}
										onClick={() => handleSkillClick(skill)}
										className={cn(
											"w-full text-left flex items-start gap-2 px-2 py-1.5 rounded-sm group",
											"text-sm text-vscode-foreground",
											"hover:bg-vscode-list-activeSelectionBackground hover:text-vscode-list-activeSelectionForeground",
											"focus:bg-vscode-list-activeSelectionBackground focus:text-vscode-list-activeSelectionForeground focus:outline-none",
											"cursor-pointer transition-colors",
										)}>
										<Check className="w-3 h-3 shrink-0 mt-0.5 text-green-400" />
										<div className="flex-1 min-w-0">
											<span className="font-medium truncate block">{skill.name}</span>
											{skill.description && (
												<span className="text-xs text-vscode-descriptionForeground truncate block mt-0.5">
													{skill.description}
												</span>
											)}
										</div>
										<span
											data-testid={`skill-open-file-${skill.name}`}
											role="button"
											tabIndex={0}
											aria-label={t("quickAccess:skills.openFile")}
											onClick={(e) => handleOpenFile(e, skill.path)}
											onKeyDown={(e) => {
												if (e.key === "Enter" || e.key === " ") {
													e.preventDefault()
													handleOpenFile(e as any, skill.path)
												}
											}}
											className={cn(
												"shrink-0 p-0.5 rounded-sm opacity-0 group-hover:opacity-100",
												"text-vscode-descriptionForeground hover:text-vscode-foreground",
												"hover:bg-[rgba(255,255,255,0.1)] transition-all",
												"cursor-pointer mt-0.5",
											)}>
											<ExternalLink className="w-3 h-3" />
										</span>
									</button>
								))}
							</div>
						)}
						{/* Available (not loaded) skills — grouped by mode */}
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
												"w-full text-left flex items-start gap-2 px-2 py-1.5 rounded-sm group",
												"text-sm text-vscode-foreground",
												"hover:bg-vscode-list-activeSelectionBackground hover:text-vscode-list-activeSelectionForeground",
												"focus:bg-vscode-list-activeSelectionBackground focus:text-vscode-list-activeSelectionForeground focus:outline-none",
												"cursor-pointer transition-colors",
											)}>
											{/* Source badge */}
											{(() => {
												const SrcIcon = SOURCE_ICONS[skill.source]
												return (
													<SrcIcon className="w-3 h-3 shrink-0 mt-0.5 text-vscode-descriptionForeground" />
												)
											})()}
											<div className="flex-1 min-w-0">
												<span className="font-medium truncate block">{skill.name}</span>
												{skill.description && (
													<span className="text-xs text-vscode-descriptionForeground truncate block mt-0.5">
														{skill.description}
													</span>
												)}
											</div>
											<span
												data-testid={`skill-open-file-${skill.name}`}
												role="button"
												tabIndex={0}
												aria-label={t("quickAccess:skills.openFile")}
												onClick={(e) => handleOpenFile(e, skill.path)}
												onKeyDown={(e) => {
													if (e.key === "Enter" || e.key === " ") {
														e.preventDefault()
														handleOpenFile(e as any, skill.path)
													}
												}}
												className={cn(
													"shrink-0 p-0.5 rounded-sm opacity-0 group-hover:opacity-100",
													"text-vscode-descriptionForeground hover:text-vscode-foreground",
													"hover:bg-[rgba(255,255,255,0.1)] transition-all",
													"cursor-pointer mt-0.5",
												)}>
												<ExternalLink className="w-3 h-3" />
											</span>
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
