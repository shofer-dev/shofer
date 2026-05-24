// Tests for filterMcpToolsForMode: verifies that MCP tools are filtered by
// per-tool group membership and that the mode's `groups` configuration gates
// which categories of MCP tools are exposed to the model.

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
	it("includes all mcp tools when the mode has the mcp group (all-or-nothing visibility)", () => {
		const customModes: ModeConfig[] = [
			{
				slug: "read-only",
				name: "Read Only",
				roleDefinition: "rd",
				groups: ["read", "mcp"],
			},
		]

		const result = filterMcpToolsForMode(mcpTools, mcpToolMeta, "read-only", customModes, {})

		// When "mcp" group is present, all enabled mcp tools are visible (all-or-nothing);
		// per-tool group is for auto-approval only.
		const names = result.map((t) => ("function" in t ? t.function.name : "")).sort()
		expect(names).toHaveLength(5)
	})

	it("includes all mcp tools when the mode has the mcp group (all-or-nothing visibility)", () => {
		const customModes: ModeConfig[] = [
			{
				slug: "edit-only",
				name: "Edit Only",
				roleDefinition: "ed",
				groups: ["write", "mcp"],
			},
		]

		const result = filterMcpToolsForMode(mcpTools, mcpToolMeta, "edit-only", customModes, {})

		// When "mcp" group is present, all enabled mcp tools are visible (all-or-nothing)
		expect(result).toHaveLength(5)
	})

	it("includes all mcp tools when the mode has the mcp group regardless of per-tool group", () => {
		const customModes: ModeConfig[] = [
			{
				slug: "loose",
				name: "Loose",
				roleDefinition: "any",
				groups: ["uncategorized", "mcp"],
			},
		]

		const result = filterMcpToolsForMode(mcpTools, mcpToolMeta, "loose", customModes, {})

		// Per-tool group is for auto-approval only; mcp group = all-or-nothing
		expect(result).toHaveLength(5)
	})

	it("defaults missing group metadata to 'uncategorized'", () => {
		const tools = [...mcpTools, makeMcpTool("misc", "weird_tool")]
		const meta: Meta[] = [...mcpToolMeta, { serverName: "misc", name: "weird_tool", enabledForPrompt: true }]

		const customModes: ModeConfig[] = [
			{
				slug: "loose",
				name: "Loose",
				roleDefinition: "any",
				groups: ["uncategorized", "mcp"],
			},
		]

		const result = filterMcpToolsForMode(tools, meta, "loose", customModes, {})
		const names = result.map((t) => ("function" in t ? t.function.name : ""))
		expect(names).toContain(buildMcpToolName("misc", "weird_tool"))
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
				groups: ["read", "mcp"],
			},
		]

		const result = filterMcpToolsForMode(mcpTools, meta, "read-only", customModes, {})
		const names = result.map((t) => ("function" in t ? t.function.name : ""))
		expect(names).not.toContain(buildMcpToolName("github", "get_pull_request"))
		expect(names).toContain(buildMcpToolName("slack", "list_channels"))
	})

	it("includes all tools sharing a name across different servers when mcp group is present", () => {
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
				groups: ["read", "mcp"],
			},
		]

		const result = filterMcpToolsForMode(tools, meta, "read-only", customModes, {})
		// When "mcp" group is present, all enabled mcp tools are visible (all-or-nothing)
		expect(result).toHaveLength(2)
	})

	it("returns an empty array when the mode is not found", () => {
		expect(filterMcpToolsForMode(mcpTools, mcpToolMeta, "nope", [], {})).toEqual([])
	})

	it("treats the 'mcp' group as a wildcard exposing every MCP tool regardless of its category", () => {
		// Backward-compatibility: legacy modes declare the broad `mcp` group; in
		// that case all MCP tools — including ones whose individual category is
		// not in the mode's groups — should be exposed.
		const customModes: ModeConfig[] = [
			{
				slug: "default-like",
				name: "Default-like",
				roleDefinition: "rd",
				groups: ["read", "mcp"],
			},
		]

		const result = filterMcpToolsForMode(mcpTools, mcpToolMeta, "default-like", customModes, {})

		const names = result.map((t) => ("function" in t ? t.function.name : "")).sort()
		expect(names).toEqual(
			[
				buildMcpToolName("github", "get_pull_request"),
				buildMcpToolName("github", "create_issue"),
				buildMcpToolName("github", "run_workflow"),
				buildMcpToolName("slack", "post_message"),
				buildMcpToolName("slack", "list_channels"),
			].sort(),
		)
	})

	it("handles empty inputs gracefully", () => {
		const customModes: ModeConfig[] = [
			{
				slug: "read-only",
				name: "Read Only",
				roleDefinition: "rd",
				groups: ["read"],
			},
		]
		expect(filterMcpToolsForMode([], [], "read-only", customModes, {})).toEqual([])
	})
})
