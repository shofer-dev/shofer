import { describe, it, expect, beforeEach, vi } from "vitest"
import type { IncomingMessage, ServerResponse } from "node:http"

import { createRequestHandler, type ShoferApi, type ServerEvent } from "../http-server.js"
import { TurnDrain } from "../drain.js"

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
			res.ended = true
			if (body) res.body = body
		},
		ended: false,
		/**
		 * The drain's refusal shape: the socket is torn down without a status
		 * line, because a pooled controller fails a turn over to a peer on a
		 * transport failure and never on an answered status.
		 */
		destroyed: false,
		destroy() {
			res.destroyed = true
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
			deliverToMailbox: vi.fn(async () => {}),
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

	// This door is the ONLY one that answers before its work runs — `Task.start()` detaches
	// `startTask()` with no `.catch` — so a malformed id accepted here is not reported anywhere a
	// caller can see it: the run dies inside an unheld promise, `shofer serve` logs the
	// `unhandledRejection` and stays up, and the client's SSE stream waits forever for a terminal
	// event that will never come. Under `task_store=postgres` the id reaches a `UUID` column and
	// Postgres answers `invalid input syntax for type uuid`.
	it("400s on a taskId that is not a UUID, rather than 201-then-silence", async () => {
		for (const taskId of ["draintest-1788894937", "t-1", "", 42]) {
			const res = mockRes()
			await run(
				mockReq("POST", "/api/v1/task", { prompt: "hello", mode: "code", taskId }),
				res as unknown as ServerResponse,
			)
			expect(res.statusCode, `taskId=${JSON.stringify(taskId)}`).toBe(400)
			expect(res.body).toContain("taskId must be a UUID")
		}
		expect(api.createTask).not.toHaveBeenCalled()
	})

	it("accepts a UUID taskId, and still accepts none at all", async () => {
		const withId = mockRes()
		await run(
			mockReq("POST", "/api/v1/task", {
				prompt: "hello",
				mode: "code",
				taskId: "0198f0a1-2b3c-7d4e-8f90-1a2b3c4d5e6f",
			}),
			withId as unknown as ServerResponse,
		)
		expect(withId.statusCode).toBe(201)
		expect(api.createTask).toHaveBeenCalledWith(
			expect.objectContaining({ taskId: "0198f0a1-2b3c-7d4e-8f90-1a2b3c4d5e6f" }),
		)

		// Omitting it is the ordinary path: the task mints its own uuidv7.
		const without = mockRes()
		await run(
			mockReq("POST", "/api/v1/task", { prompt: "hello", mode: "code" }),
			without as unknown as ServerResponse,
		)
		expect(without.statusCode).toBe(201)
		expect(api.createTask).toHaveBeenLastCalledWith(expect.objectContaining({ taskId: undefined }))
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

	/**
	 * The MAIL door. Two things it must get right and one it must refuse: the
	 * host owns `to` and `sent_at` (a client cannot address a third party by
	 * disagreeing with its own URL), an absent subject is derived from the body,
	 * and a refused delivery is a status code rather than a silent drop.
	 */
	describe("POST /api/v1/task/:id/mailbox", () => {
		const body = {
			id: "env-1",
			from: "task-sender",
			kind: "notification",
			body: "  the vm   is ready  ",
			deadline: 4_000_000_000_000,
			wake: true,
			plane: "bus",
		}

		it("fills `to` and `sent_at`, and derives an absent subject", async () => {
			const res = mockRes()
			await run(mockReq("POST", "/api/v1/task/t1/mailbox", body), res as unknown as ServerResponse)

			expect(res.statusCode).toBe(202)
			expect(JSON.parse(res.body)).toEqual({ taskId: "t1", delivered: "env-1" })
			const [taskId, envelope] = vi.mocked(api.deliverToMailbox).mock.calls[0]!
			expect(taskId).toBe("t1")
			expect(envelope.to).toBe("t1")
			expect(typeof envelope.sent_at).toBe("number")
			expect(envelope.subject).toBe("the vm is ready")
		})

		it("mints an `id` when the caller sent none, as the plugin door does", async () => {
			const res = mockRes()
			const { id: _omitted, ...withoutId } = body
			await run(mockReq("POST", "/api/v1/task/t1/mailbox", withoutId), res as unknown as ServerResponse)

			expect(res.statusCode).toBe(202)
			const envelope = vi.mocked(api.deliverToMailbox).mock.calls[0]![1]
			expect(envelope.id).toMatch(/^[0-9a-f-]{36}$/)
			expect(JSON.parse(res.body)).toEqual({ taskId: "t1", delivered: envelope.id })
		})

		it("overrides a `to` the client tried to set", async () => {
			const res = mockRes()
			await run(
				mockReq("POST", "/api/v1/task/t1/mailbox", { ...body, to: "someone-else" }),
				res as unknown as ServerResponse,
			)
			expect(vi.mocked(api.deliverToMailbox).mock.calls[0]![1].to).toBe("t1")
		})

		it("400s a body that is not an envelope", async () => {
			const res = mockRes()
			await run(
				mockReq("POST", "/api/v1/task/t1/mailbox", { ...body, kind: "reply" }),
				res as unknown as ServerResponse,
			)
			expect(res.statusCode).toBe(400)
			expect(api.deliverToMailbox).not.toHaveBeenCalled()
		})

		it("409s a refused delivery rather than reporting a receipt", async () => {
			vi.mocked(api.deliverToMailbox).mockRejectedValueOnce(new Error("Task t1 is not reachable"))
			const res = mockRes()
			await run(mockReq("POST", "/api/v1/task/t1/mailbox", body), res as unknown as ServerResponse)

			expect(res.statusCode).toBe(409)
			expect(JSON.parse(res.body).error).toContain("not reachable")
		})
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

	// ── Draining ─────────────────────────────────────────────────────────────
	//
	// The transport's half of the graceful shutdown (`../drain.ts` owns the
	// registry and the wait). Two rules, and the difference between them is the
	// whole design: a TURN-OPENING request is refused by destroying the socket,
	// because that is the only refusal a pooled controller fails over on; the
	// READINESS probe is refused with a status code, because a probe cannot fail
	// over and can only be told yes or no.
	describe("drain", () => {
		let drain: TurnDrain
		let draining: ReturnType<typeof createRequestHandler>

		beforeEach(() => {
			drain = new TurnDrain()
			draining = createRequestHandler(api, { drain, version: "1.2.3" })
		})

		const call = async (req: IncomingMessage) => {
			const res = mockRes()
			draining(req, res as unknown as ServerResponse)
			await flush()
			return res
		}

		it("registers a per-task event stream as a turn in flight, and releases it on close", async () => {
			const req = mockReq("GET", "/api/v1/task/t1/event")
			draining(req, mockRes() as unknown as ServerResponse)
			await flush()

			expect(drain.inFlight).toBe(1)
			expect(drain.inFlightTasks()).toEqual(["t1"])

			req.fireClose()
			expect(drain.inFlight).toBe(0)
		})

		it("does NOT count the node-wide firehose as a turn", async () => {
			// It has no turn boundary — an observer may hold it for the process's
			// whole life — so waiting on one would make every drain hit its ceiling.
			draining(mockReq("GET", "/api/v1/event"), mockRes() as unknown as ServerResponse)
			await flush()

			expect(drain.inFlight).toBe(0)
		})

		it("ends the firehose when the drain begins", async () => {
			const res = mockRes()
			draining(mockReq("GET", "/api/v1/event"), res as unknown as ServerResponse)
			await flush()

			drain.begin()

			expect(res.ended).toBe(true)
		})

		it("/health answers 503 while draining, so peers stop selecting this node", async () => {
			drain.begin()
			const res = await call(mockReq("GET", "/health"))

			expect(res.statusCode).toBe(503)
			expect(JSON.parse(res.body)).toMatchObject({ ok: false, version: "1.2.3", draining: true })
		})

		it.each([
			["POST", "/api/v1/task", { prompt: "hi", mode: "code" }],
			["POST", "/api/v1/task/t1/message", { message: "go" }],
			["GET", "/api/v1/task/t1/event", undefined],
			["GET", "/api/v1/event", undefined],
		])("destroys the socket rather than answering %s %s while draining", async (method, path, body) => {
			drain.begin()
			const res = await call(mockReq(method, path, body))

			expect(res.destroyed).toBe(true)
			// No status line at all: a 503 would read to the controller as "this
			// node decided", which it never re-issues elsewhere — the turn would be
			// stranded instead of picked up by a peer.
			expect(res.statusCode).toBe(0)
			expect(api.createTask).not.toHaveBeenCalled()
			expect(api.sendMessage).not.toHaveBeenCalled()
		})

		it.each([
			["POST", "/api/v1/task/t1/ask", { askResponse: "yesButtonClicked" }, 202],
			["POST", "/api/v1/task/t1/cancel", undefined, 202],
			[
				"POST",
				"/api/v1/task/t1/mailbox",
				{
					id: "env-1",
					from: "task-sender",
					kind: "notification",
					body: "hello",
					deadline: 4_000_000_000_000,
					wake: true,
					plane: "bus",
				},
				202,
			],
			["POST", "/api/v1/task/t1/plugin-request", { plugin: "p", method: "m" }, 200],
			["GET", "/api/v1/task/t1/snapshot", undefined, 200],
		])(
			"keeps serving %s %s while draining — it addresses a turn already here",
			async (method, path, body, status) => {
				// Refusing an `ask` would strand the very turn the drain exists to
				// finish: a peer has no such pending ask to answer.
				drain.begin()
				const res = await call(mockReq(method, path, body))

				expect(res.destroyed).toBe(false)
				expect(res.statusCode).toBe(status)
			},
		)

		it("does not consume a refused turn's body before destroying the socket", async () => {
			// A drained request is not a request with a bad payload; reading the
			// body would only delay the reset the caller is waiting to fail over on.
			drain.begin()
			let consumed = false
			const req = mockReq("POST", "/api/v1/task", { prompt: "hi", mode: "code" })
			const original = req[Symbol.asyncIterator].bind(req)
			;(req as unknown as { [Symbol.asyncIterator]: unknown })[Symbol.asyncIterator] = () => {
				consumed = true
				return original()
			}

			draining(req, mockRes() as unknown as ServerResponse)
			await flush()

			expect(consumed).toBe(false)
		})
	})
})
