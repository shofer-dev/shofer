/**
 * Prometheus metrics HTTP server for the Shofer VS Code extension.
 *
 * Binds to `127.0.0.1:<SHOFER_METRICS_PORT>` (default 30099) during
 * extension activation.  The port is static so Prometheus can be pointed
 * at a fixed target without a file-SD sidecar.  Each VS Code window still
 * writes a per-PID file under `globalStorage/metrics-ports/` carrying
 * windowId / workspace metadata for labelling.
 *
 * If the port is already bound (e.g. a second VS Code window on the same
 * host), `startMetricsServer` rejects — the caller should surface the
 * error via the output channel.
 *
 * ## Endpoints
 *
 * | Path     | Method | Description                                          |
 * |----------|--------|------------------------------------------------------|
 * | `/metrics` | GET   | Prometheus text format exposition.                  |
 * | `/health`  | GET   | `200 OK` when provider is initialised; `503` before. |
 *
 * Binds to `127.0.0.1` only — unreachable from remote hosts; no auth.
 *
 * Configure the port via the `SHOFER_METRICS_PORT` environment variable.
 */

import * as http from "http"
import * as path from "path"
import * as fs from "fs/promises"
import { outputLog, outputError } from "../utils/outputChannelLogger"
import { registry, incMetricsScrape, recordMetricsScrapeDuration, incMetricsServerRestart } from "./registry"
import { getWindowId, setWorkspaceLabel } from "./identity"

const PORT_DIR = "metrics-ports"

/** Static port the metrics server listens on. Configurable via env var. */
const METRICS_PORT = parseInt(process.env.SHOFER_METRICS_PORT ?? "30099", 10)

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let _server: http.Server | undefined
let _serverPort: number | undefined
let _providerReady = false
let _portFilePath: string | undefined

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

function buildRequestHandler(readyCheck: () => boolean) {
	return (req: http.IncomingMessage, res: http.ServerResponse) => {
		if (req.method !== "GET" || !req.url) {
			res.writeHead(404, { "Content-Type": "text/plain" })
			res.end("Not Found\n")
			return
		}
		const url = new URL(req.url, "http://127.0.0.1")
		if (url.pathname === "/metrics") {
			const t0 = performance.now()
			// `registry.exposition()` is async because prom-client's
			// `Registry.metrics()` returns a Promise (it `await`s any
			// registered async `collect()` callbacks).
			registry
				.exposition()
				.then((body) => {
					res.writeHead(200, { "Content-Type": registry.contentType })
					res.end(body)
					recordMetricsScrapeDuration(performance.now() - t0)
					incMetricsScrape()
				})
				.catch((err) => {
					outputError("[metrics-server] exposition failed:", err)
					res.writeHead(500, { "Content-Type": "text/plain" })
					res.end("Internal Server Error\n")
				})
			return
		}
		if (url.pathname === "/health") {
			if (readyCheck()) {
				res.writeHead(200, { "Content-Type": "text/plain" })
				res.end("OK\n")
			} else {
				res.writeHead(503, { "Content-Type": "text/plain" })
				res.end("Service Unavailable\n")
			}
			return
		}
		res.writeHead(404, { "Content-Type": "text/plain" })
		res.end("Not Found\n")
	}
}

// ---------------------------------------------------------------------------
// Per-PID port file management
// ---------------------------------------------------------------------------

interface PortFile {
	pid: number
	windowId: string
	port: number
	workspace: string | undefined
	startedAt: string
}

async function writePortFile(globalStoragePath: string, port: number, workspace: string | undefined): Promise<void> {
	try {
		const dir = path.join(globalStoragePath, PORT_DIR)
		await fs.mkdir(dir, { recursive: true })
		const filePath = path.join(dir, `${process.pid}-${getWindowId()}.json`)
		const payload: PortFile = {
			pid: process.pid,
			windowId: getWindowId(),
			port,
			workspace,
			startedAt: new Date().toISOString(),
		}
		await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8")
		_portFilePath = filePath
	} catch (err) {
		outputError("[metrics-server] Failed to write port file:", err)
		incMetricsServerRestart()
	}
}

async function deletePortFile(): Promise<void> {
	if (!_portFilePath) return
	try {
		await fs.unlink(_portFilePath)
	} catch {
		// Best-effort cleanup; absence is fine.
	} finally {
		_portFilePath = undefined
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the metrics HTTP server.  Idempotent — second call is a no-op
 * and logs the existing port.
 */
export async function startMetricsServer(
	globalStoragePath: string,
	workspace?: string,
	onReady?: (port: number) => void,
): Promise<void> {
	if (_server) {
		outputLog("[metrics-server] Already started on port", _serverPort)
		return
	}

	// Make the workspace path visible to the `shofer_window_info` gauge
	// before the first scrape.
	setWorkspaceLabel(workspace)

	return new Promise((resolve, reject) => {
		_server = http.createServer(buildRequestHandler(() => _providerReady))

		_server.on("error", (err) => {
			outputError("[metrics-server] Server error:", err)
			// Propagate bind-time errors (e.g. EADDRINUSE) so the caller can
			// log a clear message rather than silently losing metrics.
			if (!_serverPort) {
				_server = undefined
				reject(err)
			}
		})

		_server.listen(METRICS_PORT, "127.0.0.1", () => {
			_serverPort = (_server!.address() as { port: number }).port
			outputLog(`[metrics-server] Listening on 127.0.0.1:${_serverPort} (windowId=${getWindowId()})`)
			void writePortFile(globalStoragePath, _serverPort, workspace)
			if (onReady) onReady(_serverPort)
			resolve()
		})
	})
}

/**
 * Mark the provider as initialised — `/health` starts returning 200.
 */
export function setProviderReady(): void {
	_providerReady = true
}

/** Stop the metrics server and remove the port file. */
export async function stopMetricsServer(): Promise<void> {
	await deletePortFile()
	return new Promise((resolve) => {
		if (!_server) {
			resolve()
			return
		}
		_server.close(() => {
			_server = undefined
			_serverPort = undefined
			_providerReady = false
			resolve()
		})
	})
}

/** Current server port if running. */
export function getMetricsPort(): number | undefined {
	return _serverPort
}
