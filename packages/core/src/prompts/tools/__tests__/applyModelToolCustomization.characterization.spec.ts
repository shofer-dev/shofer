// npx vitest run core/prompts/tools/__tests__/applyModelToolCustomization.characterization.spec.ts

import type { ModeConfig, ModelInfo } from "@shofer/types"

import { applyModelToolCustomization } from "../filter-tools-for-mode.js"

/**
 * Characterization tests for `applyModelToolCustomization` — the per-model tool
 * preference system (v3 architecture §4, one of the three systems
 * to unify into the permission engine). Locks current behavior so the future
 * unification can preserve it. Asserts behavior as it is today.
 */

const mode = (groups: string[]): ModeConfig =>
	({ slug: "x", name: "X", roleDefinition: "", groups, tools: groups }) as unknown as ModeConfig

const model = (extra: Partial<ModelInfo>): ModelInfo => extra as ModelInfo

describe("applyModelToolCustomization", () => {
	it("returns the input unchanged when no modelInfo is given", () => {
		const allowed = new Set(["read_file"])
		const result = applyModelToolCustomization(allowed, mode(["read"]))
		expect([...result.allowedTools]).toEqual(["read_file"])
		expect(result.aliasRenames.size).toBe(0)
	})

	it("removes excludedTools from the allowed set", () => {
		const allowed = new Set(["read_file", "write_to_file"])
		const result = applyModelToolCustomization(
			allowed,
			mode(["read", "write"]),
			model({ excludedTools: ["write_to_file"] }),
		)
		expect(result.allowedTools.has("write_to_file")).toBe(false)
		expect(result.allowedTools.has("read_file")).toBe(true)
	})

	it("resolves aliases when excluding (excluding an alias removes the canonical tool)", () => {
		// search_and_replace -> edit (TOOL_ALIASES)
		const allowed = new Set(["edit", "read_file"])
		const result = applyModelToolCustomization(
			allowed,
			mode(["read", "write"]),
			model({ excludedTools: ["search_and_replace"] }),
		)
		expect(result.allowedTools.has("edit")).toBe(false)
	})

	it("adds an includedTool only when its group is allowed in the mode", () => {
		// search_replace is a customTool of the `write` group (opt-in only).
		const base = new Set(["read_file"])
		const allowedInWriteMode = applyModelToolCustomization(
			base,
			mode(["read", "write"]),
			model({ includedTools: ["search_replace"] }),
		)
		expect(allowedInWriteMode.allowedTools.has("search_replace")).toBe(true)

		const blockedInReadMode = applyModelToolCustomization(
			new Set(["read_file"]),
			mode(["read"]),
			model({ includedTools: ["search_replace"] }),
		)
		expect(blockedInReadMode.allowedTools.has("search_replace")).toBe(false)
	})

	it("tracks an alias rename when the included tool was specified as an alias", () => {
		// search_and_replace -> edit (a customTool of `write`).
		const result = applyModelToolCustomization(
			new Set<string>(),
			mode(["write"]),
			model({ includedTools: ["search_and_replace"] }),
		)
		expect(result.allowedTools.has("edit")).toBe(true)
		expect(result.aliasRenames.get("edit")).toBe("search_and_replace")
	})

	it("does not rename when the included tool is already canonical", () => {
		const result = applyModelToolCustomization(
			new Set<string>(),
			mode(["write"]),
			model({ includedTools: ["search_replace"] }),
		)
		expect(result.aliasRenames.size).toBe(0)
	})
})
