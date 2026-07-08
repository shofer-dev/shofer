import http from "node:http"
import os from "node:os"

import type {
	AgentApi,
	CheckpointDiffOptions,
	CheckpointRestoreOptions,
	ProviderSettings,
	SyncedSettings,
} from "@shofer/types"

/**
 * HTTP + SSE transport boundary (v3 architecture §11).
 *
 * shofer already has an in-process `ShoferAPI` and a headless NDJSON protocol;
 * §11 publishes that as a versioned, network-accessible surface so a TUI, web
 * client, or third-party tool can drive the agent — and a generated SDK can't
 * drift from it. This module is the transport itself: a small `node:http` server
 * (no framework dependency) exposing task control over HTTP and a one-way event
 * stream over SSE (`GET /api/event`).
 *
 * It is driven by an injected {@link AgentApi} (now defined in `@shofer/types` and
 * re-exported here), so the transport is testable in isolation.
 */

export type { AgentApi, ServerEvent } from "@shofer/types"

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

/** Options for the HTTP/SSE server (auth + version handshake, §Shofer Nodes L1). */
export interface HttpServerOptions {
	/**
	 * Optional bearer token. When set, every `/api/v1/*` route requires
	 * `Authorization: Bearer <token>` (→ `401` when missing/wrong). `/health`
	 * stays open (liveness only). Unset → no auth (loopback/dev default).
	 */
	token?: string
	/**
	 * The controller/agent build version this executor reports. Surfaced on the
	 * open `/health` and the authed `/whoami` so a controller can enforce that
	 * node and controller run the exact same shofer version before connecting.
	 */
	version?: string
	/**
	 * The node's applied config-sync version (config_sync §6), surfaced on
	 * `/health` and `/whoami` so the controller detects drift.
	 */
	getConfigVersion?: () => string | undefined
	/**
	 * Whether this node accepts controller config (config_sync §Part A). Surfaced on
	 * `/health` and `/whoami` so the controller EXEMPTS a self-administered node
	 * (`false`) from config-version pool-gating — it serves tasks on its own config.
	 */
	getManaged?: () => boolean
}

/**
 * Create the shofer HTTP/SSE server. Routes (all under `/api/<version>` except
 * `/health`):
 *   GET  /health                     → liveness + version + load metrics (loadavg, cpus) + configVersion (open)
 *   GET  /api/v1/whoami              → { version, configVersion } (authed; one-shot liveness+version+auth)
 *   POST /api/v1/config              → { config, version } → 202 (controller→node config sync, §config_sync)
 *   GET  /api/v1/event               → SSE event stream
 *   POST /api/v1/task                → { prompt, taskId?, apiConfiguration? } → { taskId }
 *   POST /api/v1/task/:id/message    → { message }
 *   POST /api/v1/task/:id/cancel
 *   POST /api/v1/task/:id/ask        → { askResponse, text?, images?, askId? } (interactive approval)
 *   POST /api/v1/task/:id/checkpoint-diff     → CheckpointDiffOptions → 200 CheckpointDiffEntry[]  (L3)
 *   POST /api/v1/task/:id/checkpoint-restore  → CheckpointRestoreOptions → 202                     (L3)
 *   GET  /api/v1/task/:id/changed-files       → 200 ChangedFilesPayload                            (L3)
 *   POST /api/v1/task/:id/changed-files/diff  → { relPath } → 200 { original, final }              (L3)
 *   POST /api/v1/task/:id/changed-files/revert→ { relPath? } → 202 (one file, or all when omitted) (L3)
 *   POST /api/v1/task/:id/changed-files/accept→ { relPath? } → 202 (one file, or all when omitted) (L3)
 */
export function createHttpServer(api: AgentApi, opts: HttpServerOptions = {}): http.Server {
	return http.createServer(createRequestHandler(api, opts))
}

/**
 * The request handler (exported for testing without a real socket).
 */
