import type { McpServerUse, McpServer, McpTool } from "@shofer/types"

/**
 * Returns true if the MCP tool referenced by the use payload has not been
 * categorized into a tool group (or is missing from the connected servers).
 * Tools without an explicit group default to "uncategorized".
 */
export function isMcpToolUncategorized(mcpServerUse: McpServerUse, mcpServers: McpServer[] | undefined): boolean {
	if (mcpServerUse.type === "use_mcp_tool" && mcpServerUse.toolName) {
		const server = mcpServers?.find((s: McpServer) => s.name === mcpServerUse.serverName)
		const tool = server?.tools?.find((t: McpTool) => t.name === mcpServerUse.toolName)
		return (tool?.group ?? "uncategorized") === "uncategorized"
	}

	return false
}
