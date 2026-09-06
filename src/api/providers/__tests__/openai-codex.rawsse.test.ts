// npx vitest src/api/providers/__tests__/openai-codex.rawsse.test.ts

/**
 * The Codex handler's RAW SSE reader — `handleStreamResponse`, the transport it
 * falls back to whenever the SDK path throws (which `executeRequest` makes it do
 * for every error, auth included). It is therefore the transport that actually
 * runs in production, and it re-implements the whole event vocabulary a second
 * time, so it can drift from the SDK path silently.
 *
 * What the tests below pin, in the order it bites:
 *
 *  - **The reader is FRAMED, not line-oriented.** A network chunk boundary falls
 *    wherever TCP puts it, so a `data:` line arrives split across two reads more
 *    often than not. The partial tail is carried in a buffer; drop that and the
 *    stream loses whichever events straddled a boundary — intermittently, and
 *    more often on a slow link.
 *  - **Text is emitted exactly once.** Codex delivers assistant text by delta,
 *    by a terminal `.done`, and again inside the final `response.completed`
 *    payload. The `hasContent` latch is what stops the reply being said twice.
 *  - **A tool call's identity is captured from `output_item`.** The argument
 *    deltas that follow carry no call id, so without the capture the partials
 *    are unattributable and the call cannot be assembled.
 *  - **Every failure is TRANSLATED, and the lock is always released.** A reader
 *    lock left held wedges the response body for the rest of the process.
 */

const hoisted = vi.hoisted(() => ({
	getAccessToken: vi.fn(async (): Promise<string | null> => "token-1"),
	getAccountId: vi.fn(async (): Promise<string | null> => "acct-1"),
	forceRefreshAccessToken: vi.fn(async (): Promise<string | null> => "token-2"),
	captureException: vi.fn(),
}))

vi.mock("../../../integrations/openai-codex/oauth", () => ({
	openAiCodexOAuthManager: {
		getAccessToken: hoisted.getAccessToken,
		getAccountId: hoisted.getAccountId,
		forceRefreshAccessToken: hoisted.forceRefreshAccessToken,
	},
}))

vi.mock("@shofer/telemetry", () => ({
	TelemetryService: { instance: { captureException: hoisted.captureException } },
}))

import { OpenAiCodexHandler } from "../openai-codex"

type Chunk = { type: string; [k: string]: unknown }

/** A `ReadableStream` that yields the given strings as UTF-8 chunks, in order. */
function streamOf(...pieces: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder()
	let index = 0
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (index >= pieces.length) {
				controller.close()
				return
			}
			controller.enqueue(encoder.encode(pieces[index++]))
		},
	})
}

/** One SSE frame, terminated the way the server sends it. */
function sse(event: unknown): string {
	return `data: ${JSON.stringify(event)}\n\n`
}

function makeHandler() {
	return new OpenAiCodexHandler({ apiModelId: "gpt-5.1" } as never)
}

