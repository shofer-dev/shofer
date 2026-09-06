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
 * The Responses API's EVENT VOCABULARY, end to end.
 *
 * OpenAI's Responses stream is not one shape: the same assistant reply arrives
 * as `response.text.delta` from one deployment, `response.output_text.delta`
 * from another, only on `…done` from a third, and wrapped in
 * `response.output_item.*` from a fourth. Every one of those spellings is
 * handled, and the handler's job is to collapse them into ONE chunk sequence so
 * nothing downstream — the agent loop, the parser, the cost accounting — has to
 * know which variant answered.
 *
 * The de-duplication is the part worth pinning, because both failure directions
 * are silent and expensive:
 *
 *  - text that arrived as deltas must NOT be re-emitted when the same text
 *    turns up again on `…done` or in the completed payload, or the model's
 *    reply is doubled in the transcript;
 *  - a tool call that was streamed as partials must NOT be re-emitted as a
 *    complete `tool_call` on `output_item.done` — that is the same call
 *    EXECUTED TWICE, which for a write tool means the edit applied twice.
 *
 * Everything is driven through the raw-SSE fallback, which is the handler's own
 * parser rather than the SDK's, so the vocabulary is exercised where we
 * implement it.
 */

const USER: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hello!" }]

/** Turn SSE event objects into the body `fetch` would deliver. */
function sseBody(events: unknown[]): unknown {
	const encoder = new TextEncoder()
	const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n"
	return new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(text))
			controller.close()
		},
	})
}

/** Force the SDK path to fail so the fallback runs, and serve `events` over SSE. */
function serving(events: unknown[]) {
	mockResponsesCreate.mockRejectedValue(new Error("SDK cannot stream here"))
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({ ok: true, status: 200, body: sseBody(events) }) as never),
	)
}

function handler(overrides: Record<string, unknown> = {}) {
	return new OpenAiNativeHandler({
		openAiNativeApiKey: "test-key",
		apiModelId: "gpt-5-2025-08-07",
		...overrides,
	} as never)
}

/** Drive one stream and collect its chunks. */
async function chunksFor(events: unknown[], overrides: Record<string, unknown> = {}) {
	serving(events)
	const out: Array<Record<string, unknown>> = []
	for await (const chunk of handler(overrides).createMessage("sys", USER)) {
		out.push(chunk as unknown as Record<string, unknown>)
	}
	return out
}

const textOf = (chunks: Array<Record<string, unknown>>) =>
	chunks
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("")

const reasoningOf = (chunks: Array<Record<string, unknown>>) =>
	chunks
		.filter((c) => c.type === "reasoning")
		.map((c) => c.text)
		.join("")

beforeEach(() => {
	vi.clearAllMocks()
})

afterEach(() => {
	vi.unstubAllGlobals()
})

describe("text, however it is spelled", () => {
	it.each(["response.text.delta", "response.output_text.delta"])("streams %s", async (type) => {
		expect(
			textOf(
				await chunksFor([
					{ type, delta: "chunk " },
					{ type, delta: "two" },
				]),
			),
		).toBe("chunk two")
	})

	it("ignores a delta event carrying no delta", async () => {
		expect(textOf(await chunksFor([{ type: "response.output_text.delta" }]))).toBe("")
	})

	it.each([
		["text", { type: "response.text.done", text: "whole reply" }],
		["output_text", { type: "response.output_text.done", output_text: "whole reply" }],
		["delta", { type: "response.text.done", delta: "whole reply" }],
	])("reads a done-only reply carried on %s", async (_field, event) => {
		// Some deployments skip deltas entirely and hand the whole reply over on
		// the done event; withholding it there loses the answer completely.
		expect(textOf(await chunksFor([event]))).toBe("whole reply")
	})

	it("does NOT repeat on `done` what already arrived as deltas", async () => {
		const chunks = await chunksFor([
			{ type: "response.output_text.delta", delta: "streamed" },
			{ type: "response.output_text.done", text: "streamed" },
		])

		expect(textOf(chunks)).toBe("streamed")
	})

	it("reads text out of a structured content part", async () => {
		expect(
			textOf(
				await chunksFor([{ type: "response.content_part.added", part: { type: "text", text: "from part" } }]),
			),
		).toBe("from part")
	})

	it("reads a content part whose text is itself a value object", async () => {
		expect(
			textOf(
				await chunksFor([
					{ type: "response.content_part.done", part: { type: "output_text", text: { value: "nested" } } },
				]),
			),
		).toBe("nested")
	})

	it("ignores a content part once deltas have been seen", async () => {
		const chunks = await chunksFor([
			{ type: "response.output_text.delta", delta: "streamed" },
			{ type: "response.content_part.done", part: { type: "text", text: "streamed" } },
		])

		expect(textOf(chunks)).toBe("streamed")
	})

	it("ignores a content part carrying nothing usable", async () => {
		expect(textOf(await chunksFor([{ type: "response.content_part.added", part: { type: "image" } }]))).toBe("")
	})

	it("falls back to the chat-completions delta shape", async () => {
		// An older proxy in front of the Responses endpoint speaks the previous
		// wire format; the caller must not have to care.
		expect(textOf(await chunksFor([{ choices: [{ delta: { content: "legacy shape" } }] }]))).toBe("legacy shape")
	})
})

