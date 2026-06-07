/**
 * Unit tests for Server Worker (Phase 1).
 *
 * Tests that the Server Worker correctly:
 * 1. Starts a WebSocket server on a dynamic port.
 * 2. Accepts a WebSocket connection.
 * 3. Correctly manages the Agent Worker registry.
 * 4. Correctly sends/receives messages to/from the Webview.
 * 5. Correctly sends messages to registered Agent Workers.
 * 6. Gracefully shuts down.
 *
 * All tests import the module as a library — Phase 1 does not spawn
 * the Server Worker as an actual worker_thread.
 */

import nock from "nock"
import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from "vitest"
import { WebSocket } from "ws"
import {
	startServer,
	shutdownServer,
	registerAgent,
	unregisterAgent,
	sendToWebview,
	sendToAgent,
	agentCount,
	isWebviewConnected,
	resetState,
} from "../server-worker.js"
import type { WebSocketServer } from "ws"
import { allowNetConnect } from "../../vitest.setup.js"

/**
 * Helper: resolve when the WS server is listening.
 */
function waitForListening(wss: WebSocketServer, timeoutMs = 5000): Promise<number> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("Timed out waiting for WebSocket server")), timeoutMs)
		wss.on("listening", () => {
			clearTimeout(timer)
			const addr = wss.address()
			if (addr && typeof addr === "object") {
				resolve(addr.port)
			} else {
				reject(new Error("Could not determine port"))
			}
		})
	})
}

/**
 * Helper: connect a WebSocket client and resolve when connected.
 */
function connectClient(port: number, timeoutMs = 5000): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}`)
		const timer = setTimeout(() => {
			ws.close()
			reject(new Error("Timed out connecting WebSocket client"))
		}, timeoutMs)
		ws.on("open", () => {
			clearTimeout(timer)
			resolve(ws)
		})
		ws.on("error", (err) => {
			clearTimeout(timer)
			reject(err)
		})
	})
}

describe("Server Worker", () => {
	// WSS-backed tests use this variable; registry-only tests don't.
	let wss: WebSocketServer | null = null

	// nock blocks all network by default (vitest.setup.ts). Allow localhost
	// so the WebSocket server and client can connect during tests.
	beforeAll(() => {
		allowNetConnect("127.0.0.1")
	})

	afterAll(() => {
		nock.disableNetConnect()
	})

	afterEach(() => {
		// Clean up any server and reset module-scoped state so no
		// test leaks agents or socket references into the next test.
		if (wss) {
			shutdownServer(wss)
			wss = null
		}
		resetState()
	})

	describe("WebSocket server lifecycle", () => {
		it("starts and listens on a dynamic port", async () => {
			wss = startServer()
			const port = await waitForListening(wss)
			expect(port).toBeGreaterThan(0)
			expect(port).toBeLessThan(65536)
		})

		it("accepts a WebSocket connection", async () => {
			wss = startServer()
			const port = await waitForListening(wss)
			const ws = await connectClient(port)
			expect(ws.readyState).toBe(WebSocket.OPEN)
			expect(isWebviewConnected()).toBe(true)
			ws.close()
		})

		it("detects Webview disconnect", async () => {
			wss = startServer()
			const port = await waitForListening(wss)
			const ws = await connectClient(port)
			expect(isWebviewConnected()).toBe(true)
			ws.close()
			// Wait for the close event to propagate.
			await new Promise((resolve) => setTimeout(resolve, 50))
			expect(isWebviewConnected()).toBe(false)
		})
	})

	describe("sendToWebview", () => {
		it("sends a JSON message to the connected Webview", async () => {
			wss = startServer()
			const port = await waitForListening(wss)
			const ws = await connectClient(port)

			const received = new Promise<unknown>((resolve) => {
				ws.on("message", (data) => {
					resolve(JSON.parse(data.toString()))
				})
			})

			sendToWebview({ type: "test", payload: 42 })

			const msg = await received
			expect(msg).toEqual({ type: "test", payload: 42 })
			ws.close()
		})

		it("no-ops when no Webview is connected", () => {
			// Should not throw.
			expect(() => sendToWebview({ type: "test" })).not.toThrow()
		})
	})

	describe("Agent Worker registry", () => {
		it("registers and unregisters agents", () => {
			const port = {
				postMessage: vi.fn(),
				on: vi.fn(),
			}
			registerAgent("task-1", port)
			expect(agentCount()).toBe(1)

			registerAgent("task-2", port)
			expect(agentCount()).toBe(2)

			expect(unregisterAgent("task-1")).toBe(true)
			expect(agentCount()).toBe(1)

			expect(unregisterAgent("nonexistent")).toBe(false)
			expect(agentCount()).toBe(1)
		})
	})

	describe("sendToAgent", () => {
		it("sends a message to a registered agent", () => {
			const port = {
				postMessage: vi.fn(),
				on: vi.fn(),
			}
			registerAgent("task-42", port)
			sendToAgent("task-42", { type: "hello" })
			expect(port.postMessage).toHaveBeenCalledWith({ type: "hello" })
		})

		it("no-ops for an unknown agent", () => {
			expect(() => sendToAgent("nonexistent", { type: "hello" })).not.toThrow()
		})
	})

	describe("shutdown", () => {
		it("shuts down cleanly and clears registry", async () => {
			wss = startServer()
			const port = await waitForListening(wss)

			const port2 = {
				postMessage: vi.fn(),
				on: vi.fn(),
			}
			registerAgent("task-1", port2)
			expect(agentCount()).toBe(1)

			shutdownServer(wss)
			wss = null

			expect(agentCount()).toBe(0)
			// Verify the server no longer accepts connections.
			await expect(connectClient(port)).rejects.toThrow()
		})
	})
})
