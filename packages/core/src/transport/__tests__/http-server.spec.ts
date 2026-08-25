import { describe, it, expect, beforeEach, vi } from "vitest"
import type { IncomingMessage, ServerResponse } from "node:http"

import {
	createRequestHandler,
	createStreamSubscribers,
	SUBSCRIBER_REATTACH_GRACE_MS,
	type ShoferApi,
	type ServerEvent,
} from "../http-server.js"

/**
 * §11 HTTP/SSE transport. Drives the request handler with mock req/res (no
 * socket — the test sandbox blocks loopback) to verify routing, task control,
 * validation, and SSE framing.
 */

function mockReq(
	method: string,
	url: string,
	body?: unknown,
	headers: Record<string, string> = {},
): IncomingMessage & { fireClose: () => void } {
	const closeHandlers: Array<() => void> = []
	const raw = body === undefined ? "" : JSON.stringify(body)
	const req = {
		method,
		url,
		headers,
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
	let api: ShoferApi
	/**
	 * The census's monotonic clock, injected so the re-attach grace is stepped
	 * explicitly rather than waited out. Global fake timers are the wrong tool
	 * here: this file's `flush()` yields through a real `setTimeout(0)` to let the
	 * request handler's async body run, and faking timers would deadlock it.
	 */
	let clock: number

	beforeEach(() => {
		clock = 1_000
		events = []
		api = {
			createTask: vi.fn(async ({ prompt }) => ({ taskId: `task-for-${prompt}` })),
			sendMessage: vi.fn(async () => {}),
			cancelTask: vi.fn(async () => {}),
			respondToAsk: vi.fn(async () => {}),
			getTaskSnapshot: vi.fn(async (taskId: string) =>
				taskId === "missing" ? undefined : { taskId, messages: [] },
			),
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

	it("POST /api/v1/task carries the W3C trace context stated in the body", async () => {
		const res = mockRes()
		const trace = { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01", tracestate: "a=1" }
		await run(
			mockReq("POST", "/api/v1/task", { prompt: "hello", mode: "code", trace }),
			res as unknown as ServerResponse,
		)
		expect(api.createTask).toHaveBeenCalledWith(expect.objectContaining({ trace }))
	})

	it("POST /api/v1/task falls back to the standard traceparent/tracestate HEADERS", async () => {
		// What a generically instrumented HTTP client sends: it knows the W3C
		// headers and nothing about this transport's body shape.
		const res = mockRes()
		await run(
			mockReq(
				"POST",
				"/api/v1/task",
				{ prompt: "hello", mode: "code" },
				{
					traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
					tracestate: "vendor=xyz",
				},
			),
			res as unknown as ServerResponse,
		)
		expect(api.createTask).toHaveBeenCalledWith(
			expect.objectContaining({
				trace: {
					traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
					tracestate: "vendor=xyz",
				},
			}),
		)
	})

	it("POST /api/v1/task drops a malformed trace rather than refusing the task", async () => {
		// Propagation is best-effort: the lens must never be able to break the
		// thing it observes.
		const res = mockRes()
		await run(
			mockReq("POST", "/api/v1/task", { prompt: "hello", mode: "code", trace: { nonsense: true } }),
			res as unknown as ServerResponse,
		)
		expect(res.statusCode).toBe(201)
		expect(api.createTask).toHaveBeenCalledWith(expect.objectContaining({ trace: undefined }))
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
		expect(api.sendMessage).toHaveBeenCalledWith("t1", "go", undefined, undefined)

		const c = mockRes()
		await run(mockReq("POST", "/api/v1/task/t1/cancel"), c as unknown as ServerResponse)
		expect(c.statusCode).toBe(202)
		expect(api.cancelTask).toHaveBeenCalledWith("t1")
	})

	it("POST /api/v1/task/:id/message carries the trace context, body or headers", async () => {
		// A conversation is created once and messaged for the rest of its life, so
		// honouring the trace on `createTask` alone attributes exactly the first
		// turn of every multi-turn run and loses the rest — silently.
		const trace = { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01", tracestate: "a=1" }

		const body = mockRes()
		await run(
			mockReq("POST", "/api/v1/task/t1/message", { message: "go", trace }),
			body as unknown as ServerResponse,
		)
		expect(api.sendMessage).toHaveBeenCalledWith("t1", "go", undefined, trace)

		const headers = mockRes()
		await run(
			mockReq("POST", "/api/v1/task/t1/message", { message: "again" }, { traceparent: trace.traceparent }),
			headers as unknown as ServerResponse,
		)
		expect(api.sendMessage).toHaveBeenCalledWith("t1", "again", undefined, { traceparent: trace.traceparent })
	})

	it("POST /api/v1/task/:id/message drops a malformed trace rather than refusing the turn", async () => {
		const res = mockRes()
		await run(
			mockReq("POST", "/api/v1/task/t1/message", { message: "go", trace: { nonsense: true } }),
			res as unknown as ServerResponse,
		)
		expect(res.statusCode).toBe(202)
		expect(api.sendMessage).toHaveBeenCalledWith("t1", "go", undefined, undefined)
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

	it("404s unknown routes", async () => {
		const res = mockRes()
		await run(mockReq("GET", "/nope"), res as unknown as ServerResponse)
		expect(res.statusCode).toBe(404)
	})

	describe("GET /api/v1/task/:id/snapshot", () => {
		it("returns the task snapshot", async () => {
			const res = mockRes()
			await run(mockReq("GET", "/api/v1/task/t%201/snapshot"), res as unknown as ServerResponse)
			expect(res.statusCode).toBe(200)
			expect(JSON.parse(res.body)).toEqual({ taskId: "t 1", messages: [] })
			// The id is decoded before it reaches the API.
			expect(api.getTaskSnapshot).toHaveBeenCalledWith("t 1")
		})

		it("404s a task this host does not own", async () => {
			const res = mockRes()
			await run(mockReq("GET", "/api/v1/task/missing/snapshot"), res as unknown as ServerResponse)
			expect(res.statusCode).toBe(404)
		})
	})

	describe("auth + version handshake", () => {
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

		it("401s the snapshot route without a token — a transcript is not open data", async () => {
			const res = await call(authed(), mockReq("GET", "/api/v1/task/t1/snapshot"))
			expect(res.statusCode).toBe(401)
			expect(api.getTaskSnapshot).not.toHaveBeenCalled()
		})

		it("serves the snapshot with the correct token", async () => {
			const req = mockReq("GET", "/api/v1/task/t1/snapshot")
			;(req.headers as Record<string, string>) = { authorization: "Bearer s3cret" }
			const res = await call(authed(), req)
			expect(res.statusCode).toBe(200)
			expect(api.getTaskSnapshot).toHaveBeenCalledWith("t1")
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

	/**
	 * The subscriber census answers "would an ask published for this task reach
	 * anybody?" — the question a headless host has to settle before parking an
	 * agent on an interactive ask nobody would ever see. It is per TASK because a
	 * controller subscribes per conversation, so "some stream is open" says
	 * nothing about the conversation the ask belongs to.
	 */
	describe("stream subscriber census", () => {
		it("counts a per-task stream against that task only", async () => {
			const subscribers = createStreamSubscribers()
			const scoped = createRequestHandler(api, { subscribers })
			const req = mockReq("GET", "/api/v1/task/t1/event")

			scoped(req, mockRes() as unknown as ServerResponse)
			await flush()

			expect(subscribers.has("t1")).toBe(true)
			expect(subscribers.has("t2")).toBe(false)

			req.fireClose()
			expect(subscribers.has("t1")).toBe(false)
		})

		it("counts a worker-wide stream against every task", async () => {
			const subscribers = createStreamSubscribers()
			const scoped = createRequestHandler(api, { subscribers })
			const req = mockReq("GET", "/api/v1/event")

			scoped(req, mockRes() as unknown as ServerResponse)
			await flush()

			expect(subscribers.has("anything")).toBe(true)

			req.fireClose()
			expect(subscribers.has("anything")).toBe(false)
		})

		it("keeps the task subscribed while a second stream on it is open", async () => {
			const subscribers = createStreamSubscribers()
			const scoped = createRequestHandler(api, { subscribers })
			const first = mockReq("GET", "/api/v1/task/t1/event")
			const second = mockReq("GET", "/api/v1/task/t1/event")

			scoped(first, mockRes() as unknown as ServerResponse)
			scoped(second, mockRes() as unknown as ServerResponse)
			await flush()

			first.fireClose()
			expect(subscribers.has("t1")).toBe(true)

			second.fireClose()
			expect(subscribers.has("t1")).toBe(false)
		})

		it("still reports a dropped stream as reachable inside the re-attach grace", async () => {
			const subscribers = createStreamSubscribers({ now: () => clock })
			const scoped = createRequestHandler(api, { subscribers })
			const req = mockReq("GET", "/api/v1/task/t1/event")

			scoped(req, mockRes() as unknown as ServerResponse)
			await flush()
			req.fireClose()

			// `has` is the instantaneous fact and must stay exact; `mightReach` is
			// the one a refuse-to-ask decision may be taken on.
			expect(subscribers.has("t1")).toBe(false)
			expect(subscribers.mightReach("t1")).toBe(true)

			clock += SUBSCRIBER_REATTACH_GRACE_MS - 1
			expect(subscribers.mightReach("t1")).toBe(true)
		})
	})

	/**
	 * The grace window on the census: a controller detaching and re-attaching is
	 * ordinary operation (an SSE drop, a proxy idle cycle, a rollout), so a
	 * momentary absence is not evidence that a conversation has no audience.
	 * Beyond the window it IS — which is what keeps the fail-fast it feeds from
	 * degenerating into "never refuse".
	 */
	describe("re-attach grace", () => {
		const attachDetach = (subscribers: ReturnType<typeof createStreamSubscribers>, taskId: string) =>
			subscribers.add(taskId)()

		it("reports a task that never had a subscriber as unreachable, with no grace", () => {
			const subscribers = createStreamSubscribers({ now: () => clock })
			expect(subscribers.mightReach("never-seen")).toBe(false)
		})

		it("expires the grace once the last detach is older than the window", () => {
			const subscribers = createStreamSubscribers({ now: () => clock })
			attachDetach(subscribers, "t1")

			clock += SUBSCRIBER_REATTACH_GRACE_MS - 1
			expect(subscribers.mightReach("t1")).toBe(true)

			clock += 1
			expect(subscribers.mightReach("t1")).toBe(false)
		})

		it("restarts the window from the LATEST detach, not the first", () => {
			const subscribers = createStreamSubscribers({ now: () => clock })
			attachDetach(subscribers, "t1")

			clock += SUBSCRIBER_REATTACH_GRACE_MS - 100
			attachDetach(subscribers, "t1")

			clock += SUBSCRIBER_REATTACH_GRACE_MS - 1
			expect(subscribers.mightReach("t1")).toBe(true)
		})

		it("counts the worker-wide firehose for a task with no stream of its own", () => {
			const subscribers = createStreamSubscribers({ now: () => clock })
			const release = subscribers.add(undefined)

			expect(subscribers.mightReach("never-seen")).toBe(true)
			release()
			expect(subscribers.mightReach("never-seen")).toBe(false)
		})

		it("does not let a detach recorded on one task speak for another", () => {
			const subscribers = createStreamSubscribers({ now: () => clock })
			attachDetach(subscribers, "t1")

			expect(subscribers.mightReach("t1")).toBe(true)
			expect(subscribers.mightReach("t2")).toBe(false)
		})

		it("prunes detach entries past the window instead of growing forever", () => {
			const subscribers = createStreamSubscribers({ now: () => clock })
			for (let i = 0; i < 50; i++) attachDetach(subscribers, `stale-${i}`)

			clock += SUBSCRIBER_REATTACH_GRACE_MS
			// The write that follows the window sweeps every entry it made stale, so
			// the ledger holds only what is still inside the window (plus this one).
			attachDetach(subscribers, "fresh")

			expect(subscribers.mightReach("fresh")).toBe(true)
			for (let i = 0; i < 50; i++) expect(subscribers.mightReach(`stale-${i}`)).toBe(false)
			expect(subscribers.detachLedgerSize()).toBe(1)
		})

		it("drops a task's detach entry when it re-attaches", () => {
			const subscribers = createStreamSubscribers({ now: () => clock })
			attachDetach(subscribers, "t1")
			const release = subscribers.add("t1")

			expect(subscribers.detachLedgerSize()).toBe(0)
			expect(subscribers.mightReach("t1")).toBe(true)
			release()
			expect(subscribers.detachLedgerSize()).toBe(1)
		})
	})
})
