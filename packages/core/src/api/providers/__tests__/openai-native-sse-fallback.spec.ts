import type { Anthropic } from "@anthropic-ai/sdk"

vi.mock("@shofer/telemetry", () => ({
	TelemetryService: { instance: { captureException: vi.fn() } },
}))

const mockResponsesCreate = vi.fn()
vi.mock("openai", () => ({
	__esModule: true,
	default: vi.fn().mockImplementation(() => ({ responses: { create: mockResponsesCreate } })),
}))

import { OpenAiNativeHandler } from "../openai-native.js"

/**
 * The Responses-API **SSE fallback** — the path taken whenever the SDK cannot
 * stream (an old SDK, a proxy that returns a non-iterable, an SDK-level
 * throw). It re-issues the same request over a raw `fetch` and parses the event
 * stream by hand, so it is a second, independent implementation of the whole
 * event vocabulary and none of it is exercised by the SDK-path tests.
 *
 * Two things here are contractual rather than incidental:
 *
 *  - **the fallback is silent to the caller.** A consumer must not be able to
 *    tell which path served it, so the chunk sequence is identical and the SDK
 *    failure is never surfaced as an error;
 *  - **an HTTP failure is translated, not relayed.** The raw body is unhelpful
 *    to a user (and to a retry classifier), so the status is turned into a
 *    message that names what to do — and 401/429 stay distinguishable, because
 *    the retry bound treats them differently.
 */

const USER: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hello!" }]

/** Turn SSE event objects into the body `fetch` would deliver. */

function sseBody(events: unknown[]): any {
	const encoder = new TextEncoder()
	const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n"
	return new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(text))
			controller.close()
		},
	})
}

function stubFetch(response: Record<string, any>) {
	const fetchMock = vi.fn(async () => response as Response)
	vi.stubGlobal("fetch", fetchMock)
	return fetchMock
}

/** Force the SDK path to fail so the fallback runs, and serve `events` over SSE. */
function fallbackServing(events: unknown[]) {
	mockResponsesCreate.mockRejectedValue(new Error("SDK cannot stream here"))
	return stubFetch({ ok: true, status: 200, body: sseBody(events) })
}

async function drain(stream: AsyncIterable<unknown>) {
	const out: unknown[] = []
	for await (const chunk of stream) out.push(chunk)
	return out
}

function handler(overrides: Record<string, unknown> = {}) {
	return new OpenAiNativeHandler({
		openAiNativeApiKey: "test-key",
		apiModelId: "gpt-5-2025-08-07",
		...overrides,
	} as never)
}

beforeEach(() => {
	vi.clearAllMocks()
})

afterEach(() => {
	vi.unstubAllGlobals()
})

describe("the SSE fallback is reached and is silent about it", () => {
	it("re-issues the request over fetch when the SDK throws", async () => {
		const fetchMock = fallbackServing([{ type: "response.output_text.delta", delta: "hello" }])

		const chunks = await drain(handler().createMessage("sys", USER))

		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(chunks).toContainEqual({ type: "text", text: "hello" })
		// The SDK's failure is not surfaced as an error chunk.
		expect(chunks.some((c) => (c as { type: string }).type === "error")).toBe(false)
	})

	it("falls back when the SDK returns something that is not an async iterable", async () => {
		mockResponsesCreate.mockResolvedValue({ not: "iterable" })
		const fetchMock = stubFetch({
			ok: true,
			status: 200,
			body: sseBody([{ type: "response.output_text.delta", delta: "recovered" }]),
		})

		const chunks = await drain(handler().createMessage("sys", USER))

		expect(fetchMock).toHaveBeenCalled()
		expect(chunks).toContainEqual({ type: "text", text: "recovered" })
	})

	it("addresses the configured base URL and identifies the session", async () => {
		const fetchMock = fallbackServing([{ type: "response.output_text.delta", delta: "x" }])

		await drain(
			handler({ openAiNativeBaseUrl: "https://proxy.example" }).createMessage("sys", USER, {
				taskId: "task-42",
			} as never),
		)

		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
		expect(url).toBe("https://proxy.example/v1/responses")
		const headers = init.headers as Record<string, string>
		expect(headers.Authorization).toBe("Bearer test-key")
		expect(headers.originator).toBe("shofer-code")
		// The task id is the session key when there is one.
		expect(headers.session_id).toBe("task-42")
	})
})

