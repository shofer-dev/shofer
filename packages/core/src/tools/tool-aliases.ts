import { TOOL_ALIASES, CROSS_ASSISTANT_ALIASES } from "@shofer/types"

/**
 * Reverse lookup map - maps alias name to canonical tool name.
 * Built once at module load from the central TOOL_ALIASES constant.
 */
export const ALIAS_TO_CANONICAL: Map<string, string> = new Map(
	Object.entries(TOOL_ALIASES).map(([alias, canonical]) => [alias, canonical]),
)

/**
 * Resolves a tool name to its canonical name.
 * If the tool name is an alias, returns the canonical tool name.
 * If it's already a canonical name or unknown, returns as-is.
 *
 * @param toolName - The tool name to resolve (may be an alias)
 * @returns The canonical tool name
 */
export function resolveToolAlias(toolName: string): string {
	const canonical = ALIAS_TO_CANONICAL.get(toolName) ?? CROSS_ASSISTANT_ALIASES[toolName]
	return canonical ?? toolName
}

/**
 * Applies tool alias resolution to a set of allowed tools.
 * Resolves any aliases to their canonical tool names.
 *
 * @param allowedTools - Set of tools that may contain aliases
 * @returns Set with aliases resolved to canonical names
 */
export function applyToolAliases(allowedTools: Set<string>): Set<string> {
	const result = new Set<string>()

	for (const tool of allowedTools) {
		// Resolve alias to canonical name
		result.add(resolveToolAlias(tool))
	}

	return result
}
