// Tests for filterMcpToolsForMode: verifies that MCP tools are filtered by
// per-tool group membership and that the mode's `groups` configuration gates
// which categories of MCP tools are exposed to the model.
//
// The `mcp` group is a gateway — it must be present for any MCP tools to be
// visible. Beyond that, each MCP tool's resolved group (user override in
// mcp.json → server-declared → "uncategorized") must also be in the mode's
// declared groups. A mode with `tools: ["read", "mcp"]` exposes only MCP tools
// classified as `read`.

import type OpenAI from "openai"
import type { McpTool, ModeConfig } from "@shofer/types"
import { filterMcpToolsForMode } from "../filter-tools-for-mode"
import { buildMcpToolName } from "../../../../utils/mcp-name"

function makeMcpTool(serverName: string, toolName: string): OpenAI.Chat.ChatCompletionTool {
	return {
		type: "function",
		function: {
			name: buildMcpToolName(serverName, toolName),
			description: `${serverName}.${toolName}`,
			parameters: { type: "object", properties: {} },
		},
	}
}

type Meta = McpTool & { serverName: string }

const mcpTools: OpenAI.Chat.ChatCompletionTool[] = [
	makeMcpTool("github", "get_pull_request"),
	makeMcpTool("github", "create_issue"),
	makeMcpTool("github", "run_workflow"),
	makeMcpTool("slack", "post_message"),
	makeMcpTool("slack", "list_channels"),
]

const mcpToolMeta: Meta[] = [
	{ serverName: "github", name: "get_pull_request", group: "read", enabledForPrompt: true },
	{ serverName: "github", name: "create_issue", group: "write", enabledForPrompt: true },
	{ serverName: "github", name: "run_workflow", group: "execute", enabledForPrompt: true },
	{ serverName: "slack", name: "post_message", group: "uncategorized", enabledForPrompt: true },
	{ serverName: "slack", name: "list_channels", group: "read", enabledForPrompt: true },
]

