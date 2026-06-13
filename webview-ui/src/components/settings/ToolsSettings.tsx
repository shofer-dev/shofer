import { HTMLAttributes, forwardRef, useImperativeHandle, useMemo, useState } from "react"

import {
	TOOL_DISPLAY_NAMES,
	TOOL_GROUPS,
	ALWAYS_AVAILABLE_TOOLS,
	TOOL_ALIASES,
	toolGroups,
	type ToolGroup,
	type ToolName,
} from "@shofer/types"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { vscode } from "@/utils/vscode"
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

import type { McpServer } from "@shofer/types"

type ToolsSettingsProps = HTMLAttributes<HTMLDivElement> & {
	disabledTools?: ToolName[]
	setCachedStateField: SetCachedStateField<"disabledTools">
	mcpServers?: McpServer[]
	/**
	 * Fired when an MCP per-tool toggle is staged. `SettingsView` wires this to
	 * `setChangeDetected(true)` so the Save button enables. (Native-tool toggles
	 * dirty the form via `setCachedStateField`.)
	 */
	onToolsDirty?: () => void
}

/** Imperative handle so `SettingsView` can apply/drop staged MCP toggles. */
export interface ToolsSettingsRef {
	/** Apply staged MCP per-tool enable/disable changes. Called from handleSubmit on Save. */
	commitToolBuffers: () => void
	/** Drop staged MCP changes. Called on Discard. */
	discardToolBuffers: () => void
}

const mcpKey = (serverName: string, source: "global" | "project", toolName: string): string =>
	`${serverName} ${source} ${toolName}`

/**
 * Represents an MCP tool entry for display alongside native tools.
 */
interface McpToolEntry {
	/** The MCP server name this tool belongs to */
	serverName: string
	/** Source of the server config ("global" | "project") */
	serverSource: "global" | "project"
	/** The tool name as used in the MCP protocol */
	toolName: string
	/** The resolved group this tool belongs to */
	group: ToolGroup
	/** Whether the tool is currently enabled for prompting */
	enabled: boolean
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
	tools: ReadonlyArray<{
		name: ToolName
		isCustom: boolean
		isMcp?: boolean
		mcpDisplayName?: string
		serverName?: string
		/** Raw MCP tool name (without `mcp--<server>--` prefix). */
		mcpToolName?: string
		/** MCP server source ("global" | "project"). */
		serverSource?: "global" | "project"
		/** For MCP tools, the user-controlled enabled-for-prompt state. */
		mcpEnabled?: boolean
	}>
}

/**
 * Extracts tools from MCP servers and organizes them by their assigned groups.
 */
function extractMcpTools(mcpServers: McpServer[] = []): McpToolEntry[] {
	const tools: McpToolEntry[] = []

	for (const server of mcpServers) {
		// Skip disabled servers
		if (server.disabled) continue

		// Skip disconnected servers (no tools)
		if (!server.tools || server.tools.length === 0) continue

		// Deduplicate tool names across servers
		const seenTools = new Set<string>()

		for (const tool of server.tools) {
			const toolKey = `${server.name}__${tool.name}`
			if (seenTools.has(toolKey)) continue
			seenTools.add(toolKey)

			tools.push({
				serverName: server.name,
				serverSource: server.source ?? "global",
				toolName: tool.name,
				group: (tool.group ?? "uncategorized") as ToolGroup,
				enabled: tool.enabledForPrompt ?? true,
			})
		}
	}

	return tools
}

function buildSections(mcpServers: McpServer[] = []): Section[] {
	const seen = new Set<ToolName>()
	const sections: Section[] = []

	const essentialTools = ALWAYS_AVAILABLE_TOOLS.filter((t) => !META_TOOL_NAMES.has(t))
	for (const t of essentialTools) seen.add(t)
	sections.push({
		id: "essential",
		tools: essentialTools.map((name) => ({ name, isCustom: false })),
	})

	// Add native tools
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

	// Add MCP tools grouped by their assigned group
	const mcpTools = extractMcpTools(mcpServers)
	const toolsByGroup = mcpTools.reduce<Record<ToolGroup, McpToolEntry[]>>(
		(acc, tool) => {
			if (!acc[tool.group]) acc[tool.group] = []
			acc[tool.group].push(tool)
			return acc
		},
		{} as Record<ToolGroup, McpToolEntry[]>,
	)

	// Append MCP tools to their respective group sections
	for (const group of toolGroups) {
		const section = sections.find((s) => s.id === group)
		const mcpGroupTools = toolsByGroup[group]

		if (mcpGroupTools && mcpGroupTools.length > 0) {
			const existingTools = section?.tools ?? []
			const mcpToolEntries = mcpGroupTools.map((tool) => ({
				name: `mcp--${tool.serverName}--${tool.toolName}` as ToolName,
				isCustom: false,
				isMcp: true,
				mcpDisplayName: `${tool.serverName}: ${tool.toolName}`,
				serverName: tool.serverName,
				mcpToolName: tool.toolName,
				serverSource: tool.serverSource,
				mcpEnabled: tool.enabled,
			}))

			// If section exists, append tools; otherwise create new section
			if (section) {
				section.tools = [...existingTools, ...mcpToolEntries]
			} else {
				sections.push({ id: group, tools: mcpToolEntries })
			}
		}
	}

	return sections
}

