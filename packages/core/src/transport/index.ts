import type { Readable, Writable } from "node:stream"

import type { ShoferAPI } from "@shofer/types"

import { ShoferApiAgent } from "./shofer-api-agent.js"

import { runAcpAgent } from "./run-acp-agent.js"

export * from "./http-server.js"
export { ShoferApiAgent } from "./shofer-api-agent.js"
export * from "./acp-mapping.js"
export * from "./acp-connection.js"
export * from "./acp-agent-server.js"
export { runAcpAgent } from "./run-acp-agent.js"

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
