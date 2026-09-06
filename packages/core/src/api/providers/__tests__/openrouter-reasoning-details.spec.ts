import type { Anthropic } from "@anthropic-ai/sdk"

const mockCreate = vi.fn()
vi.mock("openai", () => ({
	__esModule: true,
	default: vi.fn().mockImplementation(() => ({ chat: { completions: { create: mockCreate } } })),
}))

vi.mock("delay", () => ({ default: vi.fn(() => Promise.resolve()) }))

const captureException = vi.fn()
vi.mock("@shofer/telemetry", () => ({
	TelemetryService: { instance: { captureException: (...a: unknown[]) => captureException(...a) } },
}))

const MODELS = {
	"anthropic/claude-sonnet-4": {
		maxTokens: 8192,
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 3,
		outputPrice: 15,
		cacheWritesPrice: 3.75,
		cacheReadsPrice: 0.3,
	},
	"google/gemini-3-pro-preview": {
		maxTokens: 8192,
		contextWindow: 1_000_000,
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 1,
		outputPrice: 2,
	},
}

vi.mock("../fetchers/modelCache.js", () => ({
	getModels: vi.fn(async () => MODELS),
	getModelsFromCache: vi.fn(() => MODELS),
	flushModels: vi.fn(),
}))

import { OpenRouterHandler } from "../openrouter.js"

/**
 * OpenRouter's REASONING plumbing — the half of the provider that exists because
 * OpenRouter multiplexes several upstreams behind one wire format.
 *
 * Two behaviours are specific to it and invisible anywhere else:
 *
 *  - **Gemini's thought-signature validation.** Routed through OpenRouter, a
 *    Gemini model rejects an assistant turn carrying tool calls whose
 *    reasoning_details it cannot validate. The provider injects ONE
 *    `reasoning.encrypted` entry keyed to the FIRST tool call's id, which is the
 *    documented way to skip that validation — the alternative is a hard 400 on
 *    every tool round-trip after switching models mid-conversation;
 *  - **`reasoning_details` arrive FRAGMENTED and must be accumulated by
 *    `(type, index)`**, while only the displayable kinds are streamed to the UI.
 *    `reasoning.encrypted` is deliberately not shown: it is redacted content, and
 *    rendering it would put base64 in the user's chat.
 */

const USER: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hello" }]

function handler(modelId: string) {
	return new OpenRouterHandler({ openRouterApiKey: "key", openRouterModelId: modelId } as never)
}

function stubStream(chunks: unknown[]) {
	mockCreate.mockResolvedValue({
		async *[Symbol.asyncIterator]() {
			for (const c of chunks) yield c
		},
	})
}

const delta = (d: Record<string, unknown>) => ({ choices: [{ delta: d }] })

