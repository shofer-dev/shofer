import * as vscode from "vscode"

import {
	type ModeConfig,
	type PromptComponent,
	type CustomModePrompts,
	type TodoItem,
	type ToolGroup,
} from "@shofer/types"

import { Mode, modes, defaultModeSlug, getModeBySlug, getGroupName, getModeSelection } from "../../shared/modes"
import { DiffStrategy } from "../../shared/tools"
import { formatLanguage } from "../../shared/language"
import { isEmpty } from "../../utils/object"

import { McpHub } from "../../services/mcp/McpHub"
import { CodeIndexManager } from "../../services/code-index/manager"
import { SkillsManager } from "../../services/skills/SkillsManager"

import type { SystemPromptSettings } from "./types"
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
	getLiveMemorySection,
} from "./sections"

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
	context: vscode.ExtensionContext,
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
	skillsManager?: SkillsManager,
): Promise<string> {
	if (!context) {
		throw new Error("Extension context is required for generating system prompt")
	}

	// Get the full mode config to ensure we have the role definition (used for groups, etc.)
	const modeConfig = getModeBySlug(mode, customModeConfigs) || modes.find((m) => m.slug === mode) || modes[0]
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

	const codeIndexManager = CodeIndexManager.getInstance(context, cwd)

	// Tool calling is native-only.
	const effectiveProtocol = "native"

	// Per-task context overrides: each defaults to true (enabled) unless
	// explicitly suppressed via a workflow agent's `.slang` `context { ... }`.
	const includeSkills = settings?.includeSkills ?? true
	const includeSystemInfo = settings?.includeSystemInfo ?? true
	const includeMcp = settings?.includeMcp ?? true

	const [modesSection, rawSkillsSection] = await Promise.all([
		getModesSection(context),
		getSkillsSection(skillsManager, mode as string),
	])
	const skillsSection = includeSkills ? rawSkillsSection : ""

	// Resolve the LiveMemoryManager lazily to avoid circular-import issues
	// (system.ts ↔ Task.ts ↔ build-tools.ts ↔ LiveMemoryManager).
	let liveMemorySection = ""
	try {
		const { LiveMemoryManager: aam } = await import("../../services/live-memory/manager")
		const liveMemoryManager = aam.getInstance(context, cwd)
		liveMemorySection = getLiveMemorySection(cwd, liveMemoryManager)
	} catch {
		// Manager not yet wired or import failed; omit the section silently.
	}

	// Tools catalog is not included in the system prompt.
	const toolsCatalog = ""

	const basePrompt = `${roleDefinition}

${markdownFormattingSection()}

${getSharedToolUseSection()}${toolsCatalog}

	${getToolUseGuidelinesSection()}

${getCapabilitiesSection(cwd, shouldIncludeMcp && includeMcp ? mcpHub : undefined, capabilityGroups)}

${modesSection}
${skillsSection ? `\n${skillsSection}` : ""}
${getRulesSection(cwd, settings)}
${includeSystemInfo ? `\n${getSystemInfoSection(cwd)}` : ""}

${getObjectiveSection()}${liveMemorySection ? `\n\n${liveMemorySection}` : ""}

${await addCustomInstructions(baseInstructions, globalCustomInstructions || "", cwd, mode, {
	language: language ?? formatLanguage(vscode.env.language),
	shoferIgnoreInstructions,
	settings,
})}`

	return basePrompt
}

export const SYSTEM_PROMPT = async (
	context: vscode.ExtensionContext,
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
	skillsManager?: SkillsManager,
): Promise<string> => {
	if (!context) {
		throw new Error("Extension context is required for generating system prompt")
	}

	// Check if it's a custom mode
	const promptComponent = getPromptComponent(customModePrompts, mode)

	// Get full mode config from custom modes or fall back to built-in modes
	const currentMode = getModeBySlug(mode, customModes) || modes.find((m) => m.slug === mode) || modes[0]

	return generatePrompt(
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
}
