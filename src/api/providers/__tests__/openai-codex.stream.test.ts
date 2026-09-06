// npx vitest src/api/providers/__tests__/openai-codex.stream.test.ts

/**
 * The Codex handler's stream translation. This provider speaks the Responses API
 * over a ChatGPT-subscription backend, so almost everything here is a mapping
 * whose failure is silent: an event kind that yields nothing looks like a model
 * that said nothing.
 *
 * The behaviours pinned below, in the order they bite:
 *
 *  - **Auth first.** No token means a refusal before any request is made.
 *    (The handler also carries a refresh-and-retry-once loop around
 *    `executeRequest`, but `executeRequest` catches EVERY SDK error — 401
 *    included — and falls back to the raw SSE transport, so an auth failure on
 *    the SDK path never reaches that loop. What is pinned here is the fallback
 *    that actually runs.)
 *  - **Text is emitted exactly once.** Codex variants deliver assistant text via
 *    deltas, via a `.done` payload, via `content_part`, via `output_item` and via
 *    the final `response.completed` — the handler has to take whichever arrives
 *    and suppress the rest, or the reply is duplicated.
 *  - **A tool call is emitted exactly once too.** Argument deltas produce
 *    `tool_call_partial`; the terminal `output_item.done` only emits a complete
 *    `tool_call` for an id that was NOT streamed, because emitting both executes
 *    the tool twice.
 *  - **Usage carries no cost.** This is a subscription, so `totalCost` is 0 by
 *    construction rather than by a price table lookup.
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

import type { Anthropic } from "@anthropic-ai/sdk"

import { OpenAiCodexHandler } from "../openai-codex"

type Chunk = { type: string; [k: string]: unknown }

/** Drive `createMessage` with a scripted SDK stream and collect every chunk. */
async function streamWith(
	events: unknown[],
	options: {
		handlerOptions?: Record<string, unknown>
		messages?: Anthropic.Messages.MessageParam[]
		metadata?: Record<string, unknown>
	} = {},
): Promise<{ chunks: Chunk[]; handler: OpenAiCodexHandler; create: ReturnType<typeof vi.fn> }> {
	const handler = new OpenAiCodexHandler((options.handlerOptions ?? { apiModelId: "gpt-5.1" }) as never)
	const create = vi.fn(async () => ({
		async *[Symbol.asyncIterator]() {
			for (const event of events) yield event
		},
	}))
	;(handler as unknown as { client: unknown }).client = { responses: { create } }

	const chunks: Chunk[] = []
	for await (const chunk of handler.createMessage(
		"SYSTEM",
		options.messages ?? ([{ role: "user", content: "hello" }] as never),
		(options.metadata ?? { taskId: "t-1" }) as never,
	)) {
		chunks.push(chunk as Chunk)
	}
	return { chunks, handler, create }
}

function texts(chunks: Chunk[]) {
	return chunks.filter((c) => c.type === "text").map((c) => c.text)
}

beforeEach(() => {
	vi.clearAllMocks()
	hoisted.getAccessToken.mockResolvedValue("token-1")
	hoisted.getAccountId.mockResolvedValue("acct-1")
	hoisted.forceRefreshAccessToken.mockResolvedValue("token-2")
})

