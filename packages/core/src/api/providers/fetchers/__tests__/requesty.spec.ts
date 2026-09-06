// Mocks must come first, before imports
vi.mock("axios")
vi.mock("../../_deps.js", async (importOriginal) => ({
	...((await importOriginal()) as Record<string, unknown>),
	apiLog: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

import type { Mock } from "vitest"
import axios from "axios"

import { apiLog } from "../../_deps.js"
import { getRequestyModels } from "../requesty.js"

/**
 * Requesty's model catalog fetch.
 *
 * Two things here are decisions rather than plumbing, and both are pinned:
 *
 *  - **reasoning capability is INFERRED from the model id**, because Requesty's
 *    catalog says only that a model reasons, not HOW it is asked to. The two
 *    knobs are mutually exclusive in practice — a budget (Anthropic/Vertex
 *    Gemini) or an effort level (OpenAI/Google Gemini) — so the id decides
 *    which one the settings UI offers. Getting it backwards offers a slider
 *    the API will reject;
 *  - **a fetch failure yields an EMPTY catalog, never a throw.** The catalog is
 *    refreshed opportunistically behind the settings view; a provider whose
 *    endpoint is down must not take the model picker with it.
 */

const mockedAxios = axios as typeof axios & { get: Mock }

const rawModel = (over: Record<string, unknown> = {}) => ({
	id: "coding/claude-sonnet-4",
	max_output_tokens: 8192,
	context_window: 200000,
	supports_caching: true,
	supports_vision: true,
	supports_reasoning: true,
	input_price: "0.000003",
	output_price: "0.000015",
	caching_price: "0.00000375",
	cached_price: "0.0000003",
	description: "A model",
	...over,
})

const fetchOne = async (over: Record<string, unknown> = {}) => {
	mockedAxios.get.mockResolvedValue({ data: { data: [rawModel(over)] } })
	const models = await getRequestyModels()
	return Object.values(models)[0]!
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe("the request", () => {
	it("asks the resolved service URL for v1/models", async () => {
		mockedAxios.get.mockResolvedValue({ data: { data: [] } })

		await getRequestyModels()

		const [url] = mockedAxios.get.mock.calls[0]!
		expect(url).toMatch(/\/v1\/models$/)
	})

	it("honours a caller-supplied base URL", async () => {
		mockedAxios.get.mockResolvedValue({ data: { data: [] } })

		await getRequestyModels("https://proxy.example.com/router")

		expect(mockedAxios.get.mock.calls[0]![0]).toContain("proxy.example.com")
	})

	it("sends the key as a bearer token when one is supplied", async () => {
		mockedAxios.get.mockResolvedValue({ data: { data: [] } })

		await getRequestyModels(undefined, "sk-requesty-test")

		expect(mockedAxios.get.mock.calls[0]![1]).toEqual({ headers: { Authorization: "Bearer sk-requesty-test" } })
	})

	it("sends NO authorization header when there is no key", async () => {
		mockedAxios.get.mockResolvedValue({ data: { data: [] } })

		await getRequestyModels()

		expect(mockedAxios.get.mock.calls[0]![1]).toEqual({ headers: {} })
	})
})

describe("the model shape", () => {
	it("carries every field the picker and the cost accounting need", async () => {
		expect(await fetchOne()).toEqual({
			maxTokens: 8192,
			contextWindow: 200000,
			supportsPromptCache: true,
			supportsImages: true,
			supportsReasoningBudget: true,
			supportsReasoningEffort: false,
			inputPrice: 3,
			outputPrice: 15,
			description: "A model",
			cacheWritesPrice: 3.75,
			cacheReadsPrice: 0.3,
		})
	})

	it("keys the catalog by the model id", async () => {
		mockedAxios.get.mockResolvedValue({ data: { data: [rawModel({ id: "vendor/model-x" })] } })

		expect(Object.keys(await getRequestyModels())).toEqual(["vendor/model-x"])
	})

	it("leaves an absent price undefined rather than coercing it to zero", async () => {
		// Zero would be read as "free" by the cost accounting; absent is absent.
		const model = await fetchOne({ input_price: undefined, caching_price: undefined })

		expect(model.inputPrice).toBeUndefined()
		expect(model.cacheWritesPrice).toBeUndefined()
	})
})

describe("which reasoning knob the id implies", () => {
	it.each([
		["coding/claude-sonnet-4", "budget"],
		["coding/gemini-2.5-pro", "budget"],
		["vertex/gemini-2.5-flash", "budget"],
		["openai/o3-mini", "effort"],
		["google/gemini-2.5-pro", "effort"],
	])("%s asks for a %s", async (id, knob) => {
		const model = await fetchOne({ id })

		expect(model.supportsReasoningBudget).toBe(knob === "budget")
		expect(model.supportsReasoningEffort).toBe(knob === "effort")
	})

	it("offers NEITHER knob for a model that does not reason, whatever its id says", async () => {
		const model = await fetchOne({ id: "openai/gpt-4o", supports_reasoning: false })

		// The flag is the gate; the id only chooses between the two knobs.
		expect(model.supportsReasoningBudget).toBe(false)
		expect(model.supportsReasoningEffort).toBe(false)
	})

	it("offers neither for a reasoning model whose id matches no family", async () => {
		const model = await fetchOne({ id: "mistral/magistral" })

		expect(model.supportsReasoningBudget).toBe(false)
		expect(model.supportsReasoningEffort).toBe(false)
	})
})

describe("failure", () => {
	it("returns an EMPTY catalog and logs, rather than throwing, when the request fails", async () => {
		mockedAxios.get.mockRejectedValue(new Error("ECONNREFUSED"))

		await expect(getRequestyModels()).resolves.toEqual({})
		expect(apiLog.error).toHaveBeenCalledWith(expect.stringContaining("Error fetching Requesty models"))
	})

	it("survives a response whose payload is not the expected envelope", async () => {
		mockedAxios.get.mockResolvedValue({ data: { error: "Unauthorized" } })

		await expect(getRequestyModels()).resolves.toEqual({})
	})
})