async function drain(stream: AsyncIterable<unknown>) {
	const out: unknown[] = []
	for await (const c of stream) out.push(c)
	return out
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe("Gemini's thought-signature validation", () => {
	it("DROPS tool calls that arrive with no reasoning_details at all, keeping the prose", async () => {
		// Sanitization runs first: a Gemini turn whose tool calls carry no
		// reasoning_details cannot be validated upstream, so the calls are removed
		// rather than sent and rejected. The injection below only reaches calls
		// that survive this pass.
		stubStream([delta({ content: "ok" })])

		await drain(
			handler("google/gemini-3-pro-preview").createMessage("sys", [
				{
					role: "assistant",
					content: [
						{ type: "text", text: "calling" },
						{ type: "tool_use", id: "call-1", name: "read_file", input: {} },
					],
				},
				{ role: "user", content: "and now?" },
			]),
		)

		const sent = mockCreate.mock.calls[0]![0].messages as Array<Record<string, any>>
		expect(sent.some((m) => m.role === "assistant" && m.tool_calls)).toBe(false)
		expect(sent.some((m) => m.role === "assistant" && String(m.content).includes("calling"))).toBe(true)
	})

	it("injects ONE encrypted entry keyed to the FIRST surviving tool call", async () => {
		stubStream([delta({ content: "ok" })])

		await drain(
			handler("google/gemini-3-pro-preview").createMessage("sys", [
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "call-1", name: "read_file", input: {} }],
					// A non-encrypted detail matching the call survives sanitization
					// but does not satisfy the signature validator, so the fake
					// encrypted entry is added beside it.
					reasoning_details: [{ type: "reasoning.text", text: "why", id: "call-1", index: 0 }],
				} as never,
				{ role: "user", content: "and now?" },
			]),
		)

		const sent = mockCreate.mock.calls[0]![0].messages as Array<Record<string, any>>
		const assistant = sent.find((m) => m.role === "assistant" && m.tool_calls)!
		expect(assistant.reasoning_details).toContainEqual({
			type: "reasoning.encrypted",
			data: "skip_thought_signature_validator",
			id: "call-1",
			format: "google-gemini-v1",
			index: 0,
		})
	})

	it("leaves an assistant turn that already carries encrypted reasoning alone", async () => {
		stubStream([delta({ content: "ok" })])
		const existing = { type: "reasoning.encrypted", data: "real-signature", id: "call-1", index: 0 }

		await drain(
			handler("google/gemini-3-pro-preview").createMessage("sys", [
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "call-1", name: "read_file", input: {} }],
					reasoning_details: [existing],
				} as never,
				{ role: "user", content: "next" },
			]),
		)

		const sent = mockCreate.mock.calls[0]![0].messages as Array<Record<string, any>>
		const assistant = sent.find((m) => m.role === "assistant" && m.tool_calls)!
		expect(assistant.reasoning_details).toHaveLength(1)
		expect(assistant.reasoning_details[0].data).toBe("real-signature")
	})

	it("does NOT inject anything for a non-Gemini model", async () => {
		stubStream([delta({ content: "ok" })])

		await drain(
			handler("anthropic/claude-sonnet-4").createMessage("sys", [
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "call-1", name: "read_file", input: {} }],
				},
				{ role: "user", content: "next" },
			]),
		)

		const sent = mockCreate.mock.calls[0]![0].messages as Array<Record<string, any>>
		const assistant = sent.find((m) => m.role === "assistant" && m.tool_calls)
		expect(assistant?.reasoning_details).toBeUndefined()
	})

	it("leaves an assistant turn with no tool calls untouched", async () => {
		stubStream([delta({ content: "ok" })])

		await drain(
			handler("google/gemini-3-pro-preview").createMessage("sys", [
				{ role: "assistant", content: [{ type: "text", text: "just talking" }] },
				{ role: "user", content: "next" },
			]),
		)

		const sent = mockCreate.mock.calls[0]![0].messages as Array<Record<string, any>>
		expect(sent.find((m) => m.role === "assistant")?.reasoning_details).toBeUndefined()
	})
})