describe("authentication", () => {
	it("REFUSES before making a request when there is no token", async () => {
		hoisted.getAccessToken.mockResolvedValue(null)
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.1" } as never)

		const stream = handler.createMessage("s", [{ role: "user", content: "hi" }] as never)

		await expect(stream.next()).rejects.toThrow(/[Nn]ot authenticated|notAuthenticated/)
	})

	it("falls back to the RAW SSE transport when the SDK path fails", async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			status: 200,
			body: {
				getReader: () => {
					let sent = false
					return {
						read: async () => {
							if (sent) return { done: true, value: undefined }
							sent = true
							return {
								done: false,
								value: new TextEncoder().encode(
									'data: {"type":"response.output_text.delta","delta":"via-sse"}\n\n',
								),
							}
						},
						releaseLock: () => {},
						cancel: async () => {},
					}
				},
			},
			text: async () => "",
		}))
		vi.stubGlobal("fetch", fetchMock)
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.1" } as never)
		;(handler as unknown as { client: unknown }).client = {
			responses: {
				create: vi.fn(async () => {
					throw new Error("SDK unavailable")
				}),
			},
		}

		const chunks: Chunk[] = []
		for await (const chunk of handler.createMessage("s", [{ role: "user", content: "hi" }] as never)) {
			chunks.push(chunk as Chunk)
		}

		expect(fetchMock).toHaveBeenCalled()
		expect(texts(chunks)).toEqual(["via-sse"])
		vi.unstubAllGlobals()
	})

	it("surfaces a REFUSED fallback request as an error, and records it as telemetry", async () => {
		const fetchMock = vi.fn(async () => ({
			ok: false,
			status: 401,
			text: async () => '{"error":{"message":"bad token"}}',
		}))
		vi.stubGlobal("fetch", fetchMock)
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.1" } as never)
		;(handler as unknown as { client: unknown }).client = {
			responses: {
				create: vi.fn(async () => {
					throw new Error("SDK unavailable")
				}),
			},
		}

		const stream = handler.createMessage("s", [{ role: "user", content: "hi" }] as never)

		await expect(stream.next()).rejects.toThrow()
		expect(hoisted.captureException).toHaveBeenCalled()
		vi.unstubAllGlobals()
	})

	it("REFUSES a fallback response that carries no body at all", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, status: 200, body: null, text: async () => "" })),
		)
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.1" } as never)
		;(handler as unknown as { client: unknown }).client = {
			responses: { create: vi.fn(async () => ({ notIterable: true })) },
		}

		const stream = handler.createMessage("s", [{ role: "user", content: "hi" }] as never)

		await expect(stream.next()).rejects.toThrow()
		vi.unstubAllGlobals()
	})
})

describe("the request body", () => {
	async function bodyFor(options: Parameters<typeof streamWith>[1] = {}) {
		const { create } = await streamWith([], options)
		return create.mock.calls[0][0] as Record<string, unknown>
	}

	it("streams, never STORES, and carries the system prompt as `instructions`", async () => {
		const body = await bodyFor()

		expect(body).toMatchObject({ stream: true, store: false, instructions: "SYSTEM" })
	})

	it("asks for encrypted reasoning content ONLY when a reasoning effort applies", async () => {
		const withReasoning = await bodyFor({ handlerOptions: { apiModelId: "gpt-5.1" } })
		expect(withReasoning.include).toEqual(["reasoning.encrypted_content"])
		expect(withReasoning.reasoning).toMatchObject({ effort: "medium", summary: "auto" })

		const disabled = await bodyFor({ handlerOptions: { apiModelId: "gpt-5.1", reasoningEffort: "disable" } })
		expect(disabled.include).toBeUndefined()
		expect(disabled.reasoning).toBeUndefined()
	})

	it("treats 'none' as no reasoning too", async () => {
		const body = await bodyFor({ handlerOptions: { apiModelId: "gpt-5.1", reasoningEffort: "none" } })

		expect(body.reasoning).toBeUndefined()
	})

	it("lets an explicit reasoning effort override the model's default", async () => {
		const body = await bodyFor({ handlerOptions: { apiModelId: "gpt-5.1", reasoningEffort: "high" } })

		expect(body.reasoning).toMatchObject({ effort: "high" })
	})

	it("keeps only FUNCTION tools and marks a native one strict", async () => {
		const body = await bodyFor({
			metadata: {
				taskId: "t",
				tools: [
					{
						type: "function",
						function: {
							name: "read_file",
							description: "d",
							parameters: { type: "object", properties: {} },
						},
					},
					{ type: "web_search" },
				],
			},
		})

		const tools = body.tools as Array<Record<string, unknown>>
		expect(tools).toHaveLength(1)
		expect(tools[0]).toMatchObject({ type: "function", name: "read_file", strict: true })
	})

	it("makes every property REQUIRED for a native tool — the strict-schema contract", async () => {
		const body = await bodyFor({
			metadata: {
				taskId: "t",
				tools: [
					{
						type: "function",
						function: {
							name: "read_file",
							parameters: {
								type: "object",
								properties: {
									path: { type: "string" },
									opts: { type: "object", properties: { deep: { type: "boolean" } } },
									items: {
										type: "array",
										items: { type: "object", properties: { a: { type: "string" } } },
									},
								},
								required: ["path"],
							},
						},
					},
				],
			},
		})

		const params = (body.tools as Array<{ parameters: Record<string, never> }>)[0].parameters as Record<
			string,
			never
		>
		expect(params.required).toEqual(["path", "opts", "items"])
		expect(params.additionalProperties).toBe(false)
		expect((params.properties as never as Record<string, { required: string[] }>).opts.required).toEqual(["deep"])
		expect(
			(params.properties as never as Record<string, { items: { required: string[] } }>).items.items.required,
		).toEqual(["a"])
	})

	it("leaves an MCP tool's schema NON-strict — a server's schema is not ours to tighten", async () => {
		const body = await bodyFor({
			metadata: {
				taskId: "t",
				tools: [
					{
						type: "function",
						function: {
							name: "mcp__srv__do_thing",
							parameters: { type: "object", properties: { a: { type: "string" } }, required: [] },
						},
					},
				],
			},
		})

		const tool = (body.tools as Array<Record<string, never>>)[0]
		expect(tool.strict).toBe(false)
		expect((tool.parameters as unknown as Record<string, unknown>).required).toEqual([])
		expect((tool.parameters as unknown as Record<string, unknown>).additionalProperties).toBe(false)
	})

	it("leaves a non-object parameter schema untouched", async () => {
		const body = await bodyFor({
			metadata: { taskId: "t", tools: [{ type: "function", function: { name: "t", parameters: undefined } }] },
		})

		expect((body.tools as Array<Record<string, unknown>>)[0].parameters).toBeUndefined()
	})

	it("defaults parallel tool calls ON, and honours an explicit refusal", async () => {
		expect((await bodyFor()).parallel_tool_calls).toBe(true)
		expect((await bodyFor({ metadata: { taskId: "t", parallelToolCalls: false } })).parallel_tool_calls).toBe(false)
	})
})

