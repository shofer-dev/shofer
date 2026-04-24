import { HTMLAttributes, useMemo } from "react"

import {
	TOOL_DISPLAY_NAMES,
	TOOL_GROUPS,
	ALWAYS_AVAILABLE_TOOLS,
	TOOL_ALIASES,
	toolGroups,
	type ToolGroup,
	type ToolName,
} from "@roo-code/types"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import { Button, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui"

import { SetCachedStateField } from "./types"
import { SectionHeader } from "./SectionHeader"
import { Section } from "./Section"
import { SearchableSetting } from "./SearchableSetting"

/**
 * ToolsSettings — global tool enablement panel.
 *
 * This panel manages the global `disabledTools` list, a flat set of tool names
 * stripped from the LLM's tool list (`buildNativeToolsArray` →
 * `filterNativeToolsForMode`) and rejected at runtime by
 * `presentAssistantMessage`.
 *
 * Scope: GLOBAL. This is independent of per-mode `groups` configuration —
 * disabling a tool here removes it from every mode. Per-mode restriction is
 * configured in the Modes tab via `TOOL_GROUPS` membership.
 *
 * Display structure:
 * - "Essential" section: tools in `ALWAYS_AVAILABLE_TOOLS`. Rendered with a
 *   disabled checkbox + tooltip — they cannot be turned off.
 * - One section per `ToolGroup` (read / edit / command / mcp / modes), listing
 *   tools that are NOT essential. `customTools` (opt-in only) are flagged with
 *   a badge.
 * - The internal `custom_tool` placeholder is filtered out — it is a meta-name
 *   for user-defined tools, not an end-user-toggleable tool.
 *
 * Tools are deduplicated across groups: each tool appears in at most one
 * section. Section precedence is `toolGroups` order, with `customTools`
 * appended within each group.
 */

type ToolsSettingsProps = HTMLAttributes<HTMLDivElement> & {
	disabledTools?: ToolName[]
	setCachedStateField: SetCachedStateField<"disabledTools">
}

/** Internal meta-name for user-defined custom tools — not toggleable. */
const META_TOOL_NAMES: ReadonlySet<ToolName> = new Set<ToolName>(["custom_tool"])

/**
 * Returns alias names whose canonical target is the given tool.
 * Memoized at module scope via a precomputed reverse index.
 */
const REVERSE_ALIASES: Record<string, string[]> = (() => {
	const out: Record<string, string[]> = {}
	for (const [alias, canonical] of Object.entries(TOOL_ALIASES)) {
		;(out[canonical] ??= []).push(alias)
	}
	return out
})()

/**
 * Build the deduplicated section layout.
 *
 * Returns sections in render order. The first section ("essential") contains
 * `ALWAYS_AVAILABLE_TOOLS`. Subsequent sections correspond to `toolGroups` and
 * contain only the non-essential tools that haven't already been emitted.
 */
type Section = {
	id: "essential" | ToolGroup
	tools: ReadonlyArray<{ name: ToolName; isCustom: boolean }>
}

function buildSections(): Section[] {
	const seen = new Set<ToolName>()
	const sections: Section[] = []

	const essentialTools = ALWAYS_AVAILABLE_TOOLS.filter((t) => !META_TOOL_NAMES.has(t))
	for (const t of essentialTools) seen.add(t)
	sections.push({
		id: "essential",
		tools: essentialTools.map((name) => ({ name, isCustom: false })),
	})

	for (const group of toolGroups) {
		const cfg = TOOL_GROUPS[group]
		const entries: { name: ToolName; isCustom: boolean }[] = []
		const append = (name: ToolName, isCustom: boolean) => {
			if (META_TOOL_NAMES.has(name) || seen.has(name)) return
			seen.add(name)
			entries.push({ name, isCustom })
		}
		for (const t of cfg.tools) append(t as ToolName, false)
		for (const t of cfg.customTools ?? []) append(t as ToolName, true)
		if (entries.length > 0) sections.push({ id: group, tools: entries })
	}

	return sections
}

export const ToolsSettings = ({ disabledTools, setCachedStateField, ...props }: ToolsSettingsProps) => {
	const { t } = useAppTranslation()
	const sections = useMemo(buildSections, [])

	const disabledSet = useMemo(() => new Set(disabledTools ?? []), [disabledTools])

	const handleToggle = (toolName: ToolName) => {
		const current = disabledTools ?? []
		const next = current.includes(toolName) ? current.filter((x) => x !== toolName) : [...current, toolName]
		setCachedStateField("disabledTools", next)
	}

	const handleDisableAllNonEssential = () => {
		const nonEssential: ToolName[] = []
		for (const section of sections) {
			if (section.id === "essential") continue
			for (const { name } of section.tools) nonEssential.push(name)
		}
		setCachedStateField("disabledTools", nonEssential)
	}

	const handleEnableAll = () => {
		setCachedStateField("disabledTools", [])
	}

	return (
		<div {...props}>
			<SectionHeader>{t("settings:sections.tools")}</SectionHeader>

			<Section>
				<div className="text-sm text-vscode-descriptionForeground mb-2">{t("settings:tools.description")}</div>
				<div className="text-xs text-vscode-descriptionForeground mb-4 italic">
					{t("settings:tools.scopeNote")}
				</div>

				{/* Header controls */}
				<div className="flex gap-2 mb-4">
					<Button variant="secondary" size="sm" onClick={handleDisableAllNonEssential}>
						{t("settings:tools.disableAllNonEssential")}
					</Button>
					<Button variant="secondary" size="sm" onClick={handleEnableAll}>
						{t("settings:tools.enableAll")}
					</Button>
				</div>

				{sections.map((section) => (
					<div key={section.id} className="mb-6">
						<div className="flex items-center gap-2 mb-2">
							<span className="font-semibold text-vscode-foreground">
								{t(`settings:tools.groups.${section.id}`)}
							</span>
							<span className="text-xs text-vscode-descriptionForeground">
								{t("settings:tools.groupToolCount", { count: section.tools.length })}
							</span>
						</div>

						<div className="space-y-1">
							{section.tools.map(({ name, isCustom }) => {
								const isEssential = section.id === "essential"
								const isToolDisabled = disabledSet.has(name)
								const aliases = REVERSE_ALIASES[name] ?? []
								const displayName = TOOL_DISPLAY_NAMES[name] ?? name

								const checkbox = (
									<VSCodeCheckbox
										checked={!isToolDisabled}
										disabled={isEssential}
										onChange={() => !isEssential && handleToggle(name)}
										data-testid={`tool-toggle-${name}`}
									/>
								)

								return (
									<SearchableSetting
										key={name}
										settingId={`tool-${name}`}
										section="tools"
										label={displayName}>
										<div className="flex items-center gap-2 py-1 px-2 rounded hover:bg-vscode-list-hoverBackground">
											{isEssential ? (
												<TooltipProvider>
													<Tooltip>
														<TooltipTrigger asChild>
															<span>{checkbox}</span>
														</TooltipTrigger>
														<TooltipContent>
															<p>{t("settings:tools.alwaysAvailableTooltip")}</p>
														</TooltipContent>
													</Tooltip>
												</TooltipProvider>
											) : (
												checkbox
											)}

											<code className="text-xs bg-vscode-textCodeBlock-background px-1.5 py-0.5 rounded font-mono">
												{name}
											</code>

											<span className="text-sm">{displayName}</span>

											<div className="flex gap-1 ml-auto">
												{isCustom && (
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
				))}
			</Section>
		</div>
	)
}