describe("reasoning_details accumulation", () => {
	it("streams the displayable kinds and stays silent about the encrypted one", async () => {
		stubStream([
			delta({ reasoning_details: [{ type: "reasoning.text", text: "step one ", index: 0 }] }),
			delta({ reasoning_details: [{ type: "reasoning.text", text: "step two", index: 0 }] }),
			delta({ reasoning_details: [{ type: "reasoning.summary", summary: "in short", index: 1 }] }),
			delta({ reasoning_details: [{ type: "reasoning.encrypted", data: "AAAABBBB", index: 2 }] }),
			delta({ content: "the answer" }),
		])

		const chunks = (await drain(handler("google/gemini-3-pro-preview").createMessage("sys", USER))) as Array<
			Record<string, unknown>
		>

		const reasoning = chunks.filter((c) => c.type === "reasoning").map((c) => c.text)
		expect(reasoning.join("")).toContain("step one")
		expect(reasoning.join("")).toContain("step two")
		expect(reasoning.join("")).toContain("in short")
		// Redacted content never reaches the chat.
		expect(reasoning.join("")).not.toContain("AAAABBBB")
		expect(chunks).toContainEqual({ type: "text", text: "the answer" })
	})

	it("keys accumulation by (type, index), so two concurrent details do not merge", async () => {
		stubStream([
			delta({ reasoning_details: [{ type: "reasoning.text", text: "A1", index: 0 }] }),
			delta({ reasoning_details: [{ type: "reasoning.text", text: "B1", index: 1 }] }),
			delta({ reasoning_details: [{ type: "reasoning.text", text: "A2", index: 0 }] }),
			delta({ content: "done" }),
		])

		const chunks = (await drain(handler("google/gemini-3-pro-preview").createMessage("sys", USER))) as Array<
			Record<string, unknown>
		>

		// Each fragment is streamed as it arrives; the accumulator's job is the
		// FINAL detail, not the live text.
		const reasoning = chunks.filter((c) => c.type === "reasoning").map((c) => c.text)
		expect(reasoning).toEqual(expect.arrayContaining(["A1", "B1", "A2"]))
	})

	it("defaults a detail with no index to slot 0", async () => {
		stubStream([
			delta({ reasoning_details: [{ type: "reasoning.text", text: "no index" }] }),
			delta({ content: "done" }),
		])

		const chunks = (await drain(handler("google/gemini-3-pro-preview").createMessage("sys", USER))) as Array<
			Record<string, unknown>
		>

		expect(chunks.some((c) => c.type === "reasoning" && String(c.text).includes("no index"))).toBe(true)
	})

	it("falls back to the top-level reasoning field when no details arrived", async () => {
		stubStream([delta({ reasoning: "plain reasoning" }), delta({ content: "done" })])

		const chunks = (await drain(handler("anthropic/claude-sonnet-4").createMessage("sys", USER))) as Array<
			Record<string, unknown>
		>

		expect(chunks.some((c) => c.type === "reasoning" && String(c.text).includes("plain reasoning"))).toBe(true)
	})
})

describe("usage and errors", () => {
	it("reports OpenRouter's own cost alongside the token split", async () => {
		stubStream([
			delta({ content: "hi" }),
			{
				choices: [{ delta: {} }],
				usage: {
					prompt_tokens: 100,
					completion_tokens: 20,
					cost: 0.42,
					prompt_tokens_details: { cached_tokens: 30 },
				},
			},
		])

		const chunks = (await drain(handler("anthropic/claude-sonnet-4").createMessage("sys", USER))) as Array<
			Record<string, unknown>
		>

		const usage = chunks.find((c) => c.type === "usage")!
		expect(usage.inputTokens).toBe(100)
		expect(usage.outputTokens).toBe(20)
		expect(usage.totalCost).toBeCloseTo(0.42)
	})

	it("surfaces an error the stream carries INSIDE the payload", async () => {
		mockCreate.mockResolvedValue({
			async *[Symbol.asyncIterator]() {
				yield { error: { code: 429, message: "Rate limited upstream" } }
			},
		})

		await expect(drain(handler("anthropic/claude-sonnet-4").createMessage("sys", USER))).rejects.toThrow(
			/Rate limited upstream|429/,
		)
	})

	it("reports a completePrompt failure as a provider error", async () => {
		mockCreate.mockRejectedValue(new Error("upstream down"))

		await expect(handler("anthropic/claude-sonnet-4").completePrompt("q")).rejects.toThrow()
		expect(captureException).toHaveBeenCalled()
	})

	it("returns the completion text on the happy path", async () => {
		mockCreate.mockResolvedValue({ choices: [{ message: { content: "the answer" } }] })

		expect(await handler("anthropic/claude-sonnet-4").completePrompt("q")).toBe("the answer")
	})

	it("asks Anthropic models for fine-grained tool streaming", async () => {
		mockCreate.mockResolvedValue({ choices: [{ message: { content: "x" } }] })

		await handler("anthropic/claude-sonnet-4").completePrompt("q")

		expect(mockCreate.mock.calls[0]![1]).toMatchObject({
			headers: { "x-anthropic-beta": "fine-grained-tool-streaming-2025-05-14" },
		})
	})

	it("refuses image generation without an explicit key", async () => {
		const result = await handler("google/gemini-3-pro-preview").generateImage("a cat", "model", "")

		expect(result).toEqual({ success: false, error: "OpenRouter API key is required for image generation" })
	})
})
