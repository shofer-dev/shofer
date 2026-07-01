import { describe, it, expect, vi } from "vitest"

import { JsonRpcPeer, type JsonRpcMessage } from "../acp-connection"

function makePeer() {
	const out: JsonRpcMessage[] = []
	const peer = new JsonRpcPeer((frame) => out.push(JSON.parse(frame)))
	return { peer, out }
}

describe("JsonRpcPeer", () => {
	it("dispatches a request and replies with its result", async () => {
		const { peer, out } = makePeer()
		peer.onRequest("echo", (p) => ({ echoed: p }))
		await peer.receive({ jsonrpc: "2.0", id: 1, method: "echo", params: { a: 1 } })
		expect(out).toEqual([{ jsonrpc: "2.0", id: 1, result: { echoed: { a: 1 } } }])
	})

	it("replies method-not-found for unknown methods", async () => {
		const { peer, out } = makePeer()
		await peer.receive({ jsonrpc: "2.0", id: 2, method: "nope" })
		expect(out[0]).toMatchObject({ id: 2, error: { code: -32601 } })
	})

	it("returns an error result when a handler throws", async () => {
		const { peer, out } = makePeer()
		peer.onRequest("boom", () => {
			throw new Error("kaboom")
		})
		await peer.receive({ jsonrpc: "2.0", id: 3, method: "boom" })
		expect(out[0]).toMatchObject({ id: 3, error: { code: -32603, message: "kaboom" } })
	})

	it("routes notifications (no reply)", async () => {
		const { peer, out } = makePeer()
		const handler = vi.fn()
		peer.onNotification("ping", handler)
		await peer.receive({ jsonrpc: "2.0", method: "ping", params: 42 })
		expect(handler).toHaveBeenCalledWith(42)
		expect(out).toEqual([])
	})

	it("resolves an outbound request when its response arrives", async () => {
		const { peer, out } = makePeer()
		const p = peer.request("agentQuery", { x: 1 })
		expect(out[0]).toMatchObject({ id: 1, method: "agentQuery", params: { x: 1 } })
		await peer.receive({ jsonrpc: "2.0", id: 1, result: "ok" })
		await expect(p).resolves.toBe("ok")
	})
})
