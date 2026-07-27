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
		flushHeaders() {},
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
			respondToAsk: vi.fn(async () => {}),
			applyConfig: vi.fn(async () => {}),
			pluginRequest: vi.fn(async () => ({ changes: [] })),
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
		expect(JSON.parse(res.body)).toMatchObject({ ok: true })
	})

	it("GET /health reports the injected version", async () => {
		const versioned = createRequestHandler(api, { version: "9.9.9" })
		const res = mockRes()
		versioned(mockReq("GET", "/health"), res as unknown as ServerResponse)
		await flush()
		expect(JSON.parse(res.body)).toMatchObject({ ok: true, version: "9.9.9" })
	})

	it("GET /health exposes load metrics (loadavg triple + cpu count) for the LB channel", async () => {
		const res = mockRes()
		await run(mockReq("GET", "/health"), res as unknown as ServerResponse)
		const body = JSON.parse(res.body) as { loadavg: unknown; cpus: unknown }
		expect(Array.isArray(body.loadavg)).toBe(true)
		expect(body.loadavg).toHaveLength(3)
		expect((body.loadavg as number[]).every((n) => typeof n === "number")).toBe(true)
		expect(typeof body.cpus).toBe("number")
		expect(body.cpus as number).toBeGreaterThanOrEqual(1)
	})

	it("POST /api/v1/task creates a task", async () => {
		const res = mockRes()
		await run(mockReq("POST", "/api/v1/task", { prompt: "hello", mode: "code" }), res as unknown as ServerResponse)
		expect(res.statusCode).toBe(201)
		expect(JSON.parse(res.body)).toEqual({ taskId: "task-for-hello" })
		expect(api.createTask).toHaveBeenCalledWith({
			prompt: "hello",
			mode: "code",
			taskId: undefined,
			apiConfiguration: undefined,
		})
	})

	it("POST /api/v1/task forwards the per-task apiConfiguration to createTask", async () => {
		const res = mockRes()
		const apiConfiguration = { apiProvider: "openai", apiModelId: "gpt-4o" }
		await run(
			mockReq("POST", "/api/v1/task", { prompt: "hello", mode: "code", apiConfiguration }),
			res as unknown as ServerResponse,
		)
		expect(res.statusCode).toBe(201)
		expect(api.createTask).toHaveBeenCalledWith({
			prompt: "hello",
			mode: "code",
			taskId: undefined,
			apiConfiguration,
		})
	})

	it("400s on missing prompt", async () => {
		const res = mockRes()
		await run(mockReq("POST", "/api/v1/task", { mode: "code" }), res as unknown as ServerResponse)
		expect(res.statusCode).toBe(400)
	})

	it("400s on missing mode", async () => {
		const res = mockRes()
		await run(mockReq("POST", "/api/v1/task", { prompt: "hello" }), res as unknown as ServerResponse)
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

	it("routes an ask response to the agent", async () => {
		const res = mockRes()
		await run(
			mockReq("POST", "/api/v1/task/t1/ask", { askResponse: "yesButtonClicked", text: "go", askId: "a1" }),
			res as unknown as ServerResponse,
		)
		expect(res.statusCode).toBe(202)
		expect(JSON.parse(res.body)).toEqual({ taskId: "t1", answered: true })
		expect(api.respondToAsk).toHaveBeenCalledWith("t1", {
			askResponse: "yesButtonClicked",
			text: "go",
			images: undefined,
			askId: "a1",
		})
	})

	it("400s an ask response with no askResponse", async () => {
		const res = mockRes()
		await run(mockReq("POST", "/api/v1/task/t1/ask", {}), res as unknown as ServerResponse)
		expect(res.statusCode).toBe(400)
		expect(api.respondToAsk).not.toHaveBeenCalled()
	})

	it("L3: plugin-request routes to the named plugin and wraps its result", async () => {
		const res = mockRes()
		await run(
			mockReq("POST", "/api/v1/task/t1/plugin-request", {
				plugin: "checkpoints",
				method: "diff",
				params: { hash: "c1" },
			}),
			res as unknown as ServerResponse,
		)
		expect(res.statusCode).toBe(200)
		// Wrapped so a plugin returning a bare value still travels as a JSON object.
		expect(JSON.parse(res.body)).toEqual({ result: { changes: [] } })
		expect(api.pluginRequest).toHaveBeenCalledWith("t1", "checkpoints", "diff", { hash: "c1" })
	})

	it("L3: plugin-request 400s without plugin/method", async () => {
		const res = mockRes()
		await run(mockReq("POST", "/api/v1/task/t1/plugin-request", { params: {} }), res as unknown as ServerResponse)
		expect(res.statusCode).toBe(400)
		expect(api.pluginRequest).not.toHaveBeenCalled()
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

	it("GET /api/v1/task/:id/event streams ONLY that task's events", async () => {
		const res = mockRes()
		const req = mockReq("GET", "/api/v1/task/t9/event")
		await run(req, res as unknown as ServerResponse)
		expect(res.headers["content-type"]).toContain("text/event-stream")
		expect(events).toHaveLength(1)

		// Lifecycle events carry the task id at args[0]; message events at args[0].taskId.
		events.forEach((l) => l({ type: "taskStarted", args: ["t9"] } as unknown as ServerEvent))
		events.forEach((l) => l({ type: "taskStarted", args: ["other"] } as unknown as ServerEvent))
		events.forEach((l) => l({ type: "message", args: [{ taskId: "t9", message: {} }] } as unknown as ServerEvent))
		events.forEach((l) =>
			l({ type: "message", args: [{ taskId: "other", message: {} }] } as unknown as ServerEvent),
		)

		const out = res.chunks.join("")
		expect(out).toContain('"type":"taskStarted","args":["t9"]')
		expect(out).toContain('"taskId":"t9"')
		// The other task's events are filtered out.
		expect(out).not.toContain('"other"')

		req.fireClose()
		expect(events).toHaveLength(0)
	})

	describe("config sync (config_sync §4a/§6)", () => {
		it("POST /api/v1/config applies the config, secrets and version and returns 202", async () => {
			const res = mockRes()
			const config = { autoApprovalEnabled: true }
			const secrets = { codeIndexOpenAiKey: "sk-test" }
			await run(
				mockReq("POST", "/api/v1/config", { config, version: "v1", secrets }),
				res as unknown as ServerResponse,
			)
			expect(res.statusCode).toBe(202)
			expect(JSON.parse(res.body)).toEqual({ applied: true })
			expect(api.applyConfig).toHaveBeenCalledWith(config, "v1", secrets, undefined)
		})

		it("defaults the secret slice to empty when the push carries none", async () => {
			const res = mockRes()
			const config = { autoApprovalEnabled: true }
			await run(mockReq("POST", "/api/v1/config", { config, version: "v1" }), res as unknown as ServerResponse)
			expect(res.statusCode).toBe(202)
			expect(api.applyConfig).toHaveBeenCalledWith(config, "v1", {}, undefined)
		})

		it("passes the plugin slice through to the node when the push carries one", async () => {
			const res = mockRes()
			const config = { autoApprovalEnabled: true }
			// The plugin half of the slice (config_sync §4b-2) — opaque to the transport.
			const plugins = { "rag-indexing": { config: { searchOnly: true }, secrets: { apiKey: "k" } } }
			await run(
				mockReq("POST", "/api/v1/config", { config, version: "v1", plugins }),
				res as unknown as ServerResponse,
			)
			expect(res.statusCode).toBe(202)
			expect(api.applyConfig).toHaveBeenCalledWith(config, "v1", {}, plugins)
		})

		it("400s a config push with no version", async () => {
			const res = mockRes()
			await run(
				mockReq("POST", "/api/v1/config", { config: { autoApprovalEnabled: true } }),
				res as unknown as ServerResponse,
			)
			expect(res.statusCode).toBe(400)
			expect(api.applyConfig).not.toHaveBeenCalled()
		})

		it("401s the config push without a token when auth is enabled", async () => {
			const authed = createRequestHandler(api, { token: "s3cret" })
			const res = mockRes()
			authed(mockReq("POST", "/api/v1/config", { config: {}, version: "v1" }), res as unknown as ServerResponse)
			await flush()
			expect(res.statusCode).toBe(401)
			expect(api.applyConfig).not.toHaveBeenCalled()
		})

		it("GET /health includes configVersion + managed when the opts provide them", async () => {
			const h = createRequestHandler(api, { getConfigVersion: () => "v1", getManaged: () => false })
			const res = mockRes()
			h(mockReq("GET", "/health"), res as unknown as ServerResponse)
			await flush()
			expect(JSON.parse(res.body)).toMatchObject({ ok: true, configVersion: "v1", managed: false })
		})

		it("GET /health does not crash when the config opts are absent", async () => {
			const res = mockRes()
			await run(mockReq("GET", "/health"), res as unknown as ServerResponse)
			expect(res.statusCode).toBe(200)
			const body = JSON.parse(res.body) as Record<string, unknown>
			expect(body.ok).toBe(true)
			expect(body.configVersion).toBeUndefined()
			expect(body.managed).toBeUndefined()
		})

		it("GET /api/v1/whoami includes configVersion + managed", async () => {
			const h = createRequestHandler(api, {
				version: "1.2.3",
				getConfigVersion: () => "v2",
				getManaged: () => true,
			})
			const res = mockRes()
			h(mockReq("GET", "/api/v1/whoami"), res as unknown as ServerResponse)
			await flush()
			expect(JSON.parse(res.body)).toEqual({ version: "1.2.3", configVersion: "v2", managed: true })
		})
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
			const req = mockReq("POST", "/api/v1/task", { prompt: "hi", mode: "code" })
			;(req.headers as Record<string, string>) = { authorization: "Bearer s3cret" }
			const res = await call(authed(), req)
			expect(res.statusCode).toBe(201)
			expect(api.createTask).toHaveBeenCalled()
		})

		it("leaves /health open even when a token is set", async () => {
			const res = await call(authed(), mockReq("GET", "/health"))
			expect(res.statusCode).toBe(200)
			expect(JSON.parse(res.body)).toMatchObject({ ok: true, version: "1.2.3" })
		})
	})
})
