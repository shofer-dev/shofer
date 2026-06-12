import * as vscode from "vscode"
import type { ToolName, ModeConfig, ExperimentId, GroupOptions, GroupEntry } from "@shofer/types"
import { toolNames as validToolNames } from "@shofer/types"
import { customToolRegistry } from "@shofer/core"

import { type Mode, FileRestrictionError, getModeBySlug, getGroupName } from "../../shared/modes"
import { EXPERIMENT_IDS } from "../../shared/experiments"
import { TOOL_GROUPS, ALWAYS_AVAILABLE_TOOLS, TOOL_ALIASES } from "../../shared/tools"

/**
 * Check whether a tool name belongs to a tool from a private provider
 * (shofer.privateToolProviders config convention).
 *
 * Tools from VS Code built-in extensions (e.g., GitHub Copilot) are excluded —
 * they are tightly coupled to their owning extension's internal orchestration
 * and reject invocations from outside callers.
 */
import { isPrivateLmTool } from "../task/build-tools"
import { taskLog } from "../../utils/logging/subsystems"

/**
 * Checks if a tool name is a valid, known tool.
 * Note: This does NOT check if the tool is allowed for a specific mode,
 * only that the tool actually exists.
 */
export function isValidToolName(toolName: string, experiments?: Record<string, boolean>): toolName is ToolName {
	// Check if it's a valid static tool
	if ((validToolNames as readonly string[]).includes(toolName)) {
		return true
	}

	if (experiments?.customTools && customToolRegistry.has(toolName)) {
		return true
	}

	// Check if it's a dynamic MCP tool (mcp_serverName_toolName format).
	if (toolName.startsWith("mcp_")) {
		return true
	}

	// Check if it's a tool from a private provider
	// (shofer.privateToolProviders config convention).
	if (isPrivateLmTool(toolName)) {
		return true
	}

	return false
}

export function validateToolUse(
	toolName: ToolName,
	mode: Mode,
	customModes?: ModeConfig[],
	toolRequirements?: Record<string, boolean>,
	toolParams?: Record<string, unknown>,
	experiments?: Record<string, boolean>,
	includedTools?: string[],
): void {
	// First, check if the tool name is actually a valid/known tool
	// This catches completely invalid tool names like "edit_file" that don't exist
	if (!isValidToolName(toolName, experiments)) {
		throw new Error(
			`Unknown tool "${toolName}". This tool does not exist. Please use one of the available tools: ${validToolNames.join(", ")}.`,
		)
	}

	// Disabled-by-user check (Settings → Tools) takes priority over mode restrictions.
	// `toolRequirements` is built from the global `disabledTools` list and maps each
	// disabled tool (and its alias) to `false`. A disabled tool is intentionally
	// removed from the LLM's tool catalog by `filterNativeToolsForMode`; if the model
	// still calls it (typically because it hallucinated the tool from training data),
	// we must give a distinct, actionable error so the model stops retrying. The
	// generic "not allowed in <mode> mode" message previously used here led the model
	// to attempt mode switches that could never resolve the situation.
	const resolvedToolName = TOOL_ALIASES[toolName] ?? toolName
	const isDisabledByUser =
		!!toolRequirements &&
		typeof toolRequirements === "object" &&
		((toolName in toolRequirements && !toolRequirements[toolName]) ||
			(resolvedToolName in toolRequirements && !toolRequirements[resolvedToolName]))

	if (isDisabledByUser) {
		throw new Error(
			`Tool "${toolName}" has been disabled by the user in Settings → Tools and is not available in any mode. Do not attempt to call it again. Use a different tool to accomplish the task.`,
		)
	}

	// Then check if the tool is allowed for the current mode
	if (
		!isToolAllowedForMode(
			toolName,
			mode,
			customModes ?? [],
			toolRequirements,
			toolParams,
			experiments,
			includedTools,
		)
	) {
		throw new Error(`Tool "${toolName}" is not allowed in ${mode} mode.`)
	}
}