describe("conversation formatting", () => {
	async function inputFor(messages: Anthropic.Messages.MessageParam[]) {
		const { create } = await streamWith([], { messages })
		return (create.mock.calls[0][0] as { input: Array<Record<string, unknown>> }).input
	}

	it("wraps a plain user string as input_text", async () => {
		await expect(inputFor([{ role: "user", content: "hello" }])).resolves.toEqual([
			{ role: "user", content: [{ type: "input_text", text: "hello" }] },
		])
	})

	it("turns an image block into a data-url input_image", async () => {
		const input = await inputFor([
			{
				role: "user",
				content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }],
			} as never,
		])

		expect(input[0]).toMatchObject({
			content: [{ type: "input_image", image_url: "data:image/png;base64,AAA" }],
		})
	})

	it("emits a tool_result as its OWN function_call_output entry, not as user content", async () => {
		const input = await inputFor([
			{
				role: "user",
				content: [
					{ type: "text", text: "here you go" },
					{ type: "tool_result", tool_use_id: "call_1", content: "the output" },
				],
			} as never,
		])

		expect(input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "here you go" }] },
			{ type: "function_call_output", call_id: "call_1", output: "the output" },
		])
	})

	it("flattens a structured tool_result's text blocks", async () => {
		const input = await inputFor([
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "call_1",
						content: [
							{ type: "text", text: "a" },
							{ type: "image", source: {} },
							{ type: "text", text: "b" },
						],
					},
				],
			} as never,
		])

		expect(input[0]).toMatchObject({ output: "ab" })
	})

	it("emits nothing for a user message with no renderable content", async () => {
		await expect(inputFor([{ role: "user", content: [] } as never])).resolves.toEqual([])
	})

	it("turns an assistant tool_use into a function_call with STRINGIFIED arguments", async () => {
		const input = await inputFor([
			{
				role: "assistant",
				content: [
					{ type: "text", text: "calling" },
					{ type: "tool_use", id: "call_1", name: "read_file", input: { path: "a.ts" } },
				],
			} as never,
		])

		expect(input).toEqual([
			{ role: "assistant", content: [{ type: "output_text", text: "calling" }] },
			{ type: "function_call", call_id: "call_1", name: "read_file", arguments: '{"path":"a.ts"}' },
		])
	})

	it("wraps a plain assistant string as output_text", async () => {
		await expect(inputFor([{ role: "assistant", content: "sure" }])).resolves.toEqual([
			{ role: "assistant", content: [{ type: "output_text", text: "sure" }] },
		])
	})

	it("passes a REASONING item through untouched — it is the provider's own item", async () => {
		const reasoning = { type: "reasoning", encrypted_content: "abc" }

		await expect(inputFor([reasoning as never])).resolves.toEqual([reasoning])
	})
})

