import type { Anthropic } from "@anthropic-ai/sdk"

import type { ModelInfo } from "@shofer/types"

/**
 * `OpenAICompatibleHandler` is the AI-SDK-backed base every openai-compatible
 * provider that does NOT preserve reasoning sits on (DashScope, and the others
 * that opt in). Two of its properties are contractual rather than incidental:
 *
 *  - `includeUsage: true` on the provider factory. Without it the upstream
 *    never sends a final usage chunk, `result.usage` resolves empty, and the
 *    task header silently shows zero tokens and zero cost.
 *  - the model's own `temperature`/`maxOutputTokens` win over the config's, so
 *    a per-model override actually reaches the request.
 *
 * The AI SDK itself is mocked — there is no network and no provider — but the
 * stream parts are the real shapes `processAiSdkStreamPart` consumes, so the
 * conversion under test is the production one.
 */

const streamText = vi.fn()
const generateText = vi.fn()
const createOpenAICompatible = vi.fn()

vi.mock("ai", async (importOriginal) => ({
	...(await importOriginal<typeof import("ai")>()),
	streamText: (...args: unknown[]) => streamText(...args),
	generateText: (...args: unknown[]) => generateText(...args),
}))

vi.mock("@ai-sdk/openai-compatible", () => ({
	createOpenAICompatible: (...args: unknown[]) => createOpenAICompatible(...args),
}))

import { OpenAICompatibleHandler, type OpenAICompatibleConfig } from "../openai-compatible.js"

const MODEL_INFO: ModelInfo = {
	maxTokens: 4096,
	contextWindow: 128_000,
	supportsImages: false,
	supportsPromptCache: false,
	inputPrice: 1,
	outputPrice: 2,
}

class TestHandler extends OpenAICompatibleHandler {
	constructor(
		config: Partial<OpenAICompatibleConfig> = {},
		private readonly model = {},
	) {
		super({} as never, {
			providerName: "testprovider",
			baseURL: "https://test.example/v1",
			apiKey: "key",
			modelId: "test-model",
			modelInfo: MODEL_INFO,
			...config,
		})
	}

	override getModel() {
		return { id: "test-model", info: MODEL_INFO, ...this.model }
	}
}

async function drain(stream: AsyncIterable<unknown>) {
	const out: unknown[] = []
	for await (const c of stream) out.push(c)
	return out
}

function stubStream(parts: unknown[], usage?: unknown) {
	streamText.mockReturnValue({
		fullStream: (async function* () {
			for (const p of parts) yield p
		})(),
		usage: Promise.resolve(usage),
	})
}

const USER: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "hi" }]

beforeEach(() => {
	vi.clearAllMocks()
	createOpenAICompatible.mockReturnValue((modelId: string) => ({ modelId }))
})

describe("OpenAICompatibleHandler — provider construction", () => {
	it("asks the SDK for usage so the task header is not silently zeroed", () => {
		new TestHandler()

		expect(createOpenAICompatible).toHaveBeenCalledWith(
			expect.objectContaining({ name: "testprovider", baseURL: "https://test.example/v1", includeUsage: true }),
		)
	})

	it("merges configured headers over the default ones", () => {
		new TestHandler({ headers: { "X-Extra": "1" } })

		const headers = createOpenAICompatible.mock.calls[0]![0].headers
		expect(headers["X-Extra"]).toBe("1")
		expect(Object.keys(headers).length).toBeGreaterThan(1)
	})
})

