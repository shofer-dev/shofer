import type { Anthropic } from "@anthropic-ai/sdk"

/**
 * The Anthropic → Ollama message conversion, exercised through `createMessage`
 * (the converter is module-private, and driving it through the public entry
 * point is also what proves the messages actually reach the client).
 *
 * The conversion is lossy in one direction on purpose and the shape of the loss
 * is the contract: Ollama has no `tool` role and no rich tool results, so an
 * Anthropic `tool_result` becomes a plain USER message, and any image inside
 * one is lifted out into `images` with a placeholder left in the text — Ollama
 * takes raw base64, never a data URL.
 */

const mockChat = vi.fn()
vi.mock("ollama", () => ({
	Ollama: vi.fn().mockImplementation(() => ({ chat: mockChat })),
	Message: vi.fn(),
}))

const getOllamaModels = vi.fn()
vi.mock("../fetchers/ollama.js", () => ({ getOllamaModels: (...a: unknown[]) => getOllamaModels(...a) }))

import { NativeOllamaHandler } from "../native-ollama.js"

const MODEL = "llama2"

function handler(overrides: Record<string, unknown> = {}) {
	return new NativeOllamaHandler({ apiModelId: MODEL, ollamaModelId: MODEL, ...overrides } as never)
}

/** Run one turn and hand back the messages that reached the Ollama client. */
async function sentMessages(messages: Anthropic.Messages.MessageParam[]): Promise<any[]> {
	mockChat.mockImplementation(async function* () {
		yield { message: { content: "ok" } }
	})
	for await (const _ of handler().createMessage("sys", messages)) void _
	return mockChat.mock.calls.at(-1)![0].messages
}

const image = (data: string): Anthropic.ImageBlockParam => ({
	type: "image",
	source: { type: "base64", media_type: "image/png", data },
})

beforeEach(() => {
	vi.clearAllMocks()
	getOllamaModels.mockResolvedValue({
		[MODEL]: { contextWindow: 4096, maxTokens: 4096, supportsImages: true, supportsPromptCache: false },
	})
})

describe("Anthropic → Ollama message conversion", () => {
	it("passes a string-content message through unchanged", async () => {
		const sent = await sentMessages([{ role: "user", content: "plain" }])

		expect(sent).toContainEqual({ role: "user", content: "plain" })
	})

	it("flattens a user turn's text blocks and lifts its images into `images`", async () => {
		const sent = await sentMessages([
			{
				role: "user",
				content: [{ type: "text", text: "look at" }, { type: "text", text: "these" }, image("AAAA")],
			},
		])

		expect(sent.at(-1)).toEqual({ role: "user", content: "look at\nthese", images: ["AAAA"] })
	})

	it("omits `images` entirely when the turn carries none", async () => {
		const sent = await sentMessages([{ role: "user", content: [{ type: "text", text: "just words" }] }])

		expect(sent.at(-1)).toEqual({ role: "user", content: "just words", images: undefined })
	})

	it("turns a string tool_result into a USER message, since Ollama has no tool role", async () => {
		const sent = await sentMessages([
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "the file" }] },
		])

		expect(sent.at(-1)).toEqual({ role: "user", content: "the file", images: undefined })
	})

	it("joins a block-array tool_result and lifts its image out with a placeholder", async () => {
		const sent = await sentMessages([
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "c1",
						content: [{ type: "text", text: "here it is" }, image("BBBB")],
					},
				],
			},
		])

		expect(sent.at(-1)).toEqual({
			role: "user",
			content: "here it is\n(see following user message for image)",
			images: ["BBBB"],
		})
	})

	it("renders an empty tool_result as an empty message", async () => {
		const sent = await sentMessages([
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "c1" }] } as never,
		])

		expect(sent.at(-1)).toMatchObject({ role: "user", content: "" })
	})

	it("puts tool results BEFORE the turn's own text, which is the order Ollama needs", async () => {
		const sent = await sentMessages([
			{
				role: "user",
				content: [
					{ type: "text", text: "and now this" },
					{ type: "tool_result", tool_use_id: "c1", content: "result first" },
				],
			},
		])

		const tail = sent.slice(-2)
		expect(tail[0]!.content).toBe("result first")
		expect(tail[1]!.content).toBe("and now this")
	})

	it("converts an assistant turn's tool_use blocks into Ollama tool_calls", async () => {
		const sent = await sentMessages([
			{
				role: "assistant",
				content: [
					{ type: "text", text: "calling" },
					{ type: "tool_use", id: "c1", name: "read_file", input: { path: "a.ts" } },
				],
			},
		])

		expect(sent.at(-1)).toEqual({
			role: "assistant",
			content: "calling",
			tool_calls: [{ function: { name: "read_file", arguments: { path: "a.ts" } } }],
		})
	})

	it("leaves tool_calls undefined for an assistant turn that called nothing", async () => {
		const sent = await sentMessages([{ role: "assistant", content: [{ type: "text", text: "just talking" }] }])

		expect(sent.at(-1)).toEqual({ role: "assistant", content: "just talking", tool_calls: undefined })
	})
})

describe("NativeOllamaHandler — client construction and failures", () => {
	it("defaults to the local daemon and adds a bearer header only when a key is set", async () => {
		const { Ollama } = await import("ollama")
		mockChat.mockImplementation(async function* () {
			yield { message: { content: "ok" } }
		})

		for await (const _ of handler().createMessage("sys", [{ role: "user", content: "hi" }])) void _
		expect(vi.mocked(Ollama).mock.calls[0]![0]).toMatchObject({ host: "http://localhost:11434" })
		expect(vi.mocked(Ollama).mock.calls[0]![0]!.headers).toBeUndefined()

		vi.mocked(Ollama).mockClear()
		for await (const _ of handler({
			ollamaBaseUrl: "http://ollama.internal:11434",
			ollamaApiKey: "secret",
		}).createMessage("sys", [{ role: "user", content: "hi" }])) {
			void _
		}
		expect(vi.mocked(Ollama).mock.calls[0]![0]).toMatchObject({
			host: "http://ollama.internal:11434",
			headers: { Authorization: "Bearer secret" },
		})
	})

	it("tells the user Ollama is not running when the connection is refused", async () => {
		mockChat.mockRejectedValue(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }))

		const stream = handler().createMessage("sys", [{ role: "user", content: "hi" }])
		await expect(
			(async () => {
				for await (const _ of stream) void _
			})(),
		).rejects.toThrow(/Ollama service is not running/)
	})

	it("wraps a mid-stream failure with the stream-processing prefix", async () => {
		mockChat.mockImplementation(async function* () {
			yield { message: { content: "partial" } }
			throw new Error("socket hang up")
		})

		const stream = handler().createMessage("sys", [{ role: "user", content: "hi" }])
		await expect(
			(async () => {
				for await (const _ of stream) void _
			})(),
		).rejects.toThrow(/Ollama stream processing error/)
	})
})

describe("NativeOllamaHandler — completePrompt", () => {
	it("returns the non-streamed content", async () => {
		mockChat.mockResolvedValue({ message: { content: "the answer" } })

		expect(await handler().completePrompt("a question")).toBe("the answer")
		expect(mockChat.mock.calls[0]![0]).toMatchObject({ stream: false })
	})

	it("returns an empty string when the response carried no content", async () => {
		mockChat.mockResolvedValue({ message: {} })

		expect(await handler().completePrompt("q")).toBe("")
	})

	it("names Ollama in a completion failure", async () => {
		mockChat.mockRejectedValue(new Error("model not found"))

		await expect(handler().completePrompt("q")).rejects.toThrow(/Ollama completion error/)
	})
})
