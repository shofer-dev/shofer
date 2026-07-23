// Mocks must come first, before imports
vi.mock("axios")

import type { Mock } from "vitest"
import axios from "axios"

import { getShoferModels, DEFAULT_SHOFER_BASE_URL } from "../shofer.js"

const mockedAxios = axios as typeof axios & { get: Mock }

/** A minimal llm-router /v1/models model entry (prices are USD PER 1M TOKENS, as strings). */
const glm = {
	id: "zhipu/glm-5.1",
	name: "GLM 5.1",
	description: "Zhipu flagship",
	pricing: {
		prompt: "5", // $5/1M
		completion: "30", // $30/1M
		input_cache_read: "0.5", // $0.50/1M
		input_cache_write: "6",
		discount: 0.5,
	},
	context_length: 200_000,
	max_output_tokens: 32_000,
	capabilities: { image_input: true, tool_calling: true, prompt_cache: true },
}

describe("getShoferModels", () => {
	beforeEach(() => vi.clearAllMocks())

	it("fetches {baseUrl}/models with a bearer token and defaults", async () => {
		mockedAxios.get.mockResolvedValue({ data: { data: [] } })

		await getShoferModels()

		expect(mockedAxios.get).toHaveBeenCalledWith(`${DEFAULT_SHOFER_BASE_URL}/models`, {
			headers: { Authorization: "Bearer shofer" },
		})
	})

	it("uses the provided base URL (trailing slashes stripped) + api key", async () => {
		mockedAxios.get.mockResolvedValue({ data: { data: [] } })

		await getShoferModels("http://router:30081/v1/", "secret")

		expect(mockedAxios.get).toHaveBeenCalledWith("http://router:30081/v1/models", {
			headers: { Authorization: "Bearer secret" },
		})
	})

	it("parses per-1M pricing as-is and maps capabilities/context", async () => {
		mockedAxios.get.mockResolvedValue({ data: { data: [glm] } })

		const models = await getShoferModels()
		const info = models["zhipu/glm-5.1"]

		expect(info).toBeDefined()
		expect(info!.inputPrice).toBe(5)
		expect(info!.outputPrice).toBe(30)
		expect(info!.cacheReadsPrice).toBe(0.5)
		expect(info!.cacheWritesPrice).toBe(6)
		expect(info!.contextWindow).toBe(200_000)
		expect(info!.maxTokens).toBe(32_000)
		expect(info!.supportsImages).toBe(true)
		expect(info!.supportsPromptCache).toBe(true)
		expect(info!.description).toBe("Zhipu flagship")
	})

	it("falls back to top_provider context + 20% maxTokens when absent", async () => {
		mockedAxios.get.mockResolvedValue({
			data: {
				data: [
					{
						id: "arkware/code",
						pricing: { prompt: "0", completion: "0" }, // composite models advertise 0
						top_provider: { context_length: 100_000 },
						capabilities: { prompt_cache: false },
					},
				],
			},
		})

		const info = (await getShoferModels())["arkware/code"]
		expect(info!.contextWindow).toBe(100_000)
		expect(info!.maxTokens).toBe(20_000) // ceil(100000 * 0.2)
		expect(info!.inputPrice).toBe(0)
		expect(info!.supportsPromptCache).toBe(false)
	})

	it("returns {} on network error (does not throw)", async () => {
		mockedAxios.get.mockRejectedValue(new Error("ECONNREFUSED"))
		await expect(getShoferModels()).resolves.toEqual({})
	})
})
