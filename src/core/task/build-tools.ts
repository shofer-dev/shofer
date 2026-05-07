import path from "path"
import * as vscode from "vscode"

import type OpenAI from "openai"

import type { ProviderSettings, ModeConfig, ModelInfo, ToolGroup } from "@roo-code/types"
import { toolGroupsSchema } from "@roo-code/types"
import { customToolRegistry, formatNative } from "@roo-code/core"

import type { ClineProvider } from "../webview/ClineProvider"
import { getRooDirectoriesForCwd } from "../../services/roo-config/index.js"

import { getNativeTools, getMcpServerTools } from "../prompts/tools/native-tools"
import {
	filterNativeToolsForMode,
	filterMcpToolsForMode,
	resolveToolAlias,
} from "../prompts/tools/filter-tools-for-mode"
import { defaultModeSlug, getGroupName, getModeBySlug } from "../../shared/modes"

interface BuildToolsOptions {
	provider: ClineProvider
	cwd: string
	mode: string | undefined
	customModes: ModeConfig[] | undefined
	experiments: Record<string, boolean> | undefined
	apiConfiguration: ProviderSettings | undefined
	disabledTools?: string[]
	modelInfo?: ModelInfo
	/**
	 * If true, returns all tools without mode filtering, but also includes
	 * the list of allowed tool names for use with allowedFunctionNames.
	 * This enables providers that support function call restrictions (e.g., Gemini)
	 * to pass all tool definitions while restricting callable tools.
	 */
	includeAllToolsWithRestrictions?: boolean
}

interface BuildToolsResult {
	/**
	 * The tools to pass to the model.
	 * If includeAllToolsWithRestrictions is true, this includes ALL tools.
	 * Otherwise, it includes only mode-filtered tools.
	 */
	tools: OpenAI.Chat.ChatCompletionTool[]
	/**
	 * The names of tools that are allowed to be called based on mode restrictions.
	 * Only populated when includeAllToolsWithRestrictions is true.
	 * Use this with allowedFunctionNames in providers that support it.
	 */
	allowedFunctionNames?: string[]
}

/**
 * Extracts the function name from a tool definition.
 */
function getToolName(tool: OpenAI.Chat.ChatCompletionTool): string {
	return (tool as OpenAI.Chat.ChatCompletionFunctionTool).function.name
}

/**
 * Build a set of Roo-Code's own native tool names.
 * Used to filter out Roo-Code tools from externally-registered LM tools
 * so they don't appear twice in the model's tool list.
 */
let _nativeToolNamesCache: Set<string> | null = null

function getNativeToolNames(): Set<string> {
	if (!_nativeToolNamesCache) {
		_nativeToolNamesCache = new Set(
			getNativeTools().map((t) => (t as OpenAI.Chat.ChatCompletionFunctionTool).function.name),
		)
	}
	return _nativeToolNamesCache
}

/**
 * Metadata for an external language model tool discovered via vscode.lm.tools.
 *
 * Each tool's group is resolved from the tool-authoring extension's
 * configuration (arkware.*.toolGroups), not inferred from name heuristics.
 */
interface ExternalLmToolMeta {
	tool: OpenAI.Chat.ChatCompletionFunctionTool
	/** The tool group assigned to this tool for mode filtering. */
	group: ToolGroup
}

/**
 * Resolve the ToolGroup for an external LM tool by reading the
 * tool-authoring extension's declared `toolGroups` configuration.
 *
 * Each extension that registers LM tools should contribute a
 * `toolGroups` property under its config namespace (e.g.,
 * `arkware.vscodeTools.toolGroups` for ide-tools).
 *
 * Resolution strategy:
 *  1. Read known config namespaces and look up the tool name.
 *  2. If found and the declared group is a valid ToolGroup, use it.
 *  3. Fall back to "uncategorized".
 *
 * @param toolName - The name of the tool (e.g., "ide_file_read")
 * @returns The ToolGroup declared by the tool's extension, or "uncategorized"
 */
