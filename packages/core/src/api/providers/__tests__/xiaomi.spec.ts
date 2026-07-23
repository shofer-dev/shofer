// npx vitest run src/api/providers/__tests__/xiaomi.spec.ts

import OpenAI from "openai"

import { type XiaomiModelId, xiaomiDefaultModelId, xiaomiModels } from "@shofer/types"

import { XiaomiHandler } from "../xiaomi.js"

vitest.mock("openai", () => {
	const createMock = vitest.fn()
	return {
		default: vitest.fn(() => ({ chat: { completions: { create: createMock } } })),
	}
})

describe("XiaomiHandler", () => {
	let handler: XiaomiHandler
	let mockCreate: any

	beforeEach(() => {
		vitest.clearAllMocks()
		mockCreate = (OpenAI as unknown as any)().chat.completions.create
		handler = new XiaomiHandler({ xiaomiApiKey: "test-xiaomi-api-key" })
	})

	it("should use the default MiMo base URL", () => {
		new XiaomiHandler({ xiaomiApiKey: "test-xiaomi-api-key" })
		expect(OpenAI).toHaveBeenCalledWith(expect.objectContaining({ baseURL: "https://api.xiaomimimo.com/v1" }))
	})

	it("should honor a custom base URL", () => {
		new XiaomiHandler({ xiaomiApiKey: "test-xiaomi-api-key", xiaomiBaseUrl: "https://proxy.example.com/v1" })
		expect(OpenAI).toHaveBeenCalledWith(expect.objectContaining({ baseURL: "https://proxy.example.com/v1" }))
	})

	it("should use the provided API key", () => {
		const xiaomiApiKey = "test-xiaomi-api-key"
		new XiaomiHandler({ xiaomiApiKey })
		expect(OpenAI).toHaveBeenCalledWith(expect.objectContaining({ apiKey: xiaomiApiKey }))
	})

	it("should return the default model when no model is specified", () => {
		const model = handler.getModel()
		expect(model.id).toBe(xiaomiDefaultModelId)
		expect(model.info).toEqual(xiaomiModels[xiaomiDefaultModelId])
	})

	it("should return the specified model when a valid model is provided", () => {
		const testModelId: XiaomiModelId = "mimo-v2-flash"
		const handlerWithModel = new XiaomiHandler({ apiModelId: testModelId, xiaomiApiKey: "test-xiaomi-api-key" })
		const model = handlerWithModel.getModel()
		expect(model.id).toBe(testModelId)
		expect(model.info).toEqual(xiaomiModels[testModelId])
	})

	describe("createMessage request shape", () => {
		const systemPrompt = "You are a helpful assistant."

		beforeEach(() => {
			mockCreate.mockImplementation(() => ({
				[Symbol.asyncIterator]: () => ({
					async next() {
						return { done: true, value: undefined }
					},
				}),
			}))
		})

		it("sends max_completion_tokens instead of max_tokens and omits stream_options", async () => {
			const stream = handler.createMessage(systemPrompt, [{ role: "user", content: "hi" }])
			for await (const _chunk of stream) {
				// drain
			}

			expect(mockCreate).toHaveBeenCalledTimes(1)
			const params = mockCreate.mock.calls[0][0]
			expect(params.max_completion_tokens).toBeDefined()
			expect(params.max_tokens).toBeUndefined()
			expect(params.stream_options).toBeUndefined()
			expect(params.stream).toBe(true)
		})

		it("pins thinking enabled for the default (thinking) model", async () => {
			const stream = handler.createMessage(systemPrompt, [{ role: "user", content: "hi" }])
			for await (const _chunk of stream) {
				// drain
			}

			const params = mockCreate.mock.calls[0][0]
			expect(params.thinking).toEqual({ type: "enabled" })
		})

		it("does not send thinking for mimo-v2-flash (thinking off by default)", async () => {
			const flashHandler = new XiaomiHandler({ apiModelId: "mimo-v2-flash", xiaomiApiKey: "k" })
			const stream = flashHandler.createMessage(systemPrompt, [{ role: "user", content: "hi" }])
			for await (const _chunk of stream) {
				// drain
			}

			const params = mockCreate.mock.calls[0][0]
			expect(params.thinking).toBeUndefined()
		})

		it("preserves reasoning_content on assistant messages for tool-call turns", async () => {
			const messages = [
				{ role: "user" as const, content: "do something" },
				{
					role: "assistant" as const,
					content: [
						{ type: "reasoning" as const, text: "thinking about it" },
						{ type: "text" as const, text: "on it" },
					],
				},
				{ role: "user" as const, content: "ok" },
			]

			const stream = handler.createMessage(systemPrompt, messages as any)
			for await (const _chunk of stream) {
				// drain
			}

			const params = mockCreate.mock.calls[0][0]
			const assistantMsg = params.messages.find((m: any) => m.role === "assistant")
			expect(assistantMsg.reasoning_content).toBe("thinking about it")
		})
	})
})
