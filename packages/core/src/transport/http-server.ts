import http from "node:http"
import { randomUUID } from "node:crypto"

import { deriveSubject, envelopeSchema, traceContextFromHeaders, traceContextSchema } from "@shofer/types"

import type { ShoferApi, ProviderSettings, ServerEvent, TraceContext } from "@shofer/types"

/**
 * HTTP + SSE transport boundary (v3 architecture §11).
 *
 * shofer already has an in-process `ShoferExtensionApi` and a headless NDJSON protocol;
 * §11 publishes that as a versioned, network-accessible surface so a TUI, web
 * client, or third-party tool can drive the agent — and a generated SDK can't
 * drift from it. This module is the transport itself: a small `node:http` server
 * (no framework dependency) exposing task control over HTTP and a one-way event
 * stream over SSE (`GET /api/event`).
 *
 * It is driven by an injected {@link ShoferApi} (now defined in `@shofer/types` and
 * re-exported here), so the transport is testable in isolation.
 */

export type { ShoferApi, ServerEvent } from "@shofer/types"

const API_VERSION = "v1"

function send(res: http.ServerResponse, status: number, body: unknown): void {
	const json = JSON.stringify(body)
	res.writeHead(status, { "content-type": "application/json" })
	res.end(json)
}

/**
 * Open an SSE response and flush the headers immediately. Flushing NOW (rather
 * than letting Node buffer headers until the first body write) is essential for
 * both event streams: a controller that opens the stream and then waits for it to
 * be established before triggering the first event (e.g. createTask) would
 * otherwise deadlock — the headers never arrive because no event has been written,
 * and no event is written because the controller is still blocked on the headers.
 */
function startEventStream(res: http.ServerResponse): void {
	res.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "keep-alive",
	})
	res.flushHeaders()
}

/**
 * Extract the owning task id from a forwarded event so a per-task stream can
 * filter to one task. Mirrors the wire contract: a `message` event carries it at
 * `args[0].taskId`; every other forwarded event has the task id as `args[0]`.
 */
function eventTaskId(event: ServerEvent): string | undefined {
	const first = (event as { args?: unknown[] }).args?.[0]
	if (event.type === "message") {
		return (first as { taskId?: string } | undefined)?.taskId
	}
	return typeof first === "string" ? first : undefined
}

/**
 * The W3C trace context a request carries — the body's `trace` field, else the
 * standard `traceparent`/`tracestate` headers.
 *
 * Read on BOTH task-starting routes, `POST /task` and `POST /task/:id/message`:
 * a conversation is created once and messaged many times, so honouring it only
 * on creation attributes exactly the first turn of every multi-turn run and
 * silently loses the rest.
 *
 * Both, because the two kinds of caller differ: a client using this transport's
 * own SDK states the context in the body (which survives transports that have no
 * headers), while a generically instrumented HTTP client sets only the headers
 * and knows nothing about our body shape. Honouring one would silently drop the
 * other's context, and a dropped context fails as a trace that simply starts in
 * the wrong place — never as an error. The body wins when both are present: it
 * is the explicit statement.
 *
 * A malformed `trace` field is dropped rather than rejected: propagation is
 * best-effort, and refusing to start an agent because an observability header
 * was wrong would let the lens break the thing it observes.
 */
function requestTraceContext(req: http.IncomingMessage, body: Record<string, unknown>): TraceContext | undefined {
	const stated = traceContextSchema.safeParse(body.trace)
	if (stated.success) return stated.data
	return traceContextFromHeaders(req.headers)
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = []
	for await (const chunk of req) chunks.push(chunk as Buffer)
	const raw = Buffer.concat(chunks).toString("utf8")
	if (!raw) return {}
	return JSON.parse(raw) as Record<string, unknown>
}