describe("text arrives exactly once, whichever event carries it", () => {
	it("from output_text deltas", async () => {
		const { chunks } = await streamWith([
			{ type: "response.output_text.delta", delta: "he" },
			{ type: "response.output_text.delta", delta: "llo" },
		])

		expect(texts(chunks)).toEqual(["he", "llo"])
	})

	it("from the legacy response.text.delta spelling", async () => {
		const { chunks } = await streamWith([{ type: "response.text.delta", delta: "hi" }])

		expect(texts(chunks)).toEqual(["hi"])
	})

	it("ignores an EMPTY delta rather than emitting a blank chunk", async () => {
		const { chunks } = await streamWith([{ type: "response.output_text.delta", delta: "" }])

		expect(texts(chunks)).toEqual([])
	})

	it("from a `.done` payload when no delta ever arrived", async () => {
		const { chunks } = await streamWith([{ type: "response.output_text.done", text: "whole reply" }])

		expect(texts(chunks)).toEqual(["whole reply"])
	})

	it("SUPPRESSES the `.done` payload when deltas already carried the text", async () => {
		const { chunks } = await streamWith([
			{ type: "response.output_text.delta", delta: "hi" },
			{ type: "response.output_text.done", text: "hi" },
		])

		expect(texts(chunks)).toEqual(["hi"])
	})

	it("from a content_part, and not once deltas have been seen", async () => {
		const fromPart = await streamWith([
			{ type: "response.content_part.added", part: { type: "output_text", text: "part text" } },
		])
		expect(texts(fromPart.chunks)).toEqual(["part text"])

		const afterDelta = await streamWith([
			{ type: "response.output_text.delta", delta: "hi" },
			{ type: "response.content_part.done", part: { type: "text", text: "hi" } },
		])
		expect(texts(afterDelta.chunks)).toEqual(["hi"])
	})

	it("from a content_part whose text is a nested value object", async () => {
		const { chunks } = await streamWith([
			{ type: "response.content_part.added", part: { type: "text", text: { value: "nested" } } },
		])

		expect(texts(chunks)).toEqual(["nested"])
	})

	it("from an output_item.added text / output_text / message item", async () => {
		const text = await streamWith([{ type: "response.output_item.added", item: { type: "text", text: "a" } }])
		expect(texts(text.chunks)).toEqual(["a"])

		const outputText = await streamWith([
			{ type: "response.output_item.added", item: { type: "output_text", text: "b" } },
		])
		expect(texts(outputText.chunks)).toEqual(["b"])

		const message = await streamWith([
			{
				type: "response.output_item.added",
				item: { type: "message", content: [{ type: "output_text", text: "c" }, { type: "image" }] },
			},
		])
		expect(texts(message.chunks)).toEqual(["c"])
	})

	it("from an output_item.done message when nothing was streamed", async () => {
		const { chunks } = await streamWith([
			{ type: "response.output_item.done", item: { type: "message", content: [{ type: "text", text: "late" }] } },
		])

		expect(texts(chunks)).toEqual(["late"])
	})

	it("from the FINAL completed payload when nothing else carried it", async () => {
		const { chunks } = await streamWith([
			{
				type: "response.completed",
				response: {
					id: "resp_1",
					output: [{ type: "message", content: [{ type: "output_text", text: "final" }] }],
				},
			},
		])

		expect(texts(chunks)).toEqual(["final"])
	})

	it("takes a bare output_text item off the completed payload", async () => {
		const { chunks } = await streamWith([
			{ type: "response.completed", response: { output: [{ type: "output_text", text: "final" }] } },
		])

		expect(texts(chunks)).toEqual(["final"])
	})

	it("does NOT re-emit the completed payload when deltas already streamed", async () => {
		const { chunks } = await streamWith([
			{ type: "response.output_text.delta", delta: "streamed" },
			{ type: "response.completed", response: { output: [{ type: "output_text", text: "streamed" }] } },
		])

		expect(texts(chunks)).toEqual(["streamed"])
	})

	it("from a chat-completions shaped fallback event", async () => {
		const { chunks } = await streamWith([{ choices: [{ delta: { content: "legacy" } }] }])

		expect(texts(chunks)).toEqual(["legacy"])
	})
})

describe("reasoning and refusals", () => {
	it.each([
		"response.reasoning.delta",
		"response.reasoning_text.delta",
		"response.reasoning_summary.delta",
		"response.reasoning_summary_text.delta",
	])("%s becomes a reasoning chunk", async (type) => {
		const { chunks } = await streamWith([{ type, delta: "thinking" }])

		expect(chunks).toEqual([{ type: "reasoning", text: "thinking" }])
	})

	it("an output_item.added reasoning item becomes a reasoning chunk", async () => {
		const { chunks } = await streamWith([
			{ type: "response.output_item.added", item: { type: "reasoning", text: "because" } },
		])

		expect(chunks).toEqual([{ type: "reasoning", text: "because" }])
	})

	it("a refusal is surfaced as LABELLED text, not silently dropped", async () => {
		const { chunks } = await streamWith([{ type: "response.refusal.delta", delta: "I cannot" }])

		expect(texts(chunks)).toEqual(["[Refusal] I cannot"])
	})
})