export function createRequestHandler(
	api: AgentApi,
	opts: HttpServerOptions = {},
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
	const base = `/api/${API_VERSION}`
	const { token, version, getConfigVersion, getManaged } = opts

	return (req, res) => {
		void handle(req, res).catch((error) => {
			send(res, 500, { error: error instanceof Error ? error.message : String(error) })
		})
	}

	async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", "http://localhost")
		const path = url.pathname
		const method = req.method ?? "GET"

		// Open liveness probe — never gated by the bearer token. Also the
		// load-metric channel: `loadavg`/`cpus` let a controller's ExecutorPool
		// run a load-average LB policy (Shofer Nodes).
		if (method === "GET" && path === "/health") {
			return send(res, 200, {
				ok: true,
				version,
				loadavg: os.loadavg(),
				cpus: os.cpus().length,
				configVersion: getConfigVersion?.(),
				managed: getManaged?.(),
			})
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
			return send(res, 200, { version, configVersion: getConfigVersion?.(), managed: getManaged?.() })
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

		if (method === "POST" && path === `${base}/config`) {
			const body = await readJson(req)
			if (typeof body.version !== "string") return send(res, 400, { error: "version is required" })
			await api.applyConfig(body.config as SyncedSettings, body.version)
			return send(res, 202, { applied: true })
		}

		if (method === "POST" && path === `${base}/task`) {
			const body = await readJson(req)
			if (typeof body.prompt !== "string") return send(res, 400, { error: "prompt is required" })
			const result = await api.createTask({
				prompt: body.prompt,
				taskId: body.taskId as string | undefined,
				// Per-task API Configuration shipped by the controller. Honored only
				// when this node has no local CLI override (gated in ShoferApiAgent).
				apiConfiguration: body.apiConfiguration as ProviderSettings | undefined,
			})
			return send(res, 201, result)
		}

		const taskMatch = path.match(new RegExp(`^${base}/task/([^/]+)/(message|cancel|ask)$`))
		if (method === "POST" && taskMatch) {
			const taskId = taskMatch[1]!
			const action = taskMatch[2]!
			if (action === "message") {
				const body = await readJson(req)
				if (typeof body.message !== "string") return send(res, 400, { error: "message is required" })
				await api.sendMessage(taskId, body.message)
				return send(res, 202, { taskId, accepted: true })
			}
			if (action === "ask") {
				const body = await readJson(req)
				if (typeof body.askResponse !== "string") return send(res, 400, { error: "askResponse is required" })
				await api.respondToAsk(taskId, {
					askResponse: body.askResponse,
					text: body.text as string | undefined,
					images: body.images as string[] | undefined,
					askId: body.askId as string | undefined,
				})
				return send(res, 202, { taskId, answered: true })
			}
			await api.cancelTask(taskId)
			return send(res, 202, { taskId, cancelled: true })
		}

		// ── Reverse data channel (Shofer Nodes L3) — remote checkpoint + changed-files ──

		// GET the task's changed-files panel payload.
		const changedFilesGet = path.match(new RegExp(`^${base}/task/([^/]+)/changed-files$`))
		if (method === "GET" && changedFilesGet) {
			const taskId = decodeURIComponent(changedFilesGet[1]!)
			return send(res, 200, await api.getTaskChangedFiles(taskId))
		}

		// POST-with-body for the remaining L3 routes (data + execute).
		const l3Match = path.match(
			new RegExp(
				`^${base}/task/([^/]+)/(checkpoint-diff|checkpoint-restore|changed-files/diff|changed-files/revert|changed-files/accept)$`,
			),
		)
		if (method === "POST" && l3Match) {
			const taskId = decodeURIComponent(l3Match[1]!)
			const action = l3Match[2]!
			const body = await readJson(req)

			if (action === "checkpoint-diff") {
				if (typeof body.commitHash !== "string") return send(res, 400, { error: "commitHash is required" })
				const changes = await api.getCheckpointDiff(taskId, body as unknown as CheckpointDiffOptions)
				return send(res, 200, changes)
			}
			if (action === "checkpoint-restore") {
				if (typeof body.commitHash !== "string") return send(res, 400, { error: "commitHash is required" })
				await api.restoreCheckpoint(taskId, body as unknown as CheckpointRestoreOptions)
				return send(res, 202, { taskId, restored: true })
			}
			if (action === "changed-files/diff") {
				if (typeof body.relPath !== "string") return send(res, 400, { error: "relPath is required" })
				return send(res, 200, await api.getChangedFileDiff(taskId, body.relPath))
			}
			// revert / accept: a `relPath` scopes to one file; its absence targets all.
			const relPath = typeof body.relPath === "string" ? body.relPath : undefined
			if (action === "changed-files/revert") {
				if (relPath !== undefined) await api.revertChangedFile(taskId, relPath)
				else await api.revertAllChangedFiles(taskId)
				return send(res, 202, { taskId, reverted: true })
			}
			// changed-files/accept
			if (relPath !== undefined) await api.acceptChangedFile(taskId, relPath)
			else await api.acceptAllChangedFiles(taskId)
			return send(res, 202, { taskId, accepted: true })
		}

		send(res, 404, { error: `no route for ${method} ${path}` })
	}
}