function resolveExternalLmToolGroup(toolName: string): ToolGroup {
	// Known config namespaces for extensions that register LM tools.
	// Each maps a config section to its publisher prefix for tool matching.
	const configNamespaces: Array<{ section: string; toolPrefix: string }> = [
		{ section: "arkware.vscodeTools", toolPrefix: "ide_" },
		{ section: "arkware.browserTools", toolPrefix: "browser_" },
	]

	for (const ns of configNamespaces) {
		// Only check configs for tools whose names match the expected prefix.
		if (!toolName.startsWith(ns.toolPrefix)) continue

		try {
			const config = vscode.workspace.getConfiguration(ns.section)
			const toolGroups = config.get<Record<string, string>>("toolGroups")
			if (toolGroups && typeof toolGroups[toolName] === "string") {
				const declared = toolGroups[toolName]
				// Validate that the declared value is a known ToolGroup.
				if ((toolGroupsSchema.options as readonly string[]).includes(declared)) {
					return declared as ToolGroup
				}
			}
		} catch {
			// Config read failed — fall through to uncategorized.
		}
	}

	return "uncategorized"
}

/**
 * Get language model tools registered by other extensions via vscode.lm.tools,
 * each with an assigned tool group for mode filtering.
 *
 * VS Code's Language Model Tools API allows extensions to register tools that
 * are globally available to LLM providers. This function discovers those tools
 * at runtime, filters out Roo-Code's own native tools (already included via
 * getNativeTools()), and returns metadata including a group classification.
 *
 * @returns Array of external LM tool metadata with group assignments
 */
function getExternalLmToolMeta(): ExternalLmToolMeta[] {
	try {
		const nativeNames = getNativeToolNames()
		const allLmTools = vscode.lm.tools

		return allLmTools
			.filter((tool) => !nativeNames.has(tool.name))
			.map((tool) => ({
				tool: {
					type: "function" as const,
					function: {
						name: tool.name,
						description: tool.description || tool.name,
						parameters: (tool.inputSchema || {
							type: "object",
							properties: {},
						}) as OpenAI.FunctionParameters,
					},
				},
				group: resolveExternalLmToolGroup(tool.name),
			}))
	} catch {
		return []
	}
}

/**
 * Filter external LM tools by mode, using each tool's assigned group.
 *
 * A mode's `groups` list determines which ToolGroups are allowed. External
 * tools whose group is present in the mode's allowed groups are included.
 * An empty mode config (no groups) exposes all external tools.
 *
 * @param externalMeta - External tool metadata with group assignments
 * @param mode - Current mode slug
 * @param customModes - Custom mode configurations
 * @returns Filtered external tool definitions
 */
function filterExternalToolsForMode(
	externalMeta: ExternalLmToolMeta[],
	mode: string | undefined,
	customModes: ModeConfig[] | undefined,
): OpenAI.Chat.ChatCompletionFunctionTool[] {
	const modeSlug = mode ?? defaultModeSlug
	const modeConfig = getModeBySlug(modeSlug, customModes)

	// If no mode config, expose all external tools
	if (!modeConfig) {
		return externalMeta.map((m) => m.tool)
	}

	const allowedGroups = new Set<string>((modeConfig.groups ?? []).map((g) => getGroupName(g)))

	// If mode has no groups defined, expose all external tools
	if (allowedGroups.size === 0) {
		return externalMeta.map((m) => m.tool)
	}

	return externalMeta.filter((meta) => allowedGroups.has(meta.group)).map((meta) => meta.tool)
}

/**
 * Builds the complete tools array for native protocol requests.
 * Combines native tools and MCP tools, filtered by mode restrictions.
 *
 * @param options - Configuration options for building the tools
 * @returns Array of filtered native and MCP tools
 */
export async function buildNativeToolsArray(options: BuildToolsOptions): Promise<OpenAI.Chat.ChatCompletionTool[]> {
	const result = await buildNativeToolsArrayWithRestrictions(options)
	return result.tools
}