describe("filterMcpToolsForMode", () => {
	it("exposes only read-grouped MCP tools when the mode has read + mcp", () => {
		const customModes: ModeConfig[] = [
			{
				slug: "read-only",
				name: "Read Only",
				roleDefinition: "rd",
				tools: ["read", "mcp"],
			},
		]

		const result = filterMcpToolsForMode(mcpTools, mcpToolMeta, "read-only", customModes, {})

		const names = result.map((t) => ("function" in t ? t.function.name : "")).sort()
		// Only get_pull_request (read) and list_channels (read) are visible;
		// create_issue (write), run_workflow (execute), post_message (uncategorized) are hidden.
		expect(names).toEqual(
			[buildMcpToolName("github", "get_pull_request"), buildMcpToolName("slack", "list_channels")].sort(),
		)
	})

	it("exposes only write-grouped MCP tools when the mode has write + mcp", () => {
		const customModes: ModeConfig[] = [
			{
				slug: "edit-only",
				name: "Edit Only",
				roleDefinition: "ed",
				tools: ["write", "mcp"],
			},
		]

		const result = filterMcpToolsForMode(mcpTools, mcpToolMeta, "edit-only", customModes, {})

		const names = result.map((t) => ("function" in t ? t.function.name : ""))
		expect(names).toEqual([buildMcpToolName("github", "create_issue")])
	})

	it("exposes only uncategorized MCP tools when the mode has uncategorized + mcp", () => {
		const customModes: ModeConfig[] = [
			{
				slug: "loose",
				name: "Loose",
				roleDefinition: "any",
				tools: ["uncategorized", "mcp"],
			},
		]

		const result = filterMcpToolsForMode(mcpTools, mcpToolMeta, "loose", customModes, {})

		const names = result.map((t) => ("function" in t ? t.function.name : ""))
		expect(names).toEqual([buildMcpToolName("slack", "post_message")])
	})

	it("exposes all MCP tools when the mode has all groups + mcp", () => {
		const customModes: ModeConfig[] = [
			{
				slug: "full",
				name: "Full",
				roleDefinition: "any",
				tools: ["read", "write", "execute", "uncategorized", "mcp"],
			},
		]

		const result = filterMcpToolsForMode(mcpTools, mcpToolMeta, "full", customModes, {})

		expect(result).toHaveLength(5)
	})

	it("exposes no MCP tools when the mode has mcp but no other groups", () => {
		// The mcp group on its own only provides the gateway tools
		// (use_mcp_tool, access_mcp_resource, etc.) — it does not expose any
		// individual MCP tools because none of their groups are declared.
		const customModes: ModeConfig[] = [
			{
				slug: "gateway-only",
				name: "Gateway Only",
				roleDefinition: "rd",
				tools: ["mcp"],
			},
		]

		const result = filterMcpToolsForMode(mcpTools, mcpToolMeta, "gateway-only", customModes, {})

		expect(result).toHaveLength(0)
	})

	it("exposes browser-grouped MCP tools when the mode has browser + mcp", () => {
		const browserTools: OpenAI.Chat.ChatCompletionTool[] = [
			makeMcpTool("browser-tools", "browser_navigate"),
			makeMcpTool("browser-tools", "browser_click"),
			makeMcpTool("browser-tools", "browser_screenshot"),
		]
		const browserMeta: Meta[] = [
			{ serverName: "browser-tools", name: "browser_navigate", group: "browser", enabledForPrompt: true },
			{ serverName: "browser-tools", name: "browser_click", group: "browser", enabledForPrompt: true },
			{ serverName: "browser-tools", name: "browser_screenshot", group: "browser", enabledForPrompt: true },
		]

		const customModes: ModeConfig[] = [
			{
				slug: "web",
				name: "Web",
				roleDefinition: "web agent",
				tools: ["browser", "mcp"],
			},
		]

		const result = filterMcpToolsForMode(browserTools, browserMeta, "web", customModes, {})

		expect(result).toHaveLength(3)
	})

	it("hides browser-grouped MCP tools when the mode lacks browser but has mcp", () => {
		const browserTools: OpenAI.Chat.ChatCompletionTool[] = [
			makeMcpTool("browser-tools", "browser_navigate"),
			makeMcpTool("browser-tools", "browser_click"),
		]
		const browserMeta: Meta[] = [
			{ serverName: "browser-tools", name: "browser_navigate", group: "browser", enabledForPrompt: true },
			{ serverName: "browser-tools", name: "browser_click", group: "browser", enabledForPrompt: true },
		]

		const customModes: ModeConfig[] = [
			{
				slug: "no-browser",
				name: "No Browser",
				roleDefinition: "rd",
				tools: ["read", "mcp"],
			},
		]

		const result = filterMcpToolsForMode(browserTools, browserMeta, "no-browser", customModes, {})

		expect(result).toHaveLength(0)
	})

	it("defaults missing group metadata to 'mcp' (visible in any mode with the mcp gateway)", () => {
		const tools = [...mcpTools, makeMcpTool("misc", "weird_tool")]
		const meta: Meta[] = [...mcpToolMeta, { serverName: "misc", name: "weird_tool", enabledForPrompt: true }]

		const customModes: ModeConfig[] = [
			{
				slug: "read-only",
				name: "Read Only",
				roleDefinition: "rd",
				tools: ["read", "mcp"],
			},
		]

		const result = filterMcpToolsForMode(tools, meta, "read-only", customModes, {})
		const names = result.map((t) => ("function" in t ? t.function.name : ""))
		// weird_tool has no group → defaults to "mcp" → visible (mode has mcp gateway)
		expect(names).toContain(buildMcpToolName("misc", "weird_tool"))
		// read-grouped tools are visible (mode has read)
		expect(names).toContain(buildMcpToolName("github", "get_pull_request"))
		// write-grouped tools are hidden (mode lacks write)
		expect(names).not.toContain(buildMcpToolName("github", "create_issue"))
		// uncategorized tools are hidden (mode lacks uncategorized)
		expect(names).not.toContain(buildMcpToolName("slack", "post_message"))
	})

	it("excludes tools with enabledForPrompt=false even when the group matches", () => {
		const meta: Meta[] = mcpToolMeta.map((m) =>
			m.name === "get_pull_request" ? { ...m, enabledForPrompt: false } : m,
		)

		const customModes: ModeConfig[] = [
			{
				slug: "read-only",
				name: "Read Only",
				roleDefinition: "rd",
				tools: ["read", "mcp"],
			},
		]

		const result = filterMcpToolsForMode(mcpTools, meta, "read-only", customModes, {})
		const names = result.map((t) => ("function" in t ? t.function.name : ""))
		expect(names).not.toContain(buildMcpToolName("github", "get_pull_request"))
		expect(names).toContain(buildMcpToolName("slack", "list_channels"))
	})

	it("includes tools sharing a name across different servers when both groups are allowed", () => {
		const tools = [makeMcpTool("alpha", "shared"), makeMcpTool("beta", "shared")]
		const meta: Meta[] = [
			{ serverName: "alpha", name: "shared", group: "read", enabledForPrompt: true },
			{ serverName: "beta", name: "shared", group: "write", enabledForPrompt: true },
		]

		const customModes: ModeConfig[] = [
			{
				slug: "read-write",
				name: "Read Write",
				roleDefinition: "rd",
				tools: ["read", "write", "mcp"],
			},
		]

		const result = filterMcpToolsForMode(tools, meta, "read-write", customModes, {})
		expect(result).toHaveLength(2)
	})

	it("includes only the server whose group matches when tools share a name", () => {
		const tools = [makeMcpTool("alpha", "shared"), makeMcpTool("beta", "shared")]
		const meta: Meta[] = [
			{ serverName: "alpha", name: "shared", group: "read", enabledForPrompt: true },
			{ serverName: "beta", name: "shared", group: "write", enabledForPrompt: true },
		]

		const customModes: ModeConfig[] = [
			{
				slug: "read-only",
				name: "Read Only",
				roleDefinition: "rd",
				tools: ["read", "mcp"],
			},
		]

		const result = filterMcpToolsForMode(tools, meta, "read-only", customModes, {})
		expect(result).toHaveLength(1)
		const names = result.map((t) => ("function" in t ? t.function.name : ""))
		expect(names).toContain(buildMcpToolName("alpha", "shared"))
		expect(names).not.toContain(buildMcpToolName("beta", "shared"))
	})

	it("returns an empty array when the mode is not found", () => {
		expect(filterMcpToolsForMode(mcpTools, mcpToolMeta, "nope", [], {})).toEqual([])
	})

	it("returns an empty array when the mode lacks the mcp group", () => {
		const customModes: ModeConfig[] = [
			{
				slug: "no-mcp",
				name: "No MCP",
				roleDefinition: "rd",
				tools: ["read", "write"],
			},
		]

		const result = filterMcpToolsForMode(mcpTools, mcpToolMeta, "no-mcp", customModes, {})

		expect(result).toHaveLength(0)
	})

	it("handles empty inputs gracefully", () => {
		const customModes: ModeConfig[] = [
			{
				slug: "read-only",
				name: "Read Only",
				roleDefinition: "rd",
				tools: ["read"],
			},
		]
		expect(filterMcpToolsForMode([], [], "read-only", customModes, {})).toEqual([])
	})
})
