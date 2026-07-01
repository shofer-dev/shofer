import { describe, it, expect, vi } from "vitest"

import type { ServerEvent } from "@shofer/types"

import { ShoferHttpClient } from "../http-client.js"

const flush = () => new Promise((resolve) => setTimeout(resolve))

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
		expect(await client.createTask({ prompt: "hi" })).toEqual({ taskId: "t1" })
		expect(fetchMock).toHaveBeenCalledWith(
			"http://host:1/api/v1/task",
			expect.objectContaining({ method: "POST", body: JSON.stringify({ prompt: "hi" }) }),
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

	it("throws on a non-2xx response", async () => {
		const fetchMock = vi.fn(async () => new Response("nope", { status: 500 }))
		const client = new ShoferHttpClient({ baseUrl: "http://host:1", fetch: fetchMock as unknown as typeof fetch })
		await expect(client.createTask({ prompt: "x" })).rejects.toThrow(/500/)
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
