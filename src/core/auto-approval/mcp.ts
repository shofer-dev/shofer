import type { McpServerUse, McpServer, McpTool, ToolGroup } from "@shofer/types"

/**
 * Resolves the tool group of the MCP tool referenced by the use payload.
 *
 * The group is read from the connected server's tool definition, which already
 * reflects the resolution priority applied at discovery time (user override in
 * `mcp.json` → server-declared → `"uncategorized"`; see `McpHub.fetchToolsList`).
 * Tools that cannot be resolved (missing server/tool, or a non-tool payload)
 * fall back to `"uncategorized"`.
 */
export function getMcpToolGroup(mcpServerUse: McpServerUse, mcpServers: McpServer[] | undefined): ToolGroup {
	if (mcpServerUse.type === "use_mcp_tool" && mcpServerUse.toolName) {
		const server = mcpServers?.find((s: McpServer) => s.name === mcpServerUse.serverName)
		const tool = server?.tools?.find((t: McpTool) => t.name === mcpServerUse.toolName)
		// Default to "mcp" (the gateway group) so ungrouped tools are gated by
		// alwaysAllowMcp alone — consistent with the visibility default in
		// filterMcpToolsForMode where ungrouped tools default to "mcp" too.
		return tool?.group ?? "mcp"
	}

	return "mcp"
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