// Tools in the write group that mutate filesystem paths.
// Used to gate fileRegex enforcement — only these tools are subject to per-file
// restriction checks; read-only tools in the write group (none currently) are not.
const WRITE_MUTATOR_TOOLS = new Set([
	"write_to_file",
	"apply_diff",
	"insert_edit",
	"rename_symbol",
	"create_directory",
	"create_new_workspace",
	"file",
	"sed",
	"generate_image",
	// Custom tools
	"search_replace",
	"edit_file",
	"edit",
	"apply_patch",
])

/**
 * For each write-group mutator, the params that must be present before fileRegex
 * enforcement activates. Prevents premature rejection during streaming partial-param
 * parsing, where e.g. `{path: "test.js"}` arrives for `write_to_file` before
 * `content` has been streamed.
 *
 * Tools with an empty array (e.g. create_directory) validate as soon as `path`
 * appears — they have no secondary mutation-indicator param.
 */
const MUTATION_GATING_PARAMS: Record<string, string[]> = {
	write_to_file: ["content"],
	apply_diff: ["diff"],
	insert_edit: ["line", "text"],
	rename_symbol: ["newName"],
	sed: ["pattern", "replacement"],
	file: ["subcommand"],
	create_directory: [],
	// create_new_workspace mutates `${path}/${name}`; getMutatedPaths needs BOTH
	// to resolve a target, so both are listed here. Until both have streamed,
	// getMutatedPaths returns [] and enforcement is a safe no-op. Both are
	// schema-required, so a complete call always carries both and is enforced.
	create_new_workspace: ["path", "name"],
	generate_image: ["prompt"],
	search_replace: ["old_string", "new_string"],
	edit_file: ["old_string", "new_string"],
	edit: ["old_string", "new_string"],
	apply_patch: ["patch"],
}

/**
 * Extract the file/directory paths that a tool call would mutate.
 * Returns paths relative to the workspace, or an empty array if none can be
 * determined from the supplied params.
 *
 * This is the single source of truth for "which paths does this tool touch?"
 * — fileRegex enforcement and any future path-based policy checks should all
 * resolve through this function rather than inferring intent from coincidental
 * param names.
 */
function getMutatedPaths(tool: string, toolParams: Record<string, any>): string[] {
	switch (tool) {
		case "write_to_file":
		case "apply_diff":
		case "sed":
			return toolParams.path ? [toolParams.path] : []

		case "insert_edit": {
			const p = toolParams.path || toolParams.filePath
			return p ? [p] : []
		}

		case "rename_symbol": {
			// KNOWN LIMITATION: rename_symbol applies a WorkspaceEdit across every
			// file referencing the symbol (see RenameSymbolTool), but the full set
			// is only computed by VS Code's LSP at execution time — it cannot be
			// derived from the call params here. We therefore validate fileRegex
			// only against the declaration file (`path`). A restricted mode could
			// thus still mutate referencing files outside its fileRegex.
			// TODO: enforce fileRegex against every affected path inside
			// RenameSymbolTool.execute(), after the WorkspaceEdit is resolved.
			const p = toolParams.path || toolParams.filePath
			return p ? [p] : []
		}

		case "create_directory":
			return toolParams.path ? [toolParams.path] : []

		case "create_new_workspace":
			if (toolParams.path && toolParams.name) {
				return [
					typeof toolParams.path === "string" && typeof toolParams.name === "string"
						? `${toolParams.path}/${toolParams.name}`
						: String(toolParams.path),
				]
			}
			return []

		case "file": {
			const paths: string[] = []
			if (toolParams.path) paths.push(toolParams.path)
			// mv mutates both source and destination
			if (toolParams.subcommand === "mv" && toolParams.destination) {
				paths.push(toolParams.destination)
			}
			return paths
		}

		case "generate_image":
			return toolParams.path ? [toolParams.path] : []

		case "search_replace":
		case "edit_file":
		case "edit":
			return toolParams.file_path ? [toolParams.file_path] : []

		default:
			return []
	}
}

