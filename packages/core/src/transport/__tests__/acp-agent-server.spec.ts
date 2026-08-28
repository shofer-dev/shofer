import { describe, it, expect, vi } from "vitest"

import type { ShoferApi, ServerEvent } from "@shofer/types"
import { JsonRpcPeer, type JsonRpcMessage } from "../acp-connection.js"
import { AcpAgentServer } from "../acp-agent-server.js"

/** A mock ShoferApi whose event stream the test drives directly. */
function makeApi() {
	let emit: (e: ServerEvent) => void = () => {}
	const api: ShoferApi = {
		createTask: vi.fn(async () => ({ taskId: "t1" })),
		sendMessage: vi.fn(async () => {}),
		cancelTask: vi.fn(async () => {}),
		respondToAsk: vi.fn(async () => {}),
		getTaskSnapshot: vi.fn(async (taskId: string) => ({ taskId, messages: [] })),
		deliverToMailbox: vi.fn(async () => {}),
		pluginRequest: vi.fn(async () => null),
		subscribe: (listener) => {
			emit = listener
			return () => {}
		},
	}
	return { api, emit: (e: ServerEvent) => emit(e) }
}

function makeServer() {
	const out: JsonRpcMessage[] = []
	const peer = new JsonRpcPeer((frame) => out.push(JSON.parse(frame)))
	const { api, emit } = makeApi()
	new AcpAgentServer({ api, peer, agentVersion: "9.9.9" })
	return { peer, out, api, emit }
}

const reply = (out: JsonRpcMessage[], id: number) =>
	out.find((m) => (m as { id?: number }).id === id) as
		| { result?: { sessionId?: string; stopReason?: string; protocolVersion?: number; agentVersion?: string } }
		| undefined

describe("AcpAgentServer", () => {
	it("initialize returns the protocol version + agent version", async () => {
		const { peer, out } = makeServer()
		await peer.receive({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
		expect(reply(out, 1)?.result).toMatchObject({ protocolVersion: 1, agentVersion: "9.9.9" })
	})

	it("session/new allocates a session id", async () => {
		const { peer, out } = makeServer()
		await peer.receive({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} })
		expect(reply(out, 1)?.result?.sessionId).toMatch(/^sess-/)
	})

	it("session/prompt creates a task, streams updates, and resolves on TaskCompleted", async () => {
		const { peer, out, api, emit } = makeServer()
		await peer.receive({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} })
		const sessionId = reply(out, 1)!.result!.sessionId

		// prompt is a long-lived request; don't await it until the turn ends.
		const prompted = peer.receive({
			jsonrpc: "2.0",
			id: 2,
			method: "session/prompt",
			params: { sessionId, prompt: [{ type: "text", text: "hello" }] },
		})
		await Promise.resolve()
		expect(api.createTask).toHaveBeenCalledWith({ prompt: "hello", mode: "code" })

		// A streamed assistant chunk → session/update notification for this session.
		emit({ type: "text", taskId: "t1", text: "hi there" } as ServerEvent)
		const update = out.find((m) => (m as { method?: string }).method === "session/update") as
			| { params: { sessionId: string; update: unknown } }
			| undefined
		expect(update?.params).toEqual({
			sessionId,
			update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi there" } },
		})

		// Terminal event resolves the prompt with a stopReason.
		emit({ type: "TaskCompleted", taskId: "t1" } as ServerEvent)
		await prompted
		expect(reply(out, 2)?.result).toEqual({ stopReason: "end_turn" })
	})

	it("session/cancel cancels the session's task", async () => {
		const { peer, out, api, emit } = makeServer()
		await peer.receive({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} })
		const sessionId = reply(out, 1)!.result!.sessionId
		const prompted = peer.receive({
			jsonrpc: "2.0",
			id: 2,
			method: "session/prompt",
			params: { sessionId, prompt: [{ type: "text", text: "go" }] },
		})
		await Promise.resolve()
		await peer.receive({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } })
		expect(api.cancelTask).toHaveBeenCalledWith("t1")
		emit({ type: "TaskAborted", taskId: "t1" } as ServerEvent)
		await prompted
		expect(reply(out, 2)?.result).toEqual({ stopReason: "cancelled" })
	})
})
