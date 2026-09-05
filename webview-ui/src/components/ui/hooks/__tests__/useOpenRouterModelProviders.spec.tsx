// npx vitest src/components/ui/hooks/__tests__/useOpenRouterModelProviders.spec.tsx
//
// The per-model provider list OpenRouter exposes as "endpoints". What matters
// here is the projection into `ModelInfo`: the tag wins over the display name
// as the key, prices are parsed from strings, cache support is INFERRED from a
// cache-read price existing, and image-generating models are dropped entirely.

import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import axios from "axios"

import { useOpenRouterModelProviders, OPENROUTER_DEFAULT_PROVIDER_NAME } from "../useOpenRouterModelProviders"

vi.mock("axios", () => ({ default: { get: vi.fn() } }))

const get = vi.mocked(axios.get)

const wrapper = ({ children }: { children: React.ReactNode }) => (
	<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
		{children}
	</QueryClientProvider>
)

const endpoint = (over: Record<string, unknown> = {}) => ({
	name: "Anthropic",
	context_length: 200_000,
	pricing: { prompt: "0.000003", completion: "0.000015" },
	...over,
})

const answer = (data: Record<string, unknown>) =>
	get.mockResolvedValue({
		data: { data: { id: "anthropic/claude", name: "Claude", endpoints: [endpoint()], ...data } },
	})

const load = async (modelId = "anthropic/claude", baseUrl?: string) => {
	const { result } = renderHook(() => useOpenRouterModelProviders(modelId, baseUrl), { wrapper })
	await waitFor(() => expect(result.current.isSuccess).toBe(true))
	return result.current.data!
}

beforeEach(() => {
	vi.clearAllMocks()
	vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => vi.restoreAllMocks())

describe("useOpenRouterModelProviders", () => {
	it("exports the sentinel the pickers use for 'let OpenRouter choose'", () => {
		expect(OPENROUTER_DEFAULT_PROVIDER_NAME).toBe("[default]")
	})

	it("returns an empty map with no model to ask about", async () => {
		const { result } = renderHook(() => useOpenRouterModelProviders(undefined), { wrapper })
		await waitFor(() => expect(result.current.isSuccess).toBe(true))

		expect(result.current.data).toEqual({})
		expect(get).not.toHaveBeenCalled()
	})

	it("asks the model's endpoints route", async () => {
		answer({})
		await load()
		expect(get).toHaveBeenCalledWith("https://openrouter.ai/api/v1/models/anthropic/claude/endpoints")
	})

	it("honours a self-hosted base URL", async () => {
		answer({})
		await load("anthropic/claude", "https://gateway.internal/v1")
		expect(get.mock.calls[0][0]).toBe("https://gateway.internal/v1/models/anthropic/claude/endpoints")
	})

	it("projects an endpoint into model info, keyed by its display name", async () => {
		answer({ description: "a model" })
		const providers = await load()

		expect(providers.Anthropic).toMatchObject({
			label: "Anthropic",
			contextWindow: 200_000,
			maxTokens: 200_000,
			inputPrice: 3,
			outputPrice: 15,
			supportsPromptCache: false,
			supportsImages: false,
			description: "a model",
		})
	})

	it("prefers the endpoint's tag over its display name", async () => {
		answer({ endpoints: [endpoint({ tag: "anthropic/fast" })] })
		const providers = await load()

		expect(Object.keys(providers)).toEqual(["anthropic/fast"])
		expect(providers["anthropic/fast"].label).toBe("anthropic/fast")
	})

	it("prefers the endpoint's own completion cap over the context window", async () => {
		answer({ endpoints: [endpoint({ max_completion_tokens: 8192 })] })
		expect((await load()).Anthropic.maxTokens).toBe(8192)
	})

	it("infers prompt-cache support from a cache-read price", async () => {
		answer({
			endpoints: [
				endpoint({
					pricing: { prompt: "0.000003", completion: "0.000015", input_cache_read: "0.0000003" },
				}),
			],
		})
		const providers = await load()

		expect(providers.Anthropic.supportsPromptCache).toBe(true)
		expect(providers.Anthropic.cacheReadsPrice).toBeCloseTo(0.3)
	})

	it("reports image support from the architecture's input modalities", async () => {
		answer({ architecture: { input_modalities: ["text", "image"] } })
		expect((await load()).Anthropic.supportsImages).toBe(true)
	})

	it("drops a model that OUTPUTS images", async () => {
		answer({ architecture: { output_modalities: ["image"] } })
		expect(await load()).toEqual({})
	})

	it("returns an empty map when the response fails its schema", async () => {
		get.mockResolvedValue({ data: { data: { id: "x" } } })
		expect(await load()).toEqual({})
	})

	it("returns an empty map on a transport failure", async () => {
		get.mockRejectedValue(new Error("offline"))
		expect(await load()).toEqual({})
	})

	it("keeps every endpoint the model offers", async () => {
		answer({ endpoints: [endpoint(), endpoint({ name: "Bedrock" }), endpoint({ name: "Vertex" })] })
		expect(Object.keys(await load())).toEqual(["Anthropic", "Bedrock", "Vertex"])
	})
})
