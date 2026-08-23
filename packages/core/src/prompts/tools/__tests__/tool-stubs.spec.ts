// On-demand schema loading: the three tiers a mode's tool surface splits into.
//
// The tests below pin the two properties the mechanism rests on, because both
// fail SILENTLY if they regress: a mode that declares no tiering must produce
// exactly the array it produced before this feature existed (anything else is a
// change to every deployment), and a stub must be derived deterministically from
// its tool's own definition (anything else invalidates the provider's
// prompt-prefix cache turn after turn, which costs more than the stubs save).

import type OpenAI from "openai"
import type { ModeConfig } from "@shofer/types"
import { parametersSchema as z } from "@shofer/types"

import { applyToolSchemaTiers, stubToolDefinition, summarizeToolDescription } from "../tool-stubs.js"
import { filterNativeToolsForMode } from "../filter-tools-for-mode.js"
import { getNativeTools } from "../native-tools/index.js"

function tool(name: string, description: string, properties: Record<string, unknown> = {}) {
	return {
		type: "function",
		function: {
			name,
			description,
			parameters: { type: "object", properties, required: Object.keys(properties) },
		},
	} as OpenAI.Chat.ChatCompletionTool
}

const CATALOG: OpenAI.Chat.ChatCompletionTool[] = [
	tool("attempt_completion", "Present the result of your work. Use it to end every turn.", { result: {} }),
	tool("mcp--platform--vms", "Manage virtual machines. Supports list, get, create, start, stop and delete.", {
		operation: {},
		id: {},
	}),
	tool("events_publish", "Publish an event onto the mesh bus.", { topic: {}, payload: {} }),
]

/** A chat-shaped mode; `tools_full_schema` is the only thing varied per test. */
const mode = (toolsFullSchema?: string[]): ModeConfig => ({
	slug: "orchestrator",
	name: "Orchestrator",
	roleDefinition: "rd",
	tools: ["mcp", "questions", "subtasks", { read: { allowed: [] } }, { write: { allowed: [] } }],
	...(toolsFullSchema === undefined ? {} : { tools_full_schema: toolsFullSchema }),
})

describe("tool schema tiers", () => {
	describe("a mode that declares no tier", () => {
		it("is handed back its own array, unchanged and by identity", () => {
			const { tools, stubbed } = applyToolSchemaTiers(CATALOG, mode())
			expect(tools).toBe(CATALOG)
			expect(stubbed).toEqual([])
		})

		it("serializes byte-identically to the untiered array", () => {
			const { tools } = applyToolSchemaTiers(CATALOG, mode())
			expect(JSON.stringify(tools)).toEqual(JSON.stringify(CATALOG))
		})

		it("is not offered describe_tools — there is nothing to describe", () => {
			const names = filterNativeToolsForMode(getNativeTools(), "orchestrator", [mode()], {}, {}).map(
				(t) => (t as OpenAI.Chat.ChatCompletionFunctionTool).function.name,
			)
			expect(names).not.toContain("describe_tools")
			expect(names).toContain("attempt_completion")
		})
	})

	describe("a mode that declares a full-schema tier", () => {
		const tiered = () => applyToolSchemaTiers(CATALOG, mode(["attempt_completion"]))

		it("leaves a listed tool exactly as it was", () => {
			const kept = tiered().tools.find(
				(t) => (t as OpenAI.Chat.ChatCompletionFunctionTool).function.name === "attempt_completion",
			)
			expect(kept).toBe(CATALOG[0])
		})

		it("reduces every unlisted tool to a stub that still names itself", () => {
			const { tools, stubbed } = tiered()
			expect(stubbed).toEqual(["mcp--platform--vms", "events_publish"])

			const stub = tools.find(
				(t) => (t as OpenAI.Chat.ChatCompletionFunctionTool).function.name === "mcp--platform--vms",
			) as OpenAI.Chat.ChatCompletionFunctionTool
			expect(stub.function.name).toBe("mcp--platform--vms")
			expect(stub.function.description).toContain("Manage virtual machines.")
			expect(stub.function.description).toContain("describe_tools")
			// Permissive, and NOT strict: a stub declares no properties, so strict
			// mode (which requires every property declared and additionalProperties
			// false) would make the tool uncallable.
			expect(stub.function.parameters).toEqual({ type: "object", properties: {}, additionalProperties: true })
			expect(stub.function).not.toHaveProperty("strict")
		})

		it("never stubs describe_tools itself, listed or not", () => {
			const withDiscovery = [...CATALOG, tool("describe_tools", "Return the full parameter schema of tools.")]
			const { stubbed } = applyToolSchemaTiers(withDiscovery, mode([]))
			expect(stubbed).not.toContain("describe_tools")
		})

		it("admits describe_tools to the mode's native tools", () => {
			const names = filterNativeToolsForMode(
				getNativeTools(),
				"orchestrator",
				[mode(["attempt_completion"])],
				{},
				{},
			).map((t) => (t as OpenAI.Chat.ChatCompletionFunctionTool).function.name)
			expect(names).toContain("describe_tools")
		})

		it("produces byte-identical stubs on every build — the cache prefix depends on it", () => {
			expect(JSON.stringify(tiered().tools)).toEqual(JSON.stringify(tiered().tools))
		})
	})

	describe("the stub's one line", () => {
		it("keeps the first sentence", () => {
			expect(summarizeToolDescription("Do a thing. Then do another thing entirely.", "x")).toBe("Do a thing.")
		})

		it("collapses whitespace so a paragraph cannot ride along", () => {
			expect(summarizeToolDescription("Line one\n\n  line two", "x")).toBe("Line one line two")
		})

		it("caps a long sentence at a word boundary", () => {
			const long = `${"word ".repeat(80)}end.`
			const summary = summarizeToolDescription(long, "x")
			expect(summary.length).toBeLessThan(200)
			expect(summary.endsWith("…")).toBe(true)
			expect(summary).not.toContain("wor…")
		})

		it("falls back to the tool's name when it has no description", () => {
			expect(summarizeToolDescription(undefined, "some_tool")).toBe("some_tool")
		})
	})

	// A stub changes what the model is SHOWN and nothing else. The execution path
	// reads the tool's own contract from its own registry — a plugin tool's Zod
	// schema at dispatch, a native tool's required-parameter check in its handler,
	// an MCP tool's schema on the server that owns it — so a stubbed call with
	// wrong arguments still fails the real validation, which is also how the model
	// recovers when it skips discovery.
	describe("a stub weakens no validation", () => {
		it("does not touch the schema a plugin tool is dispatched against", () => {
			const parameters = z.object({ topic: z.string() })
			const definition = { name: "events_publish", description: "Publish an event.", parameters }

			stubToolDefinition(tool(definition.name, definition.description))

			expect(definition.parameters.safeParse({}).success).toBe(false)
			expect(definition.parameters.safeParse({ topic: "t" }).success).toBe(true)
		})

		it("leaves the source definition object untouched", () => {
			const original = tool("mcp--platform--vms", "Manage virtual machines.", { operation: {} })
			const before = JSON.stringify(original)
			stubToolDefinition(original)
			expect(JSON.stringify(original)).toEqual(before)
		})
	})
})
