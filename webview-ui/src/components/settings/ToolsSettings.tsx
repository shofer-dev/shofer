import { HTMLAttributes } from "react"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import { Button, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui"

import {
	TOOL_DISPLAY_NAMES,
	TOOL_GROUPS,
	ALWAYS_AVAILABLE_TOOLS,
	TOOL_ALIASES,
	toolGroups,
	type ToolGroup,
	type ToolName,
} from "@roo-code/types"

import { SetCachedStateField } from "./types"
import { SectionHeader } from "./SectionHeader"
import { Section } from "./Section"
import { SearchableSetting } from "./SearchableSetting"

type ToolsSettingsProps = HTMLAttributes<HTMLDivElement> & {
	disabledTools?: string[]
	setCachedStateField: SetCachedStateField<"disabledTools">
}

/**
 * Per-group accent color for the group header. The label itself comes from i18n
 * (`settings:tools.groups.<group>`).
 */
const TOOL_GROUP_COLORS: Record<ToolGroup, string> = {
	read: "text-blue-400",
	edit: "text-green-400",
	command: "text-yellow-400",
	mcp: "text-purple-400",
	modes: "text-pink-400",
}

/**
 * Returns the reverse aliases for a given canonical tool name.
 * Maps canonical name -> list of alias names.
 */
function getAliasesForTool(canonicalName: ToolName): string[] {
	return Object.entries(TOOL_ALIASES)
		.filter(([, canonical]) => canonical === canonicalName)
		.map(([alias]) => alias)
}

export const ToolsSettings = ({ disabledTools, setCachedStateField, ...props }: ToolsSettingsProps) => {
	const { t } = useAppTranslation()

	const handleToggle = (toolName: ToolName) => {
		const current = disabledTools ?? []
		const next = current.includes(toolName) ? current.filter((t) => t !== toolName) : [...current, toolName]
		setCachedStateField("disabledTools", next)
	}

	const handleDisableAllNonEssential = () => {
		const allToolNames = Object.values(TOOL_GROUPS).flatMap((group) => group.tools as ToolName[])
		const uniqueTools = [...new Set(allToolNames)]
		const nonEssential = uniqueTools.filter((tool) => !ALWAYS_AVAILABLE_TOOLS.includes(tool))
		setCachedStateField("disabledTools", nonEssential)
	}

	const handleResetToDefaults = () => {
		setCachedStateField("disabledTools", [])
	}

	return (
		<div {...props}>
			<SectionHeader>{t("settings:sections.tools")}</SectionHeader>

			<Section>
				<div className="text-sm text-vscode-descriptionForeground mb-4">{t("settings:tools.description")}</div>

				{/* Header controls */}
				<div className="flex gap-2 mb-4">
					<Button variant="secondary" size="sm" onClick={handleDisableAllNonEssential}>
						{t("settings:tools.disableAllNonEssential")}
					</Button>
					<Button variant="secondary" size="sm" onClick={handleResetToDefaults}>
						{t("settings:tools.resetToDefaults")}
					</Button>
				</div>

				{/* Tool groups */}
				{toolGroups.map((group) => {
					const groupConfig = TOOL_GROUPS[group]
					const groupColor = TOOL_GROUP_COLORS[group]
					const tools = groupConfig.tools as ToolName[]
					const customTools = (groupConfig.customTools ?? []) as ToolName[]
					const allGroupTools = [...tools, ...customTools]

					return (
						<div key={group} className="mb-6">
							<div className="flex items-center gap-2 mb-2">
								<span className={`font-semibold ${groupColor}`}>
									{t(`settings:tools.groups.${group}`)}
								</span>
								<span className="text-xs text-vscode-descriptionForeground">
									{t("settings:tools.groupToolCount", { count: allGroupTools.length })}
								</span>
							</div>

							<div className="space-y-1">
								{allGroupTools.map((toolName) => {
									const isAlwaysAvailable = ALWAYS_AVAILABLE_TOOLS.includes(toolName)
									const isCustomTool = customTools.includes(toolName)
									const isDisabled = disabledTools?.includes(toolName) ?? false
									const aliases = getAliasesForTool(toolName)
									const displayName = TOOL_DISPLAY_NAMES[toolName] ?? toolName

									return (
										<SearchableSetting
											key={toolName}
											settingId={`tool-${toolName}`}
											section="tools"
											label={displayName}>
											<div className="flex items-center gap-2 py-1 px-2 rounded hover:bg-vscode-list-hoverBackground">
												{/* Checkbox */}
												<TooltipProvider>
													<Tooltip>
														<TooltipTrigger asChild>
															<VSCodeCheckbox
																checked={!isDisabled}
																disabled={isAlwaysAvailable}
																onChange={() => handleToggle(toolName)}
																data-testid={`tool-toggle-${toolName}`}
															/>
														</TooltipTrigger>
														{isAlwaysAvailable && (
															<TooltipContent>
																<p>{t("settings:tools.alwaysAvailableTooltip")}</p>
															</TooltipContent>
														)}
													</Tooltip>
												</TooltipProvider>

												{/* Tool name badge */}
												<code className="text-xs bg-vscode-textCodeBlock-background px-1.5 py-0.5 rounded font-mono">
													{toolName}
												</code>

												{/* Display name */}
												<span className="text-sm">{displayName}</span>

												{/* Badges */}
												<div className="flex gap-1 ml-auto">
													{isAlwaysAvailable && (
														<span className="text-xs bg-vscode-badge-background text-vscode-badge-foreground px-1.5 py-0.5 rounded">
															{t("settings:tools.badges.alwaysAvailable")}
														</span>
													)}
													{isCustomTool && (
														<span className="text-xs bg-vscode-badge-background text-vscode-badge-foreground px-1.5 py-0.5 rounded">
															{t("settings:tools.badges.optInOnly")}
														</span>
													)}
													{aliases.length > 0 && (
														<span className="text-xs text-vscode-descriptionForeground">
															{t("settings:tools.badges.aliases", {
																aliases: aliases.join(", "),
															})}
														</span>
													)}
												</div>
											</div>
										</SearchableSetting>
									)
								})}
							</div>
						</div>
					)
				})}
			</Section>
		</div>
	)
}
