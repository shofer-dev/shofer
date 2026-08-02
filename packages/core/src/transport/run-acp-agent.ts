import * as readline from "node:readline"
import type { Readable, Writable } from "node:stream"

import type { ShoferApi } from "@shofer/types"

import { JsonRpcPeer, type JsonRpcMessage } from "./acp-connection.js"
import { AcpAgentServer } from "./acp-agent-server.js"

/**
 * Run the ACP agent over a pair of streams (stdio for the `shofer acp` entrypoint,
 * in-memory streams for tests). Reads one JSON-RPC object per line from `input` and
 * writes one per line to `output`. Resolves when `input` closes.
 */
export function runAcpAgent(
	api: ShoferApi,
	{ input, output, agentVersion }: { input: Readable; output: Writable; agentVersion?: string },
): Promise<void> {
	const peer = new JsonRpcPeer((frame) => output.write(frame + "\n"))
	const server = new AcpAgentServer({ api, peer, agentVersion })

	const rl = readline.createInterface({ input, crlfDelay: Infinity })
	rl.on("line", (line) => {
		const trimmed = line.trim()
		if (!trimmed) return
		let msg: JsonRpcMessage
		try {
			msg = JSON.parse(trimmed) as JsonRpcMessage
		} catch {
			return // ignore malformed frames
		}
		void peer.receive(msg)
	})

	return new Promise<void>((resolve) => {
		rl.on("close", () => {
			server.dispose()
			resolve()
		})
	})
}