describe("the event vocabulary the fallback parses", () => {
	it("streams text deltas under both event spellings", async () => {
		fallbackServing([
			{ type: "response.text.delta", delta: "a" },
			{ type: "response.output_text.delta", delta: "b" },
		])

		const chunks = await drain(handler().createMessage("sys", USER))

		expect(chunks).toEqual(
			expect.arrayContaining([
				{ type: "text", text: "a" },
				{ type: "text", text: "b" },
			]),
		)
	})

	it("streams reasoning summaries as reasoning chunks", async () => {
		fallbackServing([
			{ type: "response.reasoning_summary_text.delta", delta: "thinking about it" },
			{ type: "response.output_text.delta", delta: "the answer" },
		])

		const chunks = await drain(handler().createMessage("sys", USER))

		expect(chunks).toContainEqual({ type: "reasoning", text: "thinking about it" })
	})

	it("reads a COMPLETE (non-streamed) response delivered in one event", async () => {
		fallbackServing([
			{
				response: {
					output: [
						{ type: "text", content: [{ type: "text", text: "whole answer" }] },
						{ type: "reasoning", summary: [{ type: "summary_text", text: "why" }] },
					],
					usage: { input_tokens: 10, output_tokens: 5 },
				},
			},
		])

		const chunks = await drain(handler().createMessage("sys", USER))

		expect(chunks).toContainEqual({ type: "text", text: "whole answer" })
		expect(chunks).toContainEqual({ type: "reasoning", text: "why" })
		expect(chunks.some((c) => (c as { type: string }).type === "usage")).toBe(true)
	})

	it("reports usage from a completed event, with cached tokens split out", async () => {
		fallbackServing([
			{ type: "response.output_text.delta", delta: "x" },
			{
				type: "response.completed",
				response: {
					usage: {
						input_tokens: 100,
						output_tokens: 20,
						input_tokens_details: { cached_tokens: 30 },
					},
				},
			},
		])

		const chunks = (await drain(handler().createMessage("sys", USER))) as Array<Record<string, unknown>>

		const usage = chunks.find((c) => c.type === "usage")!
		expect(usage.inputTokens).toBe(100)
		expect(usage.outputTokens).toBe(20)
		expect(usage.cacheReadTokens).toBe(30)
	})

	it("ignores an event it does not recognise rather than failing the stream", async () => {
		fallbackServing([
			{ type: "response.some.future.event", data: { unknown: true } },
			{ type: "response.output_text.delta", delta: "still here" },
		])

		const chunks = await drain(handler().createMessage("sys", USER))

		expect(chunks).toContainEqual({ type: "text", text: "still here" })
	})

	it("skips a malformed SSE line instead of aborting the stream", async () => {
		mockResponsesCreate.mockRejectedValue(new Error("SDK cannot stream here"))
		const encoder = new TextEncoder()
		stubFetch({
			ok: true,
			status: 200,
			body: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(encoder.encode("data: { not json\n\n"))
					controller.enqueue(
						encoder.encode(
							`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}\n\n`,
						),
					)
					controller.enqueue(encoder.encode("data: [DONE]\n\n"))
					controller.close()
				},
			}),
		})

		const chunks = await drain(handler().createMessage("sys", USER))

		expect(chunks).toContainEqual({ type: "text", text: "ok" })
	})
})

describe("HTTP failures are translated, not relayed", () => {
	async function failWith(status: number, body: string) {
		mockResponsesCreate.mockRejectedValue(new Error("SDK cannot stream here"))
		stubFetch({ ok: false, status, text: async () => body })
		return drain(handler().createMessage("sys", USER)).catch((e: Error) => e)
	}

	it("names an authentication failure", async () => {
		const error = (await failWith(401, JSON.stringify({ error: { message: "Invalid API key" } }))) as Error

		expect(error).toBeInstanceOf(Error)
		expect(error.message).toMatch(/API key|401|authentication/i)
	})

	it("names a rate limit distinctly, so the retry bound can tell them apart", async () => {
		const error = (await failWith(429, JSON.stringify({ error: { message: "Rate limit reached" } }))) as Error

		expect(error.message).toMatch(/rate limit|429/i)
	})

	it("still reports a failure whose body is not JSON", async () => {
		const error = (await failWith(500, "<html>gateway blew up</html>")) as Error

		expect(error).toBeInstanceOf(Error)
		expect(error.message).toMatch(/500|failed/i)
	})

	it("reports a response that carried no body at all", async () => {
		mockResponsesCreate.mockRejectedValue(new Error("SDK cannot stream here"))
		stubFetch({ ok: true, status: 200, body: undefined })

		const error = await drain(handler().createMessage("sys", USER)).catch((e: Error) => e)

		expect(error).toBeInstanceOf(Error)
	})
})