describe("OpenAICompatibleHandler — createMessage", () => {
	it("converts every stream part shape and ends with a usage chunk", async () => {
		stubStream(
			[
				{ type: "text", text: "hello" },
				{ type: "reasoning", text: "thinking" },
				{ type: "tool-input-start", id: "c1", toolName: "read_file" },
				{ type: "tool-input-delta", id: "c1", delta: '{"path"' },
				{ type: "tool-input-end", id: "c1" },
				// A lifecycle part that yields nothing.
				{ type: "text-start" },
			],
			{ inputTokens: 10, outputTokens: 5, details: { cachedInputTokens: 3, reasoningTokens: 2 } },
		)

		const chunks = await drain(new TestHandler().createMessage("sys", USER))

		expect(chunks).toEqual([
			{ type: "text", text: "hello" },
			{ type: "reasoning", text: "thinking" },
			{ type: "tool_call_start", id: "c1", name: "read_file" },
			{ type: "tool_call_delta", id: "c1", delta: '{"path"' },
			{ type: "tool_call_end", id: "c1" },
			{ type: "usage", inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, reasoningTokens: 2 },
		])
	})

	it("emits no usage chunk when the upstream reported none", async () => {
		stubStream([{ type: "text", text: "hi" }], undefined)

		const chunks = await drain(new TestHandler().createMessage("sys", USER))

		expect(chunks).toEqual([{ type: "text", text: "hi" }])
	})

	it("defaults absent token counts to zero rather than undefined", async () => {
		stubStream([], {})

		const chunks = await drain(new TestHandler().createMessage("sys", USER))

		expect(chunks).toEqual([
			{ type: "usage", inputTokens: 0, outputTokens: 0, cacheReadTokens: undefined, reasoningTokens: undefined },
		])
	})

	it("prefers the model's temperature over the config's, and the config's over zero", async () => {
		stubStream([])
		await drain(new TestHandler({ temperature: 0.3 }, { temperature: 0.9 }).createMessage("sys", USER))
		expect(streamText.mock.calls[0]![0].temperature).toBe(0.9)

		streamText.mockClear()
		stubStream([])
		await drain(new TestHandler({ temperature: 0.3 }).createMessage("sys", USER))
		expect(streamText.mock.calls[0]![0].temperature).toBe(0.3)

		streamText.mockClear()
		stubStream([])
		await drain(new TestHandler().createMessage("sys", USER))
		expect(streamText.mock.calls[0]![0].temperature).toBe(0)
	})

	it("prefers a user max-tokens override over the model's own ceiling", async () => {
		stubStream([])
		await drain(new TestHandler({ modelMaxTokens: 999 }).createMessage("sys", USER))

		expect(streamText.mock.calls[0]![0].maxOutputTokens).toBe(999)
	})

	it("forwards provider-specific options into the request body", async () => {
		stubStream([])
		await drain(
			new TestHandler({ providerOptions: { testprovider: { enable_thinking: true } } }).createMessage(
				"sys",
				USER,
			),
		)

		expect(streamText.mock.calls[0]![0].providerOptions).toEqual({ testprovider: { enable_thinking: true } })
	})

	it("sends no tools and no tool choice when the turn declares none", async () => {
		stubStream([])
		await drain(new TestHandler().createMessage("sys", USER))

		expect(streamText.mock.calls[0]![0].tools).toBeUndefined()
		expect(streamText.mock.calls[0]![0].toolChoice).toBeUndefined()
	})

	it.each([
		["auto", "auto"],
		["none", "none"],
		["required", "required"],
		["something-else", "auto"],
	])("maps the %s tool choice to %s", async (given, expected) => {
		stubStream([])
		await drain(
			new TestHandler().createMessage("sys", USER, {
				taskId: "t",
				tool_choice: given as never,
				tools: [
					{
						type: "function",
						function: { name: "read_file", description: "d", parameters: { type: "object" } },
					},
				],
			} as never),
		)

		expect(streamText.mock.calls[0]![0].toolChoice).toBe(expected)
		expect(Object.keys(streamText.mock.calls[0]![0].tools)).toEqual(["read_file"])
	})

	it("maps a named function choice to the AI SDK's tool form", async () => {
		stubStream([])
		await drain(
			new TestHandler().createMessage("sys", USER, {
				taskId: "t",
				tool_choice: { type: "function", function: { name: "read_file" } },
			} as never),
		)

		expect(streamText.mock.calls[0]![0].toolChoice).toEqual({ type: "tool", toolName: "read_file" })
	})

	it("ignores an object tool choice it cannot interpret", async () => {
		stubStream([])
		await drain(
			new TestHandler().createMessage("sys", USER, { taskId: "t", tool_choice: { type: "mystery" } } as never),
		)

		expect(streamText.mock.calls[0]![0].toolChoice).toBeUndefined()
	})
})

describe("OpenAICompatibleHandler — completePrompt", () => {
	it("returns the generated text under the same token ceiling", async () => {
		generateText.mockResolvedValue({ text: "the answer" })

		const result = await new TestHandler({ temperature: 0.2 }).completePrompt("a question")

		expect(result).toBe("the answer")
		expect(generateText).toHaveBeenCalledWith(
			expect.objectContaining({ prompt: "a question", maxOutputTokens: 4096, temperature: 0.2 }),
		)
	})
})
