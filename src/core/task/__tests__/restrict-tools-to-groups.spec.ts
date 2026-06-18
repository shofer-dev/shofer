// npx vitest run core/task/__tests__/restrict-tools-to-groups.spec.ts

import type OpenAI from "openai"
import type { ToolGroup } from "@shofer/types"

import { restrictToolsToDeclaredGroups, type ToolCategories } from "../build-tools"

/**
 * Regression coverage for the workflow `.slang` `agent { tools: [...] }`
 * restriction (the structural fix that prevents an orchestrator agent from
 * doing the workers' job — e.g. an architect-mode orchestrator investigating
 * or editing instead of coordinating).
 *
 * `restrictToolsToDeclaredGroups` is the pure intersection step: it can only
 * REMOVE tools, never add them, and `ALWAYS_AVAILABLE_TOOLS` (e.g.
 * `attempt_completion`) must always survive so a restricted agent can still
 * complete stakes.
 */
const fn = (name: string): OpenAI.Chat.ChatCompletionFunctionTool => ({
	type: "function",
	function: { name, description: name, parameters: { type: "object", properties: {} } },
})

const READ_FILE = fn("read_file")
const WRITE_FILE = fn("write_to_file")
const EXEC = fn("execute_command")
const ALWAYS = fn("attempt_completion") // ALWAYS_AVAILABLE_TOOLS
const MCP_TOOL = fn("some_mcp_tool")
const CUSTOM_TOOL = fn("my_custom_tool")
const PRIVATE_READ = fn("ide_read_thing")
const PRIVATE_EXEC = fn("ide_run_thing")

function categories(over: Partial<ToolCategories> = {}): ToolCategories {
	return {
		native: [READ_FILE, WRITE_FILE, EXEC, ALWAYS],
		mcp: [MCP_TOOL],
		custom: [CUSTOM_TOOL],
		private: [PRIVATE_READ, PRIVATE_EXEC],
		privateMeta: [
			{ tool: PRIVATE_READ, group: "read" as ToolGroup, invokeCommand: "x" },
			{ tool: PRIVATE_EXEC, group: "execute" as ToolGroup, invokeCommand: "x" },
		] as any,
		...over,
	}
}

const names = (tools: OpenAI.Chat.ChatCompletionTool[]) =>
	tools.map((t) => (t as OpenAI.Chat.ChatCompletionFunctionTool).function.name)

describe("restrictToolsToDeclaredGroups", () => {
	it("undefined → no restriction (passes every category through unchanged)", () => {
		const r = restrictToolsToDeclaredGroups(undefined, categories())
		expect(names(r.native)).toEqual(["read_file", "write_to_file", "execute_command", "attempt_completion"])
		expect(names(r.mcp)).toEqual(["some_mcp_tool"])
		expect(names(r.custom)).toEqual(["my_custom_tool"])
		expect(names(r.private)).toEqual(["ide_read_thing", "ide_run_thing"])
	})

	it("['read'] → keeps read native tools, drops write/execute, keeps always-available, drops mcp/custom", () => {
		const r = restrictToolsToDeclaredGroups(["read"], categories())
		expect(names(r.native).sort()).toEqual(["attempt_completion", "read_file"])
		expect(r.mcp).toEqual([])
		expect(r.custom).toEqual([])
		expect(names(r.private)).toEqual(["ide_read_thing"]) // private read tool kept, exec dropped
	})

	it("always-available tools survive even when their group is not declared", () => {
		// attempt_completion is in ALWAYS_AVAILABLE_TOOLS, not the read group.
		const r = restrictToolsToDeclaredGroups(["read"], categories())
		expect(names(r.native)).toContain("attempt_completion")
	})

	it("['write'] → keeps write native + custom tools", () => {
		const r = restrictToolsToDeclaredGroups(["write"], categories())
		expect(names(r.native)).toContain("write_to_file")
		expect(names(r.native)).not.toContain("read_file")
		expect(names(r.custom)).toEqual(["my_custom_tool"])
	})

	it("['mcp'] → keeps mcp tools", () => {
		const r = restrictToolsToDeclaredGroups(["mcp"], categories())
		expect(names(r.mcp)).toEqual(["some_mcp_tool"])
		expect(names(r.native).sort()).toEqual(["attempt_completion"]) // only always-available
	})

	it("[] (explicit empty) → only always-available; everything else dropped (pure coordinator)", () => {
		const r = restrictToolsToDeclaredGroups([], categories())
		expect(names(r.native)).toEqual(["attempt_completion"])
		expect(r.mcp).toEqual([])
		expect(r.custom).toEqual([])
		expect(r.private).toEqual([])
	})

	it("unknown group name → fail-closed (same as empty)", () => {
		const r = restrictToolsToDeclaredGroups(["bogus_group"], categories())
		expect(names(r.native)).toEqual(["attempt_completion"])
		expect(r.mcp).toEqual([])
	})

	it("is a restriction only — never introduces a tool absent from the input", () => {
		const input = categories({ native: [READ_FILE, ALWAYS] })
		const r = restrictToolsToDeclaredGroups(["read", "write", "execute"], input)
		// write/execute declared but no such tools were present → not invented
		expect(names(r.native).sort()).toEqual(["attempt_completion", "read_file"])
	})
})
