/**
 * Unit tests for `getContextWindow` (`src/lib/utils/context-window.ts`).
 *
 * The function is a pure lookup over the router-model catalogue, so every
 * provider branch of `getModelIdForProvider` is exercised by asking for a
 * catalogue entry keyed on that provider's own model-id field.
 */

import type { ProviderSettings } from "@shofer/types"

import type { RouterModels } from "@/ui/store.js"

import { DEFAULT_CONTEXT_WINDOW, getContextWindow } from "../context-window.js"

/** Catalogue with one provider/model pair carrying `contextWindow`. */
function catalogue(provider: string, modelId: string, contextWindow: number): RouterModels {
	return { [provider]: { [modelId]: { contextWindow } } }
}

describe("getContextWindow", () => {
	it("falls back to the default when there is no catalogue", () => {
		expect(getContextWindow(null, { apiProvider: "openrouter" } as ProviderSettings)).toBe(DEFAULT_CONTEXT_WINDOW)
	})

	it("falls back to the default when there is no api configuration", () => {
		expect(getContextWindow(catalogue("openrouter", "m", 1), null)).toBe(DEFAULT_CONTEXT_WINDOW)
	})

	it("falls back to the default when the provider is absent", () => {
		expect(getContextWindow(catalogue("openrouter", "m", 1), {} as ProviderSettings)).toBe(DEFAULT_CONTEXT_WINDOW)
	})

	it("falls back to the default when the model id is absent", () => {
		const config = { apiProvider: "openrouter" } as ProviderSettings
		expect(getContextWindow(catalogue("openrouter", "m", 1), config)).toBe(DEFAULT_CONTEXT_WINDOW)
	})

	it("falls back to the default when the provider is not in the catalogue", () => {
		const config = { apiProvider: "anthropic", apiModelId: "m" } as ProviderSettings
		expect(getContextWindow(catalogue("openrouter", "m", 1), config)).toBe(DEFAULT_CONTEXT_WINDOW)
	})

	it("falls back to the default when the model is not in the catalogue", () => {
		const config = { apiProvider: "openrouter", openRouterModelId: "other" } as ProviderSettings
		expect(getContextWindow(catalogue("openrouter", "m", 1), config)).toBe(DEFAULT_CONTEXT_WINDOW)
	})

	it("falls back to the default when the catalogue entry has no contextWindow", () => {
		const models: RouterModels = { openrouter: { m: {} } }
		const config = { apiProvider: "openrouter", openRouterModelId: "m" } as ProviderSettings
		expect(getContextWindow(models, config)).toBe(DEFAULT_CONTEXT_WINDOW)
	})

	// One row per branch of the private `getModelIdForProvider` switch.
	const cases: Array<{ provider: string; field: string }> = [
		{ provider: "openrouter", field: "openRouterModelId" },
		{ provider: "ollama", field: "ollamaModelId" },
		{ provider: "lmstudio", field: "lmStudioModelId" },
		{ provider: "openai", field: "openAiModelId" },
		{ provider: "requesty", field: "requestyModelId" },
		{ provider: "unbound", field: "unboundModelId" },
		{ provider: "litellm", field: "litellmModelId" },
		{ provider: "vercel-ai-gateway", field: "vercelAiGatewayModelId" },
		{ provider: "anthropic", field: "apiModelId" },
		{ provider: "gemini", field: "apiModelId" },
	]

	it.each(cases)("reads $provider's model id from $field", ({ provider, field }) => {
		const config = { apiProvider: provider, [field]: "the-model" } as unknown as ProviderSettings
		expect(getContextWindow(catalogue(provider, "the-model", 4242), config)).toBe(4242)
	})
})
