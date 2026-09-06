import type { Anthropic } from "@anthropic-ai/sdk"

/**
 * The Unbound router. Beyond the ordinary OpenAI-shaped streaming, three
 * things here are Unbound-specific and worth pinning:
 *
 *  - it bills through ANTHROPIC-style cache tokens
 *    (`cache_creation_input_tokens` / `cache_read_input_tokens`), so the usage
 *    chunk carries cache reads and writes that a plain OpenAI provider has no
 *    field for, and a cost computed from them;
 *  - `unbound_metadata` carries the task id and mode upstream — dropping it
 *    loses the attribution the router bills against;
 *  - a reasoning effort outside `low|medium|high` is OMITTED rather than
 *    forwarded, because Chat Completions rejects the extended values.
 *
 * The OpenAI SDK is mocked, so no request leaves the process.
 */

const mockCreate = vi.fn()

vi.mock("openai", () => ({
	default: vi.fn(() => ({ chat: { completions: { create: mockCreate } } })),
}))

const getModels = vi.fn()
vi.mock("../fetchers/modelCache.js", () => ({ getModels: (...a: unknown[]) => getModels(...a) }))

import OpenAI from "openai"

import { UnboundHandler } from "../unbound.js"

const MODEL_ID = "anthropic/claude-3-5-sonnet-20241022"

const MODEL_INFO = {
	maxTokens: 8192,
	contextWindow: 200_000,
	supportsImages: true,
	supportsPromptCache: true,
	inputPrice: 3,
	outputPrice: 15,
	cacheWritesPrice: 3.75,
	cacheReadsPrice: 0.3,
	supportsReasoningEffort: true,
}

const USER: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "hi" }]

function stubStream(chunks: unknown[]) {
	mockCreate.mockResolvedValue({
		async *[Symbol.asyncIterator]() {
			for (const c of chunks) yield c
		},
	})
}

async function drain(stream: AsyncIterable<unknown>) {
	const out: unknown[] = []
	for await (const c of stream) out.push(c)
	return out
}

beforeEach(() => {
	vi.clearAllMocks()
	getModels.mockResolvedValue({ [MODEL_ID]: MODEL_INFO })
})

describe("UnboundHandler — construction and model resolution", () => {
	it("points at the Unbound router and labels the app", () => {
		new UnboundHandler({ unboundApiKey: "key" } as never)

		expect(OpenAI).toHaveBeenCalledWith(
			expect.objectContaining({ baseURL: "https://api.getunbound.ai/v1", apiKey: "key" }),
		)
		const headers = vi.mocked(OpenAI).mock.calls[0]![0]!.defaultHeaders as Record<string, string>
		expect(JSON.parse(headers["X-Unbound-Metadata"]!)).toEqual({ labels: [{ key: "app", value: "shofer-code" }] })
	})

	it("substitutes a placeholder key rather than sending undefined", () => {
		new UnboundHandler({} as never)

		expect(vi.mocked(OpenAI).mock.calls[0]![0]!.apiKey).toBe("not-provided")
	})

	it("falls back to the default model info for an id the router does not list", async () => {
		getModels.mockResolvedValue({})
		const handler = new UnboundHandler({ unboundModelId: "who/knows" } as never)

		const { id, info } = await handler.fetchModel()

		expect(id).toBe("who/knows")
		expect(info.contextWindow).toBeGreaterThan(0)
	})

	it("asks the model cache with the configured key", async () => {
		await new UnboundHandler({ unboundApiKey: "key", unboundModelId: MODEL_ID } as never).fetchModel()

		expect(getModels).toHaveBeenCalledWith({ provider: "unbound", apiKey: "key" })
	})
})