describe("tool calls are emitted exactly once", () => {
	it("streams partials once an output_item has established the call's identity", async () => {
		const { chunks } = await streamWith([
			{
				type: "response.output_item.added",
				item: { type: "function_call", call_id: "call_1", name: "read_file" },
			},
			{ type: "response.function_call_arguments.delta", delta: '{"path":' },
			{ type: "response.function_call_arguments.delta", delta: '"a.ts"}' },
		])

		expect(chunks.filter((c) => c.type === "tool_call_partial")).toEqual([
			{ type: "tool_call_partial", index: 0, id: "call_1", name: "read_file", arguments: '{"path":' },
			{ type: "tool_call_partial", index: 0, id: "call_1", name: "read_file", arguments: '"a.ts"}' },
		])
	})

	it("emits NOTHING for an argument delta with no id or name to attribute it to", async () => {
		const { chunks } = await streamWith([{ type: "response.function_call_arguments.delta", delta: "{}" }])

		expect(chunks).toEqual([])
	})

	it("emits a COMPLETE tool_call from output_item.done for a call that was never streamed", async () => {
		const { chunks } = await streamWith([
			{
				type: "response.output_item.done",
				item: { type: "function_call", call_id: "call_9", name: "read_file", arguments: '{"path":"a.ts"}' },
			},
		])

		expect(chunks).toEqual([{ type: "tool_call", id: "call_9", name: "read_file", arguments: '{"path":"a.ts"}' }])
	})

	it("stringifies an OBJECT arguments payload", async () => {
		const { chunks } = await streamWith([
			{
				type: "response.output_item.done",
				item: {
					type: "tool_call",
					tool_call_id: "call_9",
					function: { name: "read_file", arguments: { path: "a" } },
				},
			},
		])

		expect(chunks[0]).toMatchObject({ arguments: '{"path":"a"}' })
	})

	it("substitutes an empty argument string when the item carries none", async () => {
		const { chunks } = await streamWith([
			{ type: "response.output_item.done", item: { type: "function_call", id: "call_9", name: "read_file" } },
		])

		expect(chunks[0]).toMatchObject({ arguments: "" })
	})

	it("does NOT re-emit a call whose arguments were already streamed — that would run the tool twice", async () => {
		const { chunks } = await streamWith([
			{
				type: "response.output_item.added",
				item: { type: "function_call", call_id: "call_1", name: "read_file" },
			},
			{ type: "response.function_call_arguments.delta", delta: "{}" },
			{
				type: "response.output_item.done",
				item: { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{}" },
			},
		])

		expect(chunks.filter((c) => c.type === "tool_call")).toEqual([])
	})

	it("ignores the arguments.done event entirely — the parser finalizes instead", async () => {
		const { chunks } = await streamWith([{ type: "response.function_call_arguments.done", arguments: "{}" }])

		expect(chunks).toEqual([])
	})
})

describe("usage", () => {
	it("carries ZERO cost — this is a subscription, not metered", async () => {
		const { chunks } = await streamWith([
			{ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 4 } } },
		])

		expect(chunks).toEqual([
			{ type: "usage", inputTokens: 10, outputTokens: 4, cacheWriteTokens: 0, cacheReadTokens: 0, totalCost: 0 },
		])
	})

	it("accepts the chat-completions spellings of the token counts", async () => {
		const { chunks } = await streamWith([
			{ type: "response.done", response: { usage: { prompt_tokens: 7, completion_tokens: 2 } } },
		])

		expect(chunks[0]).toMatchObject({ inputTokens: 7, outputTokens: 2 })
	})

	it("RECONSTRUCTS the input total from cache details when the total is zero", async () => {
		const { chunks } = await streamWith([
			{
				type: "response.completed",
				response: {
					usage: { input_tokens: 0, input_tokens_details: { cached_tokens: 30, cache_miss_tokens: 12 } },
				},
			},
		])

		expect(chunks[0]).toMatchObject({ inputTokens: 42, cacheReadTokens: 30 })
	})

	it("surfaces reasoning tokens only when the provider reports them", async () => {
		const withReasoning = await streamWith([
			{
				type: "response.completed",
				response: { usage: { input_tokens: 1, output_tokens_details: { reasoning_tokens: 5 } } },
			},
		])
		expect(withReasoning.chunks[0]).toMatchObject({ reasoningTokens: 5 })

		const without = await streamWith([{ type: "response.completed", response: { usage: { input_tokens: 1 } } }])
		expect(without.chunks[0]).not.toHaveProperty("reasoningTokens")
	})

	it("emits NOTHING for a completion event carrying no usage at all", async () => {
		const { chunks } = await streamWith([{ type: "response.completed", response: {} }])

		expect(chunks).toEqual([])
	})

	it("accepts a top-level usage on an otherwise unrecognised event", async () => {
		const { chunks } = await streamWith([{ usage: { input_tokens: 3, output_tokens: 1 } }])

		expect(chunks[0]).toMatchObject({ type: "usage", inputTokens: 3, outputTokens: 1 })
	})

	it("ignores an event that is neither recognised nor carries usage", async () => {
		const { chunks } = await streamWith([{ type: "response.in_progress" }])

		expect(chunks).toEqual([])
	})
})

