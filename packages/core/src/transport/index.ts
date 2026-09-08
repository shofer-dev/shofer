import type { Server } from "node:http"
import type { Readable, Writable } from "node:stream"

import type { ShoferExtensionApi } from "@shofer/types"

import { Package } from "../shared/package.js"
import { ShoferApiAgent } from "./shofer-api-agent.js"
import { createHttpServer } from "./http-server.js"
import { STORE_SETTLE_MS, TurnDrain } from "./drain.js"
import { runAcpAgent } from "./run-acp-agent.js"

export * from "./http-server.js"
export * from "./drain.js"
export * from "./http-client.js"
export { ShoferApiAgent, FORWARDED_EVENTS, findOutstandingAsk } from "./shofer-api-agent.js"
export * from "./acp-mapping.js"
export * from "./acp-connection.js"
export * from "./acp-agent-server.js"
export { runAcpAgent } from "./run-acp-agent.js"

/** Default ceiling on a graceful shutdown's wait for the turns in flight. */
export const DEFAULT_DRAIN_GRACE_MS = 60_000

/**
 * A served node: the listening server, its drain registry, and the shutdown
 * that puts the two together.
 */
export interface ShoferHttpService {
	/** The listening server — bind errors and the `listening` event live here. */
	readonly server: Server
	/** The drain registry: what is in flight, and whether new turns are refused. */
	readonly drain: TurnDrain
	/**
	 * Stop serving gracefully and resolve with the number of turns that were
	 * STRANDED (still running when `graceMs` elapsed, and closed by this call).
	 * Zero is the healthy outcome. See {@link TurnDrain} for the semantics; the
	 * three listener steps here are the transport half:
	 *
	 *   - `drain.begin()` — new turns are refused from this instant, and
	 *     `/health` starts answering 503 so whatever selects over this node's
	 *     peers stops selecting it.
	 *   - `server.close()` — the listener stops accepting, so a NEW connection
	 *     gets a refused dial. That is deliberately the failure a pooled caller
	 *     fails over on; an answered status is not.
	 *   - `server.closeIdleConnections()` — a keep-alive socket a caller's
	 *     connection pool is holding would otherwise be picked for the next turn
	 *     and reset mid-request. Closing it now moves that caller onto a fresh
	 *     dial, which the closed listener then refuses cleanly.
	 *
	 * Connections currently serving a response — every turn's event stream — are
	 * untouched by all three and run to completion.
	 */
	shutdown(opts?: { graceMs?: number; settleMs?: number }): Promise<number>
}

/**
 * Start the HTTP/SSE server over a live {@link ShoferExtensionApi} and begin listening. The
 * single entrypoint the `shofer serve` command calls.
 *
 * `allowClientConfig` lets the controller's per-task API Configuration drive each
 * task (set when the node was started without CLI provider/model/key/url overrides).
 *
 * Serving is also what makes this host REMOTELY DRIVEN: `shofer serve` always
 * starts its ask dispatcher with `brokerInteractiveAsks`, so an interactive ask
 * here is answered by a subscribed controller or by nobody at all.
 */
export function serveHttpOverShoferApi(
	api: ShoferExtensionApi,
	opts: { port: number; host?: string; token?: string; version?: string; allowClientConfig?: boolean },
): ShoferHttpService {
	const agent = new ShoferApiAgent(api, { allowClientConfig: opts.allowClientConfig })
	const drain = new TurnDrain()
	const server = createHttpServer(agent, {
		token: opts.token,
		version: opts.version ?? Package.version,
		drain,
	})
	server.listen(opts.port, opts.host)
	return {
		server,
		drain,
		async shutdown({ graceMs = DEFAULT_DRAIN_GRACE_MS, settleMs = STORE_SETTLE_MS } = {}) {
			drain.begin()
			server.close()
			server.closeIdleConnections()
			return drain.settle({ graceMs, settleMs })
		},
	}
}

/**
 * Run the ACP agent over a live {@link ShoferExtensionApi} (the extension's control plane),
 * bridged through {@link ShoferApiAgent}. This is the single entrypoint a headless
 * front-end (the `shofer acp` CLI command) calls: give it the activated ShoferExtensionApi
 * and the stdio streams, and an ACP client can drive the agent.
 */
export function runAcpAgentOverShoferApi(
	api: ShoferExtensionApi,
	streams: { input: Readable; output: Writable; agentVersion?: string },
): Promise<void> {
	return runAcpAgent(new ShoferApiAgent(api), streams)
}
