import type OpenAI from "openai"
import type { McpTool } from "@shofer/types"

import { BUILTIN_MODES } from "../../../__fixtures__/builtin-config.js"
import { buildMcpToolName } from "../../../utils/mcp-name.js"
import {
	filterMcpToolsForMode,
	filterNativeToolsForMode,
	getAvailableToolsInGroup,
	getToolAliasGroup,
	isToolAllowedInMode,
} from "../filter-tools-for-mode.js"

/**
 * The **Mode-Filtered Tool Exposure Rule**, on the three surfaces that answer
 * it: the native catalog, the MCP catalog, and the two single-tool queries the
 * prompt builder uses to decide what to describe.
 *
 * The MCP filter is the interesting one, because it is TWO gates in series and
 * conflating them was a real hole:
 *
 *  - `mcp` is a GATEWAY. A mode that does not list it sees no MCP tool at all,
 *    whatever the individual tools claim;
 *  - past the gateway, each tool is gated by its OWN resolved group. So a mode
 *    carrying `["read", "mcp"]` sees the MCP tools classified `read` and not
 *    the ones classified `write`.
 *
 * `uncategorized` is an ORDINARY group in that second gate. It used to be
 * IMPLIED by the gateway, which let a tool nobody had classified ride into
 * every mode that opened MCP at all — saying nothing about whether it mutates.
 * Visibility is not auto-execution either way: `alwaysAllowUncategorized`
 * gates the call separately.
 */

const nativeTool = (name: string): OpenAI.Chat.ChatCompletionTool =>
	({
		type: "function",
		function: { name, description: `${name} tool`, parameters: { type: "object", properties: {} } },
	}) as OpenAI.Chat.ChatCompletionTool

const mcpTool = (serverName: string, name: string): OpenAI.Chat.ChatCompletionTool =>
	nativeTool(buildMcpToolName(serverName, name))

const meta = (serverName: string, name: string, over: Partial<McpTool> = {}) =>
	({ serverName, name, ...over }) as McpTool & { serverName: string }

const namesOf = (tools: OpenAI.Chat.ChatCompletionTool[]) =>
	tools.map((t) => ("function" in t ? t.function.name : undefined))

describe("the MCP gateway", () => {
	const tools = [mcpTool("srv", "do_thing")]
	const metas = [meta("srv", "do_thing", { group: "read" })]

	it("exposes nothing to a mode that does not list mcp", () => {
		const restricted = [{ ...BUILTIN_MODES[0]!, slug: "no-mcp", tools: ["read", "write"] }] as never

		expect(filterMcpToolsForMode(tools, metas, "no-mcp", restricted, {})).toEqual([])
	})

	it("exposes nothing for a mode nobody defined", () => {
		// Failing closed: an unknown mode must not inherit the whole catalog.
		expect(filterMcpToolsForMode(tools, metas, "no-such-mode", BUILTIN_MODES, {})).toEqual([])
	})

	it("falls back to the default mode when none is named", () => {
		expect(namesOf(filterMcpToolsForMode(tools, metas, undefined, BUILTIN_MODES, {}))).toEqual([
			buildMcpToolName("srv", "do_thing"),
		])
	})
})

describe("per-tool group visibility past the gateway", () => {
	const catalog = [mcpTool("srv", "reader"), mcpTool("srv", "writer"), mcpTool("srv", "loose")]
	const metas = [
		meta("srv", "reader", { group: "read" }),
		meta("srv", "writer", { group: "write" }),
		meta("srv", "loose"),
	]

	it("shows a mode only the groups it carries", () => {
		// `code-search` carries read/execute/browser/mcp/questions — no write,
		// no uncategorized.
		expect(namesOf(filterMcpToolsForMode(catalog, metas, "code-search", BUILTIN_MODES, {}))).toEqual([
			buildMcpToolName("srv", "reader"),
		])
	})

	it("shows an UNGROUPED tool only to a mode listing uncategorized", () => {
		// The old special case let it ride the gateway into every mode, which
		// said nothing about whether it mutates.
		const withUncategorized = namesOf(filterMcpToolsForMode(catalog, metas, "code", BUILTIN_MODES, {}))

		expect(withUncategorized).toContain(buildMcpToolName("srv", "loose"))
		expect(namesOf(filterMcpToolsForMode(catalog, metas, "reviewer", BUILTIN_MODES, {}))).not.toContain(
			buildMcpToolName("srv", "loose"),
		)
	})

	it("hides a tool the user excluded from the prompt, whatever its group", () => {
		const excluded = [meta("srv", "reader", { group: "read", enabledForPrompt: false })]

		expect(filterMcpToolsForMode([mcpTool("srv", "reader")], excluded, "code", BUILTIN_MODES, {})).toEqual([])
	})

	it("keys metadata by the SANITIZED wire name, so two servers' same-named tools do not collide", () => {
		// `buildMcpToolName` is what the model sees; matching on the bare tool
		// name would conflate `a--query` with `b--query`.
		const twoServers = [mcpTool("alpha", "query"), mcpTool("beta", "query")]
		const twoMetas = [meta("alpha", "query", { group: "read" }), meta("beta", "query", { group: "write" })]

		expect(namesOf(filterMcpToolsForMode(twoServers, twoMetas, "code-search", BUILTIN_MODES, {}))).toEqual([
			buildMcpToolName("alpha", "query"),
		])
	})

	it("treats a tool with no metadata as uncategorized", () => {
		const orphan = [mcpTool("srv", "unknown")]

		expect(namesOf(filterMcpToolsForMode(orphan, [], "code", BUILTIN_MODES, {}))).toHaveLength(1)
		expect(filterMcpToolsForMode(orphan, [], "reviewer", BUILTIN_MODES, {})).toEqual([])
	})
})

