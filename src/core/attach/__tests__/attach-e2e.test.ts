import { EventEmitter } from "node:events"
import type { IncomingMessage, ServerResponse } from "node:http"

import { ShoferEventName, type HistoryItem, type ShoferAPI, type ShoferMessage } from "@shofer/types"
import { ShoferApiAgent, ShoferHttpClient, createRequestHandler } from "@shofer/core"

import { TaskAttachmentManager, type AttachViewHost } from "../TaskAttachmentManager"

/**
 * The Phase-2 done-when, end to end through every real layer: a controller attaches
 * mid-task to a task on a served host, renders the full transcript INCLUDING an ask
 * raised before it attached, answers it, sends a follow-up, detaches and re-attaches.
 *
 * Everything below the fake `ShoferAPI` is production code — `ShoferApiAgent`, the
 * HTTP request handler, `ShoferHttpClient`, `TaskAttachmentManager`. Only the socket
 * is replaced (the test sandbox blocks loopback), by a `fetch` that drives the
 * request handler directly and supports SSE the way the real one does: headers flush
 * immediately, each `write` becomes a stream chunk, and aborting the request fires
 * the server's `close` handler so it unsubscribes.
 */

function handlerFetch(handler: (req: IncomingMessage, res: ServerResponse) => void): typeof fetch {
	return (async (url: string, init?: RequestInit) => {
		const target = new URL(url)
		const body = init?.body as string | undefined
		const closeHandlers: Array<() => void> = []
		const req = {
			method: init?.method ?? "GET",
			url: `${target.pathname}${target.search}`,
			headers: (init?.headers ?? {}) as Record<string, string>,
			on(event: string, cb: () => void) {
				if (event === "close") closeHandlers.push(cb)
				return req
			},
			async *[Symbol.asyncIterator]() {
				if (body) yield Buffer.from(body)
			},
		}

		init?.signal?.addEventListener("abort", () => closeHandlers.forEach((cb) => cb()))

		return await new Promise<Response>((resolve) => {
			let status = 200
			let stream: ReadableStreamDefaultController<Uint8Array> | undefined
			const encoder = new TextEncoder()
			const res = {
				writeHead(code: number, headers?: Record<string, string>) {
					status = code
					if (headers?.["content-type"] === "text/event-stream") {
						resolve(
							new Response(
								new ReadableStream<Uint8Array>({
									start(controller) {
										stream = controller
									},
								}),
								{ status, headers },
							),
						)
						init?.signal?.addEventListener("abort", () => {
							try {
								stream?.close()
							} catch {
								/* already closed */
							}
						})
					}
					return res
				},
				flushHeaders() {},
				write(chunk: string) {
					stream?.enqueue(encoder.encode(chunk))
					return true
				},
				end(payload?: string) {
					resolve(new Response(payload ?? "", { status, headers: { "content-type": "application/json" } }))
				},
			}
			handler(req as unknown as IncomingMessage, res as unknown as ServerResponse)
		})
	}) as unknown as typeof fetch
}

/** A served host with one task: the transcript, plus the ask it is blocked on. */
function makeServedHost() {
	const messages: ShoferMessage[] = [
		{ ts: 1, type: "say", say: "text", text: "rename the widget module" },
		{ ts: 2, type: "ask", ask: "tool", askId: "ask-1", text: '{"tool":"editedExistingFile"}' },
	]
	const answered: unknown[] = []
	const sent: string[] = []
	const cancelled: string[] = []

	const emitter = new EventEmitter()
	const api = Object.assign(emitter, {
		getTaskConversation: async (taskId: string) =>
			taskId === "t1"
				? {
						messages: [...messages],
						tokenUsage: { totalTokensIn: 120, totalTokensOut: 30, totalCost: 0.04, contextTokens: 900 },
					}
				: undefined,
		getTaskHistoryItems: (): HistoryItem[] => [
			{
				id: "t1",
				number: 1,
				ts: 1700,
				task: "rename the widget module",
				tokensIn: 120,
				tokensOut: 30,
				totalCost: 0.04,
				taskState: { lifecycle: "running" },
			},
		],
		respondToAsk: async (taskId: string, response: unknown) => {
			answered.push({ taskId, response })
		},
		sendMessage: async (text?: string) => {
			sent.push(text ?? "")
		},
		resumeTask: async () => {},
		cancelCurrentTask: async () => {
			cancelled.push("t1")
		},
		startNewTask: async () => "t1",
		pluginRequest: async () => null,
	}) as unknown as ShoferAPI & EventEmitter

	/** What the task says next, as the served host would emit it. */
	const say = (message: ShoferMessage, action: "created" | "updated" = "created") => {
		messages.push(message)
		emitter.emit(ShoferEventName.Message, { taskId: "t1", action, message })
	}

	const handler = createRequestHandler(new ShoferApiAgent(api), { token: "s3cret", version: "test" })
	return { api, handler, say, answered, sent, cancelled }
}

