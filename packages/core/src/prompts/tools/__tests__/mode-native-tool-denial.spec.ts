// A mode that carries a tool GROUP but does not want every native tool in it.
//
// `tools_denied` is the lever: it is applied after the groups have contributed
// their tools (and again after the always-available set), so it subtracts by
// NAME from whatever the mode would otherwise see. What makes it usable for
// trimming an agent's surface is the second half — denying members of the `mcp`
// group does NOT take the group off the mode, so the MCP servers' own tools,
// which are gated on the group being present, are untouched.
//
// That combination is what lets a chat-shaped deployment keep a large MCP
// catalog while dropping the four native MCP-plumbing tools whose schemas it
// re-sends on every turn.

import type OpenAI from "openai"
import type { McpTool, ModeConfig } from "@shofer/types"

import { filterNativeToolsForMode, filterMcpToolsForMode } from "../filter-tools-for-mode.js"
import { buildMcpToolName } from "../../../utils/mcp-name.js"

/** The native MCP-plumbing tools — the `mcp` group's own members. */
const MCP_NATIVE_TOOLS = [
	"call_mcp_tool_async",
	"check_mcp_call_status",
	"wait_for_mcp_call",
	"access_mcp_resource",
] as const

function nativeTool(name: string): OpenAI.Chat.ChatCompletionTool {
	return {
		type: "function",
		function: { name, description: name, parameters: { type: "object", properties: {} } },
	}
}

const NATIVE_TOOLS = [
	...MCP_NATIVE_TOOLS.map(nativeTool),
	nativeTool("ask_followup_question"),
	nativeTool("new_task"),
	nativeTool("check_task_status"),
	nativeTool("attempt_completion"),
	nativeTool("give_feedback"),
]

const catalogTool: OpenAI.Chat.ChatCompletionTool = {
	type: "function",
	function: {
		name: buildMcpToolName("platform", "vms"),
		description: "platform.vms",
		parameters: { type: "object", properties: {} },
	},
}
const catalogMeta: (McpTool & { serverName: string })[] = [
	{ serverName: "platform", name: "vms", group: "read", enabledForPrompt: true },
]

const chatMode = (toolsDenied?: string[]): ModeConfig => ({
	slug: "orchestrator",
	name: "Orchestrator",
	roleDefinition: "rd",
	tools: ["mcp", "questions", "subtasks", { read: { allowed: [] } }, { write: { allowed: [] } }],
	...(toolsDenied ? { tools_denied: toolsDenied } : {}),
})

const nativeNames = (mode: ModeConfig): string[] =>
	filterNativeToolsForMode(NATIVE_TOOLS, mode.slug, [mode], {}, {}).map((t) =>
		"function" in t ? t.function.name : "",
	)

describe("mode-level native tool denial", () => {
	it("exposes the mcp group's native tools when nothing is denied", () => {
		const names = nativeNames(chatMode())
		for (const tool of MCP_NATIVE_TOOLS) {
			// access_mcp_resource is additionally gated on a connected server
			// actually exposing resources, so it is absent here with no hub.
			if (tool === "access_mcp_resource") continue
			expect(names, `${tool} should be present with no denial`).toContain(tool)
		}
	})

	it("removes exactly the denied tools and keeps the rest of the mode's surface", () => {
		const names = nativeNames(chatMode([...MCP_NATIVE_TOOLS]))
		for (const tool of MCP_NATIVE_TOOLS) {
			expect(names, `${tool} should be denied`).not.toContain(tool)
		}
		// The subtask-management set and the question/completion tools are a
		// different decision and must survive the denial untouched.
		for (const kept of ["ask_followup_question", "new_task", "check_task_status", "attempt_completion"]) {
			expect(names, `${kept} was collateral`).toContain(kept)
		}
	})

	it("denies an always-available tool too, since denial is applied after that set", () => {
		expect(nativeNames(chatMode())).toContain("give_feedback")
		expect(nativeNames(chatMode(["give_feedback"]))).not.toContain("give_feedback")
	})

	it("leaves the MCP servers' own tools visible — denial subtracts tools, not the group", () => {
		const denied = filterMcpToolsForMode(
			[catalogTool],
			catalogMeta,
			"orchestrator",
			[chatMode([...MCP_NATIVE_TOOLS])],
			{},
		)
		expect(denied.map((t) => ("function" in t ? t.function.name : ""))).toEqual([
			buildMcpToolName("platform", "vms"),
		])
	})
})