describe("asking about ONE tool", () => {
	it("admits an always-available tool in every mode", () => {
		expect(isToolAllowedInMode("ask_followup_question", "web-search", BUILTIN_MODES, {})).toBe(true)
	})

	it("gates the todo list on its setting rather than on a group", () => {
		expect(isToolAllowedInMode("update_todo_list", "code", BUILTIN_MODES, {})).toBe(true)
		expect(isToolAllowedInMode("update_todo_list", "code", BUILTIN_MODES, {}, { todoListEnabled: false })).toBe(
			false,
		)
	})

	it("gates run_slash_command on its experiment flag despite being always-available", () => {
		// The always-available list is not unconditional: three of its members
		// carry their own gate, and the conditional exclusions run BEFORE the
		// blanket `true`.
		expect(isToolAllowedInMode("run_slash_command", "code", BUILTIN_MODES, {})).toBe(false)
		expect(isToolAllowedInMode("run_slash_command", "code", BUILTIN_MODES, { runSlashCommand: true })).toBe(true)
	})

	it("gates generate_image by its GROUP, because it is not always-available", () => {
		// It is an ordinary write-group tool; the experiment gate that guards it
		// lives in the catalog builder, not in this per-tool query.
		expect(isToolAllowedInMode("generate_image", "code", BUILTIN_MODES, {})).toBe(true)
		expect(isToolAllowedInMode("generate_image", "code-search", BUILTIN_MODES, {})).toBe(false)
	})

	it("answers by GROUP for an ordinary tool", () => {
		expect(isToolAllowedInMode("write_to_file", "code", BUILTIN_MODES, {})).toBe(true)
		// `code-search` carries no write group.
		expect(isToolAllowedInMode("write_to_file", "code-search", BUILTIN_MODES, {})).toBe(false)
	})

	it("resolves an ALIAS to its canonical tool before answering", () => {
		// Otherwise a model calling the aliased spelling is refused for a mode
		// that plainly allows the tool.
		const [canonical, ...aliases] = getToolAliasGroup("apply_diff")

		expect(canonical).toBe("apply_diff")
		for (const alias of aliases) {
			expect(isToolAllowedInMode(alias as never, "code", BUILTIN_MODES, {})).toBe(
				isToolAllowedInMode("apply_diff", "code", BUILTIN_MODES, {}),
			)
		}
	})

	it("falls back to the default mode when none is named", () => {
		expect(isToolAllowedInMode("write_to_file", undefined, BUILTIN_MODES, {})).toBe(true)
	})

	it("returns the tool itself for a name that is not aliased", () => {
		expect(getToolAliasGroup("read_file")).toEqual(["read_file"])
	})
})

describe("asking about a whole GROUP", () => {
	it("lists the group's tools that the mode admits", () => {
		const readTools = getAvailableToolsInGroup("read", "code", BUILTIN_MODES, {})

		expect(readTools).toContain("read_file")
		expect(readTools.every((t) => typeof t === "string")).toBe(true)
	})

	it("lists nothing from a group the mode does not carry", () => {
		expect(getAvailableToolsInGroup("write", "code-search", BUILTIN_MODES, {})).toEqual([])
	})

	it("lists nothing for a DYNAMIC category, which has no native tools", () => {
		// A category minted by an MCP server or a plugin never appears in
		// TOOL_GROUPS, and indexing it directly would throw.
		expect(getAvailableToolsInGroup("salesforce" as never, "code", BUILTIN_MODES, {})).toEqual([])
	})

	it("lists nothing for a name that is not a group at all", () => {
		expect(getAvailableToolsInGroup("not-a-group" as never, "code", BUILTIN_MODES, {})).toEqual([])
	})
})

describe("the native catalog", () => {
	it("keeps the tools the mode's groups admit and drops the rest", () => {
		const catalog = [nativeTool("read_file"), nativeTool("write_to_file")]

		expect(namesOf(filterNativeToolsForMode(catalog, "code-search", BUILTIN_MODES, {}))).toEqual(["read_file"])
	})

	it("falls back to a mode that exists when the one named has been deleted", () => {
		// The agent keeps a functional tool set rather than going silent.
		const catalog = [nativeTool("read_file")]

		expect(namesOf(filterNativeToolsForMode(catalog, "deleted-mode", BUILTIN_MODES, {}))).toEqual(["read_file"])
	})

	it("ignores an entry that is not a function tool", () => {
		const catalog = [{ type: "custom", custom: { name: "x" } }] as unknown as OpenAI.Chat.ChatCompletionTool[]

		expect(filterNativeToolsForMode(catalog, "code", BUILTIN_MODES, {})).toEqual([])
	})

	it("opens the MCP resource tool only when a server actually has resources", () => {
		const catalog = [nativeTool("access_mcp_resource")]
		const withNone = { getServers: () => [{ resources: [] }] } as never
		const withSome = { getServers: () => [{ resources: [{ uri: "file://x" }] }] } as never

		expect(filterNativeToolsForMode(catalog, "code", BUILTIN_MODES, {}, {}, withNone)).toEqual([])
		expect(namesOf(filterNativeToolsForMode(catalog, "code", BUILTIN_MODES, {}, {}, withSome))).toEqual([
			"access_mcp_resource",
		])
	})
})
