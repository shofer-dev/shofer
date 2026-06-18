import path from "path"
import * as vscode from "vscode"

import type OpenAI from "openai"

import type { ProviderSettings, ModeConfig, ModelInfo, ToolGroup } from "@shofer/types"
import { toolGroupsSchema } from "@shofer/types"
import { customToolRegistry, formatNative } from "@shofer/core"

import type { ShoferProvider } from "../webview/ShoferProvider"
import { getRooDirectoriesForCwd } from "../../services/shofer-config/index.js"

import { getNativeTools, getMcpServerTools } from "../prompts/tools/native-tools"
import {
	filterNativeToolsForMode,
	filterMcpToolsForMode,
	resolveToolAlias,
} from "../prompts/tools/filter-tools-for-mode"
import { defaultModeSlug, getGroupName, getModeBySlug, getToolsForMode } from "../../shared/modes"

interface BuildToolsOptions {
	provider: ShoferProvider
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
	/**
	 * Per-task JSON Schema override for the `attempt_completion` tool's
	 * `result` parameter. Threaded from {@link Task.completionSchema}.
	 * When set, the generic `result: string` is replaced with a structured
	 * object schema.
	 */
	completionSchema?: Record<string, unknown>
	/**
	 * When true, this task's title was locked by its spawning parent (via
	 * `new_task`'s `title`), so the `set_task_title` tool is omitted from the
	 * tool list entirely — the agent can't even attempt a rename. Threaded from
	 * {@link Task.nameLocked}.
	 */
	titleLocked?: boolean
	/**
	 * Per-task tool-group allow-list (workflow agents' `.slang` `tools:`).
	 * Threaded from {@link Task.agentToolGroups}. When set, the final tool list
	 * is intersected with these groups — a tool survives only if its group is
	 * declared (native tools resolved via `TOOL_GROUPS`, MCP tools via the
	 * `mcp` group, private/custom tools via their own group), EXCEPT
	 * `ALWAYS_AVAILABLE_TOOLS`, which are always retained so the agent can still
	 * complete/coordinate. This is a restriction layered on top of mode
	 * filtering — it can only remove tools, never add them. Unknown group names
	 * are ignored.
	 */
	agentToolGroups?: string[]
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

// ──────────────────────────────────────────────
// Private Tool Provider system
// ──────────────────────────────────────────────
//
// Extensions register tools via the `shofer.privateToolProviders` VS Code
// configuration, not via `vscode.lm.tools` (which is Copilot's interface).
// Each provider exposes two commands:
//
//   <getDefinitionsCommand>  → returns Array<{name, description, inputSchema, group?}>
//   <invokeToolCommand>      → takes (name, input), returns {content, is_error?}
//
// See docs/tool-registration-interface.md for the full contract.

/** Configuration shape for a single private tool provider. */
interface PrivateToolProviderConfig {
	/** VS Code command ID that returns all tool definitions. */
	getDefinitionsCommand: string
	/** VS Code command ID that invokes a tool by name. */
	invokeToolCommand: string
}

/** A tool definition returned by a provider's getDefinitions command. */
interface PrivateToolDef {
	name: string
	description: string
	inputSchema: object
	/** Optional tool group override. Falls back to provider config. */
	group?: string
}

/** Metadata for a single tool discovered from a private provider. */
interface PrivateToolMeta {
	tool: OpenAI.Chat.ChatCompletionFunctionTool
	group: ToolGroup
	/** The VS Code command to invoke this tool at execution time. */
	invokeCommand: string
}

/**
 * Read all registered private tool providers from config and discover
 * their tools. Returns a combined list with group assignments and
 * invocation commands.
 *
 * Config key: `shofer.privateToolProviders`
 */
async function getPrivateLmToolMeta(): Promise<PrivateToolMeta[]> {
	const config = vscode.workspace.getConfiguration("shofer")
	const providers = config.get<Record<string, PrivateToolProviderConfig>>("privateToolProviders", {})

	const allMeta: PrivateToolMeta[] = []

	for (const [providerId, providerCfg] of Object.entries(providers)) {
		if (!providerCfg?.getDefinitionsCommand || !providerCfg?.invokeToolCommand) continue

		try {
			const definitions = await vscode.commands.executeCommand<PrivateToolDef[] | undefined>(
				providerCfg.getDefinitionsCommand,
			)

			if (!definitions || !Array.isArray(definitions)) continue

			for (const def of definitions) {
				const group = resolvePrivateToolGroup(providerId, def)
				allMeta.push({
					tool: {
						type: "function" as const,
						function: {
							name: def.name,
							description: def.description || def.name,
							parameters: (def.inputSchema || {
								type: "object",
								properties: {},
							}) as OpenAI.FunctionParameters,
						},
					},
					group,
					invokeCommand: providerCfg.invokeToolCommand,
				})
			}
		} catch {
			// Provider extension not installed or not activated — skip.
		}
	}

	return allMeta
}

/**
 * Resolve the ToolGroup for a private tool:
 *  1. If the tool definition has an explicit `group`, validate and use it.
 *  2. Fall back to the provider's `shofer.<providerId>.toolGroups` config.
 *  3. Default to "uncategorized".
 */
function resolvePrivateToolGroup(providerId: string, def: PrivateToolDef): ToolGroup {
	// 1. Explicit group in the definition
	if (def.group && (toolGroupsSchema.options as readonly string[]).includes(def.group)) {
		return def.group as ToolGroup
	}

	// 2. Provider-level config
	try {
		const config = vscode.workspace.getConfiguration(`shofer.${providerId}`)
		const toolGroups = config.get<Record<string, string>>("toolGroups")
		if (toolGroups && typeof toolGroups[def.name] === "string") {
			const declared = toolGroups[def.name]
			if ((toolGroupsSchema.options as readonly string[]).includes(declared)) {
				return declared as ToolGroup
			}
		}
	} catch {
		// Config read failed.
	}

	return "uncategorized"
}

/**
 * Lookup map: tool name → invoke command, built during discovery.
 * Used by the execution layer (presentAssistantMessage.ts) to route
 * private tool invocations to the correct provider.
 */
let _privateToolInvokeMap: Map<string, string> | null = null

/**
 * Return the invoke command for a private tool name, or undefined
 * if the name is not a known private tool.
 */
export function getPrivateToolInvokeCommand(toolName: string): string | undefined {
	return _privateToolInvokeMap?.get(toolName)
}

/**
 * Check whether a tool name belongs to any registered private provider.
 */
export function isPrivateLmTool(toolName: string): boolean {
	return _privateToolInvokeMap?.has(toolName) ?? false
}

/**
 * Filter private tools by mode, using each tool's assigned group.
 *
 * @param privateMeta - Private tool metadata with group assignments
 * @param mode - Current mode slug
 * @param customModes - Custom mode configurations
 * @returns Filtered private tool definitions
 */
function filterPrivateToolsForMode(
	privateMeta: PrivateToolMeta[],
	mode: string | undefined,
	customModes: ModeConfig[] | undefined,
): OpenAI.Chat.ChatCompletionFunctionTool[] {
	const modeSlug = mode ?? defaultModeSlug
	const modeConfig = getModeBySlug(modeSlug, customModes)

	if (!modeConfig) {
		return privateMeta.map((m) => m.tool)
	}

	const allowedGroups = new Set<string>((modeConfig.tools ?? []).map((g) => getGroupName(g)))

	if (allowedGroups.size === 0) {
		return privateMeta.map((m) => m.tool)
	}

	return privateMeta.filter((meta) => allowedGroups.has(meta.group)).map((meta) => meta.tool)
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

/** The already-mode-filtered tool categories, plus the private-tool metadata
 *  needed to resolve each private tool's group. */
export interface ToolCategories {
	native: OpenAI.Chat.ChatCompletionTool[]
	mcp: OpenAI.Chat.ChatCompletionTool[]
	custom: OpenAI.Chat.ChatCompletionFunctionTool[]
	private: OpenAI.Chat.ChatCompletionFunctionTool[]
	privateMeta: PrivateToolMeta[]
}

/**
 * Apply a workflow agent's declared `.slang` `tools:` restriction to the
 * already-mode-filtered tool set. Pure intersection — only removes tools,
 * never adds them.
 *
 * Semantics:
 * - `agentToolGroups === undefined` → no restriction (returns categories as-is).
 * - declared (incl. `[]`) → keep a tool only if its group is declared. Native
 *   tools are matched via `getToolsForMode` (which also re-adds
 *   `ALWAYS_AVAILABLE_TOOLS`, so `attempt_completion` etc. always survive — a
 *   restricted agent can still complete stakes). MCP tools belong to the `mcp`
 *   group; native custom tools to `write`; private tools carry their own group.
 * - Unknown group names are dropped (fail-closed): `tools: [typo]` restricts to
 *   always-available only.
 */
export function restrictToolsToDeclaredGroups(
	agentToolGroups: string[] | undefined,
	categories: ToolCategories,
): Omit<ToolCategories, "privateMeta"> {
	const { native, mcp, custom, private: priv, privateMeta } = categories
	if (agentToolGroups === undefined) {
		return { native, mcp, custom, private: priv }
	}
	const declaredGroups = agentToolGroups.filter((g): g is ToolGroup =>
		(toolGroupsSchema.options as readonly string[]).includes(g),
	)
	const declaredSet = new Set<ToolGroup>(declaredGroups)
	const allowedNativeNames = new Set(getToolsForMode(declaredGroups))
	const privateGroupByName = new Map(privateMeta.map((m) => [getToolName(m.tool), m.group]))
	return {
		native: native.filter((t) => allowedNativeNames.has(resolveToolAlias(getToolName(t)))),
		mcp: declaredSet.has("mcp") ? mcp : [],
		custom: declaredSet.has("write") ? custom : [],
		private: priv.filter((t) => {
			const g = privateGroupByName.get(getToolName(t))
			return g !== undefined && declaredSet.has(g)
		}),
	}
}

/**
 * Builds the complete tools array for native protocol requests with optional mode restrictions.
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

	const { CodeIndexManager } = await import("../../services/code-index/manager")
	const codeIndexManager = CodeIndexManager.getInstance(provider.context, cwd)

	const { GitIndexManager } = await import("../../services/git-index/git-index-manager")
	const gitIndexManager = GitIndexManager.getInstance(provider.context, cwd)

	const { LiveMemoryManager } = await import("../../services/live-memory/manager")
	const liveMemoryManager = LiveMemoryManager.getInstance(provider.context, cwd)

	const filterSettings = {
		todoListEnabled: apiConfiguration?.todoListEnabled ?? true,
		disabledTools,
		modelInfo,
	}

	const supportsImages = modelInfo?.supportsImages ?? false

	const nativeTools = getNativeTools({
		supportsImages,
		completionSchema: options.completionSchema,
		titleLocked: options.titleLocked,
	})

	const filteredNativeTools = filterNativeToolsForMode(
		nativeTools,
		mode,
		customModes,
		experiments,
		codeIndexManager,
		gitIndexManager,
		filterSettings,
		mcpHub,
		liveMemoryManager,
	)

	const mcpTools = getMcpServerTools(mcpHub)
	const mcpToolMeta = mcpHub?.getMcpToolMetadata() ?? []
	const filteredMcpTools = filterMcpToolsForMode(mcpTools, mcpToolMeta, mode, customModes, experiments)

	let nativeCustomTools: OpenAI.Chat.ChatCompletionFunctionTool[] = []
	if (experiments?.customTools) {
		const toolDirs = getRooDirectoriesForCwd(cwd).map((dir) => path.join(dir, "tools"))
		await customToolRegistry.loadFromDirectoriesIfStale(toolDirs)
		const customTools = customToolRegistry.getAllSerialized()
		if (customTools.length > 0) {
			nativeCustomTools = customTools.map(formatNative)
		}
	}

	// Discover all tools from private providers (extensions using the
	// shofer.privateToolProviders config convention).
	const privateMeta = await getPrivateLmToolMeta()
	const allPrivateTools = privateMeta.map((m) => m.tool)
	const filteredPrivateTools = filterPrivateToolsForMode(privateMeta, mode, customModes)

	// Build the invoke-command lookup map for the execution layer.
	_privateToolInvokeMap = new Map(privateMeta.map((m) => [getToolName(m.tool), m.invokeCommand]))

	// Per-task `.slang` `tools:` restriction (no-op when the field is absent).
	const {
		native: restrictedNative,
		mcp: restrictedMcp,
		custom: restrictedCustom,
		private: restrictedPrivate,
	} = restrictToolsToDeclaredGroups(options.agentToolGroups, {
		native: filteredNativeTools,
		mcp: filteredMcpTools,
		custom: nativeCustomTools,
		private: filteredPrivateTools,
		privateMeta,
	})

	const filteredTools = [...restrictedNative, ...restrictedMcp, ...restrictedCustom, ...restrictedPrivate]

	if (includeAllToolsWithRestrictions) {
		const allTools = [...nativeTools, ...mcpTools, ...nativeCustomTools, ...allPrivateTools]
		const allowedFunctionNames = filteredTools.map((tool) => resolveToolAlias(getToolName(tool)))
		return { tools: allTools, allowedFunctionNames }
	}

	return { tools: filteredTools }
}
