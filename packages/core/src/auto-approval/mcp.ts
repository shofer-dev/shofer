import type { McpServerUse, McpServer, McpTool, ToolGroup } from "@shofer/types"

/**
 * The argument by which a verb-multiplexing MCP tool names the verb to run.
 *
 * One spelling, on both planes the platform serves (the L2 user-console
 * families and the L1 families), and the same string the server keys its
 * `_meta["shofer.dev/opGroups"]` map by — the map and the dispatch enum are
 * asserted equal server-side, so a value that resolves a group here is a value
 * the executor will actually dispatch on.
 */
export const MCP_OPERATION_ARG = "operation"

/**
 * The `operation` a `use_mcp_tool` call will run, or `undefined` when the call
 * names none.
 *
 * Read from the ask envelope's `arguments`, which is the serialization of the
 * very object handed to the executor — both `use_mcp_tool` and
 * `call_mcp_tool_async` build the envelope and the call from one variable via
 * `mcpApprovalEnvelope`. That is the property that keeps this honest: the verb
 * that is GATED is by construction the verb that RUNS, and no second parse of
 * the model's raw output can drift from it.
 *
 * Every way of failing returns `undefined`, which sends the caller back to the
 * tool-level group — the maximum over the tool's operations. Absent arguments,
 * an unparsable blob, a non-object blob and a non-string (or empty) `operation`
 * all over-gate; none of them widens.
 */
function readOperation(mcpServerUse: McpServerUse): string | undefined {
	const raw = mcpServerUse.arguments

	if (typeof raw !== "string" || raw.length === 0) {
		return undefined
	}

	try {
		const parsed: unknown = JSON.parse(raw)

		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return undefined
		}

		const operation = (parsed as Record<string, unknown>)[MCP_OPERATION_ARG]
		return typeof operation === "string" && operation.length > 0 ? operation : undefined
	} catch {
		return undefined
	}
}

/**
 * Resolves the tool group that gates THIS call of an MCP tool.
 *
 * The resolution is per call, not per tool, because a family tool multiplexes
 * verbs of different danger behind one name — `events list` and `events delete`
 * are one tool and must not share one gate. In priority order:
 *
 *   1. The user's own `toolGroups` assignment in `mcp.json`. It is a statement
 *      about the whole tool and wins outright; `McpHub.fetchToolsList` records
 *      that it was the source in `groupIsUserOverride`.
 *   2. The server's group for the call's `operation`, from the tool's
 *      `opGroups` map (declared in `_meta["shofer.dev/opGroups"]`).
 *   3. The tool-level group — for a family tool the MAXIMUM over its
 *      operations, so falling back here can only be stricter.
 *   4. `"uncategorized"` when the tool cannot be resolved at all (missing
 *      server/tool, or a non-tool payload), matching the discovery default: an
 *      ungrouped MCP tool needs `alwaysAllowUncategorized` on top of
 *      `alwaysAllowMcp`, because the `mcp` gateway grants visibility, not
 *      auto-execution. Visibility is handled separately in
 *      `filterMcpToolsForMode`, where `uncategorized` is an ordinary group the
 *      mode must list.
 */
export function getMcpToolGroup(mcpServerUse: McpServerUse, mcpServers: McpServer[] | undefined): ToolGroup {
	if (mcpServerUse.type === "use_mcp_tool" && mcpServerUse.toolName) {
		const server = mcpServers?.find((s: McpServer) => s.name === mcpServerUse.serverName)
		const tool = server?.tools?.find((t: McpTool) => t.name === mcpServerUse.toolName)
		const toolGroup = tool?.group ?? "uncategorized"

		if (!tool || tool.groupIsUserOverride === true || !tool.opGroups) {
			return toolGroup
		}

		const operation = readOperation(mcpServerUse)

		return (operation !== undefined ? tool.opGroups[operation] : undefined) ?? toolGroup
	}

	return "uncategorized"
}

/**
 * Returns true if the MCP tool referenced by the use payload has not been
 * categorized into a tool group (or is missing from the connected servers).
 * Tools without an explicit group default to "uncategorized".
 */
export function isMcpToolUncategorized(mcpServerUse: McpServerUse, mcpServers: McpServer[] | undefined): boolean {
	if (mcpServerUse.type === "use_mcp_tool" && mcpServerUse.toolName) {
		return getMcpToolGroup(mcpServerUse, mcpServers) === "uncategorized"
	}

	return false
}