describe("reasoning", () => {
	it.each([
		"response.reasoning.delta",
		"response.reasoning_text.delta",
		"response.reasoning_summary.delta",
		"response.reasoning_summary_text.delta",
	])("streams %s as a reasoning chunk", async (type) => {
		expect(reasoningOf(await chunksFor([{ type, delta: "thinking…" }]))).toBe("thinking…")
	})

	it("keeps reasoning out of the visible text", async () => {
		const chunks = await chunksFor([
			{ type: "response.reasoning.delta", delta: "internal" },
			{ type: "response.output_text.delta", delta: "visible" },
		])

		expect(textOf(chunks)).toBe("visible")
		expect(reasoningOf(chunks)).toBe("internal")
	})

	it("ignores a reasoning event carrying no delta", async () => {
		expect(reasoningOf(await chunksFor([{ type: "response.reasoning.delta" }]))).toBe("")
	})
})

describe("a refusal", () => {
	it("reaches the user as text, marked as a refusal", async () => {
		// Silently dropping it would leave the turn looking like an empty reply.
		expect(textOf(await chunksFor([{ type: "response.refusal.delta", delta: "I can't help with that" }]))).toBe(
			"[Refusal] I can't help with that",
		)
	})

	it("ignores an empty refusal delta", async () => {
		expect(textOf(await chunksFor([{ type: "response.refusal.delta" }]))).toBe("")
	})
})

describe("tool calls", () => {
	const partials = (chunks: Array<Record<string, unknown>>) => chunks.filter((c) => c.type === "tool_call_partial")
	const complete = (chunks: Array<Record<string, unknown>>) => chunks.filter((c) => c.type === "tool_call")

	it("streams argument deltas as partial calls", async () => {
		const chunks = await chunksFor([
			{ type: "response.function_call_arguments.delta", call_id: "c1", name: "read_file", delta: '{"pa' },
			{ type: "response.function_call_arguments.delta", call_id: "c1", name: "read_file", delta: 'th":"a"}' },
		])

		expect(partials(chunks)).toEqual([
			{ type: "tool_call_partial", index: 0, id: "c1", name: "read_file", arguments: '{"pa' },
			{ type: "tool_call_partial", index: 0, id: "c1", name: "read_file", arguments: 'th":"a"}' },
		])
	})

	it("attributes an anonymous delta to the identity announced on output_item.added", async () => {
		// Several deployments omit stable identity on the delta events; without
		// the carried-over identity the parser has nothing to start a call with.
		const chunks = await chunksFor([
			{
				type: "response.output_item.added",
				item: { type: "function_call", call_id: "c9", name: "write_to_file" },
			},
			{ type: "response.function_call_arguments.delta", delta: '{"path":"a"}' },
		])

		expect(partials(chunks)).toEqual([
			{ type: "tool_call_partial", index: 0, id: "c9", name: "write_to_file", arguments: '{"path":"a"}' },
		])
	})

	it("withholds a partial with no name, which the parser could not use", async () => {
		expect(
			partials(await chunksFor([{ type: "response.tool_call_arguments.delta", call_id: "c1", delta: "{}" }])),
		).toEqual([])
	})

	it("emits a COMPLETE call for a model that only reports it on output_item.done", async () => {
		const chunks = await chunksFor([
			{
				type: "response.output_item.done",
				item: { type: "function_call", call_id: "c2", name: "read_file", arguments: '{"path":"a"}' },
			},
		])

		expect(complete(chunks)).toEqual([
			{ type: "tool_call", id: "c2", name: "read_file", arguments: '{"path":"a"}' },
		])
	})

	it("serializes an object-valued arguments payload", async () => {
		const chunks = await chunksFor([
			{
				type: "response.output_item.done",
				item: { type: "tool_call", id: "c3", function: { name: "read_file", arguments: { path: "a" } } },
			},
		])

		expect(complete(chunks)).toEqual([
			{ type: "tool_call", id: "c3", name: "read_file", arguments: '{"path":"a"}' },
		])
	})

	it("treats an unusable arguments payload as empty rather than dropping the call", async () => {
		const chunks = await chunksFor([
			{ type: "response.output_item.done", item: { type: "function_call", call_id: "c4", name: "read_file" } },
		])

		expect(complete(chunks)).toEqual([{ type: "tool_call", id: "c4", name: "read_file", arguments: "" }])
	})

	it("does NOT re-emit a call whose arguments were already streamed", async () => {
		// The duplicate would be the same tool EXECUTED TWICE — for a write tool,
		// the edit applied twice.
		const chunks = await chunksFor([
			{ type: "response.function_call_arguments.delta", call_id: "c5", name: "read_file", delta: "{}" },
			{
				type: "response.output_item.done",
				item: { type: "function_call", call_id: "c5", name: "read_file", arguments: "{}" },
			},
		])

		expect(partials(chunks)).toHaveLength(1)
		expect(complete(chunks)).toEqual([])
	})

	it("ignores the arguments-done event, which carries nothing new", async () => {
		const chunks = await chunksFor([
			{ type: "response.function_call_arguments.done", call_id: "c6", name: "read_file" },
		])

		expect(complete(chunks)).toEqual([])
		expect(partials(chunks)).toEqual([])
	})
})