/**
 * How long after its last subscriber detached a task is still considered
 * REACHABLE (`mightReach`), even though nothing is subscribed right now.
 *
 * 30 seconds, and both bounds of that choice are load-bearing:
 *
 * - **Long enough that a reconnect is not mistaken for an absence.** A
 *   controller detaching and re-attaching is NORMAL, not evidence of a missing
 *   audience: an SSE connection drops and the client re-subscribes, a proxy
 *   recycles an idle stream, a controller rolls out and its replacement
 *   re-attaches. Every one of those is a gap of milliseconds to a few seconds.
 *   An instantaneous census reads each as "nobody is watching", and a fail-fast
 *   built on it converts a transient gap into a permanent wrong refusal — which
 *   is exactly how a live sync child was refused mid-turn while its controller
 *   was demonstrably driving the conversation.
 * - **Short enough that a genuinely dead controller still fails fast.** The
 *   fail-fast exists so a question nobody can ever answer does not park the
 *   child (and its suspended parent) forever. Half a minute of grace costs one
 *   stalled turn in that case; the alternative costs the run.
 *
 * It is a grace on the OBSERVATION, never a timer that answers anything: no ask
 * is resolved, denied or fabricated when it lapses. All that changes is whether
 * the host is willing to state "this question provably reaches nobody".
 *
 * It also bounds the detach ledger's retention — see {@link createStreamSubscribers}.
 */
export const SUBSCRIBER_REATTACH_GRACE_MS = 30_000

/**
 * Live census of the open event-stream subscriptions, so the host can answer
 * "would an ask published on task X's stream reach anybody?".
 *
 * The question has to be asked per TASK, not per host: a controller subscribes
 * to one conversation (`GET /api/v1/task/:id/event`), so "some SSE connection is
 * open" says nothing about the conversation an ask belongs to. A worker-wide
 * subscriber (`GET /api/v1/event`) counts for every task, because it receives
 * every task's events unfiltered.
 *
 * Two questions, deliberately separate. {@link StreamSubscribers.has} is the
 * instantaneous fact — is a stream open on this task at this instant — and
 * {@link StreamSubscribers.mightReach} is the one a decision may be taken on,
 * which additionally honours {@link SUBSCRIBER_REATTACH_GRACE_MS} for a task
 * whose subscriber detached moments ago. Keeping `has` exact matters: it is what
 * a future consumer asking a genuinely instantaneous question (a metric, a
 * readiness gauge) needs, and folding the grace into it would make the census
 * itself report something it cannot observe.
 */
export interface StreamSubscribers {
	/**
	 * Record a new subscription and return its release function. `taskId`
	 * `undefined` means the worker-wide firehose.
	 */
	add(taskId: string | undefined): () => void
	/** Whether an event published for `taskId` would reach at least one subscriber RIGHT NOW. */
	has(taskId: string): boolean
	/**
	 * Whether an event published for `taskId` would reach a subscriber, treating
	 * a subscriber that detached within {@link SUBSCRIBER_REATTACH_GRACE_MS} as
	 * still present — i.e. "is there plausibly an audience", the question a
	 * refuse-to-ask decision is entitled to ask.
	 *
	 * `false` therefore means: nothing is subscribed now, AND either nothing ever
	 * was for this task, or the last thing that was gave up long enough ago that
	 * no reconnect explains it.
	 */
	mightReach(taskId: string): boolean
	/**
	 * How many tasks are currently remembered as recently-detached. A diagnostic
	 * over the detach ledger — it makes the ledger's memory bound assertable and
	 * observable — and never an input to a decision.
	 */
	detachLedgerSize(): number
}

/** Construction options for {@link createStreamSubscribers}. */
export interface StreamSubscribersOptions {
	/**
	 * Monotonic millisecond clock, defaulting to `performance.now()`. Monotonic
	 * on purpose: the grace window measures an ELAPSED interval of seconds, and a
	 * wall clock can step (NTP correction, a suspended host resuming) mid-window,
	 * which would either extend the grace indefinitely or collapse it to zero.
	 * Injectable so the window is testable without global timer mocking.
	 */
	now?: () => number
}

/**
 * An independent {@link StreamSubscribers} census (one per server).
 *
 * Memory: the detach ledger is bounded by construction rather than capped after
 * the fact. An entry is written only when a task's LAST subscriber detaches, and
 * every write first sweeps every entry older than
 * {@link SUBSCRIBER_REATTACH_GRACE_MS} — which is precisely the set that can no
 * longer change any answer. So after any write the ledger holds only entries
 * inside the window, and between writes nothing is added: its size is bounded by
 * the number of distinct tasks that lost their last subscriber in the last 30
 * seconds, plus one. Re-attaching drops the task's entry outright. (An LRU cap
 * would have been the other option; it is strictly worse here because "old
 * enough to be useless" is the exact eviction criterion the window already
 * gives, and a cap can evict a live-window entry under load — silently
 * restoring the instantaneous behaviour this exists to fix.)
 */
