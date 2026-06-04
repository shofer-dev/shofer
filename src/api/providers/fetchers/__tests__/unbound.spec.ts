// Mocks must come first, before imports
vi.mock("axios")
vi.mock("../../../../utils/logging/subsystems", () => ({ apiLog: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }))

import type { Mock } from "vitest"
import axios from "axios"
import { getUnboundModels } from "../unbound"

const mockedAxios = axios as typeof axios & { get: Mock }

describe("getUnboundModels", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("returns empty object and does not throw when response data is not an array (error object from API)", async () => {
		mockedAxios.get.mockResolvedValue({ data: { error: "Unauthorized" } })
		const result = await getUnboundModels()
		expect(result).toEqual({})
	})

	it("returns empty object when response.data is null", async () => {
		mockedAxios.get.mockResolvedValue({ data: null })
		const result = await getUnboundModels()
		expect(result).toEqual({})
	})

	it("parses models from top-level array (response.data is an array)", async () => {
		mockedAxios.get.mockResolvedValue({
			data: [
				{
					id: "anthropic/claude-3-5-sonnet",
					max_output_tokens: 8192,
					context_window: 200000,
					supports_caching: true,
					supports_vision: true,
					input_price: "3.00",
					output_price: "15.00",
					caching_price: "3.75",
					cached_price: "0.30",
					description: "Claude 3.5 Sonnet",
				},
			],
		})

		const result = await getUnboundModels("test-api-key")

		expect(Object.keys(result)).toHaveLength(1)
		expect(result["anthropic/claude-3-5-sonnet"]).toMatchObject({
			maxTokens: 8192,
			contextWindow: 200000,
			supportsPromptCache: true,
			supportsImages: true,
		})
	})

	it("parses models from nested data array (response.data.data is an array)", async () => {
		mockedAxios.get.mockResolvedValue({
			data: {
				data: [
					{
						id: "openai/gpt-4o",
						max_output_tokens: 16384,
						context_window: 128000,
						supports_caching: false,
						supports_vision: true,
						input_price: "2.50",
						output_price: "10.00",
					},
				],
			},
		})

		const result = await getUnboundModels("test-api-key")

		expect(Object.keys(result)).toHaveLength(1)
		expect(result["openai/gpt-4o"]).toMatchObject({
			maxTokens: 16384,
			contextWindow: 128000,
			supportsPromptCache: false,
			supportsImages: true,
		})
	})

	it("sets Authorization header when apiKey is provided", async () => {
		mockedAxios.get.mockResolvedValue({ data: [] })
		await getUnboundModels("my-secret-key")
		expect(mockedAxios.get).toHaveBeenCalledWith("https://api.getunbound.ai/models", {
			headers: { Authorization: "Bearer my-secret-key" },
		})
	})

	it("does not set Authorization header when apiKey is absent", async () => {
		mockedAxios.get.mockResolvedValue({ data: [] })
		await getUnboundModels()
		expect(mockedAxios.get).toHaveBeenCalledWith("https://api.getunbound.ai/models", { headers: {} })
	})

	it("returns empty object and logs error when axios throws", async () => {
		const { apiLog } = await import("../../../../utils/logging/subsystems")
		mockedAxios.get.mockRejectedValue(new Error("Network error"))
		const result = await getUnboundModels("key")
		expect(result).toEqual({})
		expect(apiLog.error).toHaveBeenCalled()
	})
})