describe("output items carrying text", () => {
	it.each([
		["text", { type: "text", text: "item text" }],
		["output_text", { type: "output_text", text: "item text" }],
	])("streams an added %s item", async (_kind, item) => {
		expect(textOf(await chunksFor([{ type: "response.output_item.added", item }]))).toBe("item text")
	})

	it("streams an added reasoning item as reasoning", async () => {
		expect(
			reasoningOf(
				await chunksFor([{ type: "response.output_item.added", item: { type: "reasoning", text: "why" } }]),
			),
		).toBe("why")
	})

	it("walks a message item's content blocks", async () => {
		const chunks = await chunksFor([
			{
				type: "response.output_item.added",
				item: {
					type: "message",
					content: [
						{ type: "text", text: "one " },
						{ type: "output_text", text: "two" },
						{ type: "image", url: "ignored" },
					],
				},
			},
		])

		expect(textOf(chunks)).toBe("one two")
	})

	it("emits a done item's text ONLY when nothing was streamed", async () => {
		expect(
			textOf(await chunksFor([{ type: "response.output_item.done", item: { type: "text", text: "late" } }])),
		).toBe("late")
	})

	it("suppresses a done item's text once text has been streamed", async () => {
		const chunks = await chunksFor([
			{ type: "response.output_text.delta", delta: "streamed" },
			{ type: "response.output_item.done", item: { type: "text", text: "streamed" } },
		])

		expect(textOf(chunks)).toBe("streamed")
	})

	it("walks a done message item's content when nothing was streamed", async () => {
		const chunks = await chunksFor([
			{
				type: "response.output_item.done",
				item: { type: "message", content: [{ type: "output_text", text: "recovered" }] },
			},
		])

		expect(textOf(chunks)).toBe("recovered")
	})

	it("ignores an output_item event with no item at all", async () => {
		expect(await chunksFor([{ type: "response.output_item.added" }])).toEqual([])
	})
})

describe("the completed event", () => {
	it("recovers the whole reply from the completed payload when nothing streamed", async () => {
		const chunks = await chunksFor([
			{ type: "response.completed", response: { output: [{ type: "output_text", text: "final answer" }] } },
		])

		expect(textOf(chunks)).toBe("final answer")
	})

	it("walks message items inside the completed payload", async () => {
		const chunks = await chunksFor([
			{
				type: "response.done",
				response: { output: [{ type: "message", content: [{ type: "text", text: "final" }] }] },
			},
		])

		expect(textOf(chunks)).toBe("final")
	})

	it("does NOT repeat text already streamed", async () => {
		const chunks = await chunksFor([
			{ type: "response.output_text.delta", delta: "streamed" },
			{ type: "response.completed", response: { output: [{ type: "output_text", text: "streamed" }] } },
		])

		expect(textOf(chunks)).toBe("streamed")
	})

	it("reports usage carried beside the response", async () => {
		const chunks = await chunksFor([
			{ type: "response.completed", response: { usage: { input_tokens: 100, output_tokens: 20 } } },
		])

		expect(chunks.filter((c) => c.type === "usage")).toHaveLength(1)
	})

	it("reports a bare top-level usage object too", async () => {
		const chunks = await chunksFor([{ usage: { input_tokens: 10, output_tokens: 2 } }])

		expect(chunks.filter((c) => c.type === "usage")).toHaveLength(1)
	})
})

describe("what the handler remembers from the stream", () => {
	it("keeps the response id, so a follow-up turn can continue the conversation", async () => {
		serving([{ type: "response.completed", response: { id: "resp_123", output: [] } }])
		const h = handler()

		for await (const _ of h.createMessage("sys", USER)) {
			void _
		}

		expect(h.getResponseId()).toBe("resp_123")
	})

	it("keeps the encrypted reasoning item, which a later turn must send back", async () => {
		// Reasoning is opaque and server-held; dropping it makes the model
		// re-derive everything on the next turn.
		serving([
			{
				type: "response.completed",
				response: {
					id: "resp_1",
					output: [{ type: "reasoning", id: "rs_1", encrypted_content: "OPAQUE" }],
				},
			},
		])
		const h = handler()

		for await (const _ of h.createMessage("sys", USER)) {
			void _
		}

		expect(h.getEncryptedContent()).toEqual({ encrypted_content: "OPAQUE", id: "rs_1" })
	})

	it("has nothing to hand back when the response carried no reasoning", async () => {
		serving([{ type: "response.completed", response: { id: "resp_1", output: [] } }])
		const h = handler()

		for await (const _ of h.createMessage("sys", USER)) {
			void _
		}

		expect(h.getEncryptedContent()).toBeUndefined()
	})
})