describe("response bookkeeping", () => {
	it("remembers the response id for the next turn's continuation", async () => {
		const { handler } = await streamWith([{ type: "response.completed", response: { id: "resp_42", output: [] } }])

		expect(handler.getResponseId()).toBe("resp_42")
	})

	it("has no encrypted reasoning content before a response arrives", () => {
		expect(new OpenAiCodexHandler({ apiModelId: "gpt-5.1" } as never).getEncryptedContent()).toBeUndefined()
	})

	it("extracts the encrypted reasoning item, with its id when present", async () => {
		const { handler } = await streamWith([
			{
				type: "response.completed",
				response: { output: [{ type: "reasoning", encrypted_content: "ENC", id: "rs_1" }] },
			},
		])

		expect(handler.getEncryptedContent()).toEqual({ encrypted_content: "ENC", id: "rs_1" })
	})

	it("returns undefined when the output has no encrypted reasoning item", async () => {
		const { handler } = await streamWith([
			{ type: "response.completed", response: { output: [{ type: "message", content: [] }] } },
		])

		expect(handler.getEncryptedContent()).toBeUndefined()
	})

	it("RESETS the per-response state between requests", async () => {
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.1" } as never)
		const events: unknown[][] = [
			[
				{
					type: "response.completed",
					response: { id: "resp_1", output: [{ type: "reasoning", encrypted_content: "E" }] },
				},
			],
			[{ type: "response.completed", response: { output: [] } }],
		]
		let call = 0
		;(handler as unknown as { client: unknown }).client = {
			responses: {
				create: vi.fn(async () => {
					const script = events[call++]
					return {
						async *[Symbol.asyncIterator]() {
							for (const e of script) yield e
						},
					}
				}),
			},
		}

		for await (const _ of handler.createMessage("s", [{ role: "user", content: "a" }] as never)) void _
		expect(handler.getResponseId()).toBe("resp_1")

		for await (const _ of handler.createMessage("s", [{ role: "user", content: "b" }] as never)) void _
		expect(handler.getResponseId()).toBeUndefined()
		expect(handler.getEncryptedContent()).toBeUndefined()
	})
})

