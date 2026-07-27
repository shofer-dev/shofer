import { type GroupEntry, type ModeConfig, type PromptComponent } from "./mode.js"
import { type ToolGroup, TOOL_GROUPS, ALWAYS_AVAILABLE_TOOLS } from "./tool.js"

export type Mode = string

// Helper to extract group name regardless of format (string, tuple, or scoped object)
export function getGroupName(group: GroupEntry): ToolGroup {
	if (typeof group === "string") {
		return group
	}

	if (Array.isArray(group)) {
		return group[0]
	}

	// Scoped group entry: { "groupName": { allowed?, denied? } }
	return Object.keys(group)[0] as ToolGroup
}

// Helper to get all tools for a mode
export function getToolsForMode(
	tools: readonly GroupEntry[] | undefined,
	toolsAllowed?: readonly string[],
	toolsDenied?: readonly string[],
): string[] {
	const toolSet = new Set<string>()

	// Add tools from each group (excluding customTools which are opt-in only)
	if (tools) {
		tools.forEach((group) => {
			const groupName = getGroupName(group)
			const groupConfig = TOOL_GROUPS[groupName]

			// Extract group-level scope (allowed/denied) from scoped entries
			let scope: { allowed?: readonly string[]; denied?: readonly string[] } | undefined
			if (typeof group === "object" && !Array.isArray(group)) {
				scope = (group as Record<string, { allowed?: string[]; denied?: string[] }>)[groupName]
			}

			if (scope?.allowed) {
				// Exclusive list: only these tools from the group (must be subset)
				const groupTools = groupConfig.tools as readonly string[]
				scope.allowed.forEach((tool: string) => {
					if (groupTools.includes(tool)) {
						toolSet.add(tool)
					}
				})
			} else {
				// Add all tools from the group
				groupConfig.tools.forEach((tool: string) => toolSet.add(tool))
			}

			// Apply group-level denied (removes from what was added)
			if (scope?.denied) {
				scope.denied.forEach((tool: string) => toolSet.delete(tool))
			}
		})
	}

	// Add explicitly whitelisted tools from the mode's tools_allowed field (OR semantics)
	if (toolsAllowed) {
		toolsAllowed.forEach((tool: string) => toolSet.add(tool))
	}

	// Remove explicitly denied tools (denial takes priority over tool groups)
	if (toolsDenied) {
		toolsDenied.forEach((tool: string) => toolSet.delete(tool))
	}

	// Always add required tools
	ALWAYS_AVAILABLE_TOOLS.forEach((tool) => toolSet.add(tool))

	// Denial also applies to always-available tools
	if (toolsDenied) {
		toolsDenied.forEach((tool: string) => toolSet.delete(tool))
	}

	return Array.from(toolSet)
}

/**
 * The slug of the mode a task falls back to when its own mode cannot be resolved.
 *
 * This is a **platform constant, not a lookup**: modes themselves are data — Shofer's
 * own six ship in the bundled `builtin-modes` plugin, and a user, a project or an org
 * can add, override or (by suppressing that plugin) replace all of them. What stays
 * fixed is the *name* the platform reaches for first. If nothing defines `code`,
 * resolution falls through to whatever modes do exist; see {@link resolveModeConfig}.
 */
export const defaultModeSlug = "code"

/**
 * Look up a mode by slug.
 *
 * `modes` is the **effective** mode list — every mode the host knows about, which since
 * the built-ins moved into a plugin means plugin-contributed ones too (they reach the
 * host and the webview through the same `customModes` channel). There is no separate
 * built-in list to fall back to.
 */
export function getModeBySlug(slug: string, modes?: ModeConfig[]): ModeConfig | undefined {
	return modes?.find((mode) => mode.slug === slug)
}

/**
 * Resolve a slug to a concrete mode, preferring the requested one, then
 * {@link defaultModeSlug}, then the first mode that exists.
 *
 * Callers that build a system prompt need *some* mode; this is the one place that
 * decides which. It throws when the list is empty rather than inventing a mode — an
 * empty list means the built-in modes plugin is suppressed and nothing replaced it,
 * which is a misconfiguration the user has to see.
 */
export function resolveModeConfig(slug: string, modes: readonly ModeConfig[] | undefined): ModeConfig {
	const found = modes?.find((mode) => mode.slug === slug) ?? modes?.find((mode) => mode.slug === defaultModeSlug)
	if (found) {
		return found
	}
	const first = modes?.[0]
	if (!first) {
		throw new Error(
			"No modes are available: the built-in modes are disabled and no custom modes are defined. " +
				'Enable the "builtin-modes" plugin or define a mode in .shofer/shofermodes.',
		)
	}
	return first
}

