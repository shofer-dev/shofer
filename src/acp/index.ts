import type { Readable, Writable } from "node:stream"

import type { ShoferAPI } from "@shofer/types"

import { ShoferApiAgent } from "../server/shofer-api-agent"

import { runAcpAgent } from "./run-acp-agent"

export * from "./acp-mapping"
export * from "./acp-connection"
export * from "./acp-agent-server"
export { runAcpAgent } from "./run-acp-agent"

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