describe("UnboundHandler — createMessage", () => {
	it("streams text, reasoning and partial tool calls", async () => {
		stubStream([
			{ choices: [{ delta: { content: "hello" } }] },
			{ choices: [{ delta: { reasoning_content: "thinking" } }] },
			{
				choices: [
					{
						delta: {
							tool_calls: [{ index: 0, id: "c1", function: { name: "read_file", arguments: '{"p' } }],
						},
					},
				],
			},
			{ choices: [{ delta: {} }] },
		])

		const chunks = await drain(
			new UnboundHandler({ unboundApiKey: "key", unboundModelId: MODEL_ID } as never).createMessage("sys", USER),
		)

		expect(chunks).toEqual([
			{ type: "text", text: "hello" },
			{ type: "reasoning", text: "thinking" },
			{ type: "tool_call_partial", index: 0, id: "c1", name: "read_file", arguments: '{"p' },
		])
	})

	it("bills the Anthropic-style cache tokens the router reports", async () => {
		stubStream([
			{
				choices: [{ delta: {} }],
				usage: {
					prompt_tokens: 100,
					completion_tokens: 50,
					cache_creation_input_tokens: 20,
					cache_read_input_tokens: 30,
				},
			},
		])

		const chunks = (await drain(
			new UnboundHandler({ unboundApiKey: "key", unboundModelId: MODEL_ID } as never).createMessage("sys", USER),
		)) as Array<Record<string, number | string>>

		expect(chunks[0]).toMatchObject({
			type: "usage",
			inputTokens: 100,
			outputTokens: 50,
			cacheWriteTokens: 20,
			cacheReadTokens: 30,
		})
		expect(chunks[0]!.totalCost).toBeGreaterThan(0)
	})

	it("zeroes every count the usage payload omits", async () => {
		stubStream([{ choices: [{ delta: {} }], usage: {} }])

		const chunks = (await drain(
			new UnboundHandler({ unboundApiKey: "key", unboundModelId: MODEL_ID } as never).createMessage("sys", USER),
		)) as Array<Record<string, unknown>>

		expect(chunks[0]).toMatchObject({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 })
	})

	it("carries the task id and mode in unbound_metadata", async () => {
		stubStream([])

		await drain(
			new UnboundHandler({ unboundApiKey: "key", unboundModelId: MODEL_ID } as never).createMessage("sys", USER, {
				taskId: "task-1",
				mode: "code",
			} as never),
		)

		expect(mockCreate.mock.calls[0]![0].unbound_metadata).toEqual({
			originApp: "shofer-code",
			taskId: "task-1",
			mode: "code",
		})
		expect(mockCreate.mock.calls[0]![0].stream_options).toEqual({ include_usage: true })
	})

	it("forwards an accepted reasoning effort and drops an extended one", async () => {
		stubStream([])
		await drain(
			new UnboundHandler({
				unboundApiKey: "key",
				unboundModelId: MODEL_ID,
				reasoningEffort: "high",
			} as never).createMessage("sys", USER),
		)
		expect(mockCreate.mock.calls[0]![0].reasoning_effort).toBe("high")

		mockCreate.mockClear()
		stubStream([])
		await drain(
			new UnboundHandler({
				unboundApiKey: "key",
				unboundModelId: MODEL_ID,
				reasoningEffort: "minimal",
			} as never).createMessage("sys", USER),
		)
		expect(mockCreate.mock.calls[0]![0].reasoning_effort).toBeUndefined()
	})

	it("wraps an upstream failure in a provider-named error", async () => {
		mockCreate.mockRejectedValue(new Error("upstream exploded"))

		await expect(
			drain(
				new UnboundHandler({ unboundApiKey: "key", unboundModelId: MODEL_ID } as never).createMessage(
					"sys",
					USER,
				),
			),
		).rejects.toThrow(/Unbound/)
	})
})

describe("UnboundHandler — completePrompt", () => {
	it("returns the completion text", async () => {
		mockCreate.mockResolvedValue({ choices: [{ message: { content: "the answer" } }] })

		const result = await new UnboundHandler({
			unboundApiKey: "key",
			unboundModelId: MODEL_ID,
		} as never).completePrompt("a question")

		expect(result).toBe("the answer")
		expect(mockCreate.mock.calls[0]![0].messages).toEqual([{ role: "system", content: "a question" }])
	})

	it("returns an empty string when the completion carried no content", async () => {
		mockCreate.mockResolvedValue({ choices: [{ message: {} }] })

		expect(
			await new UnboundHandler({ unboundApiKey: "key", unboundModelId: MODEL_ID } as never).completePrompt("q"),
		).toBe("")
	})

	it("wraps an upstream failure in a provider-named error", async () => {
		mockCreate.mockRejectedValue(new Error("upstream exploded"))

		await expect(
			new UnboundHandler({ unboundApiKey: "key", unboundModelId: MODEL_ID } as never).completePrompt("q"),
		).rejects.toThrow(/Unbound/)
	})
})
