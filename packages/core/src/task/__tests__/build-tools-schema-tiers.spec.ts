// The seam between the tool build and on-demand schema loading.
//
// The pure pieces are covered elsewhere (`prompts/tools/__tests__/tool-stubs.spec.ts`
// for the tiers, `tools/__tests__/DescribeToolsTool.test.ts` for discovery). What
// only this file can catch is the WIRING: that the build records the pre-stub
// definitions — record the stubs instead and `describe_tools` would echo the very
// thing it was asked to expand — and that the tiers are applied to what the model
// is handed.

import type { ModeConfig } from "@shofer/types"
import { createInMemoryHost, setHost } from "@shofer/types"

import { buildNativeToolsArrayWithRestrictions } from "../build-tools.js"
import { knownToolNames, lookupToolSchema, resetToolSchemas } from "../../tools/tool-schema-registry.js"
import type { TaskProviderLike } from "../../task-provider/index.js"

const CHAT_MODE: ModeConfig = {
	slug: "orchestrator",
	name: "Orchestrator",
	roleDefinition: "You operate a platform and delegate work; you edit no files.",
	tools: ["questions", "subtasks", { read: { allowed: [] } }, { write: { allowed: [] } }],
}

const TIERED_MODE: ModeConfig = {
	...CHAT_MODE,
	tools_full_schema: ["attempt_completion", "ask_followup_question", "new_task"],
}

/** A provider with no MCP hub — the native and plugin channels are enough here. */
const provider = { getMcpHub: () => undefined } as unknown as TaskProviderLike

async function build(mode: ModeConfig) {
	return buildNativeToolsArrayWithRestrictions({
		provider,
		cwd: "/workspace",
		mode: mode.slug,
		customModes: [mode],
		experiments: {},
		apiConfiguration: undefined,
	})
}

const nameOf = (tool: { function: { name: string } }) => tool.function.name

describe("build-tools × schema tiers", () => {
	beforeEach(() => {
		setHost(createInMemoryHost())
		resetToolSchemas()
	})

	it("records the FULL definitions, not the stubs, for describe_tools to answer from", async () => {
		const { tools } = await build(TIERED_MODE)

		const wireDefinition = tools.find((t) => nameOf(t as never) === "check_task_status")
		expect(JSON.stringify(wireDefinition)).toContain("describe_tools")

		const recorded = lookupToolSchema(TIERED_MODE.slug, "check_task_status")
		expect(recorded, "the pre-stub definition was not recorded").toBeDefined()
		expect(JSON.stringify(recorded)).not.toContain("describe_tools")
		expect((recorded!.function.parameters as { properties: Record<string, unknown> }).properties).toHaveProperty(
			"task_id",
		)

		expect(knownToolNames(TIERED_MODE.slug)).toContain("attempt_completion")
	})

	it("stubs everything outside the declared tier and offers describe_tools", async () => {
		const { tools } = await build(TIERED_MODE)
		const names = tools.map((t) => nameOf(t as never))

		expect(names).toContain("describe_tools")
		for (const kept of TIERED_MODE.tools_full_schema!) {
			expect(names).toContain(kept)
		}

		const stubbed = tools.find((t) => nameOf(t as never) === "cancel_tasks")
		expect(stubbed).toBeDefined()
		// The stub's real parameters are gone, replaced by the one declared escape
		// hatch a schema-constrained decoder can express (see `tool-stubs.ts`).
		expect((stubbed as { function: { parameters: unknown } }).function.parameters).toEqual({
			type: "object",
			properties: {
				arguments_json: { type: "string", description: expect.stringContaining("JSON-encoded") },
			},
			additionalProperties: true,
		})
	})

	it("leaves a mode that declares no tier with the array it always got", async () => {
		const { tools } = await build(CHAT_MODE)
		const names = tools.map((t) => nameOf(t as never))

		expect(names).not.toContain("describe_tools")
		expect(JSON.stringify(tools)).not.toContain("describe_tools")

		const untieredCancel = tools.find((t) => nameOf(t as never) === "cancel_tasks")
		expect(
			(untieredCancel as unknown as { function: { parameters: { properties: object } } }).function.parameters
				.properties,
		).toHaveProperty("task_ids")
	})
})
