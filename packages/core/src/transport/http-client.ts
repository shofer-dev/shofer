import { taskSnapshotSchema } from "@shofer/types"

import type { ShoferApi, AskResponse, CreateTaskInput, ServerEvent, TaskSnapshot } from "@shofer/types"

/**
 * Typed HTTP/SSE client SDK for the shofer server (v3 architecture §11).
 *
 * It **implements `ShoferApi`** — the exact contract the server exposes — so client
 * and server share one source of truth and cannot drift: any change to the agent
 * surface is a compile error on both sides. `createTask`/`sendMessage`/`cancelTask`
 * are POSTs; `subscribe` reads the SSE event stream. `fetch` is injectable for tests.
 */
export interface ShoferHttpClientOptions {
	/** Base URL of the server, e.g. `http://127.0.0.1:30099`. */
	baseUrl: string
	/** Bearer token sent as `Authorization: Bearer <token>` on every request (when the server requires auth). */
	token?: string
	/** Override for tests / non-global fetch. */
	fetch?: typeof fetch
}

export class ShoferHttpClient implements ShoferApi {
	private readonly base: string
	private readonly doFetch: typeof fetch
	private readonly authHeaders: Record<string, string>

	constructor(options: ShoferHttpClientOptions) {
		this.base = `${options.baseUrl.replace(/\/$/, "")}/api/v1`
		this.doFetch = options.fetch ?? fetch
		this.authHeaders = options.token ? { authorization: `Bearer ${options.token}` } : {}
	}

	async createTask(input: CreateTaskInput): Promise<{ taskId: string }> {
		// The whole input (incl. `apiConfiguration`, when present) is forwarded as
		// the POST body — the server applies the config per-task unless it has a
		// local CLI override.
		return (await this.post("/task", input)) as { taskId: string }
	}

	async sendMessage(taskId: string, message: string, images?: string[]): Promise<void> {
		await this.post(`/task/${encodeURIComponent(taskId)}/message`, { message, images })
	}

	async cancelTask(taskId: string): Promise<void> {
		await this.post(`/task/${encodeURIComponent(taskId)}/cancel`, {})
	}

	async respondToAsk(taskId: string, response: AskResponse): Promise<void> {
		await this.post(`/task/${encodeURIComponent(taskId)}/ask`, response)
	}

	/**
	 * Backfill a task's state so far. `undefined` when the server has no such task
	 * (404) — the one status this method treats as an answer rather than a failure,
	 * because "that task does not live here" is information the caller acts on.
	 *
	 * The body is validated against `taskSnapshotSchema`: a snapshot from a host on
	 * a different build must fail closed rather than be rendered as `any`.
	 */
	async getTaskSnapshot(taskId: string): Promise<TaskSnapshot | undefined> {
		const body = await this.get(`/task/${encodeURIComponent(taskId)}/snapshot`, { notFoundAsUndefined: true })
		if (body === undefined) return undefined
		const parsed = taskSnapshotSchema.safeParse(body)
		if (!parsed.success) throw new Error(`shofer server returned an unreadable task snapshot for ${taskId}`)
		return parsed.data
	}

	// ── Reverse data channel ──────────────────────────────────────────────────────

	async pluginRequest(taskId: string, plugin: string, method: string, params?: unknown): Promise<unknown> {
		// Wrapped server-side (`{ result }`) so a plugin returning a bare value —
		// `null`, a string, an array — still travels as a JSON object body.
		const body = (await this.post(`/task/${encodeURIComponent(taskId)}/plugin-request`, {
			plugin,
			method,
			params,
		})) as { result: unknown }
		return body?.result
	}

	/** Subscribe to the SSE event stream; returns an unsubscribe fn (aborts the request). */
	subscribe(listener: (event: ServerEvent) => void): () => void {
		const controller = new AbortController()
		void this.streamEvents("/event", listener, controller.signal)
		return () => controller.abort()
	}

	/**
	 * Subscribe to ONE task's events (`GET /api/v1/task/:id/event`); returns an
	 * unsubscribe fn. Not part of {@link ShoferApi} — that interface's `subscribe`
	 * is the whole-host firehose — but it is what an attached view wants: a
	 * connection that exists only while something is watching that task, carrying
	 * only that task's content.
	 */
	subscribeTask(taskId: string, listener: (event: ServerEvent) => void): () => void {
		const controller = new AbortController()
		void this.streamEvents(`/task/${encodeURIComponent(taskId)}/event`, listener, controller.signal)
		return () => controller.abort()
	}

	private async get(path: string, opts: { notFoundAsUndefined?: boolean } = {}): Promise<unknown> {
		const res = await this.doFetch(`${this.base}${path}`, {
			method: "GET",
			headers: { ...this.authHeaders },
		})
		if (res.status === 404 && opts.notFoundAsUndefined) return undefined
		if (!res.ok) throw new Error(`shofer server ${path} → ${res.status}`)
		const text = await res.text()
		return text ? JSON.parse(text) : undefined
	}

	private async post(path: string, body: unknown): Promise<unknown> {
		const res = await this.doFetch(`${this.base}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", ...this.authHeaders },
			body: JSON.stringify(body),
		})
		if (!res.ok) throw new Error(`shofer server ${path} → ${res.status}`)
		const text = await res.text()
		return text ? JSON.parse(text) : undefined
	}

	private async streamEvents(
		path: string,
		listener: (event: ServerEvent) => void,
		signal: AbortSignal,
	): Promise<void> {
		let res: Response
		try {
			res = await this.doFetch(`${this.base}${path}`, {
				headers: { accept: "text/event-stream", ...this.authHeaders },
				signal,
			})
		} catch {
			return // aborted or connection failed
		}
		if (!res.body) return
		const reader = res.body.getReader()
		const decoder = new TextDecoder()
		let buffer = ""
		try {
			for (;;) {
				const { done, value } = await reader.read()
				if (done) break
				buffer += decoder.decode(value, { stream: true })
				// SSE frames are separated by a blank line; each carries `data:` lines.
				let sep: number
				while ((sep = buffer.indexOf("\n\n")) !== -1) {
					const frame = buffer.slice(0, sep)
					buffer = buffer.slice(sep + 2)
					const data = frame
						.split("\n")
						.filter((l) => l.startsWith("data:"))
						.map((l) => l.slice(5).trim())
						.join("\n")
					if (!data) continue
					try {
						listener(JSON.parse(data) as ServerEvent)
					} catch {
						// skip unparseable frames (e.g. comments/heartbeats)
					}
				}
			}
		} catch {
			// stream ended / aborted
		}
	}
}
