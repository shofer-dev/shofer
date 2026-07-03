import { describe, it, expect, beforeEach, vi } from "vitest"
import type { IncomingMessage, ServerResponse } from "node:http"

import { createRequestHandler, type AgentApi, type ServerEvent } from "../http-server.js"

/**
 * §11 HTTP/SSE transport. Drives the request handler with mock req/res (no
 * socket — the test sandbox blocks loopback) to verify routing, task control,
 * validation, and SSE framing.
 */

function mockReq(method: string, url: string, body?: unknown): IncomingMessage & { fireClose: () => void } {
	const closeHandlers: Array<() => void> = []
	const raw = body === undefined ? "" : JSON.stringify(body)
	const req = {
		method,
		url,
		headers: {} as Record<string, string>,
		on(event: string, cb: () => void) {
			if (event === "close") closeHandlers.push(cb)
			return req
		},
		async *[Symbol.asyncIterator]() {
			if (raw) yield Buffer.from(raw)
		},
		fireClose: () => closeHandlers.forEach((cb) => cb()),
	}
	return req as unknown as IncomingMessage & { fireClose: () => void }
}

function mockRes() {
	const res = {
		statusCode: 0,
		headers: {} as Record<string, string>,
		chunks: [] as string[],
		body: "",
		writeHead(status: number, headers?: Record<string, string>) {
			res.statusCode = status
			if (headers) res.headers = headers
			return res
		},
		write(chunk: string) {
			res.chunks.push(chunk)
			return true
		},
		end(body?: string) {
			if (body) res.body = body
		},
	}
	return res
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe("createRequestHandler (§11)", () => {
	let events: Array<(e: ServerEvent) => void>
	let handler: ReturnType<typeof createRequestHandler>
	let api: AgentApi

	beforeEach(() => {
		events = []
		api = {
			createTask: vi.fn(async ({ prompt }) => ({ taskId: `task-for-${prompt}` })),
			sendMessage: vi.fn(async () => {}),
			cancelTask: vi.fn(async () => {}),
			subscribe: vi.fn((l: (e: ServerEvent) => void) => {
				events.push(l)
				return () => {
					events = events.filter((x) => x !== l)
				}
			}),
		}
		handler = createRequestHandler(api)
	})

	const run = async (req: IncomingMessage, res: ServerResponse) => {
		handler(req, res)
		await flush()
	}

	it("GET /health returns ok + version", async () => {
		const res = mockRes()
		await run(mockReq("GET", "/health"), res as unknown as ServerResponse)
		expect(res.statusCode).toBe(200)
		expect(JSON.parse(res.body)).toEqual({ ok: true })
	})

	it("GET /health reports the injected version", async () => {
		const versioned = createRequestHandler(api, { version: "9.9.9" })
		const res = mockRes()
		versioned(mockReq("GET", "/health"), res as unknown as ServerResponse)
		await flush()
		expect(JSON.parse(res.body)).toEqual({ ok: true, version: "9.9.9" })
	})

	it("POST /api/v1/task creates a task", async () => {
		const res = mockRes()
		await run(mockReq("POST", "/api/v1/task", { prompt: "hello" }), res as unknown as ServerResponse)
		expect(res.statusCode).toBe(201)
		expect(JSON.parse(res.body)).toEqual({ taskId: "task-for-hello" })
		expect(api.createTask).toHaveBeenCalledWith({ prompt: "hello", taskId: undefined })
	})

	it("400s on missing prompt", async () => {
		const res = mockRes()
		await run(mockReq("POST", "/api/v1/task", {}), res as unknown as ServerResponse)
		expect(res.statusCode).toBe(400)
	})

	it("routes message and cancel to the agent", async () => {
		const m = mockRes()
		await run(mockReq("POST", "/api/v1/task/t1/message", { message: "go" }), m as unknown as ServerResponse)
		expect(m.statusCode).toBe(202)
		expect(api.sendMessage).toHaveBeenCalledWith("t1", "go")

		const c = mockRes()
		await run(mockReq("POST", "/api/v1/task/t1/cancel"), c as unknown as ServerResponse)
		expect(c.statusCode).toBe(202)
		expect(api.cancelTask).toHaveBeenCalledWith("t1")
	})

	it("streams events over SSE and unsubscribes on close", async () => {
		const res = mockRes()
		const req = mockReq("GET", "/api/v1/event")
		await run(req, res as unknown as ServerResponse)
		expect(res.headers["content-type"]).toContain("text/event-stream")
		expect(events).toHaveLength(1)

		events.forEach((l) => l({ type: "task.created", taskId: "t9" }))
		expect(res.chunks.join("")).toBe('data: {"type":"task.created","taskId":"t9"}\n\n')

		req.fireClose()
		expect(events).toHaveLength(0)
	})

	it("404s unknown routes", async () => {
		const res = mockRes()
		await run(mockReq("GET", "/nope"), res as unknown as ServerResponse)
		expect(res.statusCode).toBe(404)
	})

	describe("auth + version handshake (Shofer Nodes L1)", () => {
		const authed = () => createRequestHandler(api, { token: "s3cret", version: "1.2.3" })
		const call = async (h: ReturnType<typeof createRequestHandler>, req: IncomingMessage) => {
			const res = mockRes()
			h(req, res as unknown as ServerResponse)
			await flush()
			return res
		}

		it("GET /api/v1/whoami returns the version when the token matches", async () => {
			const req = mockReq("GET", "/api/v1/whoami")
			;(req.headers as Record<string, string>) = { authorization: "Bearer s3cret" }
			const res = await call(authed(), req)
			expect(res.statusCode).toBe(200)
			expect(JSON.parse(res.body)).toEqual({ version: "1.2.3" })
		})

		it("401s /whoami with a missing token", async () => {
			const res = await call(authed(), mockReq("GET", "/api/v1/whoami"))
			expect(res.statusCode).toBe(401)
		})

		it("401s /whoami with a wrong token", async () => {
			const req = mockReq("GET", "/api/v1/whoami")
			;(req.headers as Record<string, string>) = { authorization: "Bearer nope" }
			const res = await call(authed(), req)
			expect(res.statusCode).toBe(401)
		})

		it("401s the task API without a token when auth is enabled", async () => {
			const res = await call(authed(), mockReq("POST", "/api/v1/task", { prompt: "hi" }))
			expect(res.statusCode).toBe(401)
			expect(api.createTask).not.toHaveBeenCalled()
		})

		it("allows the task API with the correct token", async () => {
			const req = mockReq("POST", "/api/v1/task", { prompt: "hi" })
			;(req.headers as Record<string, string>) = { authorization: "Bearer s3cret" }
			const res = await call(authed(), req)
			expect(res.statusCode).toBe(201)
			expect(api.createTask).toHaveBeenCalled()
		})

		it("leaves /health open even when a token is set", async () => {
			const res = await call(authed(), mockReq("GET", "/health"))
			expect(res.statusCode).toBe(200)
			expect(JSON.parse(res.body)).toEqual({ ok: true, version: "1.2.3" })
		})
	})
})
