import type { Server } from "node:http"
import type { Readable, Writable } from "node:stream"

import type { ShoferAPI } from "@shofer/types"

import { Package } from "../shared/package.js"
import { ShoferApiAgent } from "./shofer-api-agent.js"
import { createHttpServer } from "./http-server.js"
import { runAcpAgent } from "./run-acp-agent.js"

export * from "./http-server.js"
export * from "./http-client.js"
export { ShoferApiAgent } from "./shofer-api-agent.js"
export * from "./acp-mapping.js"
export * from "./acp-connection.js"
export * from "./acp-agent-server.js"
export { runAcpAgent } from "./run-acp-agent.js"

/**
 * Start the HTTP/SSE server over a live {@link ShoferAPI} and begin listening. The
 * single entrypoint the `shofer serve` command calls. Returns the listening server.
 */
export function serveHttpOverShoferApi(
	api: ShoferAPI,
	opts: { port: number; host?: string; token?: string; version?: string },
): Server {
	const server = createHttpServer(new ShoferApiAgent(api), {
		token: opts.token,
		version: opts.version ?? Package.version,
	})
	server.listen(opts.port, opts.host)
	return server
}

/**
 * Run the ACP agent over a live {@link ShoferAPI} (the extension's control plane),
 * bridged through {@link ShoferApiAgent}. This is the single entrypoint a headless
 * front-end (the `shofer acp` CLI command) calls: give it the activated ShoferAPI
 * and the stdio streams, and an ACP client can drive the agent.
 */
export function runAcpAgentOverShoferApi(
	api: ShoferAPI,
	streams: { input: Readable; output: Writable; agentVersion?: string },
): Promise<void> {
	return runAcpAgent(new ShoferApiAgent(api), streams)
}
