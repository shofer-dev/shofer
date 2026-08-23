// The discovery half of on-demand schema loading.
//
// `describe_tools` answers from the definitions the tool build recorded, so the
// tests below drive the real registry: what the build records is what the model
// is handed, and the three tool CHANNELS (native, MCP, plugin) must all come
// back, since a mode that stubs its surface stubs all three.

import type OpenAI from "openai"

import { DescribeToolsTool, suggestToolNames } from "../DescribeToolsTool.js"
import { recordToolSchemas, resetToolSchemas } from "../tool-schema-registry.js"

const MODE = "orchestrator"

function tool(name: string, description: string, properties: Record<string, unknown>) {
	return {
		type: "function",
		function: {
			name,
			description,
			parameters: { type: "object", properties, required: Object.keys(properties) },
		},
	} as OpenAI.Chat.ChatCompletionTool
}

/** One tool per channel, exactly as `buildNativeToolsArrayWithRestrictions` records them. */
const BUILT: OpenAI.Chat.ChatCompletionTool[] = [
	tool("attempt_completion", "Present the result.", { result: { type: "string" } }),
	tool("mcp--platform--vms", "Manage virtual machines.", { operation: { type: "string" } }),
	tool("events_publish", "Publish an event onto the mesh bus.", { topic: { type: "string" } }),
]

function buildTask(overrides: Record<string, unknown> = {}) {
	return {
		consecutiveMistakeCount: 0,
		getTaskMode: async () => MODE,
		recordToolError: vi.fn(),
		sayAndCreateMissingParamError: vi.fn().mockResolvedValue("missing param: names"),
		ask: vi.fn().mockResolvedValue(undefined),
		...overrides,
	} as any
}

function buildCallbacks() {
	return {
		askApproval: vi.fn().mockResolvedValue(true),
		pushToolResult: vi.fn(),
		handleError: vi.fn(),
	} as any
}

describe("DescribeToolsTool", () => {
	let tool_: DescribeToolsTool

	beforeEach(() => {
		resetToolSchemas()
		recordToolSchemas(MODE, BUILT)
		tool_ = new DescribeToolsTool()
	})

	it("returns the real schema of a native, an MCP and a plugin tool in one call", async () => {
		const cbs = buildCallbacks()
		await tool_.execute({ names: ["attempt_completion", "mcp--platform--vms", "events_publish"] }, buildTask(), cbs)

		const payload = JSON.parse(cbs.pushToolResult.mock.calls[0][0])
		expect(payload.tools.map((t: { name: string }) => t.name)).toEqual([
			"attempt_completion",
			"mcp--platform--vms",
			"events_publish",
		])
		// The schema handed back is the one the call will be validated against —
		// the same object the build recorded, not a summary of it.
		expect(payload.tools[1].parameters).toEqual({
			type: "object",
			properties: { operation: { type: "string" } },
			required: ["operation"],
		})
		expect(payload.tools[0].description).toBe("Present the result.")
	})

	it("names an unknown tool, suggests the near misses, and still answers the rest", async () => {
		const cbs = buildCallbacks()
		await tool_.execute({ names: ["mcp--platform--vm", "attempt_completion"] }, buildTask(), cbs)

		const result: string = cbs.pushToolResult.mock.calls[0][0]
		expect(result).toContain(`No tool named "mcp--platform--vm"`)
		expect(result).toContain("mcp--platform--vms")
		expect(JSON.parse(result.slice(0, result.indexOf("\n\nNo tool")))).toHaveProperty("tools")
	})

	it("lists what does exist when nothing asked for was found", async () => {
		const cbs = buildCallbacks()
		await tool_.execute({ names: ["not_a_tool"] }, buildTask(), cbs)

		const result: string = cbs.pushToolResult.mock.calls[0][0]
		expect(result).toContain(`No tool named "not_a_tool"`)
		expect(result).toContain("attempt_completion")
		expect(result).toContain("events_publish")
	})

	it("raises the missing-parameter error rather than answering an empty batch", async () => {
		const task = buildTask()
		const cbs = buildCallbacks()
		await tool_.execute({ names: [] }, task, cbs)

		expect(task.sayAndCreateMissingParamError).toHaveBeenCalledWith("describe_tools", "names")
		expect(task.consecutiveMistakeCount).toBe(1)
		expect(cbs.pushToolResult).toHaveBeenCalledWith("missing param: names")
	})

	it("reads the catalog of the caller's OWN mode", async () => {
		recordToolSchemas("other-mode", [tool("only_here", "Elsewhere.", {})])
		const cbs = buildCallbacks()
		await tool_.execute({ names: ["only_here"] }, buildTask(), cbs)

		expect(cbs.pushToolResult.mock.calls[0][0]).toContain(`No tool named "only_here"`)
	})

	it("renders a chat row so the discovery call is not a silent hang", async () => {
		const cbs = buildCallbacks()
		await tool_.execute({ names: ["attempt_completion"] }, buildTask(), cbs)

		expect(cbs.askApproval).toHaveBeenCalledWith("tool", expect.stringContaining("describeTools"))
	})
})

describe("suggestToolNames", () => {
	const known = ["mcp--platform--vms", "mcp--platform--volumes", "events_publish", "attempt_completion"]

	it("puts a substring match first", () => {
		expect(suggestToolNames("vms", known)[0]).toBe("mcp--platform--vms")
	})

	it("falls back to a shared leading token", () => {
		expect(suggestToolNames("mcp--platform--nope", known)).toContain("mcp--platform--volumes")
	})

	it("offers nothing rather than noise when there is no relation", () => {
		expect(suggestToolNames("zzz", known)).toEqual([])
	})
})