export function createStreamSubscribers(opts: StreamSubscribersOptions = {}): StreamSubscribers {
	const now = opts.now ?? (() => performance.now())
	const perTask = new Map<string, number>()
	/** taskId → monotonic ms at which its last subscriber detached. */
	const detachedAt = new Map<string, number>()
	let firehose = 0

	const sweep = (at: number): void => {
		for (const [taskId, when] of detachedAt) {
			if (at - when >= SUBSCRIBER_REATTACH_GRACE_MS) detachedAt.delete(taskId)
		}
	}

	return {
		add(taskId) {
			if (taskId === undefined) {
				firehose++
				return () => {
					firehose--
				}
			}
			sweep(now())
			// A live subscriber makes this task's detach time meaningless, and
			// keeping it would let a stale entry outlive the sweep that only runs
			// on write.
			detachedAt.delete(taskId)
			perTask.set(taskId, (perTask.get(taskId) ?? 0) + 1)
			let released = false
			return () => {
				if (released) return
				released = true
				const next = (perTask.get(taskId) ?? 1) - 1
				if (next <= 0) {
					perTask.delete(taskId)
					const at = now()
					sweep(at)
					detachedAt.set(taskId, at)
				} else {
					perTask.set(taskId, next)
				}
			}
		},
		has(taskId) {
			return firehose > 0 || (perTask.get(taskId) ?? 0) > 0
		},
		mightReach(taskId) {
			if (firehose > 0 || (perTask.get(taskId) ?? 0) > 0) return true
			const when = detachedAt.get(taskId)
			// Never attached — nothing to be tolerant of. This is the case the
			// fail-fast was written for.
			if (when === undefined) return false
			return now() - when < SUBSCRIBER_REATTACH_GRACE_MS
		},
		detachLedgerSize() {
			return detachedAt.size
		},
	}
}

/** Options for the HTTP/SSE server (auth + version handshake). */
export interface HttpServerOptions {
	/**
	 * Optional bearer token. When set, every `/api/v1/*` route requires
	 * `Authorization: Bearer <token>` (→ `401` when missing/wrong). `/health`
	 * stays open (liveness only). Unset → no auth (loopback/dev default).
	 */
	token?: string
	/**
	 * The agent build version this executor reports. Surfaced on the open
	 * `/health` and the authed `/whoami` so a client can verify the served
	 * build before driving it.
	 */
	version?: string
	/**
	 * Census to record this server's open event streams in. Supply one when the
	 * caller needs to ask whether a task has a live driver (see
	 * `setConversationDriverProbe`); omitted, the server keeps a private census
	 * nobody reads.
	 */
	subscribers?: StreamSubscribers
}

/**
 * Create the shofer HTTP/SSE server. Routes (all under `/api/<version>` except
 * `/health`):
 *   GET  /health                     → liveness + version (open)
 *   GET  /api/v1/whoami              → { version } (authed; one-shot liveness+version+auth)
 *   GET  /api/v1/event               → SSE event stream (worker-wide: ALL tasks)
 *   GET  /api/v1/task/:id/event      → SSE event stream filtered to ONE task
 *   GET  /api/v1/task/:id/snapshot   → 200 TaskSnapshot | 404 (attach backfill)
 *   POST /api/v1/task                → { prompt, mode, taskId?, apiConfiguration?, title?, trace? } → { taskId }
 *                                      (also honours W3C `traceparent`/`tracestate` headers)
 *   POST /api/v1/task/:id/message    → { message, images?, trace? }
 *                                      (also honours W3C `traceparent`/`tracestate` headers)
 *   POST /api/v1/task/:id/cancel
 *   POST /api/v1/task/:id/ask        → { askResponse, text?, images?, askId?, mode? } (interactive approval)
 *   POST /api/v1/task/:id/mailbox    → an Envelope minus `to`/`sent_at` (the server fills both)
 *   POST /api/v1/task/:id/plugin-request → { plugin, method, params } → 200 { result }
 */