// Markers used in apply_patch format to identify file operations
const PATCH_FILE_MARKERS = ["*** Add File: ", "*** Delete File: ", "*** Update File: "] as const

/**
 * Extract file paths from apply_patch content.
 * The patch format uses markers like "*** Add File: path", "*** Delete File: path", "*** Update File: path"
 * @param patchContent The patch content string
 * @returns Array of file paths found in the patch
 */
function extractFilePathsFromPatch(patchContent: string): string[] {
	const filePaths: string[] = []
	const lines = patchContent.split("\n")

	for (const line of lines) {
		for (const marker of PATCH_FILE_MARKERS) {
			if (line.startsWith(marker)) {
				const path = line.substring(marker.length).trim()
				if (path) {
					filePaths.push(path)
				}
				break
			}
		}
	}

	return filePaths
}

function getGroupOptions(group: GroupEntry): GroupOptions | undefined {
	return Array.isArray(group) ? group[1] : undefined
}

/**
 * Extract the group-level scope (allowed/denied) from a scoped group entry.
 * Returns undefined for bare strings and tuples.
 */
function getGroupScope(group: GroupEntry): { allowed?: string[]; denied?: string[] } | undefined {
	if (typeof group === "object" && !Array.isArray(group)) {
		const groupName = getGroupName(group)
		return (group as Record<string, { allowed?: string[]; denied?: string[] }>)[groupName]
	}
	return undefined
}

function doesFileMatchRegex(filePath: string, pattern: string): boolean {
	try {
		const regex = new RegExp(pattern)
		return regex.test(filePath)
	} catch (error) {
		taskLog.error(`Invalid regex pattern: ${pattern}`, error)
		return false
	}
}

