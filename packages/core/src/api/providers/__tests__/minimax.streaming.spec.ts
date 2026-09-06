import type { Anthropic } from "@anthropic-ai/sdk"

const mockCreate = vi.fn()
vi.mock("@anthropic-ai/sdk", () => ({
	Anthropic: vi.fn().mockImplementation(() => ({ messages: { create: mockCreate } })),
}))

import { MiniMaxHandler } from "../minimax.js"

/**
 * MiniMax speaks the ANTHROPIC wire protocol, so its stream consumer is an
 * Anthropic event translator rather than an OpenAI one — a different event
 * vocabulary (`content_block_start` / `content_block_delta` / `message_delta`)
 * with its own tool-call shape.
 *
 * Two translations are load-bearing:
 *
 *  - **`tool_choice`.** Anthropic has no `"none"`, so the OpenAI spelling has to
 *    be mapped rather than passed through: `none` becomes an OMISSION, and
 *    `required` becomes `any`. Forwarding the OpenAI word is a 400;
 *  - **cost.** The provider reports token counts across several events and the
 *    final cost is computed once, from the ANTHROPIC cost model (cache writes
 *    and reads priced separately), not the OpenAI one.
 */

const USER: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "hi" }]

function handler() {
	return new MiniMaxHandler({ minimaxApiKey: "key" } as never)
}

function stubStream(events: unknown[]) {
	mockCreate.mockResolvedValue({
		async *[Symbol.asyncIterator]() {
			for (const e of events) yield e
		},
	})
}

async function drain(stream: AsyncIterable<unknown>) {
	const out: unknown[] = []
	for await (const c of stream) out.push(c)
	return out
}

const messageStart = (usage: Record<string, number> = { input_tokens: 10, output_tokens: 0 }) => ({
	type: "message_start",
	message: { usage },
})

beforeEach(() => {
	vi.clearAllMocks()
	stubStream([])
})

describe("the Anthropic event vocabulary", () => {
	it("streams a text block and its deltas", async () => {
		stubStream([
			messageStart(),
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "Hello" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: ", world" } },
			{ type: "content_block_stop", index: 0 },
		])

		const chunks = await drain(handler().createMessage("sys", USER))

		expect(chunks).toEqual(
			expect.arrayContaining([
				{ type: "text", text: "Hello" },
				{ type: "text", text: ", world" },
			]),
		)
	})

	it("separates a SECOND text block with a newline", async () => {
		stubStream([
			messageStart(),
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "first" } },
			{ type: "content_block_start", index: 1, content_block: { type: "text", text: "second" } },
		])

		const chunks = (await drain(handler().createMessage("sys", USER))) as Array<Record<string, string>>

		const texts = chunks.filter((c) => c.type === "text").map((c) => c.text)
		expect(texts).toEqual(["first", "\n", "second"])
	})

	it("streams thinking blocks as reasoning, with the same separation", async () => {
		stubStream([
			messageStart(),
			{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "step one" } },
			{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: " continued" } },
			{ type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "step two" } },
		])

		const chunks = (await drain(handler().createMessage("sys", USER))) as Array<Record<string, string>>

		expect(chunks.filter((c) => c.type === "reasoning").map((c) => c.text)).toEqual([
			"step one",
			" continued",
			"\n",
			"step two",
		])
	})

	it("reassembles a tool call from its start event and json deltas", async () => {
		stubStream([
			messageStart(),
			{
				type: "content_block_start",
				index: 0,
				content_block: { type: "tool_use", id: "call-1", name: "read_file" },
			},
			{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path"' } },
			{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: ':"a.ts"}' } },
			{ type: "content_block_stop", index: 0 },
		])

		const chunks = await drain(handler().createMessage("sys", USER))

		expect(chunks).toEqual(
			expect.arrayContaining([
				{ type: "tool_call_partial", index: 0, id: "call-1", name: "read_file", arguments: undefined },
				{ type: "tool_call_partial", index: 0, id: undefined, name: undefined, arguments: '{"path"' },
				{ type: "tool_call_partial", index: 0, id: undefined, name: undefined, arguments: ':"a.ts"}' },
			]),
		)
	})

	it("ignores message_stop, which carries nothing", async () => {
		stubStream([messageStart(), { type: "message_stop" }])

		await expect(drain(handler().createMessage("sys", USER))).resolves.toBeDefined()
	})
})

describe("usage and cost", () => {
	it("reports the opening usage, the delta usage, and one final cost", async () => {
		stubStream([
			messageStart({
				input_tokens: 100,
				output_tokens: 0,
				cache_creation_input_tokens: 5,
				cache_read_input_tokens: 3,
			} as never),
			{ type: "message_delta", usage: { output_tokens: 20 } },
		])

		const chunks = (await drain(handler().createMessage("sys", USER))) as Array<Record<string, number | string>>
		const usages = chunks.filter((c) => c.type === "usage")

		expect(usages[0]).toMatchObject({ inputTokens: 100, cacheWriteTokens: 5, cacheReadTokens: 3 })
		expect(usages[1]).toMatchObject({ outputTokens: 20 })
		// One cost row at the end, priced on the Anthropic model.
		expect(usages.at(-1)!.totalCost).toBeTypeOf("number")
	})

	it("emits no cost row when nothing was consumed", async () => {
		stubStream([{ type: "message_stop" }])

		const chunks = (await drain(handler().createMessage("sys", USER))) as Array<Record<string, unknown>>

		expect(chunks.some((c) => c.type === "usage" && c.totalCost !== undefined)).toBe(false)
	})
})

describe("tool_choice translation", () => {
	async function sentToolChoice(toolChoice: unknown) {
		stubStream([messageStart()])
		await drain(
			handler().createMessage("sys", USER, {
				taskId: "t",
				tools: [
					{
						type: "function",
						function: { name: "read_file", description: "d", parameters: { type: "object" } },
					},
				],
				tool_choice: toolChoice,
			} as never),
		)
		return mockCreate.mock.calls.at(-1)![0].tool_choice
	}

	it("OMITS a choice of none, which Anthropic has no word for", async () => {
		expect(await sentToolChoice("none")).toBeUndefined()
	})

	it("maps required onto Anthropic's any", async () => {
		expect(await sentToolChoice("required")).toEqual({ type: "any" })
	})

	it("maps auto, and anything unrecognised, onto auto", async () => {
		expect(await sentToolChoice("auto")).toEqual({ type: "auto" })
		expect(await sentToolChoice("something-else")).toEqual({ type: "auto" })
	})

	it("maps a named function onto Anthropic's tool form", async () => {
		expect(await sentToolChoice({ type: "function", function: { name: "read_file" } })).toEqual({
			type: "tool",
			name: "read_file",
		})
	})

	it("sends no choice at all when the turn declares no tools", async () => {
		stubStream([messageStart()])
		await drain(handler().createMessage("sys", USER))

		expect(mockCreate.mock.calls.at(-1)![0].tool_choice).toBeUndefined()
	})
})