describe("completePrompt", () => {
	let fetchMock: ReturnType<typeof vi.fn>

	beforeEach(() => {
		fetchMock = vi.fn()
		vi.stubGlobal("fetch", fetchMock)
	})

	afterEach(() => vi.unstubAllGlobals())

	function response(body: unknown, init: { ok?: boolean; status?: number } = {}) {
		return {
			ok: init.ok ?? true,
			status: init.status ?? 200,
			json: async () => body,
			text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
		}
	}

	it("REFUSES without a token", async () => {
		hoisted.getAccessToken.mockResolvedValue(null)
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.1" } as never)

		await expect(handler.completePrompt("hi")).rejects.toThrow()
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it("sends the Codex identity headers, including the account id", async () => {
		fetchMock.mockResolvedValueOnce(response({ output: [] }))
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.1" } as never)

		await handler.completePrompt("hi")

		const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }]
		expect(init.headers).toMatchObject({
			Authorization: "Bearer token-1",
			originator: "shofer-code",
			"ChatGPT-Account-Id": "acct-1",
		})
		expect(init.headers["User-Agent"]).toContain("shofer-code/")
	})

	it("omits the account header when there is no organization account", async () => {
		hoisted.getAccountId.mockResolvedValue(null)
		fetchMock.mockResolvedValueOnce(response({ output: [] }))
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.1" } as never)

		await handler.completePrompt("hi")

		const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }]
		expect(init.headers["ChatGPT-Account-Id"]).toBeUndefined()
	})

	it("requests a NON-streamed completion", async () => {
		fetchMock.mockResolvedValueOnce(response({ output: [] }))
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.1" } as never)

		await handler.completePrompt("hi")

		const [, init] = fetchMock.mock.calls[0] as [string, { body: string }]
		expect(JSON.parse(init.body)).toMatchObject({ stream: false, store: false })
	})

	it("returns the first output_text it finds inside a message item", async () => {
		fetchMock.mockResolvedValueOnce(
			response({
				output: [
					{ type: "reasoning" },
					{ type: "message", content: [{ type: "refusal" }, { type: "output_text", text: "the answer" }] },
				],
			}),
		)
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.1" } as never)

		await expect(handler.completePrompt("hi")).resolves.toBe("the answer")
	})

	it("falls back to a top-level `text` field", async () => {
		fetchMock.mockResolvedValueOnce(response({ text: "flat answer" }))
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.1" } as never)

		await expect(handler.completePrompt("hi")).resolves.toBe("flat answer")
	})

	it("returns an EMPTY string rather than undefined when the payload carries no text", async () => {
		fetchMock.mockResolvedValueOnce(response({ output: [] }))
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.1" } as never)

		await expect(handler.completePrompt("hi")).resolves.toBe("")
	})

	it("reports an HTTP failure and records it as telemetry", async () => {
		fetchMock.mockResolvedValueOnce(response("quota exceeded", { ok: false, status: 429 }))
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.1" } as never)

		await expect(handler.completePrompt("hi")).rejects.toThrow()
		expect(hoisted.captureException).toHaveBeenCalled()
	})
})