/** Drive the raw reader directly and collect what it yields. */
async function readRaw(handler: OpenAiCodexHandler, body: ReadableStream<Uint8Array>): Promise<Chunk[]> {
	const model = handler.getModel()
	const chunks: Chunk[] = []
	const stream = (
		handler as unknown as {
			handleStreamResponse: (b: ReadableStream<Uint8Array>, m: unknown) => AsyncIterable<Chunk>
		}
	).handleStreamResponse(body, model)
	for await (const chunk of stream) {
		chunks.push(chunk)
	}
	return chunks
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe("framing", () => {
	it("reassembles an event SPLIT across two network chunks", async () => {
		const handler = makeHandler()
		const frame = sse({ type: "response.output_text.delta", delta: "hello world" })
		const split = Math.floor(frame.length / 2)

		const chunks = await readRaw(handler, streamOf(frame.slice(0, split), frame.slice(split)))

		expect(chunks).toEqual([{ type: "text", text: "hello world" }])
	})

	it("ignores keep-alive comments and the terminal [DONE] sentinel", async () => {
		const handler = makeHandler()

		const chunks = await readRaw(
			handler,
			streamOf(": keep-alive\n", sse({ type: "response.output_text.delta", delta: "hi" }), "data: [DONE]\n\n"),
		)

		expect(chunks).toEqual([{ type: "text", text: "hi" }])
	})

	it("SKIPS a malformed frame instead of failing the whole stream", async () => {
		const handler = makeHandler()

		const chunks = await readRaw(
			handler,
			streamOf("data: {not json\n\n", sse({ type: "response.output_text.delta", delta: "after" })),
		)

		expect(chunks).toEqual([{ type: "text", text: "after" }])
	})

	it("stops reading once the request has been ABORTED", async () => {
		const handler = makeHandler()
		;(handler as unknown as { abortController: AbortController }).abortController = (() => {
			const controller = new AbortController()
			controller.abort()
			return controller
		})()

		const chunks = await readRaw(handler, streamOf(sse({ type: "response.output_text.delta", delta: "never" })))

		expect(chunks).toEqual([])
	})
})

describe("text", () => {
	it("emits a delta once", async () => {
		const handler = makeHandler()

		const chunks = await readRaw(
			handler,
			streamOf(
				sse({ type: "response.output_text.delta", delta: "a" }),
				sse({ type: "response.output_text.delta", delta: "b" }),
			),
		)

		expect(chunks).toEqual([
			{ type: "text", text: "a" },
			{ type: "text", text: "b" },
		])
	})

	it("takes the terminal `.done` payload when no delta ever arrived", async () => {
		const handler = makeHandler()

		const chunks = await readRaw(handler, streamOf(sse({ type: "response.output_text.done", text: "whole reply" })))

		expect(chunks).toEqual([{ type: "text", text: "whole reply" }])
	})

	it("does NOT repeat the reply when the completed response repeats it", async () => {
		const handler = makeHandler()

		const chunks = await readRaw(
			handler,
			streamOf(
				sse({ type: "response.output_text.delta", delta: "said once" }),
				sse({
					type: "response.completed",
					response: { output: [{ type: "text", content: [{ type: "text", text: "said once" }] }] },
				}),
			),
		)

		expect(chunks.filter((c) => c.type === "text")).toEqual([{ type: "text", text: "said once" }])
	})

	it("reads text out of an UNRECOGNISED envelope that carries a completed response", async () => {
		const handler = makeHandler()

		const chunks = await readRaw(
			handler,
			streamOf(
				sse({
					type: "something.we.do.not.know",
					response: { output: [{ type: "text", content: [{ type: "text", text: "recovered" }] }] },
				}),
			),
		)

		expect(chunks).toEqual([{ type: "text", text: "recovered" }])
	})

	it("reads a REASONING summary out of the same envelope", async () => {
		const handler = makeHandler()

		const chunks = await readRaw(
			handler,
			streamOf(
				sse({
					type: "something.we.do.not.know",
					response: {
						output: [{ type: "reasoning", summary: [{ type: "summary_text", text: "thinking" }] }],
					},
				}),
			),
		)

		expect(chunks).toEqual([{ type: "reasoning", text: "thinking" }])
	})

	it("accepts a BARE JSON line — some deployments drop the `data:` prefix", async () => {
		const handler = makeHandler()

		const chunks = await readRaw(handler, streamOf(`${JSON.stringify({ content: "bare" })}\n`))

		expect(chunks).toEqual([{ type: "text", text: "bare" }])
	})

	it("ignores a bare line that is not JSON at all", async () => {
		const handler = makeHandler()

		const chunks = await readRaw(handler, streamOf("event: ping\n", "\n"))

		expect(chunks).toEqual([])
	})
})

describe("usage", () => {
	it("reports the completed response's usage with NO cost — this is a subscription", async () => {
		const handler = makeHandler()

		const chunks = await readRaw(
			handler,
			streamOf(
				sse({
					type: "response.finished.unknown",
					response: {
						output: [],
						usage: {
							input_tokens: 100,
							output_tokens: 20,
							input_tokens_details: { cached_tokens: 30 },
						},
					},
				}),
			),
		)

		expect(chunks).toEqual([
			expect.objectContaining({ type: "usage", inputTokens: 100, outputTokens: 20, totalCost: 0 }),
		])
	})

	it("DERIVES the input total from the cache breakdown when the top-level count is absent", async () => {
		const handler = makeHandler()

		const chunks = await readRaw(
			handler,
			streamOf(
				sse({
					type: "response.finished.unknown",
					response: {
						output: [],
						usage: {
							output_tokens: 5,
							input_tokens_details: { cached_tokens: 40, cache_miss_tokens: 60 },
						},
					},
				}),
			),
		)

		expect(chunks[0]).toMatchObject({ type: "usage", inputTokens: 100 })
	})
})

describe("tool calls", () => {
	it("CAPTURES the call identity from output_item so the argument deltas can be attributed", async () => {
		const handler = makeHandler()

		const chunks = await readRaw(
			handler,
			streamOf(
				sse({
					type: "response.output_item.added",
					item: { type: "function_call", call_id: "call-1", name: "read_file" },
				}),
				sse({ type: "response.function_call_arguments.delta", delta: '{"path":' }),
			),
		)

		const partial = chunks.find((c) => c.type === "tool_call_partial")
		expect(partial).toMatchObject({ id: "call-1", name: "read_file" })
	})

	it("treats a tool-only response as HAVING content — a turn with no text is not an empty turn", async () => {
		const handler = makeHandler()

		const chunks = await readRaw(
			handler,
			streamOf(
				sse({
					type: "response.output_item.done",
					item: { type: "function_call", call_id: "call-2", name: "list_files", arguments: "{}" },
				}),
			),
		)

		expect(chunks.some((c) => c.type === "tool_call")).toBe(true)
	})
})

describe("failure", () => {
	it("TRANSLATES a mid-stream read failure and reports it to telemetry", async () => {
		const handler = makeHandler()
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.error(new Error("socket reset"))
			},
		})

		await expect(readRaw(handler, body)).rejects.toThrow()
		expect(hoisted.captureException).toHaveBeenCalled()
	})

	it("RELEASES the reader lock even when the stream failed", async () => {
		const handler = makeHandler()
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.error(new Error("socket reset"))
			},
		})

		await expect(readRaw(handler, body)).rejects.toThrow()

		// A held lock wedges the body for the rest of the process; getting a
		// second reader is the only observable proof it was given back.
		expect(() => body.getReader()).not.toThrow()
	})
})
