import type { AgentApi, AskResponse, ServerEvent } from "@shofer/types"

/**
 * Typed HTTP/SSE client SDK for the shofer server (v3 architecture §11).
 *
 * It **implements `AgentApi`** — the exact contract the server exposes — so client
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

export class ShoferHttpClient implements AgentApi {
	private readonly base: string
	private readonly doFetch: typeof fetch
	private readonly authHeaders: Record<string, string>

	constructor(options: ShoferHttpClientOptions) {
		this.base = `${options.baseUrl.replace(/\/$/, "")}/api/v1`
		this.doFetch = options.fetch ?? fetch
		this.authHeaders = options.token ? { authorization: `Bearer ${options.token}` } : {}
	}

	async createTask(input: { prompt: string; taskId?: string }): Promise<{ taskId: string }> {
		return (await this.post("/task", input)) as { taskId: string }
	}

	async sendMessage(taskId: string, message: string): Promise<void> {
		await this.post(`/task/${encodeURIComponent(taskId)}/message`, { message })
	}

	async cancelTask(taskId: string): Promise<void> {
		await this.post(`/task/${encodeURIComponent(taskId)}/cancel`, {})
	}

	async respondToAsk(taskId: string, response: AskResponse): Promise<void> {
		await this.post(`/task/${encodeURIComponent(taskId)}/ask`, response)
	}

	/** Subscribe to the SSE event stream; returns an unsubscribe fn (aborts the request). */
	subscribe(listener: (event: ServerEvent) => void): () => void {
		const controller = new AbortController()
		void this.streamEvents(listener, controller.signal)
		return () => controller.abort()
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

	private async streamEvents(listener: (event: ServerEvent) => void, signal: AbortSignal): Promise<void> {
		let res: Response
		try {
			res = await this.doFetch(`${this.base}/event`, {
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
