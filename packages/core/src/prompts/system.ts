import { getHost } from "@shofer/types"

import {
	type ModeConfig,
	type PromptComponent,
	type CustomModePrompts,
	type TodoItem,
	type ToolGroup,
} from "@shofer/types"
import { pluginRegistry } from "../plugins/plugin-registry.js"

import { Mode, defaultModeSlug, getGroupName, getModeSelection, resolveModeConfig } from "@shofer/types"
import { DiffStrategy } from "@shofer/types"
import { formatLanguage } from "@shofer/types"
import { isEmpty } from "../utils/object.js"

import { McpHub } from "../services/mcp/McpHub.js"
import type { SkillsManagerLike } from "../services/skills/skills-registry.js"

import { listSubmodules } from "../utils/git-submodules.js"

import type { SystemPromptSettings } from "./types.js"
import {
	getRulesSection,
	getSystemInfoSection,
	getObjectiveSection,
	getSharedToolUseSection,
	getToolUseGuidelinesSection,
	getCapabilitiesSection,
	getModesSection,
	addCustomInstructions,
	markdownFormattingSection,
	getSkillsSection,
} from "./sections/index.js"

// Helper function to get prompt component, filtering out empty objects
export function getPromptComponent(
	customModePrompts: CustomModePrompts | undefined,
	mode: string,
): PromptComponent | undefined {
	const component = customModePrompts?.[mode]
	// Return undefined if component is empty
	if (isEmpty(component)) {
		return undefined
	}
	return component
}

async function generatePrompt(
	context: unknown,
	cwd: string,
	supportsComputerUse: boolean,
	mode: Mode,
	mcpHub?: McpHub,
	diffStrategy?: DiffStrategy,
	promptComponent?: PromptComponent,
	customModeConfigs?: ModeConfig[],
	globalCustomInstructions?: string,
	experiments?: Record<string, boolean>,
	language?: string,
	shoferIgnoreInstructions?: string,
	settings?: SystemPromptSettings,
	todoList?: TodoItem[],
	modelId?: string,
	skillsManager?: SkillsManagerLike,
): Promise<string> {
	if (!context) {
		throw new Error("Extension context is required for generating system prompt")
	}

	// Get the full mode config to ensure we have the role definition (used for groups, etc.)
	const modeConfig = resolveModeConfig(mode, customModeConfigs)
	const { roleDefinition, baseInstructions } = getModeSelection(mode, promptComponent, customModeConfigs)

	// Effective capability groups: the mode's tools, optionally narrowed by a
	// workflow agent's `.slang` `tools:` restriction (settings.agentToolGroups).
	// When the restriction is set, the CAPABILITIES section is gated to only
	// what the agent can actually do; undefined ⇒ no gating.
	const modeGroupNames = new Set((modeConfig.tools ?? []).map((g) => getGroupName(g)))
	const capabilityGroups =
		settings?.agentToolGroups !== undefined
			? new Set(settings.agentToolGroups.filter((g) => modeGroupNames.has(g as ToolGroup)))
			: undefined

	// Check if MCP functionality should be included
	const hasMcpGroup = modeGroupNames.has("mcp")
	const hasMcpServers = mcpHub && mcpHub.getServers().length > 0
	// A `tools:` restriction that omits `mcp` also suppresses the MCP section.
	const mcpAllowedByRestriction = capabilityGroups === undefined || capabilityGroups.has("mcp")
	const shouldIncludeMcp = hasMcpGroup && hasMcpServers && mcpAllowedByRestriction

	// Per-task context overrides: each defaults to true (enabled) unless
	// explicitly suppressed via a workflow agent's `.slang` `context { ... }`.
	const includeSkills = settings?.includeSkills ?? true
	const includeSystemInfo = settings?.includeSystemInfo ?? true
	const includeMcp = settings?.includeMcp ?? true

	const [modesSection, rawSkillsSection] = await Promise.all([
		// Mode overrides are read through the host `state` capability (VS Code reads
		// `globalState`; a headless host returns none) — no `context` needed here.
		getModesSection(),
		getSkillsSection(skillsManager, mode as string),
	])
	const skillsSection = includeSkills ? rawSkillsSection : ""

	// Tools catalog is not included in the system prompt.
	const toolsCatalog = ""

	// Enumerate workspace submodules (recursively, including nested ones) for the
	// SYSTEM INFORMATION section, with URL/branch resolved from each submodule's
	// immediate superproject `.gitmodules`. Degrades to no block when git or
	// `.gitmodules` is unavailable.
	const submoduleList = await listSubmodules(cwd)
	const submoduleInfos = submoduleList.length > 0 ? submoduleList : undefined

	const basePrompt = `${roleDefinition}

${markdownFormattingSection()}

${getSharedToolUseSection()}${toolsCatalog}

	${getToolUseGuidelinesSection()}

${getCapabilitiesSection(cwd, shouldIncludeMcp && includeMcp ? mcpHub : undefined, capabilityGroups)}

${modesSection}
${skillsSection ? `\n${skillsSection}` : ""}
${getRulesSection(cwd, settings)}
${includeSystemInfo ? `\n${getSystemInfoSection(cwd, submoduleInfos)}` : ""}

${getObjectiveSection()}

${await addCustomInstructions(baseInstructions, globalCustomInstructions || "", cwd, mode, {
	language: language ?? formatLanguage(getHost().env.language),
	shoferIgnoreInstructions,
	settings,
})}`

	return basePrompt
}

export const SYSTEM_PROMPT = async (
	context: unknown,
	cwd: string,
	supportsComputerUse: boolean,
	mcpHub?: McpHub,
	diffStrategy?: DiffStrategy,
	mode: Mode = defaultModeSlug,
	customModePrompts?: CustomModePrompts,
	customModes?: ModeConfig[],
	globalCustomInstructions?: string,
	experiments?: Record<string, boolean>,
	language?: string,
	shoferIgnoreInstructions?: string,
	settings?: SystemPromptSettings,
	todoList?: TodoItem[],
	modelId?: string,
	skillsManager?: SkillsManagerLike,
): Promise<string> => {
	if (!context) {
		throw new Error("Extension context is required for generating system prompt")
	}

	// Check if it's a custom mode
	const promptComponent = getPromptComponent(customModePrompts, mode)

	const currentMode = resolveModeConfig(mode, customModes)

	const prompt = await generatePrompt(
		context,
		cwd,
		supportsComputerUse,
		currentMode.slug,
		mcpHub,
		diffStrategy,
		promptComponent,
		customModes,
		globalCustomInstructions,
		experiments,
		language,
		shoferIgnoreInstructions,
		settings,
		todoList,
		modelId,
		skillsManager,
	)

	// §10: let registered plugins transform the assembled prompt (no-op when no
	// plugins are registered — threaded in registration order).
	return pluginRegistry.applySystemPromptTransforms(prompt, { workspacePath: cwd, cwd, mode: currentMode.slug })
}
