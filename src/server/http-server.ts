import http from "node:http"

/**
 * HTTP + SSE transport boundary (todos/opencode_inspired_work.md §11).
 *
 * shofer already has an in-process `ShoferAPI` and a headless NDJSON protocol;
 * §11 publishes that as a versioned, network-accessible surface so a TUI, web
 * client, or third-party tool can drive the agent — and a generated SDK can't
 * drift from it. This module is the transport itself: a small `node:http` server
 * (no framework dependency) exposing task control over HTTP and a one-way event
 * stream over SSE (`GET /api/event`), mirroring opencode's server shape.
 *
 * It is driven by an injected {@link AgentApi}, so the transport is testable in
 * isolation; wiring `AgentApi` to the live `ShoferAPI` (extension) or the headless
 * CLI agent is the follow-on, as is generating a typed SDK from the route set.
 */

export interface ServerEvent {
	type: string
	[key: string]: unknown
}

/** The agent surface the HTTP server exposes. Implemented over `ShoferAPI` / the CLI agent. */
export interface AgentApi {
	createTask(input: { prompt: string; taskId?: string }): Promise<{ taskId: string }>
	sendMessage(taskId: string, message: string): Promise<void>
	cancelTask(taskId: string): Promise<void>
	/** Subscribe to the agent event stream; returns an unsubscribe fn. */
	subscribe(listener: (event: ServerEvent) => void): () => void
}

const API_VERSION = "v1"

function send(res: http.ServerResponse, status: number, body: unknown): void {
	const json = JSON.stringify(body)
	res.writeHead(status, { "content-type": "application/json" })
	res.end(json)
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = []
	for await (const chunk of req) chunks.push(chunk as Buffer)
	const raw = Buffer.concat(chunks).toString("utf8")
	if (!raw) return {}
	return JSON.parse(raw) as Record<string, unknown>
}

/**
 * Create the shofer HTTP/SSE server. Routes (all under `/api/<version>` except
 * `/health`):
 *   GET  /health                     → liveness
 *   GET  /api/v1/event               → SSE event stream
 *   POST /api/v1/task                → { prompt, taskId? } → { taskId }
 *   POST /api/v1/task/:id/message    → { message }
 *   POST /api/v1/task/:id/cancel
 */
export function createHttpServer(api: AgentApi): http.Server {
	return http.createServer(createRequestHandler(api))
}

/**
 * The request handler (exported for testing without a real socket).
 */
export function createRequestHandler(api: AgentApi): (req: http.IncomingMessage, res: http.ServerResponse) => void {
	const base = `/api/${API_VERSION}`

	return (req, res) => {
		void handle(req, res).catch((error) => {
			send(res, 500, { error: error instanceof Error ? error.message : String(error) })
		})
	}

	async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", "http://localhost")
		const path = url.pathname
		const method = req.method ?? "GET"

		if (method === "GET" && path === "/health") {
			return send(res, 200, { status: "ok", version: API_VERSION })
		}

		if (method === "GET" && path === `${base}/event`) {
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			})
			const unsubscribe = api.subscribe((event) => {
				res.write(`data: ${JSON.stringify(event)}\n\n`)
			})
			req.on("close", unsubscribe)
			return
		}

		if (method === "POST" && path === `${base}/task`) {
			const body = await readJson(req)
			if (typeof body.prompt !== "string") return send(res, 400, { error: "prompt is required" })
			const result = await api.createTask({ prompt: body.prompt, taskId: body.taskId as string | undefined })
			return send(res, 201, result)
		}

		const taskMatch = path.match(new RegExp(`^${base}/task/([^/]+)/(message|cancel)$`))
		if (method === "POST" && taskMatch) {
			const [, taskId, action] = taskMatch
			if (action === "message") {
				const body = await readJson(req)
				if (typeof body.message !== "string") return send(res, 400, { error: "message is required" })
				await api.sendMessage(taskId, body.message)
				return send(res, 202, { taskId, accepted: true })
			}
			await api.cancelTask(taskId)
			return send(res, 202, { taskId, cancelled: true })
		}

		send(res, 404, { error: `no route for ${method} ${path}` })
	}
}
