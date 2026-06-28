import { describe, it, expect } from "vitest"

import {
	STATIC_MODEL_CATALOG,
	hasStaticCatalog,
	getStaticModelsForProvider,
	lookupStaticModel,
	getModelCapabilities,
} from "../providers/catalog.js"
import { anthropicModels, anthropicDefaultModelId } from "../providers/anthropic.js"

/**
 * §7 data-driven model catalog. Pins the catalog registry + accessors.
 */
describe("STATIC_MODEL_CATALOG", () => {
	it("every entry's defaultModelId exists in its own models record", () => {
		const offenders: string[] = []
		for (const [provider, entry] of Object.entries(STATIC_MODEL_CATALOG)) {
			// Some providers (e.g. shofer) ship an empty record on purpose; skip those.
			if (Object.keys(entry.models).length === 0) continue
			if (!(entry.defaultModelId in entry.models)) {
				offenders.push(`${provider}: default '${entry.defaultModelId}' not in models`)
			}
		}
		expect(offenders).toEqual([])
	})

	it("hasStaticCatalog narrows known providers and rejects dynamic ones", () => {
		expect(hasStaticCatalog("anthropic")).toBe(true)
		expect(hasStaticCatalog("openrouter")).toBe(false)
		expect(hasStaticCatalog("nonsense")).toBe(false)
	})

	it("getStaticModelsForProvider returns the provider's own record", () => {
		expect(getStaticModelsForProvider("anthropic")).toBe(anthropicModels)
		expect(getStaticModelsForProvider("openrouter")).toBeUndefined()
	})

	it("lookupStaticModel resolves a known (provider, model) pair", () => {
		const info = lookupStaticModel("anthropic", anthropicDefaultModelId)
		expect(info).toBeDefined()
		expect(info).toBe(anthropicModels[anthropicDefaultModelId as keyof typeof anthropicModels])
		expect(lookupStaticModel("anthropic", "no-such-model")).toBeUndefined()
		expect(lookupStaticModel("ollama", "anything")).toBeUndefined()
	})

	it("getModelCapabilities normalizes a ModelInfo into the capability/dialect view", () => {
		const caps = getModelCapabilities({
			contextWindow: 200_000,
			supportsPromptCache: true,
			supportsImages: true,
			inputPrice: 3,
			outputPrice: 15,
			includedTools: ["apply_patch"],
		} as never)
		expect(caps).toMatchObject({
			contextWindow: 200_000,
			supportsImages: true,
			supportsPromptCache: true,
			inputPrice: 3,
			outputPrice: 15,
			includedTools: ["apply_patch"],
			excludedTools: [],
		})
	})

	it("defaults supportsImages and tool dialect arrays when absent", () => {
		const caps = getModelCapabilities({ contextWindow: 8_000, supportsPromptCache: false } as never)
		expect(caps.supportsImages).toBe(false)
		expect(caps.includedTools).toEqual([])
		expect(caps.excludedTools).toEqual([])
	})
})