export function isToolAllowedForMode(
	tool: string,
	modeSlug: string,
	customModes: ModeConfig[],
	toolRequirements?: Record<string, boolean>,
	toolParams?: Record<string, any>, // All tool parameters
	experiments?: Record<string, boolean>,
	includedTools?: string[], // Opt-in tools explicitly included (e.g., from modelInfo)
): boolean {
	// Resolve alias to canonical name (e.g., "search_and_replace" → "edit")
	const resolvedTool = TOOL_ALIASES[tool] ?? tool
	const resolvedIncludedTools = includedTools?.map((t) => TOOL_ALIASES[t] ?? t)

	// Check tool requirements first — explicit disabling takes priority over everything,
	// including ALWAYS_AVAILABLE_TOOLS. This ensures disabledTools works consistently
	// at both the filtering layer and the execution-time validation layer.
	if (toolRequirements && typeof toolRequirements === "object") {
		if (
			(tool in toolRequirements && !toolRequirements[tool]) ||
			(resolvedTool in toolRequirements && !toolRequirements[resolvedTool])
		) {
			return false
		}
	} else if (toolRequirements === false) {
		// If toolRequirements is a boolean false, all tools are disabled
		return false
	}

	// Always allow these tools (unless explicitly disabled above)
	if (ALWAYS_AVAILABLE_TOOLS.includes(tool as any)) {
		return true
	}

	// For now, allow all custom tools in any mode.
	// As a follow-up we should expand the custom tool definition to include mode restrictions.
	if (experiments?.customTools && customToolRegistry.has(tool)) {
		return true
	}

	// Private provider tools are already filtered by mode at
	// build-tools.ts time. Allow them through unconditionally.
	if (isPrivateLmTool(tool)) {
		return true
	}

	// Check if this is a dynamic MCP tool (mcp_serverName_toolName)
	// These should be allowed if the mcp group is allowed for the mode
	const isDynamicMcpTool = tool.startsWith("mcp_")

	if (experiments && Object.values(EXPERIMENT_IDS).includes(tool as ExperimentId)) {
		if (!experiments[tool]) {
			return false
		}
	}

	const mode = getModeBySlug(modeSlug, customModes)

	if (!mode) {
		return false
	}

	// Check if tool is explicitly denied — denial takes priority over groups
	if (mode.tools_denied && mode.tools_denied.length > 0) {
		if (mode.tools_denied.includes(tool) || mode.tools_denied.includes(resolvedTool)) {
			return false
		}
	}

	// Check if tool is explicitly whitelisted in mode.tools_allowed (OR with groups)
	if (mode.tools_allowed && mode.tools_allowed.length > 0) {
		if (mode.tools_allowed.includes(tool) || mode.tools_allowed.includes(resolvedTool)) {
			return true
		}
	}

	// Check if tool is in any of the mode's groups and respects any group options
	for (const group of mode.groups ?? []) {
		const groupName = getGroupName(group)
		const options = getGroupOptions(group)
		const scope = getGroupScope(group)

		const groupConfig = TOOL_GROUPS[groupName]

		// Check if this is a dynamic MCP tool and the mcp group is allowed
		if (isDynamicMcpTool && groupName === "mcp") {
			// Dynamic MCP tools are allowed if the mcp group is in the mode's groups
			return true
		}

		// Check if the tool is in the group's regular tools
		const isRegularTool = groupConfig.tools.includes(resolvedTool)

		// Check if the tool is a custom tool that has been explicitly included
		const isCustomTool =
			groupConfig.customTools?.includes(resolvedTool) && resolvedIncludedTools?.includes(resolvedTool)

		// If the tool isn't in regular tools and isn't an included custom tool, continue to next group
		if (!isRegularTool && !isCustomTool) {
			continue
		}

		// Check group-level scope (allowed/denied) from scoped group entries
		if (scope) {
			if (scope.denied && (scope.denied.includes(tool) || scope.denied.includes(resolvedTool))) {
				return false
			}
			if (scope.allowed && !scope.allowed.includes(tool) && !scope.allowed.includes(resolvedTool)) {
				return false
			}
		}

		// If there are no options, allow the tool
		if (!options) {
			return true
		}

		// For the write group, check file regex if specified
		if (groupName === "write" && options.fileRegex) {
			// Only enforce for tools that actually mutate files (excludes read-only
			// tools that may be in the write group in the future).
			if (WRITE_MUTATOR_TOOLS.has(tool)) {
				// Streaming partial-params gate: skip enforcement until at least one
				// mutation-indicator param is present, so we don't reject a partial
				// {path: "test.js"} before the model streams {content: ...}.
				//
				// Presence is tested with `!== undefined`, NOT truthiness: an
				// intentionally-empty value (e.g. `content: ""` to clear a file, or
				// `pattern: ""`) is a real mutation and MUST be enforced. Using
				// truthiness here would treat those as "absent" and silently bypass
				// fileRegex. Do not "simplify" this back to `toolParams?.[p]`.
				const gatingParams = MUTATION_GATING_PARAMS[tool]
				const hasMutationParams =
					!gatingParams || gatingParams.length === 0
						? true
						: gatingParams.some((p) => toolParams?.[p] !== undefined)

				if (hasMutationParams) {
					const mutatedPaths = getMutatedPaths(tool, toolParams || {})

					// apply_patch: also extract paths from embedded patch markers
					const allPaths =
						tool === "apply_patch" && typeof toolParams?.patch === "string"
							? [...mutatedPaths, ...extractFilePathsFromPatch(toolParams.patch)]
							: mutatedPaths

					for (const targetPath of allPaths) {
						if (!doesFileMatchRegex(targetPath, options.fileRegex)) {
							throw new FileRestrictionError(
								mode.name,
								options.fileRegex,
								options.description,
								targetPath,
								tool,
							)
						}
					}
				}
			}
		}

		return true
	}

	return false
}
