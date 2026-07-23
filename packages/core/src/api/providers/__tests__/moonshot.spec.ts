// npx vitest run src/api/providers/__tests__/moonshot.spec.ts
//
// Tests for the MoonshotHandler after migration from the Vercel AI SDK path
// (OpenAICompatibleHandler) to the raw OpenAI SDK path
// (BaseOpenAiCompatibleProvider). The key behavioural assertions are:
//
//   - reasoning_content is preserved on assistant messages (the quota-burn fix)
//   - temperature is forced to 1 for fixed-temperature Kimi models
//   - tool schemas are normalized to the Moonshot-flavored JSON Schema subset
//   - usage metrics (including cached_tokens) are correctly extracted
//   - stream_options.include_usage is always sent

import OpenAI from "openai"
import { Anthropic } from "@anthropic-ai/sdk"

import { moonshotDefaultModelId, moonshotModels, type MoonshotModelId } from "@shofer/types"

import type { ApiHandlerOptions } from "../_deps.js"

import { MoonshotHandler } from "../moonshot.js"

vitest.mock("openai", () => {
	const createMock = vitest.fn()
	return {
		default: vitest.fn(() => ({ chat: { completions: { create: createMock } } })),
	}
})

describe("MoonshotHandler", () => {
	let handler: MoonshotHandler
	let mockCreate: any
	let mockOptions: ApiHandlerOptions

	beforeEach(() => {
		vitest.clearAllMocks()
		mockOptions = {
			moonshotApiKey: "test-api-key",
			apiModelId: "kimi-k2-0905-preview",
			moonshotBaseUrl: "https://api.moonshot.ai/v1",
		}
		handler = new MoonshotHandler(mockOptions)
		mockCreate = (OpenAI as unknown as any)().chat.completions.create
	})

	describe("constructor", () => {
		it("should initialize with provided options", () => {
			expect(handler).toBeInstanceOf(MoonshotHandler)
			expect(handler.getModel().id).toBe(mockOptions.apiModelId)
		})

		it("should use default model ID if not provided", () => {
			const handlerWithoutModel = new MoonshotHandler({
				...mockOptions,
				apiModelId: undefined,
			})
			expect(handlerWithoutModel.getModel().id).toBe(moonshotDefaultModelId)
		})

		it("should use default base URL if not provided", () => {
			const handlerWithoutBaseUrl = new MoonshotHandler({
				...mockOptions,
				moonshotBaseUrl: undefined,
			})
			expect(OpenAI).toHaveBeenCalledWith(
				expect.objectContaining({
					baseURL: "https://api.moonshot.ai/v1",
				}),
			)
		})

		it("should use custom base URL when provided", () => {
			const customBaseUrl = "https://api.kimi.com/coding/v1"
			new MoonshotHandler({
				...mockOptions,
				moonshotBaseUrl: customBaseUrl,
			})
			expect(OpenAI).toHaveBeenCalledWith(
				expect.objectContaining({
					baseURL: customBaseUrl,
				}),
			)
		})

		it("should pass the API key to the OpenAI client", () => {
			new MoonshotHandler({ ...mockOptions, moonshotApiKey: "my-key" })
			expect(OpenAI).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "my-key" }))
		})

		it("should use 'not-provided' as API key when none is specified", () => {
			new MoonshotHandler({ ...mockOptions, moonshotApiKey: undefined })
			expect(OpenAI).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "not-provided" }))
		})
	})

	describe("getModel", () => {
		it("should return model info for valid model ID", () => {
			const model = handler.getModel()
			expect(model.id).toBe(mockOptions.apiModelId)
			expect(model.info).toBeDefined()
			expect(model.info.maxTokens).toBe(16384)
			expect(model.info.contextWindow).toBe(262144)
			expect(model.info.supportsImages).toBe(false)
			expect(model.info.supportsPromptCache).toBe(true)
		})

		it("should fall back to default model when an invalid model ID is provided", () => {
			// BaseOpenAiCompatibleProvider.getModel() falls back to the default
			// when the ID is not in the catalog (unlike the old AI SDK handler
			// which returned the invalid ID as-is).
			const handlerWithInvalidModel = new MoonshotHandler({
				...mockOptions,
				apiModelId: "invalid-model",
			})
			const model = handlerWithInvalidModel.getModel()
			expect(model.id).toBe(moonshotDefaultModelId)
			expect(model.info).toBeDefined()
			expect(model.info.supportsPromptCache).toBe(true)
		})

		it("should return default model if no model ID is provided", () => {
			const handlerWithoutModel = new MoonshotHandler({
				...mockOptions,
				apiModelId: undefined,
			})
			const model = handlerWithoutModel.getModel()
			expect(model.id).toBe(moonshotDefaultModelId)
			expect(model.info).toBeDefined()
			expect(model.info.supportsPromptCache).toBe(true)
		})

		it("forces temperature to 1 for fixed-temperature Kimi models (k3) even with a custom modelTemperature", async () => {
			// The Kimi-for-Coding endpoint rejects any temperature != 1; a profile
			// carrying temperature 0 would 400 the request otherwise.
			const k3Handler = new MoonshotHandler({
				...mockOptions,
				apiModelId: "k3",
				modelTemperature: 0,
			})

			mockCreate.mockImplementationOnce(() => ({
				[Symbol.asyncIterator]: () => ({
					async next() {
						return { done: true }
					},
				}),
			}))

			const messageGenerator = k3Handler.createMessage("system prompt", [])
			await messageGenerator.next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "k3",
					temperature: 1,
				}),
				undefined,
			)
		})

		it("forces temperature to 1 for kimi-k2-thinking", async () => {
			const thinkingHandler = new MoonshotHandler({
				...mockOptions,
				apiModelId: "kimi-k2-thinking",
				modelTemperature: 0.5,
			})

			mockCreate.mockImplementationOnce(() => ({
				[Symbol.asyncIterator]: () => ({
					async next() {
						return { done: true }
					},
				}),
			}))

			const messageGenerator = thinkingHandler.createMessage("system prompt", [])
			await messageGenerator.next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					temperature: 1,
				}),
				undefined,
			)
		})
	})

	describe("reasoning_effort", () => {
		const emptyStream = () => ({
			[Symbol.asyncIterator]: () => ({
				async next() {
					return { done: true }
				},
			}),
		})

		it("sends the catalog default 'high' for k3 when no effort is configured", async () => {
			// Omitting reasoning_effort means the SERVER default "max" — maximum
			// thinking effort on every agent-loop step — so an explicit value must
			// always be sent for K3.
			const k3Handler = new MoonshotHandler({ ...mockOptions, apiModelId: "k3" })
			mockCreate.mockImplementationOnce(emptyStream)

			await k3Handler.createMessage("system prompt", []).next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({ model: "k3", reasoning_effort: "high" }),
				undefined,
			)
		})

		it("maps the 'xhigh' setting to Kimi's 'max'", async () => {
			const k3Handler = new MoonshotHandler({ ...mockOptions, apiModelId: "k3", reasoningEffort: "xhigh" })
			mockCreate.mockImplementationOnce(emptyStream)

			await k3Handler.createMessage("system prompt", []).next()

			expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ reasoning_effort: "max" }), undefined)
		})

		it("passes 'low' through unchanged", async () => {
			const k3Handler = new MoonshotHandler({ ...mockOptions, apiModelId: "k3", reasoningEffort: "low" })
			mockCreate.mockImplementationOnce(emptyStream)

			await k3Handler.createMessage("system prompt", []).next()

			expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ reasoning_effort: "low" }), undefined)
		})

		it("maps an off-ish 'disable' selection to 'low' (thinking cannot be disabled)", async () => {
			const k3Handler = new MoonshotHandler({ ...mockOptions, apiModelId: "k3", reasoningEffort: "disable" })
			mockCreate.mockImplementationOnce(emptyStream)

			await k3Handler.createMessage("system prompt", []).next()

			expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ reasoning_effort: "low" }), undefined)
		})

		it("sends reasoning_effort for the platform 'kimi-k3' id as well", async () => {
			const k3Handler = new MoonshotHandler({ ...mockOptions, apiModelId: "kimi-k3" })
			mockCreate.mockImplementationOnce(emptyStream)

			await k3Handler.createMessage("system prompt", []).next()

			expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ reasoning_effort: "high" }), undefined)
		})

		it("does not send reasoning_effort for models without the capability (kimi-k2-thinking)", async () => {
			const thinkingHandler = new MoonshotHandler({
				...mockOptions,
				apiModelId: "kimi-k2-thinking",
				reasoningEffort: "high",
			})
			mockCreate.mockImplementationOnce(emptyStream)

			await thinkingHandler.createMessage("system prompt", []).next()

			const params = mockCreate.mock.calls[0][0]
			expect(params).not.toHaveProperty("reasoning_effort")
		})
	})

	describe("completePrompt", () => {
		// The single-shot path (used by e.g. "Enhance prompt") must resolve the
		// same request parameters as the streaming path — the base-class
		// implementation sends only {model, messages}, which on K3 means the
		// server-default reasoning_effort "max" and no output-token cap.
		const completionResponse = (content: string) => ({
			choices: [{ message: { content } }],
		})

		it("sends an explicit reasoning_effort for k3 (never the server default 'max')", async () => {
			const k3Handler = new MoonshotHandler({ ...mockOptions, apiModelId: "k3" })
			mockCreate.mockResolvedValueOnce(completionResponse("enhanced"))

			const result = await k3Handler.completePrompt("test prompt")

			expect(result).toBe("enhanced")
			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "k3",
					reasoning_effort: "high",
					messages: [{ role: "user", content: "test prompt" }],
				}),
			)
			const params = mockCreate.mock.calls[0][0]
			expect(params).not.toHaveProperty("stream")
		})

		it("maps a configured 'xhigh' to Kimi's 'max' on the single-shot path too", async () => {
			const k3Handler = new MoonshotHandler({ ...mockOptions, apiModelId: "k3", reasoningEffort: "xhigh" })
			mockCreate.mockResolvedValueOnce(completionResponse("ok"))

			await k3Handler.completePrompt("test prompt")

			expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ reasoning_effort: "max" }))
		})

		it("pins temperature to 1 and caps max_tokens for fixed-temperature models", async () => {
			const k3Handler = new MoonshotHandler({ ...mockOptions, apiModelId: "k3", modelTemperature: 0 })
			mockCreate.mockResolvedValueOnce(completionResponse("ok"))

			await k3Handler.completePrompt("test prompt")

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					temperature: 1,
					max_tokens: moonshotModels.k3.maxTokens,
				}),
			)
		})

		it("does not send reasoning_effort for models without the capability", async () => {
			mockCreate.mockResolvedValueOnce(completionResponse("ok"))

			await handler.completePrompt("test prompt")

			const params = mockCreate.mock.calls[0][0]
			expect(params).not.toHaveProperty("reasoning_effort")
		})

		it("returns an empty string when the response has no content", async () => {
			mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: null } }] })

			expect(await handler.completePrompt("test prompt")).toBe("")
		})
	})

	describe("createMessage", () => {
		it("should yield text content from stream", async () => {
			const testContent = "Test response from Moonshot"

			mockCreate.mockImplementationOnce(() => ({
				[Symbol.asyncIterator]: () => ({
					next: vitest
						.fn()
						.mockResolvedValueOnce({
							done: false,
							value: { choices: [{ delta: { content: testContent } }] },
						})
						.mockResolvedValueOnce({ done: true }),
				}),
			}))

			const stream = handler.createMessage("system prompt", [])
			const firstChunk = await stream.next()

			expect(firstChunk.done).toBe(false)
			expect(firstChunk.value).toEqual({ type: "text", text: testContent })
		})

		it("should yield reasoning content from stream", async () => {
			const reasoningContent = "Thinking about the problem..."

			mockCreate.mockImplementationOnce(() => ({
				[Symbol.asyncIterator]: () => ({
					next: vitest
						.fn()
						.mockResolvedValueOnce({
							done: false,
							value: { choices: [{ delta: { reasoning_content: reasoningContent } }] },
						})
						.mockResolvedValueOnce({ done: true }),
				}),
			}))

			const stream = handler.createMessage("system prompt", [])
			const firstChunk = await stream.next()

			expect(firstChunk.done).toBe(false)
			expect(firstChunk.value).toEqual({ type: "reasoning", text: reasoningContent })
		})

		it("should yield usage data from stream", async () => {
			mockCreate.mockImplementationOnce(() => ({
				[Symbol.asyncIterator]: () => ({
					next: vitest
						.fn()
						.mockResolvedValueOnce({
							done: false,
							value: {
								choices: [{ delta: {} }],
								usage: { prompt_tokens: 10, completion_tokens: 20 },
							},
						})
						.mockResolvedValueOnce({ done: true }),
				}),
			}))

			const stream = handler.createMessage("system prompt", [])
			const firstChunk = await stream.next()

			expect(firstChunk.done).toBe(false)
			expect(firstChunk.value).toMatchObject({ type: "usage", inputTokens: 10, outputTokens: 20 })
		})

		it("should include cache metrics from raw cached_tokens in usage", async () => {
			mockCreate.mockImplementationOnce(() => ({
				[Symbol.asyncIterator]: () => ({
					next: vitest
						.fn()
						.mockResolvedValueOnce({
							done: false,
							value: {
								choices: [{ delta: {} }],
								usage: {
									prompt_tokens: 100,
									completion_tokens: 50,
									// Moonshot puts cached_tokens at the top level
									cached_tokens: 30,
								},
							},
						})
						.mockResolvedValueOnce({ done: true }),
				}),
			}))

			const stream = handler.createMessage("system prompt", [])
			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			const usageChunks = chunks.filter((c) => c.type === "usage")
			expect(usageChunks.length).toBeGreaterThan(0)
			expect(usageChunks[0].cacheReadTokens).toBe(30)
		})

		it("should include cache metrics from prompt_tokens_details.cached_tokens in usage", async () => {
			mockCreate.mockImplementationOnce(() => ({
				[Symbol.asyncIterator]: () => ({
					next: vitest
						.fn()
						.mockResolvedValueOnce({
							done: false,
							value: {
								choices: [{ delta: {} }],
								usage: {
									prompt_tokens: 100,
									completion_tokens: 50,
									prompt_tokens_details: { cached_tokens: 25 },
								},
							},
						})
						.mockResolvedValueOnce({ done: true }),
				}),
			}))

			const stream = handler.createMessage("system prompt", [])
			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			const usageChunks = chunks.filter((c) => c.type === "usage")
			expect(usageChunks.length).toBeGreaterThan(0)
			expect(usageChunks[0].cacheReadTokens).toBe(25)
		})

		it("should always send stream_options.include_usage", async () => {
			mockCreate.mockImplementationOnce(() => ({
				[Symbol.asyncIterator]: () => ({
					async next() {
						return { done: true }
					},
				}),
			}))

			const messageGenerator = handler.createMessage("system prompt", [])
			await messageGenerator.next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					stream: true,
					stream_options: { include_usage: true },
				}),
				undefined,
			)
		})

		it("should pass correct model and max_tokens parameters", async () => {
			const modelId: MoonshotModelId = "kimi-k2-0905-preview"
			const modelInfo = moonshotModels[modelId]
			const handlerWithModel = new MoonshotHandler({
				...mockOptions,
				apiModelId: modelId,
			})

			mockCreate.mockImplementationOnce(() => ({
				[Symbol.asyncIterator]: () => ({
					async next() {
						return { done: true }
					},
				}),
			}))

			const messageGenerator = handlerWithModel.createMessage("system prompt", [])
			await messageGenerator.next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: modelId,
					max_tokens: modelInfo.maxTokens,
				}),
				undefined,
			)
		})
	})

	describe("reasoning_content preservation", () => {
		it("should preserve reasoning_content on assistant messages with tool calls", async () => {
			// This is the core fix: reasoning stored as a {type:"reasoning"} content
			// block must be converted to the top-level reasoning_content field that
			// Moonshot expects, NOT dropped silently.
			const handlerWithModel = new MoonshotHandler({
				...mockOptions,
				apiModelId: "k3",
			})

			mockCreate.mockImplementationOnce(() => ({
				[Symbol.asyncIterator]: () => ({
					async next() {
						return { done: true }
					},
				}),
			}))

			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: "What is 2+2?" },
				{
					role: "assistant",
					content: [
						{ type: "reasoning", text: "I need to add 2 and 2." } as any,
						{ type: "text", text: "Let me calculate that." },
						{
							type: "tool_use",
							id: "call_abc",
							name: "calculator",
							input: { expression: "2+2" },
						},
					],
				},
				{
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "call_abc", content: "4" }],
				},
			]

			const messageGenerator = handlerWithModel.createMessage("system prompt", messages)
			await messageGenerator.next()

			const callArgs = mockCreate.mock.calls[0][0]
			const assistantMessages = callArgs.messages.filter((m: any) => m.role === "assistant")

			// The assistant message should have reasoning_content set
			expect(assistantMessages.length).toBeGreaterThan(0)
			expect(assistantMessages[0].reasoning_content).toBe("I need to add 2 and 2.")
		})

		it("should merge post-tool-result text into the last tool message", async () => {
			// For thinking models, a user message after tool results causes the
			// model to drop all prior reasoning_content. The converter should
			// merge the text (e.g. environment_details) into the last tool message.
			const handlerWithModel = new MoonshotHandler({
				...mockOptions,
				apiModelId: "k3",
			})

			mockCreate.mockImplementationOnce(() => ({
				[Symbol.asyncIterator]: () => ({
					async next() {
						return { done: true }
					},
				}),
			}))

			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: "Read the file" },
				{
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: "call_xyz",
							name: "read_file",
							input: { path: "test.ts" },
						},
					],
				},
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "call_xyz", content: "file contents here" },
						{ type: "text", text: "[environment_details]\nCurrent time: 12:00" },
					],
				},
			]

			const messageGenerator = handlerWithModel.createMessage("system prompt", messages)
			await messageGenerator.next()

			const callArgs = mockCreate.mock.calls[0][0]
			const toolMessages = callArgs.messages.filter((m: any) => m.role === "tool")

			// The environment_details text should be merged into the tool message,
			// not appear as a separate user message.
			expect(toolMessages.length).toBe(1)
			expect(toolMessages[0].content).toContain("file contents here")
			expect(toolMessages[0].content).toContain("[environment_details]")

			// There should be no user message after the tool message
			const userMessages = callArgs.messages.filter((m: any) => m.role === "user")
			expect(userMessages.length).toBe(1) // only the original "Read the file"
		})
	})

	describe("tool schema normalization", () => {
		it("should normalize nullable union types in tool parameters", async () => {
			mockCreate.mockImplementationOnce(() => ({
				[Symbol.asyncIterator]: () => ({
					async next() {
						return { done: true }
					},
				}),
			}))

			const messageGenerator = handler.createMessage("system prompt", [], {
				taskId: "test-task",
				tools: [
					{
						type: "function",
						function: {
							name: "test_tool",
							description: "A test tool",
							parameters: {
								type: "object",
								properties: {
									path: { type: ["string", "null"] },
								},
								required: ["path"],
							},
						},
					},
				],
			})
			await messageGenerator.next()

			const callArgs = mockCreate.mock.calls[0][0]
			const tool = callArgs.tools[0]
			// Array-typed type should be collapsed to single "string"
			expect(tool.function.parameters.properties.path.type).toBe("string")
		})
	})

	describe("completePrompt", () => {
		it("should complete a prompt and return text", async () => {
			const expectedResponse = "Test completion from Moonshot"
			mockCreate.mockResolvedValueOnce({
				choices: [{ message: { content: expectedResponse } }],
			})

			const result = await handler.completePrompt("Test prompt")
			expect(result).toBe(expectedResponse)
		})

		it("should handle errors in completePrompt", async () => {
			const errorMessage = "Moonshot API error"
			mockCreate.mockRejectedValueOnce(new Error(errorMessage))
			await expect(handler.completePrompt("test prompt")).rejects.toThrow()
		})
	})

	describe("processUsageMetrics", () => {
		it("should correctly process usage metrics including cache information from raw cached_tokens", () => {
			class TestMoonshotHandler extends MoonshotHandler {
				public testProcessUsageMetrics(usage: any) {
					return this.processUsageMetrics(usage, this.getModel().info)
				}
			}

			const testHandler = new TestMoonshotHandler(mockOptions)

			const usage = {
				prompt_tokens: 100,
				completion_tokens: 50,
				cached_tokens: 20,
			}

			const result = testHandler.testProcessUsageMetrics(usage)

			expect(result.type).toBe("usage")
			expect(result.inputTokens).toBe(100)
			expect(result.outputTokens).toBe(50)
			expect(result.cacheReadTokens).toBe(20)
		})

		it("should handle missing cache metrics gracefully", () => {
			class TestMoonshotHandler extends MoonshotHandler {
				public testProcessUsageMetrics(usage: any) {
					return this.processUsageMetrics(usage, this.getModel().info)
				}
			}

			const testHandler = new TestMoonshotHandler(mockOptions)

			const usage = {
				prompt_tokens: 100,
				completion_tokens: 50,
			}

			const result = testHandler.testProcessUsageMetrics(usage)

			expect(result.type).toBe("usage")
			expect(result.inputTokens).toBe(100)
			expect(result.outputTokens).toBe(50)
			expect(result.cacheReadTokens).toBeUndefined()
		})
	})
})