export function createHttpServer(api: ShoferApi, opts: HttpServerOptions = {}): http.Server {
	return http.createServer(createRequestHandler(api, opts))
}

/**
 * The request handler (exported for testing without a real socket).
 */
export function createRequestHandler(
	api: ShoferApi,
	opts: HttpServerOptions = {},
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
	const base = `/api/${API_VERSION}`
	const { token, version } = opts
	const subscribers = opts.subscribers ?? createStreamSubscribers()

	return (req, res) => {
		void handle(req, res).catch((error) => {
			send(res, 500, { error: error instanceof Error ? error.message : String(error) })
		})
	}

	async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", "http://localhost")
		const path = url.pathname
		const method = req.method ?? "GET"

		// Open liveness probe — never gated by the bearer token.
		if (method === "GET" && path === "/health") {
			return send(res, 200, { ok: true, version })
		}

		// Bearer-token gate for the entire versioned API surface.
		if (token && (path === base || path.startsWith(`${base}/`))) {
			const header = req.headers["authorization"]
			if (header !== `Bearer ${token}`) {
				return send(res, 401, { error: "unauthorized" })
			}
		}

		// Authed liveness+version+auth check in a single round-trip.
		if (method === "GET" && path === `${base}/whoami`) {
			return send(res, 200, { version })
		}

		if (method === "GET" && path === `${base}/event`) {
			startEventStream(res)
			const unsubscribe = api.subscribe((event) => {
				res.write(`data: ${JSON.stringify(event)}\n\n`)
			})
			const release = subscribers.add(undefined)
			req.on("close", () => {
				release()
				unsubscribe()
			})
			return
		}

		// Per-task event stream — the same SSE as /event, filtered to ONE task's
		// events. Multi-tenant isolation: a client driving many users' tasks on
		// a shared host subscribes per authorized task instead of to the worker-wide
		// firehose, so it never receives (or has to demux) other tenants' content.
		// The worker-wide /event stays for single-tenant / whole-host consumers.
		const taskEventMatch = path.match(new RegExp(`^${base}/task/([^/]+)/event$`))
		if (method === "GET" && taskEventMatch) {
			const taskId = decodeURIComponent(taskEventMatch[1]!)
			startEventStream(res)
			const unsubscribe = api.subscribe((event) => {
				if (eventTaskId(event) === taskId) {
					res.write(`data: ${JSON.stringify(event)}\n\n`)
				}
			})
			const release = subscribers.add(taskId)
			req.on("close", () => {
				release()
				unsubscribe()
			})
			return
		}

		// Backfill for a controller attaching to a task that is ALREADY running: the
		// transcript so far, the ask it is blocked on, lifecycle and token usage. A
		// host that owns no such task answers 404 rather than an empty snapshot, so
		// the caller can tell "not here" apart from "nothing said yet".
		const snapshotMatch = path.match(new RegExp(`^${base}/task/([^/]+)/snapshot$`))
		if (method === "GET" && snapshotMatch) {
			const snapshotTaskId = decodeURIComponent(snapshotMatch[1]!)
			const snapshot = await api.getTaskSnapshot(snapshotTaskId)
			if (!snapshot) return send(res, 404, { error: `no task ${snapshotTaskId}` })
			return send(res, 200, snapshot)
		}

		if (method === "POST" && path === `${base}/task`) {
			const body = await readJson(req)
			if (typeof body.prompt !== "string") return send(res, 400, { error: "prompt is required" })
			if (typeof body.mode !== "string") return send(res, 400, { error: "mode is required" })
			const result = await api.createTask({
				prompt: body.prompt,
				mode: body.mode,
				taskId: body.taskId as string | undefined,
				// Per-task API Configuration shipped by the controller. A local CLI
				// override narrows this to the behaviour-only subset rather than
				// dropping it wholesale (gated in ShoferApiAgent).
				apiConfiguration: body.apiConfiguration as ProviderSettings | undefined,
				// Supplying a title LOCKS it: the task cannot rename itself, and
				// `set_task_title` leaves its tool list.
				title: typeof body.title === "string" ? body.title : undefined,
				// W3C trace context of the creating request, so the run the controller
				// asked for continues the controller's trace instead of starting an
				// unrelated one.
				trace: requestTraceContext(req, body),
			})
			return send(res, 201, result)
		}

		const taskMatch = path.match(new RegExp(`^${base}/task/([^/]+)/(message|cancel|ask|mailbox)$`))
		if (method === "POST" && taskMatch) {
			const taskId = taskMatch[1]!
			const action = taskMatch[2]!
			if (action === "message") {
				const body = await readJson(req)
				if (typeof body.message !== "string") return send(res, 400, { error: "message is required" })
				await api.sendMessage(
					taskId,
					body.message,
					body.images as string[] | undefined,
					// The trace this turn belongs to — the same body-or-headers pair
					// `createTask` honours, because a follow-up message starts a turn
					// exactly as task creation does.
					requestTraceContext(req, body),
				)
				return send(res, 202, { taskId, accepted: true })
			}
			if (action === "mailbox") {
				// The MAIL door, beside `/message`'s TURN door. The body is an
				// envelope minus the two fields the host owns: `to` comes from the
				// addressed task (a client cannot deliver to a third party by
				// disagreeing with its own URL) and `sent_at` from this host's clock.
				// An absent `subject` is derived from the body, so a caller that has
				// only prose still produces a scannable digest row.
				const body = await readJson(req)
				if (typeof body.body !== "string") return send(res, 400, { error: "body is required" })
				// `id` is the idempotency key a retrying sender re-uses; a caller
				// with no retry story gets one minted here, as the plugin door does.
				const candidate = {
					...body,
					id: typeof body.id === "string" && body.id ? body.id : randomUUID(),
					to: decodeURIComponent(taskId),
					sent_at: Date.now(),
					subject: typeof body.subject === "string" ? body.subject : deriveSubject(body.body),
				}
				const parsed = envelopeSchema.safeParse(candidate)
				if (!parsed.success) {
					return send(res, 400, {
						error: `invalid envelope: ${parsed.error.issues[0]?.message ?? "unknown"}`,
					})
				}
				// A refused delivery (no such task, errored task, full box) is an
				// ERROR to the caller, never a silent drop — that is the whole point
				// of a receipt that means "in the box".
				try {
					await api.deliverToMailbox(decodeURIComponent(taskId), parsed.data)
				} catch (error) {
					return send(res, 409, { error: error instanceof Error ? error.message : String(error) })
				}
				return send(res, 202, { taskId, delivered: parsed.data.id })
			}
			if (action === "ask") {
				const body = await readJson(req)
				if (typeof body.askResponse !== "string") return send(res, 400, { error: "askResponse is required" })
				await api.respondToAsk(taskId, {
					askResponse: body.askResponse,
					text: body.text as string | undefined,
					images: body.images as string[] | undefined,
					askId: body.askId as string | undefined,
					mode: body.mode as string | undefined,
				})
				return send(res, 202, { taskId, answered: true })
			}
			await api.cancelTask(taskId)
			return send(res, 202, { taskId, cancelled: true })
		}

		// ── Reverse data channel — plugin requests ────────────────────────────────────
		// One generic route carries every plugin-owned per-task feature (the file-changes
		// panel, checkpoints, …): `plugin` + `method` + opaque `params` in, the plugin's
		// JSON result out. Adding a feature never means adding a route.

		const pluginRequestMatch = path.match(new RegExp(`^${base}/task/([^/]+)/plugin-request$`))
		if (method === "POST" && pluginRequestMatch) {
			const taskId = decodeURIComponent(pluginRequestMatch[1]!)
			const body = await readJson(req)
			if (typeof body.plugin !== "string" || typeof body.method !== "string") {
				return send(res, 400, { error: "plugin and method are required" })
			}
			const result = await api.pluginRequest(taskId, body.plugin, body.method, body.params)
			return send(res, 200, { result })
		}

		send(res, 404, { error: `no route for ${method} ${path}` })
	}
}
