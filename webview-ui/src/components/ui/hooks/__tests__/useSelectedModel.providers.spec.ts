// npx vitest src/components/ui/hooks/__tests__/useSelectedModel.providers.spec.ts
//
// `useSelectedModel` is one switch over every provider, and each arm answers the
// same question differently: which STATIC catalog holds the model, or which
// dynamically-fetched router catalog does. This spec walks the arms, because a
// provider added without an arm silently resolves to Anthropic's default.

import React from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderHook } from "@testing-library/react"
import type { Mock } from "vitest"

import {
	type ProviderSettings,
	anthropicModels,
	basetenModels,
	dashScopeModels,
	deepSeekModels,
	fireworksModels,
	geminiModels,
	getProviderDefaultModelId,
	internationalZAiModels,
	lMStudioDefaultModelInfo,
	litellmDefaultModelInfo,
	mainlandZAiModels,
	minimaxModels,
	mistralModels,
	moonshotModels,
	openAiCodexModels,
	openAiModelInfoSaneDefaults,
	openAiNativeModels,
	qwenCodeModels,
	sambaNovaModels,
	vertexModels,
	xaiModels,
	xiaomiModels,
} from "@shofer/types"

import { useSelectedModel } from "../useSelectedModel"
import { useRouterModels } from "../useRouterModels"
import { useOpenRouterModelProviders } from "../useOpenRouterModelProviders"
import { useLmStudioModels } from "../useLmStudioModels"
import { useOllamaModels } from "../useOllamaModels"

vi.mock("../useRouterModels")
vi.mock("../useOpenRouterModelProviders")
vi.mock("../useLmStudioModels")
vi.mock("../useOllamaModels")

const vsCodeLmModels: Array<Record<string, unknown>> = []
vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ vsCodeLmModels }),
}))
vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ vsCodeLmModels }),
}))

const routerModels = useRouterModels as Mock<typeof useRouterModels>
const openRouterProviders = useOpenRouterModelProviders as Mock<typeof useOpenRouterModelProviders>
const lmStudioModels = useLmStudioModels as Mock<typeof useLmStudioModels>
const ollamaModels = useOllamaModels as Mock<typeof useOllamaModels>

