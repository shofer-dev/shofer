import { describe, it, expect } from "vitest"

import { STATIC_MODEL_CATALOG, lookupStaticModel, getModelCapabilities } from "@shofer/types"

import { calculateApiCostAnthropic, calculateApiCostOpenAI } from "@shofer/core"

const anthropicDefault = () => STATIC_MODEL_CATALOG.anthropic.defaultModelId

/**
 * §8 — cost and context limits are derived from the model catalog (§7), not from
 * per-provider constants. `calculateApiCost*` already consume a `ModelInfo`; this
 * pins that a catalog lookup feeds straight into cost + limit logic, end to end.
 */
describe("cost & limits are catalog-driven", () => {
	it("computes cost from a catalog model's pricing", () => {
		const model = lookupStaticModel("anthropic", anthropicDefault())
		expect(model, `expected a catalog entry for anthropic/${anthropicDefault}`).toBeDefined()
		if (!model) return

		const { totalCost } = calculateApiCostAnthropic(model, 1_000_000, 0)
		// inputPrice is per-million tokens, so 1M input tokens costs exactly inputPrice.
		expect(totalCost).toBeCloseTo(model.inputPrice ?? 0, 6)
	})

	it("derives the context limit from the catalog entry", () => {
		const model = lookupStaticModel("anthropic", anthropicDefault())!
		const caps = getModelCapabilities(model)
		expect(caps.contextWindow).toBe(model.contextWindow)
		expect(caps.contextWindow).toBeGreaterThan(0)
	})

	it("an unpriced model yields zero cost (no scattered fallback constants)", () => {
		const unpriced = { contextWindow: 8_000, supportsPromptCache: false } as never
		expect(calculateApiCostOpenAI(unpriced, 10_000, 2_000).totalCost).toBe(0)
		expect(calculateApiCostAnthropic(unpriced, 10_000, 2_000).totalCost).toBe(0)
	})
})
