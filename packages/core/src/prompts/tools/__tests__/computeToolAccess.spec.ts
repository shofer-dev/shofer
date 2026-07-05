// npx vitest run core/prompts/tools/__tests__/computeToolAccess.spec.ts

import { getModeBySlug } from "@shofer/types"
import { computeToolAccess, FEATURE_GATED_TOOLS, type ToolAccessGates } from "../filter-tools-for-mode.js"

/**
 * §4 unified tool-access decision. computeToolAccess composes mode filtering,
 * per-model preferences, feature gates, and user-disabled tools into one source
 * of truth. applyModelToolCustomization is characterized separately; this pins
 * the feature-gate table and disabled-tool removal.
 */

const codeMode = getModeBySlug("code", [])!

const allGatesOn: ToolAccessGates = {
	ragSearch: true,
	gitSearch: true,
	generateImage: true,
	runSlashCommand: true,
	accessMcpResource: true,
	todoList: true,
}

const run = (gates: ToolAccessGates, disabledTools?: string[]) =>
	computeToolAccess({
		modeSlug: "code",
		modeConfig: codeMode,
		customModes: [],
		experiments: {},
		gates,
		disabledTools,
	}).allowedTools

describe("computeToolAccess", () => {
	it("includes feature-gated tools when their gate is on (code mode)", () => {
		const tools = run(allGatesOn)
		for (const tool of Object.keys(FEATURE_GATED_TOOLS)) {
			expect(tools.has(tool), `${tool} should be present when gated on`).toBe(true)
		}
	})

	it("removes each feature-gated tool when its gate is off", () => {
		for (const [tool, gate] of Object.entries(FEATURE_GATED_TOOLS)) {
			const tools = run({ ...allGatesOn, [gate]: false })
			expect(tools.has(tool), `${tool} should be absent when ${gate} is off`).toBe(false)
		}
	})

	it("removes user-disabled tools (alias-resolved)", () => {
		expect(run(allGatesOn).has("read_file")).toBe(true)
		expect(run(allGatesOn, ["read_file"]).has("read_file")).toBe(false)
		// search_and_replace is an alias of edit — disabling the alias disables the canonical tool.
		expect(run(allGatesOn, ["search_and_replace"]).has("edit")).toBe(false)
	})
})