const wrapper = ({ children }: { children: React.ReactNode }) =>
	React.createElement(
		QueryClientProvider,
		{ client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
		children,
	)

const select = (apiConfiguration: ProviderSettings) =>
	renderHook(() => useSelectedModel(apiConfiguration), { wrapper }).result.current

/** First key of a static catalog — a value guaranteed to resolve. */
const anyId = (catalog: Record<string, unknown>) => Object.keys(catalog)[0]

beforeEach(() => {
	vi.clearAllMocks()
	vsCodeLmModels.length = 0
	routerModels.mockReturnValue({ data: {}, isLoading: false, isError: false } as never)
	openRouterProviders.mockReturnValue({ data: {}, isLoading: false, isError: false } as never)
	lmStudioModels.mockReturnValue({ data: undefined, isLoading: false, isError: false } as never)
	ollamaModels.mockReturnValue({ data: undefined, isLoading: false, isError: false } as never)
})

describe("static-catalog providers", () => {
	const cases: Array<[string, Record<string, unknown>]> = [
		["xai", xaiModels],
		["xiaomi", xiaomiModels],
		["baseten", basetenModels],
		["gemini", geminiModels],
		["deepseek", deepSeekModels],
		["moonshot", moonshotModels],
		["dashscope", dashScopeModels],
		["minimax", minimaxModels],
		["openai-native", openAiNativeModels],
		["mistral", mistralModels],
		["sambanova", sambaNovaModels],
		["fireworks", fireworksModels],
		["qwen-code", qwenCodeModels],
		["openai-codex", openAiCodexModels],
		["vertex", vertexModels],
	]

	it.each(cases)("%s resolves the configured model from its catalog", (apiProvider, catalog) => {
		const apiModelId = anyId(catalog)
		const model = select({ apiProvider, apiModelId } as ProviderSettings)
		expect(model.id).toBe(apiModelId)
		expect(model.info).toBe(catalog[apiModelId])
	})

	it.each(cases)("%s falls back to its own default model", (apiProvider) => {
		const model = select({ apiProvider } as ProviderSettings)
		expect(model.id).toBe(getProviderDefaultModelId(apiProvider as never))
	})

	it("reports no info for a model the catalog does not know", () => {
		expect(select({ apiProvider: "xai", apiModelId: "no-such-model" } as ProviderSettings).info).toBeUndefined()
	})
})

describe("zai picks a catalog per api line", () => {
	it("uses the international catalog by default", () => {
		const id = anyId(internationalZAiModels)
		expect(select({ apiProvider: "zai", apiModelId: id } as ProviderSettings).info).toBe(
			internationalZAiModels[id as keyof typeof internationalZAiModels],
		)
	})

	it("uses the mainland catalog for the china line", () => {
		const id = anyId(mainlandZAiModels)
		expect(
			select({ apiProvider: "zai", apiModelId: id, zaiApiLine: "china_coding" } as ProviderSettings).info,
		).toBe(mainlandZAiModels[id as keyof typeof mainlandZAiModels])
	})

	it("defaults per line", () => {
		expect(select({ apiProvider: "zai" } as ProviderSettings).id).toBe(
			getProviderDefaultModelId("zai", { isChina: false } as never),
		)
		expect(select({ apiProvider: "zai", zaiApiLine: "china_coding" } as ProviderSettings).id).toBe(
			getProviderDefaultModelId("zai", { isChina: true } as never),
		)
	})
})

describe("bedrock", () => {
	it("answers a fixed shape for a custom ARN", () => {
		const model = select({ apiProvider: "bedrock", apiModelId: "custom-arn" } as ProviderSettings)
		expect(model.info).toEqual({
			maxTokens: 5000,
			contextWindow: 128_000,
			supportsPromptCache: true,
			supportsImages: true,
		})
	})
})

describe("anthropic (the default arm)", () => {
	it("resolves a catalog model", () => {
		const id = anyId(anthropicModels)
		expect(select({ apiProvider: "anthropic", apiModelId: id } as ProviderSettings).info).toBe(
			anthropicModels[id as keyof typeof anthropicModels],
		)
	})

	it("is what an unset provider resolves to", () => {
		const model = select({} as ProviderSettings)
		expect(model.provider).toBe("anthropic")
	})

	it("widens the context window under the 1M beta for a supporting model", () => {
		const withBeta = select({
			apiProvider: "anthropic",
			apiModelId: "claude-sonnet-4-5",
			anthropicBeta1MContext: true,
		} as ProviderSettings)
		const without = select({
			apiProvider: "anthropic",
			apiModelId: "claude-sonnet-4-5",
		} as ProviderSettings)
		expect(withBeta.info!.contextWindow).toBeGreaterThan(without.info!.contextWindow)
	})

	it("leaves a non-supporting model alone under the beta flag", () => {
		const id = Object.keys(anthropicModels).find((k) => !k.startsWith("claude-sonnet-4"))!
		const model = select({
			apiProvider: "anthropic",
			apiModelId: id,
			anthropicBeta1MContext: true,
		} as ProviderSettings)
		expect(model.info).toBe(anthropicModels[id as keyof typeof anthropicModels])
	})
})

describe("openai-compatible", () => {
	it("uses the operator's declared model info, falling back to the sane defaults", () => {
		const custom = { contextWindow: 42, supportsPromptCache: false }
		expect(
			select({ apiProvider: "openai", openAiModelId: "m", openAiCustomModelInfo: custom } as ProviderSettings)
				.info,
		).toBe(custom)
		expect(select({ apiProvider: "openai", openAiModelId: "m" } as ProviderSettings).info).toBe(
			openAiModelInfoSaneDefaults,
		)
	})

	it("reports an empty id when none is configured", () => {
		expect(select({ apiProvider: "openai" } as ProviderSettings).id).toBe("")
	})
})

describe("dynamic router providers", () => {
	it("resolves a router model and validates the configured id against the catalog", () => {
		routerModels.mockReturnValue({
			data: { openrouter: { "vendor/model": { contextWindow: 1, supportsPromptCache: false } } },
			isLoading: false,
			isError: false,
		} as never)

		expect(select({ apiProvider: "openrouter", openRouterModelId: "vendor/model" } as ProviderSettings).id).toBe(
			"vendor/model",
		)
		// An id the catalog does not carry falls back to the provider default.
		expect(select({ apiProvider: "openrouter", openRouterModelId: "gone" } as ProviderSettings).id).toBe(
			getProviderDefaultModelId("openrouter"),
		)
	})

	it("substitutes litellm's built-in info when the router knows nothing", () => {
		routerModels.mockReturnValue({ data: { litellm: {} }, isLoading: false, isError: false } as never)
		expect(select({ apiProvider: "litellm" } as ProviderSettings).info).toBe(litellmDefaultModelInfo)
	})

	it.each(["requesty", "unbound", "shofer", "poe", "vercel-ai-gateway"])(
		"%s reads its own router catalog",
		(apiProvider) => {
			const key = apiProvider
			const id = "the-model"
			routerModels.mockReturnValue({
				data: { [key]: { [id]: { contextWindow: 7, supportsPromptCache: false } } },
				isLoading: false,
				isError: false,
			} as never)

			const config = {
				apiProvider,
				requestyModelId: id,
				unboundModelId: id,
				apiModelId: id,
				vercelAiGatewayModelId: id,
			} as ProviderSettings
			expect(select(config).info).toEqual({ contextWindow: 7, supportsPromptCache: false })
		},
	)

	it("reports loading and error state from the router query", () => {
		routerModels.mockReturnValue({ data: undefined, isLoading: true, isError: false } as never)
		expect(select({ apiProvider: "openrouter" } as ProviderSettings).isLoading).toBe(true)

		routerModels.mockReturnValue({ data: undefined, isLoading: false, isError: true } as never)
		expect(select({ apiProvider: "openrouter" } as ProviderSettings).isError).toBe(true)
	})
})

describe("local model servers", () => {
	it("merges LM Studio's default info under the server's own", () => {
		lmStudioModels.mockReturnValue({
			data: { local: { contextWindow: 4096 } },
			isLoading: false,
			isError: false,
		} as never)
		const model = select({ apiProvider: "lmstudio", lmStudioModelId: "local" } as ProviderSettings)
		expect(model.info).toEqual({ ...lMStudioDefaultModelInfo, contextWindow: 4096 })
	})

	it("reports no info for an LM Studio model the server does not serve", () => {
		lmStudioModels.mockReturnValue({ data: {}, isLoading: false, isError: false } as never)
		expect(select({ apiProvider: "lmstudio", lmStudioModelId: "gone" } as ProviderSettings).info).toBeUndefined()
	})

	it("clamps Ollama's context window to the configured num_ctx", () => {
		ollamaModels.mockReturnValue({
			data: { "llama3:8b": { contextWindow: 8192, supportsPromptCache: false } },
			isLoading: false,
			isError: false,
		} as never)

		expect(
			select({ apiProvider: "ollama", ollamaModelId: "llama3:8b", ollamaNumCtx: 4096 } as ProviderSettings).info!
				.contextWindow,
		).toBe(4096)

		// A num_ctx above the model's own window is not applied.
		expect(
			select({ apiProvider: "ollama", ollamaModelId: "llama3:8b", ollamaNumCtx: 99999 } as ProviderSettings).info!
				.contextWindow,
		).toBe(8192)
	})
})

describe("vscode-lm", () => {
	it("derives the id from the vendor/family selector", () => {
		const model = select({
			apiProvider: "vscode-lm",
			vsCodeLmModelSelector: { vendor: "copilot", family: "gpt-4o" },
		} as ProviderSettings)
		expect(model.id).toBe("copilot/gpt-4o")
	})

	it("takes the context window and capabilities the host advertises", () => {
		vsCodeLmModels.push({
			vendor: "llm-provider",
			family: "kimi",
			maxInputTokens: 123_456,
			shoferCapabilities: { imageInput: true, promptCache: true },
			shoferPricing: { inputPrice: 1, outputPrice: 2, cacheReadsPrice: 3, cacheWritesPrice: 4 },
		})

		const model = select({
			apiProvider: "vscode-lm",
			vsCodeLmModelSelector: { vendor: "llm-provider", family: "kimi" },
		} as ProviderSettings)

		expect(model.info).toMatchObject({
			contextWindow: 123_456,
			supportsImages: true,
			supportsPromptCache: true,
			inputPrice: 1,
			outputPrice: 2,
			cacheReadsPrice: 3,
			cacheWritesPrice: 4,
		})
	})

	it("accepts VS Code's own imageInput capability as a fallback", () => {
		vsCodeLmModels.push({
			vendor: "copilot",
			family: "bundled",
			maxInputTokens: 1000,
			capabilities: { imageInput: true },
		})
		const model = select({
			apiProvider: "vscode-lm",
			vsCodeLmModelSelector: { vendor: "copilot", family: "bundled" },
		} as ProviderSettings)
		expect(model.info!.supportsImages).toBe(true)
		expect(model.info!.supportsPromptCache).toBe(false)
	})

	it("falls back to the sane-default context window for an unknown model", () => {
		const model = select({
			apiProvider: "vscode-lm",
			vsCodeLmModelSelector: { vendor: "nobody", family: "nothing" },
		} as ProviderSettings)
		expect(model.info!.contextWindow).toBe(openAiModelInfoSaneDefaults.contextWindow)
	})
})

describe("a retired provider", () => {
	it("resolves nothing and reports no model info", () => {
		const model = select({ apiProvider: "groq", apiModelId: "whatever" } as ProviderSettings)
		expect(model.provider).toBe("groq")
		expect(model.info).toBeUndefined()
	})
})