export function getModeConfig(slug: string, customModes?: ModeConfig[]): ModeConfig {
	const mode = getModeBySlug(slug, customModes)
	if (!mode) {
		throw new Error(`No mode found for slug: ${slug}`)
	}
	return mode
}

/**
 * The effective, de-duplicated mode list.
 *
 * `modes` already carries every source merged in precedence order by the host's
 * `CustomModesManager` — project, then global, then plugin-contributed (which is where
 * Shofer's own six now come from). The earlier entry wins on a repeated slug, so a
 * project mode named `code` still shadows the built-in one.
 */
export function getAllModes(modes?: ModeConfig[]): ModeConfig[] {
	if (!modes?.length) {
		return []
	}

	const bySlug = new Map<string, ModeConfig>()
	for (const mode of modes) {
		if (!bySlug.has(mode.slug)) {
			bySlug.set(mode.slug, mode)
		}
	}
	return Array.from(bySlug.values())
}

/** Whether the mode comes from the user's or the project's own definitions. */
export function isCustomMode(slug: string, modes?: ModeConfig[]): boolean {
	const mode = getModeBySlug(slug, modes)
	return !!mode && mode.source !== "plugin"
}

/** Find a mode by its slug in an explicit list. */
export function findModeBySlug(slug: string, modes: readonly ModeConfig[] | undefined): ModeConfig | undefined {
	return modes?.find((mode) => mode.slug === slug)
}

/**
 * The mode a **user or project** authored, if this slug names one.
 *
 * The Modes view uses this to decide what may be edited, renamed or deleted: a
 * plugin-contributed mode (which is what Shofer's own six are) is read-only there —
 * it is owned by the plugin, and overriding it means authoring a mode of the same
 * slug, not mutating the plugin's copy.
 */
export function findAuthoredMode(slug: string, modes: readonly ModeConfig[] | undefined): ModeConfig | undefined {
	const mode = findModeBySlug(slug, modes)
	return mode && mode.source !== "plugin" ? mode : undefined
}

/**
 * Get the mode selection based on the provided mode slug, prompt component, and custom modes.
 * If a custom mode is found, it takes precedence over the built-in modes.
 * If no custom mode is found, the built-in mode is used with partial merging from promptComponent.
 * If neither is found, the default mode is used.
 */
export function getModeSelection(mode: string, promptComponent?: PromptComponent, modes?: ModeConfig[]) {
	const authored = findAuthoredMode(mode, modes)

	// A mode the user wrote is taken exactly as written — `customModePrompts` overrides
	// exist to reshape modes the user did NOT write (the plugin-contributed ones).
	if (authored) {
		return {
			roleDefinition: authored.roleDefinition || "",
			baseInstructions: authored.customInstructions || "",
			description: authored.description || "",
		}
	}

	const baseMode = resolveModeConfig(mode, modes)

	return {
		roleDefinition: promptComponent?.roleDefinition || baseMode.roleDefinition || "",
		baseInstructions: promptComponent?.customInstructions || baseMode.customInstructions || "",
		description: baseMode.description || "",
	}
}

// Custom error class for file restrictions
export class FileRestrictionError extends Error {
	constructor(mode: string, pattern: string, description: string | undefined, filePath: string, tool?: string) {
		const toolInfo = tool ? `Tool '${tool}' in mode '${mode}'` : `This mode (${mode})`
		super(
			`${toolInfo} can only edit files matching pattern: ${pattern}${description ? ` (${description})` : ""}. Got: ${filePath}`,
		)
		this.name = "FileRestrictionError"
	}
}

// Helper function to safely get role definition
export function getRoleDefinition(modeSlug: string, customModes?: ModeConfig[]): string {
	const mode = getModeBySlug(modeSlug, customModes)
	if (!mode) {
		console.warn(`No mode found for slug: ${modeSlug}`)
		return ""
	}
	return mode.roleDefinition
}

// Helper function to safely get description
export function getDescription(modeSlug: string, customModes?: ModeConfig[]): string {
	const mode = getModeBySlug(modeSlug, customModes)
	if (!mode) {
		console.warn(`No mode found for slug: ${modeSlug}`)
		return ""
	}
	return mode.description ?? ""
}

// Helper function to safely get whenToUse
export function getWhenToUse(modeSlug: string, customModes?: ModeConfig[]): string {
	const mode = getModeBySlug(modeSlug, customModes)
	if (!mode) {
		console.warn(`No mode found for slug: ${modeSlug}`)
		return ""
	}
	return mode.whenToUse ?? ""
}

// Helper function to safely get custom instructions
export function getCustomInstructions(modeSlug: string, customModes?: ModeConfig[]): string {
	const mode = getModeBySlug(modeSlug, customModes)
	if (!mode) {
		console.warn(`No mode found for slug: ${modeSlug}`)
		return ""
	}
	return mode.customInstructions ?? ""
}