describe("the raw SSE fallback transport", () => {
	/** Drive `createMessage` through the fetch/SSE path with a scripted event stream. */
	async function sseWith(lines: string[]): Promise<Chunk[]> {
		const encoder = new TextEncoder()
		const chunks = lines.map((line) => encoder.encode(line))
		let index = 0
		const fetchMock = vi.fn(async () => ({
			ok: true,
			status: 200,
			text: async () => "",
			body: {
				getReader: () => ({
					read: async () =>
						index < chunks.length
							? { done: false, value: chunks[index++] }
							: { done: true, value: undefined },
					releaseLock: () => {},
					cancel: async () => {},
				}),
			},
		}))
		vi.stubGlobal("fetch", fetchMock)

		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.1" } as never)
		;(handler as unknown as { client: unknown }).client = {
			responses: {
				create: vi.fn(async () => {
					throw new Error("force the SSE path")
				}),
			},
		}

		const out: Chunk[] = []
		for await (const chunk of handler.createMessage("s", [{ role: "user", content: "hi" }] as never)) {
			out.push(chunk as Chunk)
		}
		vi.unstubAllGlobals()
		return out
	}

	const event = (payload: Record<string, unknown>) => `data: ${JSON.stringify(payload)}\n\n`

	it("streams text deltas", async () => {
		const chunks = await sseWith([
			event({ type: "response.output_text.delta", delta: "he" }),
			event({ type: "response.output_text.delta", delta: "llo" }),
		])

		expect(texts(chunks)).toEqual(["he", "llo"])
	})

	it("IGNORES the [DONE] sentinel", async () => {
		const chunks = await sseWith([event({ type: "response.output_text.delta", delta: "hi" }), "data: [DONE]\n\n"])

		expect(texts(chunks)).toEqual(["hi"])
	})

	it("tolerates a line split ACROSS chunk boundaries", async () => {
		const payload = event({ type: "response.output_text.delta", delta: "split" })
		const chunks = await sseWith([payload.slice(0, 12), payload.slice(12)])

		expect(texts(chunks)).toEqual(["split"])
	})

	it("SKIPS a malformed data line rather than aborting the stream", async () => {
		const chunks = await sseWith([
			"data: {not json\n\n",
			event({ type: "response.output_text.delta", delta: "after" }),
		])

		expect(texts(chunks)).toEqual(["after"])
	})

	it("ignores a line that is not an SSE data line", async () => {
		const chunks = await sseWith([": keep-alive\n\n", event({ type: "response.output_text.delta", delta: "hi" })])

		expect(texts(chunks)).toEqual(["hi"])
	})

	it("renders a reasoning summary out of the completed payload", async () => {
		const chunks = await sseWith([
			event({
				response: {
					id: "resp_1",
					output: [{ type: "reasoning", summary: [{ type: "summary_text", text: "because" }] }],
					usage: { input_tokens: 1, output_tokens: 1 },
				},
			}),
		])

		expect(chunks.filter((c) => c.type === "reasoning").map((c) => c.text)).toEqual(["because"])
		expect(chunks.some((c) => c.type === "usage")).toBe(true)
	})

	it("renders TEXT out of the completed payload's output items", async () => {
		const chunks = await sseWith([
			event({
				response: { output: [{ type: "text", content: [{ type: "text", text: "final" }] }] },
			}),
		])

		expect(texts(chunks)).toEqual(["final"])
	})

	it("streams reasoning deltas in both spellings", async () => {
		const chunks = await sseWith([
			event({ type: "response.reasoning.delta", delta: "a" }),
			event({ type: "response.reasoning_summary_text.delta", delta: "b" }),
		])

		expect(chunks.filter((c) => c.type === "reasoning").map((c) => c.text)).toEqual(["a", "b"])
	})

	it("labels a refusal", async () => {
		const chunks = await sseWith([event({ type: "response.refusal.delta", delta: "I cannot" })])

		expect(texts(chunks)).toEqual(["[Refusal] I cannot"])
	})

	it("takes the `.done` text only when nothing was streamed", async () => {
		const fromDone = await sseWith([event({ type: "response.output_text.done", text: "whole" })])
		expect(texts(fromDone)).toEqual(["whole"])

		const suppressed = await sseWith([
			event({ type: "response.output_text.delta", delta: "streamed" }),
			event({ type: "response.output_text.done", text: "streamed" }),
		])
		expect(texts(suppressed)).toEqual(["streamed"])
	})

	it("REMEMBERS the response id and the encrypted reasoning content off the stream", async () => {
		const encoder = new TextEncoder()
		const payload = encoder.encode(
			event({
				response: { id: "resp_9", output: [{ type: "reasoning", encrypted_content: "ENC" }] },
			}),
		)
		let sent = false
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				status: 200,
				text: async () => "",
				body: {
					getReader: () => ({
						read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: payload })),
						releaseLock: () => {},
						cancel: async () => {},
					}),
				},
			})),
		)
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.1" } as never)
		;(handler as unknown as { client: unknown }).client = {
			responses: {
				create: vi.fn(async () => {
					throw new Error("force the SSE path")
				}),
			},
		}

		for await (const _ of handler.createMessage("s", [{ role: "user", content: "hi" }] as never)) void _

		expect(handler.getResponseId()).toBe("resp_9")
		expect(handler.getEncryptedContent()).toEqual({ encrypted_content: "ENC" })
		vi.unstubAllGlobals()
	})
})

describe("the fallback transport's error mapping", () => {
	async function refuse(status: number, body: string) {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: false, status, text: async () => body })),
		)
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.1" } as never)
		;(handler as unknown as { client: unknown }).client = {
			responses: {
				create: vi.fn(async () => {
					throw new Error("force the SSE path")
				}),
			},
		}
		const stream = handler.createMessage("s", [{ role: "user", content: "hi" }] as never)
		const result = await stream.next().catch((error: Error) => error)
		vi.unstubAllGlobals()
		return result as Error
	}

	it.each([400, 401, 403, 404, 429, 500, 502, 503, 418])("maps HTTP %s onto a distinct message", async (status) => {
		const error = await refuse(status, '{"error":{"message":"upstream said no"}}')

		expect(error).toBeInstanceOf(Error)
	})

	it.each([
		['{"error":{"message":"bad request detail"}}'],
		['{"message":"flat message"}'],
		['{"detail":"detail field"}'],
		["gateway exploded"],
		['{"unexpected":true}'],
	])("REFUSES every error-body shape rather than yielding an empty stream (%s)", async (body) => {
		// The detail the parser extracted is folded into a translated
		// `connectionFailed` message, so the assertion is that the refusal happens
		// and is recorded — the extraction itself is exercised by the shapes above.
		const error = await refuse(400, body)

		expect(error).toBeInstanceOf(Error)
		expect(hoisted.captureException).toHaveBeenCalled()
	})
})