/**
 * Builds the complete tools array for native protocol requests with optional mode restrictions.
 * When includeAllToolsWithRestrictions is true, returns ALL tools but also provides
 * the list of allowed tool names for use with allowedFunctionNames.
 *
 * This enables providers like Gemini to pass all tool definitions to the model
 * (so it can reference historical tool calls) while restricting which tools
 * can actually be invoked via allowedFunctionNames in toolConfig.
 *
 * @param options - Configuration options for building the tools
 * @returns BuildToolsResult with tools array and optional allowedFunctionNames
 */
export async function buildNativeToolsArrayWithRestrictions(options: BuildToolsOptions): Promise<BuildToolsResult> {
	const {
		provider,
		cwd,
		mode,
		customModes,
		experiments,
		apiConfiguration,
		disabledTools,
		modelInfo,
		includeAllToolsWithRestrictions,
	} = options

	const mcpHub = provider.getMcpHub()

	// Get CodeIndexManager for feature checking.
	const { CodeIndexManager } = await import("../../services/code-index/manager")
	const codeIndexManager = CodeIndexManager.getInstance(provider.context, cwd)

	// Build settings object for tool filtering.
	const filterSettings = {
		todoListEnabled: apiConfiguration?.todoListEnabled ?? true,
		disabledTools,
		modelInfo,
	}

	// Check if the model supports images for read_file tool description.
	const supportsImages = modelInfo?.supportsImages ?? false

	// Build native tools with dynamic read_file tool based on settings.
	const nativeTools = getNativeTools({
		supportsImages,
	})

	// Filter native tools based on mode restrictions.
	const filteredNativeTools = filterNativeToolsForMode(
		nativeTools,
		mode,
		customModes,
		experiments,
		codeIndexManager,
		filterSettings,
		mcpHub,
	)

	// Filter MCP tools based on mode restrictions using per-tool group assignments.
	const mcpTools = getMcpServerTools(mcpHub)
	const mcpToolMeta = mcpHub?.getMcpToolMetadata() ?? []
	const filteredMcpTools = filterMcpToolsForMode(mcpTools, mcpToolMeta, mode, customModes, experiments)

	// Add custom tools if they are available and the experiment is enabled.
	let nativeCustomTools: OpenAI.Chat.ChatCompletionFunctionTool[] = []

	if (experiments?.customTools) {
		const toolDirs = getRooDirectoriesForCwd(cwd).map((dir) => path.join(dir, "tools"))
		await customToolRegistry.loadFromDirectoriesIfStale(toolDirs)
		const customTools = customToolRegistry.getAllSerialized()

		if (customTools.length > 0) {
			nativeCustomTools = customTools.map(formatNative)
		}
	}

	// Get tools registered by other extensions via vscode.lm.tools,
	// each with an assigned tool group for mode filtering.
	const externalLmMeta = getExternalLmToolMeta()
	const allExternalLmTools = externalLmMeta.map((meta) => meta.tool)
	const filteredExternalLmTools = filterExternalToolsForMode(externalLmMeta, mode, customModes)

	// Combine filtered tools (for backward compatibility and for allowedFunctionNames)
	const filteredTools = [
		...filteredNativeTools,
		...filteredMcpTools,
		...nativeCustomTools,
		...filteredExternalLmTools,
	]

	// If includeAllToolsWithRestrictions is true, return ALL tools but provide
	// allowed names based on mode filtering
	if (includeAllToolsWithRestrictions) {
		// Combine ALL tools (unfiltered native + all MCP + custom + external)
		const allTools = [...nativeTools, ...mcpTools, ...nativeCustomTools, ...allExternalLmTools]

		// Extract names of tools that are allowed based on mode filtering.
		// Resolve any alias names to canonical names to ensure consistency with allTools
		// (which uses canonical names). This prevents Gemini errors when tools are renamed
		// to aliases in filteredTools but allTools contains the original canonical names.
		const allowedFunctionNames = filteredTools.map((tool) => resolveToolAlias(getToolName(tool)))

		return {
			tools: allTools,
			allowedFunctionNames,
		}
	}

	// Default behavior: return only filtered tools
	return {
		tools: filteredTools,
	}
}
