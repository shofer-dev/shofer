import path from "path"
import { fileURLToPath } from "url"

import { getProviderDefaultModelId } from "@shofer/types"

import { ExtensionHost, type ExtensionHostOptions } from "@/agent/index.js"
import { getDefaultExtensionPath } from "@/lib/utils/extension.js"
import type { SupportedProvider } from "@/types/index.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export interface ServeOptions {
	port?: string
	host?: string
	workspace?: string
	extension?: string
	apiKey?: string
	provider?: string
	/** Base URL for the API provider (e.g. `http://localhost:30081/v1` for llm-router). */
	baseUrl?: string
	model?: string
	debug?: boolean
	/** Bearer token required on `/api/v1/*`. Falls back to `SHOFER_NODE_TOKEN`. */
	token?: string
}

/**
 * `shofer serve` — run the Shofer HTTP/SSE server over a headless extension host.
 *
 * Boots the agent, then exposes it on `http://<host>:<port>` via the versioned
 * task-control API + SSE event stream (see `@shofer/core` `createHttpServer`), which
 * the typed `ShoferHttpClient` SDK consumes. Runs until interrupted (SIGINT/SIGTERM).
 *
 * API Configuration: with NO `--provider`/`--model`/`--api-key`/`--base-url` flag,
 * the node has no manual override and each task runs on whatever API Configuration
 * the controlling VS Code front-end picked for it (per-task; shipped over the wire).
 * Pass any of those flags to pin the node to a fixed config that always wins.
 */
export async function serve(options: ServeOptions = {}): Promise<void> {
	// A manual override is any explicit provider/model/key/base-url flag. When none
	// are given the node defers to the controller's per-task API Configuration.
	const hasOverride = !!(options.provider || options.model || options.apiKey || options.baseUrl)
	const provider = (options.provider ?? "openrouter") as SupportedProvider
	const port = Number.parseInt(options.port ?? "30099", 10)
	const host = options.host ?? "127.0.0.1"
	const token = options.token ?? process.env.SHOFER_NODE_TOKEN

	const hostOptions: ExtensionHostOptions = {
		mode: "code",
		reasoningEffort: undefined,
		user: null,
		provider,
		model: options.model ?? getProviderDefaultModelId(provider),
		apiKey: options.apiKey,
		baseUrl: options.baseUrl,
		workspacePath: path.resolve(options.workspace || process.cwd()),
		extensionPath: path.resolve(options.extension || getDefaultExtensionPath(__dirname)),
		nonInteractive: true,
		ephemeral: false,
		debug: options.debug ?? false,
		exitOnComplete: false,
		exitOnError: false,
	}

	const extHost = new ExtensionHost(hostOptions)
	await extHost.activate()
	const server = extHost.serve({ port, host, token, allowClientConfig: !hasOverride })

	// Await the actual bind before claiming success — `listen()` is async, so without
	// this a taken port (EADDRINUSE) would print "serving on …" and then silently fail,
	// leaving requests to hit whatever else owns the port. Fail loudly instead.
	await new Promise<void>((resolve, reject) => {
		server.once("listening", () => resolve())
		server.once("error", (err) => reject(err))
	}).catch((err: NodeJS.ErrnoException) => {
		console.error(
			err.code === "EADDRINUSE"
				? `[shofer] port ${port} on ${host} is already in use — pick a free port with --port`
				: `[shofer] failed to start server: ${err.message}`,
		)
		process.exit(1)
	})

	console.error(
		`[shofer] serving on http://${host}:${port}${token ? " (token auth enabled)" : ""} · ` +
			(hasOverride ? `API config: pinned to ${provider} (CLI override)` : "API config: per-task from controller"),
	)

	await new Promise<void>((resolve) => {
		const shutdown = () => server.close(() => resolve())
		process.on("SIGINT", shutdown)
		process.on("SIGTERM", shutdown)
	})
}