export const ToolsSettings = forwardRef<ToolsSettingsRef, ToolsSettingsProps>(function ToolsSettings(
	{ disabledTools, setCachedStateField, mcpServers, onToolsDirty, ...props },
	ref,
) {
	const { t } = useAppTranslation()
	const sections = useMemo(() => buildSections(mcpServers), [mcpServers])

	const disabledSet = useMemo(() => new Set(disabledTools ?? []), [disabledTools])

	// Staged MCP per-tool toggles. MCP tool enablement lives in mcp.json
	// (per-server), not in cachedState, so buffer changes here and apply them on
	// Save via the imperative handle — keeping the Tools panel save-gated like the
	// rest of Settings. Keyed by server+source+tool; only entries that differ from
	// the live state are kept. [Settings View Pattern]
	const [pendingMcp, setPendingMcp] = useState<
		Map<string, { serverName: string; source: "global" | "project"; toolName: string; isEnabled: boolean }>
	>(new Map())

	const effectiveMcpEnabled = (entry: {
		serverName?: string
		serverSource?: "global" | "project"
		mcpToolName?: string
		mcpEnabled?: boolean
	}): boolean => {
		if (entry.serverName && entry.mcpToolName) {
			const staged = pendingMcp.get(mcpKey(entry.serverName, entry.serverSource ?? "global", entry.mcpToolName))
			if (staged) return staged.isEnabled
		}
		return entry.mcpEnabled ?? true
	}

	const stageMcp = (
		entry: { serverName?: string; serverSource?: "global" | "project"; mcpToolName?: string; mcpEnabled?: boolean },
		isEnabled: boolean,
	) => {
		if (!entry.serverName || !entry.mcpToolName) return
		const serverName = entry.serverName
		const toolName = entry.mcpToolName
		const source = entry.serverSource ?? "global"
		const k = mcpKey(serverName, source, toolName)
		const live = entry.mcpEnabled ?? true
		setPendingMcp((prev) => {
			const next = new Map(prev)
			if (isEnabled === live) {
				next.delete(k) // back to the live value — nothing to apply
			} else {
				next.set(k, { serverName, source, toolName, isEnabled })
			}
			return next
		})
		onToolsDirty?.()
	}

	useImperativeHandle(
		ref,
		(): ToolsSettingsRef => ({
			commitToolBuffers: () => {
				for (const { serverName, source, toolName, isEnabled } of pendingMcp.values()) {
					vscode.postMessage({ type: "toggleToolEnabledForPrompt", serverName, source, toolName, isEnabled })
				}
				setPendingMcp(new Map())
			},
			discardToolBuffers: () => setPendingMcp(new Map()),
		}),
		[pendingMcp],
	)

	/**
	 * Toggle a single tool's prompt-inclusion state. Save-gated:
	 *  - Native tools: staged in global `disabledTools` (cachedState).
	 *  - MCP tools: staged in `pendingMcp`; applied on Save via the imperative
	 *    handle (`toggleToolEnabledForPrompt` → `McpHub` → `mcp.json`).
	 */
	const handleToggle = (entry: {
		name: ToolName
		isMcp?: boolean
		serverName?: string
		serverSource?: "global" | "project"
		mcpToolName?: string
		mcpEnabled?: boolean
	}) => {
		if (entry.isMcp && entry.serverName && entry.mcpToolName) {
			stageMcp(entry, !effectiveMcpEnabled(entry))
			return
		}
		const current = disabledTools ?? []
		const next = current.includes(entry.name) ? current.filter((x) => x !== entry.name) : [...current, entry.name]
		setCachedStateField("disabledTools", next)
	}

	const handleDisableAllNonEssential = () => {
		const nonEssential: ToolName[] = []
		for (const section of sections) {
			if (section.id === "essential") continue
			for (const entry of section.tools) {
				if (entry.isMcp && entry.serverName && entry.mcpToolName) {
					stageMcp(entry, false)
				} else {
					nonEssential.push(entry.name)
				}
			}
		}
		setCachedStateField("disabledTools", nonEssential)
	}

	const handleEnableAll = () => {
		for (const section of sections) {
			for (const entry of section.tools) {
				if (entry.isMcp && entry.serverName && entry.mcpToolName) {
					stageMcp(entry, true)
				}
			}
		}
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
							{section.tools.map((entry) => {
								const { name, isCustom, isMcp, mcpDisplayName } = entry
								const isEssential = section.id === "essential"
								// MCP tools: read enabled state from per-server `mcp.json` (via the
								// `mcpServers` prop). Native tools: read from global `disabledTools`.
								const isToolDisabled = isMcp ? !effectiveMcpEnabled(entry) : disabledSet.has(name)
								const aliases = REVERSE_ALIASES[name] ?? []
								const displayName = mcpDisplayName ?? TOOL_DISPLAY_NAMES[name] ?? name

								const checkbox = (
									<VSCodeCheckbox
										checked={!isToolDisabled}
										disabled={isEssential}
										onChange={() => !isEssential && handleToggle(entry)}
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
												{isMcp && (
													<span className="text-xs bg-blue-100 text-blue-800 px-1.5 py-0.5 rounded">
														{t("settings:tools.badges.mcpTool")}
													</span>
												)}
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
})

ToolsSettings.displayName = "ToolsSettings"
