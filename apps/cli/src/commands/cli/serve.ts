import path from "path"
import { fileURLToPath } from "url"

import { getProviderDefaultModelId, ShoferEventName, type TokenUsage } from "@shofer/types"

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
	/** Suppress the live per-task activity log on stderr (on by default). */
	quiet?: boolean
	/**
	 * Where this node keeps its own state (default `$HOME/.vscode-mock`). Falls back
	 * to `SHOFER_STATE_DIR`. Give each node a private directory when several share a
	 * filesystem — the store is SQLite, so nodes pointed at one directory would be N
	 * writers on one database.
	 */
	stateDir?: string
	/**
	 * Interactive approvals — how an ask is HANDLED locally, not which tools raise
	 * one. A served node's approval posture comes from its own layered
	 * `.shofer/settings.json` and nothing else: the host seeds
	 * `autoApprovalEnabled: false` and leaves every other posture key absent, where
	 * absent denies, so a tool auto-approves only where a scope states it `true`.
	 * Whatever this flag is set to, an ask the posture does not pre-approve is
	 * raised over ShoferApi for the driving controller to broker to its user and
	 * answer via `respondToAsk`. The startup banner prints the resolved posture and
	 * its source.
	 */
	interactive?: boolean
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
	// Resilience: a single task's uncaught error must NOT take down the whole node
	// — it serves many tasks (and, in SaaS, many users). Log and keep serving
	// instead of letting an unhandled rejection/exception exit the process (e.g. a
	// misconfigured task throwing deep in the agent loop). The owning task still
	// fails and surfaces its error over ShoferApi; the server stays up.
	process.on("unhandledRejection", (reason) => {
		const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
		console.error(`[shofer] unhandledRejection (task error; node stays up): ${detail}`)
	})
	process.on("uncaughtException", (err) => {
		console.error(`[shofer] uncaughtException (task error; node stays up): ${err.stack ?? err.message}`)
	})

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
		// No local stdin user by default. This decides how the node HANDLES an ask,
		// not which tools raise one — the posture is the node's `.shofer/` config, and
		// no seed is stated here, so a served node auto-approves only what a scope
		// grants it (`approval-posture.ts`).
		nonInteractive: !options.interactive,
		// A served node is always driven by a remote controller, never a local stdin
		// user — so interactive asks (approvals + followup questions) are ALWAYS
		// brokered to the controller, not prompted/auto-answered on the node, under
		// either setting of `--interactive`.
		brokerInteractiveAsks: true,
		ephemeral: false,
		storageDir: options.stateDir ?? process.env.SHOFER_STATE_DIR,
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
			(hasOverride
				? `API config: pinned to ${provider} (CLI override)`
				: "API config: per-task from controller") +
			// The posture is resolved, not assumed: the built-in default auto-approves
			// nothing, and only the node's own `.shofer/` config widens it. Printing the
			// resolved summary (rather than echoing the launch flags) is what makes a
			// config-driven posture visible — a node silently gating, or silently
			// un-gating, every stake is the failure this line exists to prevent.
			` · approvals: ${extHost.approvalPosture.summary}`,
	)

	// Live per-task activity on stderr. Headless mode stubs console.log/warn/info to
	// no-ops (ExtensionHost.setupQuietMode), so a running task is otherwise invisible
	// without `--debug` (which only writes ~/.shofer/cli-debug.log). stderr survives
	// quiet mode, so a concise lifecycle line per task confirms the node is working.
	if (!options.quiet) {
		wireActivityLog(extHost.api)
	}

	await new Promise<void>((resolve) => {
		const shutdown = () => server.close(() => resolve())
		process.on("SIGINT", shutdown)
		process.on("SIGTERM", shutdown)
	})
}

/**
 * Subscribe to the node's task lifecycle and print one concise `[shofer]` line per
 * event to **stderr** (not suppressed by headless quiet mode). Deliberately terse —
 * created / started / completed (with tokens + cost) / aborted / error — so a test
 * node shows it's doing work without the volume of `--debug`'s file log.
 */
function wireActivityLog(api: ExtensionHost["api"]): void {
	const short = (id: string) => id.slice(0, 8)
	api.on(ShoferEventName.TaskCreated, (taskId: string) => {
		console.error(`[shofer] task ${short(taskId)} created`)
	})
	api.on(ShoferEventName.TaskStarted, (taskId: string) => {
		console.error(`[shofer] task ${short(taskId)} started`)
	})
	api.on(ShoferEventName.TaskCompleted, (taskId: string, usage: TokenUsage) => {
		const cost = usage?.totalCost != null ? `$${usage.totalCost.toFixed(4)}` : "?"
		console.error(
			`[shofer] task ${short(taskId)} completed · ` +
				`${usage?.totalTokensIn ?? "?"} in / ${usage?.totalTokensOut ?? "?"} out · ${cost}`,
		)
	})
	api.on(ShoferEventName.TaskAborted, (taskId: string, info: { reason: string }) => {
		console.error(`[shofer] task ${short(taskId)} aborted (${info?.reason ?? "?"})`)
	})
	api.on(ShoferEventName.TaskError, (taskId: string, errorType: string) => {
		console.error(`[shofer] task ${short(taskId)} error: ${errorType}`)
	})
}
