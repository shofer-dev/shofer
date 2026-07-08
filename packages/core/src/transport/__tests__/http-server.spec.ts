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
			respondToAsk: vi.fn(async () => {}),
			applyConfig: vi.fn(async () => {}),
			getCheckpointDiff: vi.fn(async () => [
				{ paths: { relative: "a.ts", absolute: "/w/a.ts" }, content: { before: "x", after: "y" } },
			]),
			getTaskChangedFiles: vi.fn(async () => ({ taskId: "t1", entries: [], backend: "none" as const })),
			getChangedFileDiff: vi.fn(async () => ({ original: "base", final: "final" })),
			restoreCheckpoint: vi.fn(async () => {}),
			revertChangedFile: vi.fn(async () => {}),
			revertAllChangedFiles: vi.fn(async () => {}),
			acceptChangedFile: vi.fn(async () => {}),
			acceptAllChangedFiles: vi.fn(async () => {}),
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
		await run(mockReq("POST", "/api/v1/task", { prompt: "hello" }), res as unknown as ServerResponse)
		expect(res.statusCode).toBe(201)
		expect(JSON.parse(res.body)).toEqual({ taskId: "task-for-hello" })
		expect(api.createTask).toHaveBeenCalledWith({ prompt: "hello", taskId: undefined, apiConfiguration: undefined })
	})

	it("POST /api/v1/task forwards the per-task apiConfiguration to createTask", async () => {
		const res = mockRes()
		const apiConfiguration = { apiProvider: "openai", apiModelId: "gpt-4o" }
		await run(
			mockReq("POST", "/api/v1/task", { prompt: "hello", apiConfiguration }),
			res as unknown as ServerResponse,
		)
		expect(res.statusCode).toBe(201)
		expect(api.createTask).toHaveBeenCalledWith({ prompt: "hello", taskId: undefined, apiConfiguration })
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

	it("L3: checkpoint-diff returns 200 with the computed changes", async () => {
		const res = mockRes()
		await run(
			mockReq("POST", "/api/v1/task/t1/checkpoint-diff", { commitHash: "c1", mode: "checkpoint" }),
			res as unknown as ServerResponse,
		)
		expect(res.statusCode).toBe(200)
		expect(JSON.parse(res.body)).toEqual([
			{ paths: { relative: "a.ts", absolute: "/w/a.ts" }, content: { before: "x", after: "y" } },
		])
		expect(api.getCheckpointDiff).toHaveBeenCalledWith("t1", { commitHash: "c1", mode: "checkpoint" })
	})

	it("L3: checkpoint-diff 400s without a commitHash", async () => {
		const res = mockRes()
		await run(
			mockReq("POST", "/api/v1/task/t1/checkpoint-diff", { mode: "checkpoint" }),
			res as unknown as ServerResponse,
		)
		expect(res.statusCode).toBe(400)
		expect(api.getCheckpointDiff).not.toHaveBeenCalled()
	})

	it("L3: checkpoint-restore returns 202", async () => {
		const res = mockRes()
		await run(
			mockReq("POST", "/api/v1/task/t1/checkpoint-restore", { ts: 1, commitHash: "c1", mode: "restore" }),
			res as unknown as ServerResponse,
		)
		expect(res.statusCode).toBe(202)
		expect(api.restoreCheckpoint).toHaveBeenCalledWith("t1", { ts: 1, commitHash: "c1", mode: "restore" })
	})

	it("L3: GET changed-files returns 200 with the payload", async () => {
		const res = mockRes()
		await run(mockReq("GET", "/api/v1/task/t1/changed-files"), res as unknown as ServerResponse)
		expect(res.statusCode).toBe(200)
		expect(JSON.parse(res.body)).toEqual({ taskId: "t1", entries: [], backend: "none" })
		expect(api.getTaskChangedFiles).toHaveBeenCalledWith("t1")
	})

	it("L3: changed-files/diff returns 200 { original, final }", async () => {
		const res = mockRes()
		await run(
			mockReq("POST", "/api/v1/task/t1/changed-files/diff", { relPath: "a.ts" }),
			res as unknown as ServerResponse,
		)
		expect(res.statusCode).toBe(200)
		expect(JSON.parse(res.body)).toEqual({ original: "base", final: "final" })
		expect(api.getChangedFileDiff).toHaveBeenCalledWith("t1", "a.ts")
	})

	it("L3: revert/accept route to per-file vs all by relPath presence, 202", async () => {
		const r1 = mockRes()
		await run(
			mockReq("POST", "/api/v1/task/t1/changed-files/revert", { relPath: "a.ts" }),
			r1 as unknown as ServerResponse,
		)
		expect(r1.statusCode).toBe(202)
		expect(api.revertChangedFile).toHaveBeenCalledWith("t1", "a.ts")

		const r2 = mockRes()
		await run(mockReq("POST", "/api/v1/task/t1/changed-files/revert", {}), r2 as unknown as ServerResponse)
		expect(api.revertAllChangedFiles).toHaveBeenCalledWith("t1")

		const a1 = mockRes()
		await run(
			mockReq("POST", "/api/v1/task/t1/changed-files/accept", { relPath: "a.ts" }),
			a1 as unknown as ServerResponse,
		)
		expect(api.acceptChangedFile).toHaveBeenCalledWith("t1", "a.ts")

		const a2 = mockRes()
		await run(mockReq("POST", "/api/v1/task/t1/changed-files/accept", {}), a2 as unknown as ServerResponse)
		expect(api.acceptAllChangedFiles).toHaveBeenCalledWith("t1")
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

	describe("config sync (config_sync §4a/§6)", () => {
		it("POST /api/v1/config applies the config with its version and returns 202", async () => {
			const res = mockRes()
			const config = { autoApprovalEnabled: true }
			await run(mockReq("POST", "/api/v1/config", { config, version: "v1" }), res as unknown as ServerResponse)
			expect(res.statusCode).toBe(202)
			expect(JSON.parse(res.body)).toEqual({ applied: true })
			expect(api.applyConfig).toHaveBeenCalledWith(config, "v1")
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
			const req = mockReq("POST", "/api/v1/task", { prompt: "hi" })
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
