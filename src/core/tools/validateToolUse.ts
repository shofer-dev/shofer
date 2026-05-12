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

const EDIT_OPERATION_PARAMS = [
	"diff",
	"content",
	"operations",
	"search",
	"replace",
	"args",
	"line",
	"patch", // Used by apply_patch
	"old_string", // Used by search_replace and edit_file
	"new_string", // Used by search_replace and edit_file
] as const

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
		console.error(`Invalid regex pattern: ${pattern}`, error)
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
			const filePath = toolParams?.path || toolParams?.file_path
			// Check if this is an actual edit operation (not just path-only for streaming)
			const isEditOperation = EDIT_OPERATION_PARAMS.some((param) => toolParams?.[param])

			// Handle single file path validation
			if (filePath && isEditOperation && !doesFileMatchRegex(filePath, options.fileRegex)) {
				throw new FileRestrictionError(mode.name, options.fileRegex, options.description, filePath, tool)
			}

			// Handle apply_patch: extract file paths from patch content and validate each
			if (tool === "apply_patch" && typeof toolParams?.patch === "string") {
				const patchFilePaths = extractFilePathsFromPatch(toolParams.patch)
				for (const patchFilePath of patchFilePaths) {
					if (!doesFileMatchRegex(patchFilePath, options.fileRegex)) {
						throw new FileRestrictionError(
							mode.name,
							options.fileRegex,
							options.description,
							patchFilePath,
							tool,
						)
					}
				}
			}

			// Native-only: multi-file edits provide structured params; no legacy XML args parsing.
		}

		return true
	}

	return false
}