function makeView(): AttachViewHost {
	return {
		postMessageToWebview: vi.fn(async () => {}),
		postInitState: vi.fn(async () => {}),
	}
}

const flush = () => new Promise((resolve) => setTimeout(resolve))

describe("attaching to a task on a served host (end to end)", () => {
	it("backfills, answers a pre-attach ask, follows up, detaches and re-attaches", async () => {
		const host = makeServedHost()
		const manager = new TaskAttachmentManager(
			(target) =>
				new ShoferHttpClient({
					baseUrl: target.address,
					token: target.token,
					fetch: handlerFetch(host.handler),
				}),
		)
		const view = makeView()

		// ── attach mid-task ──────────────────────────────────────────────────
		const task = await manager.attach(view, {
			address: "http://worker:30099",
			taskId: "t1",
			token: "s3cret",
		})

		// The whole transcript, including the ask raised BEFORE the attach.
		expect(task.messages.map((m) => m.ts)).toEqual([1, 2])
		expect(task.messages[1]).toMatchObject({ type: "ask", ask: "tool", askId: "ask-1" })
		// Authoritative counters and title from the owning host.
		expect(task.toTaskItem()).toMatchObject({ task: "rename the widget module", tokensIn: 120, totalCost: 0.04 })

		// ── answer the ask ───────────────────────────────────────────────────
		await manager.respondToAsk(view, { askResponse: "yesButtonClicked", askId: "ask-1" })
		expect(host.answered).toEqual([
			{
				taskId: "t1",
				response: expect.objectContaining({ askResponse: "yesButtonClicked", askId: "ask-1" }),
			},
		])

		// ── the task carries on; its events stream into the attached view ────
		await flush()
		host.say({ ts: 3, type: "say", say: "text", text: "renamed 4 files" })
		await flush()
		expect(task.messages.map((m) => m.ts)).toEqual([1, 2, 3])
		expect(view.postMessageToWebview).toHaveBeenCalledWith({
			type: "shoferMessageAppended",
			shoferMessage: expect.objectContaining({ ts: 3 }),
		})

		// ── send a follow-up ─────────────────────────────────────────────────
		await manager.sendMessage(view, "now update the tests")
		expect(host.sent).toEqual(["now update the tests"])

		// ── detach: the connection goes, the task does not ───────────────────
		manager.detach(view)
		expect(manager.get(view)).toBeUndefined()
		await flush()
		host.say({ ts: 4, type: "say", say: "text", text: "spoken while nobody watched" })
		await flush()
		expect(task.messages.map((m) => m.ts)).toEqual([1, 2, 3])

		// ── re-attach: a fresh backfill, nothing missed ──────────────────────
		const reattached = await manager.attach(view, {
			address: "http://worker:30099",
			taskId: "t1",
			token: "s3cret",
		})
		expect(reattached).not.toBe(task)
		expect(reattached.messages.map((m) => m.ts)).toEqual([1, 2, 3, 4])
		manager.detach(view)
	})

	it("refuses an attach with the wrong token, and one to a task the host does not have", async () => {
		const host = makeServedHost()
		const manager = new TaskAttachmentManager(
			(target) =>
				new ShoferHttpClient({
					baseUrl: target.address,
					token: target.token,
					fetch: handlerFetch(host.handler),
				}),
		)

		// A rejected bearer surfaces as the "could not reach that host" error, with
		// the 401 carried in its interpolated cause (i18n is not initialized under
		// test, so only the key is asserted here).
		await expect(
			manager.attach(makeView(), { address: "http://worker:30099", taskId: "t1", token: "wrong" }),
		).rejects.toThrow(/attach.errors.unreachable/)

		await expect(
			manager.attach(makeView(), { address: "http://worker:30099", taskId: "nope", token: "s3cret" }),
		).rejects.toThrow(/attach.errors.no_such_task/)
	})
})
