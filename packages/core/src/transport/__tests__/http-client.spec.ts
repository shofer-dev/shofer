import { describe, it, expect, vi } from "vitest"
import type { IncomingMessage, ServerResponse } from "node:http"

import type { ShoferApi, ServerEvent, ShoferMessage } from "@shofer/types"

import { ShoferHttpClient } from "../http-client.js"
import { createRequestHandler, type HttpServerOptions } from "../http-server.js"

const flush = () => new Promise((resolve) => setTimeout(resolve))

/**
 * A `fetch` that drives the real request handler instead of a socket (the test
 * sandbox blocks loopback). This is what makes the round-trip tests below a genuine
 * client↔server contract check rather than two mirrors of the same assumption.
 * Streaming routes (SSE) are out of scope here — they never call `end()`.
 */
function handlerFetch(api: ShoferApi, opts: HttpServerOptions = {}): typeof fetch {
	const handler = createRequestHandler(api, opts)
	return (async (url: string, init?: RequestInit) => {
		const target = new URL(url)
		const body = init?.body as string | undefined
		const req = {
			method: init?.method ?? "GET",
			url: `${target.pathname}${target.search}`,
			headers: (init?.headers ?? {}) as Record<string, string>,
			on: () => req,
			async *[Symbol.asyncIterator]() {
				if (body) yield Buffer.from(body)
			},
		}
		return await new Promise<Response>((resolve) => {
			let status = 200
			const res = {
				writeHead(code: number) {
					status = code
					return res
				},
				flushHeaders() {},
				write() {
					return true
				},
				end(payload?: string) {
					resolve(
						new Response(payload ?? "", {
							status,
							headers: { "content-type": "application/json" },
						}),
					)
				},
			}
			handler(req as unknown as IncomingMessage, res as unknown as ServerResponse)
		})
	}) as unknown as typeof fetch
}

function sseResponse(frames: string[]): Response {
	const encoder = new TextEncoder()
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const f of frames) controller.enqueue(encoder.encode(f))
			controller.close()
		},
	})
	return new Response(body, { headers: { "content-type": "text/event-stream" } })
}

describe("ShoferHttpClient (typed SDK)", () => {
	it("createTask POSTs to /api/v1/task and returns the taskId", async () => {
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({ taskId: "t1" }), { status: 200 }))
		const client = new ShoferHttpClient({ baseUrl: "http://host:1", fetch: fetchMock as unknown as typeof fetch })
		expect(await client.createTask({ prompt: "hi", mode: "code" })).toEqual({ taskId: "t1" })
		expect(fetchMock).toHaveBeenCalledWith(
			"http://host:1/api/v1/task",
			expect.objectContaining({ method: "POST", body: JSON.stringify({ prompt: "hi", mode: "code" }) }),
		)
	})

	it("createTask includes the per-task apiConfiguration in the POST body", async () => {
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({ taskId: "t1" }), { status: 200 }))
		const client = new ShoferHttpClient({ baseUrl: "http://host:1", fetch: fetchMock as unknown as typeof fetch })
		const apiConfiguration = { apiProvider: "openai", apiModelId: "gpt-4o" } as never
		await client.createTask({ prompt: "hi", mode: "code", apiConfiguration })
		expect(fetchMock).toHaveBeenCalledWith(
			"http://host:1/api/v1/task",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ prompt: "hi", mode: "code", apiConfiguration }),
			}),
		)
	})

	it("sendMessage + cancelTask POST to the task subroutes", async () => {
		const fetchMock = vi.fn(async () => new Response("", { status: 202 }))
		const client = new ShoferHttpClient({ baseUrl: "http://host:1", fetch: fetchMock as unknown as typeof fetch })
		await client.sendMessage("t 1", "go")
		await client.cancelTask("t 1")
		expect(fetchMock).toHaveBeenNthCalledWith(1, "http://host:1/api/v1/task/t%201/message", expect.anything())
		expect(fetchMock).toHaveBeenNthCalledWith(2, "http://host:1/api/v1/task/t%201/cancel", expect.anything())
	})

	it("respondToAsk POSTs the response to the task /ask subroute", async () => {
		const fetchMock = vi.fn(async () => new Response("", { status: 202 }))
		const client = new ShoferHttpClient({ baseUrl: "http://host:1", fetch: fetchMock as unknown as typeof fetch })
		await client.respondToAsk("t 1", { askResponse: "yesButtonClicked", askId: "a1" })
		expect(fetchMock).toHaveBeenCalledWith(
			"http://host:1/api/v1/task/t%201/ask",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ askResponse: "yesButtonClicked", askId: "a1" }),
			}),
		)
	})

	it("pluginRequest POSTs { plugin, method, params } and unwraps the result", async () => {
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({ result: { changes: [] } }), { status: 200 }))
		const client = new ShoferHttpClient({ baseUrl: "http://host:1", fetch: fetchMock as unknown as typeof fetch })
		expect(await client.pluginRequest("t1", "checkpoints", "diff", { hash: "c1" })).toEqual({ changes: [] })
		expect(fetchMock).toHaveBeenCalledWith(
			"http://host:1/api/v1/task/t1/plugin-request",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ plugin: "checkpoints", method: "diff", params: { hash: "c1" } }),
			}),
		)
	})

	it("throws on a non-2xx response", async () => {
		const fetchMock = vi.fn(async () => new Response("nope", { status: 500 }))
		const client = new ShoferHttpClient({ baseUrl: "http://host:1", fetch: fetchMock as unknown as typeof fetch })
		await expect(client.createTask({ prompt: "x", mode: "code" })).rejects.toThrow(/500/)
	})

	it("getTaskSnapshot GETs the snapshot subroute and returns undefined on 404", async () => {
		const snapshot = { taskId: "t 1", messages: [] }
		const fetchMock = vi.fn(async (url: string) =>
			url.includes("missing")
				? new Response(JSON.stringify({ error: "no task" }), { status: 404 })
				: new Response(JSON.stringify(snapshot), { status: 200 }),
		)
		const client = new ShoferHttpClient({ baseUrl: "http://host:1", fetch: fetchMock as unknown as typeof fetch })
		expect(await client.getTaskSnapshot("t 1")).toEqual(snapshot)
		expect(fetchMock).toHaveBeenCalledWith(
			"http://host:1/api/v1/task/t%201/snapshot",
			expect.objectContaining({ method: "GET" }),
		)
		expect(await client.getTaskSnapshot("missing")).toBeUndefined()
	})

	it("getTaskSnapshot rejects a body that is not a snapshot", async () => {
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({ nope: true }), { status: 200 }))
		const client = new ShoferHttpClient({ baseUrl: "http://host:1", fetch: fetchMock as unknown as typeof fetch })
		await expect(client.getTaskSnapshot("t1")).rejects.toThrow(/unreadable task snapshot/)
	})

	it("subscribeTask streams the per-task SSE route, not the worker-wide firehose", async () => {
		const fetchMock = vi.fn(async () => sseResponse([`data: ${JSON.stringify({ type: "Message" })}\n\n`]))
		const client = new ShoferHttpClient({ baseUrl: "http://host:1", fetch: fetchMock as unknown as typeof fetch })
		const seen: ServerEvent[] = []
		const unsub = client.subscribeTask("t 1", (e) => seen.push(e))
		await flush()
		expect(fetchMock).toHaveBeenCalledWith("http://host:1/api/v1/task/t%201/event", expect.anything())
		expect(seen).toEqual([{ type: "Message" }])
		unsub()
	})

	describe("round-trip against the real request handler", () => {
		const messages: ShoferMessage[] = [
			{ ts: 1, type: "say", say: "text", text: "hello" },
			{ ts: 2, type: "ask", ask: "tool", askId: "a1", text: "{}" },
		]
		const makeApi = () =>
			({
				createTask: vi.fn(async () => ({ taskId: "t1" })),
				sendMessage: vi.fn(async () => {}),
				cancelTask: vi.fn(async () => {}),
				respondToAsk: vi.fn(async () => {}),
				getTaskSnapshot: vi.fn(async (taskId: string) =>
					taskId === "t1"
						? {
								taskId,
								summary: "do the thing",
								state: { lifecycle: "running" as const },
								messages,
								outstandingAsk: { ask: "tool" as const, askId: "a1", text: "{}", ts: 2 },
							}
						: undefined,
				),
				pluginRequest: vi.fn(async () => null),
				subscribe: vi.fn(() => () => {}),
			}) satisfies ShoferApi

		it("backfills the transcript and the ask raised before the client existed", async () => {
			const api = makeApi()
			const client = new ShoferHttpClient({ baseUrl: "http://host:1", fetch: handlerFetch(api) })

			const snapshot = await client.getTaskSnapshot("t1")
			expect(snapshot?.messages).toEqual(messages)
			expect(snapshot?.outstandingAsk).toEqual({ ask: "tool", askId: "a1", text: "{}", ts: 2 })
			expect(snapshot?.summary).toBe("do the thing")
		})

		it("answers that ask and sends a follow-up over the same client", async () => {
			const api = makeApi()
			const client = new ShoferHttpClient({ baseUrl: "http://host:1", fetch: handlerFetch(api) })

			await client.respondToAsk("t1", { askResponse: "yesButtonClicked", askId: "a1" })
			await client.sendMessage("t1", "carry on")
			expect(api.respondToAsk).toHaveBeenCalledWith("t1", expect.objectContaining({ askId: "a1" }))
			expect(api.sendMessage).toHaveBeenCalledWith("t1", "carry on", undefined)
		})

		it("reports an unknown task as undefined and a wrong token as an error", async () => {
			const api = makeApi()
			const open = new ShoferHttpClient({ baseUrl: "http://host:1", fetch: handlerFetch(api) })
			expect(await open.getTaskSnapshot("nope")).toBeUndefined()

			const guarded = new ShoferHttpClient({
				baseUrl: "http://host:1",
				token: "wrong",
				fetch: handlerFetch(api, { token: "s3cret" }),
			})
			await expect(guarded.getTaskSnapshot("t1")).rejects.toThrow(/401/)
		})
	})

	it("subscribe parses SSE frames into events", async () => {
		const fetchMock = vi.fn(async () =>
			sseResponse([
				`data: ${JSON.stringify({ type: "Message", text: "a" })}\n\n`,
				`data: ${JSON.stringify({ type: "TaskCompleted" })}\n\n`,
			]),
		)
		const client = new ShoferHttpClient({ baseUrl: "http://host:1", fetch: fetchMock as unknown as typeof fetch })
		const seen: ServerEvent[] = []
		const unsub = client.subscribe((e) => seen.push(e))
		await flush()
		expect(seen).toEqual([{ type: "Message", text: "a" }, { type: "TaskCompleted" }])
		unsub()
	})
})
