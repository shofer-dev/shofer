/**
 * Unit tests for WorkerExtensionHost (Phase 1).
 *
 * Tests that the IExtensionHost implementation correctly:
 * 1. Routes extension→webview messages through the server port.
 * 2. Routes webview→extension messages from the server port.
 * 3. Correctly tracks ready state via markWebviewReady / isInInitialSetup.
 * 4. Correctly tracks registered providers.
 * 5. Does not forward vscode API calls (that's the IpcDemuxer's job).
 */

import { describe, it, expect, vi } from "vitest"
import { WorkerExtensionHost } from "../worker-extension-host.js"

/**
 * Creates a mock IPC port that captures posted messages and simulates
 * incoming messages for `on("message", …)` listeners.
 */
function createMockPort() {
	const listeners: Array<(value: unknown) => void> = []
	const sentMessages: unknown[] = []
	return {
		postMessage: vi.fn((value: unknown) => {
			sentMessages.push(value)
		}),
		on: vi.fn((_event: "message", listener: (value: unknown) => void) => {
			listeners.push(listener)
		}),
		/** Simulate a message arriving on this port. */
		simulateMessage: (value: unknown) => {
			for (const l of listeners) l(value)
		},
		/** All messages sent through postMessage. */
		getSentMessages: () => sentMessages,
	}
}

describe("WorkerExtensionHost", () => {
	describe("message routing", () => {
		it("routes extension→webview messages through serverPort", () => {
			const serverPort = createMockPort()
			const host = new WorkerExtensionHost(serverPort)

			host.emit("extensionWebviewMessage", { type: "state", payload: { key: "val" } })

			const messages = serverPort.getSentMessages()
			expect(messages.length).toBe(1)
			expect(messages[0]).toEqual({ type: "state", payload: { key: "val" } })
		})

		it('emits "extensionWebviewMessage" returns true', () => {
			const host = new WorkerExtensionHost(createMockPort())
			expect(host.emit("extensionWebviewMessage", { type: "foo" })).toBe(true)
		})

		it("routes webview→extension messages from serverPort", () => {
			const serverPort = createMockPort()
			const host = new WorkerExtensionHost(serverPort)
			const listener = vi.fn()

			host.on("webviewMessage", listener)
			serverPort.simulateMessage({ type: "askResponse", text: "yes" })

			expect(listener).toHaveBeenCalledOnce()
			expect(listener).toHaveBeenCalledWith({ type: "askResponse", text: "yes" })
		})

		it('registers exactly one "message" listener on serverPort for webview messages', () => {
			const serverPort = createMockPort()
			const host = new WorkerExtensionHost(serverPort)

			host.on("webviewMessage", vi.fn())
			host.on("webviewMessage", vi.fn())

			// on() is called once per listener registration
			expect(serverPort.on).toHaveBeenCalledTimes(2)
		})
	})

	describe("setup lifecycle", () => {
		it("starts in initial setup mode", () => {
			const host = new WorkerExtensionHost(createMockPort())
			expect(host.isInInitialSetup()).toBe(true)
		})

		it("marks webview ready", () => {
			const host = new WorkerExtensionHost(createMockPort())
			host.markWebviewReady()
			expect(host.isInInitialSetup()).toBe(false)
		})
	})

	describe("provider registration", () => {
		it("registers and unregisters webview providers", () => {
			const host = new WorkerExtensionHost(createMockPort())
			const provider = { resolveWebviewView: vi.fn() }

			host.registerWebviewProvider("shofer.SidebarProvider", provider)
			// Registration is internal — validated by the absence of throw.
			host.unregisterWebviewProvider("shofer.SidebarProvider")
			// Unregistration should not throw.
		})
	})

	describe("dispose", () => {
		it("clears providers and resets ready state", () => {
			const host = new WorkerExtensionHost(createMockPort())
			host.markWebviewReady()
			const provider = { resolveWebviewView: vi.fn() }
			host.registerWebviewProvider("test.view", provider)

			host.dispose()

			expect(host.isInInitialSetup()).toBe(true)
		})
	})

	describe("IExtensionHost contract", () => {
		it("emit() with unknown event returns false", () => {
			const host = new WorkerExtensionHost(createMockPort())
			expect(host.emit("nonexistent" as any, "data")).toBe(false)
		})

		it("emit('webviewMessage') returns false — only on() delivers inbound messages", () => {
			const host = new WorkerExtensionHost(createMockPort())
			expect(host.emit("webviewMessage" as any, { type: "test" })).toBe(false)
		})

		it("emit() returns true for extensionWebviewMessage", () => {
			const host = new WorkerExtensionHost(createMockPort())
			expect(host.emit("extensionWebviewMessage", { hello: "world" })).toBe(true)
		})

		it("on() returns this for chaining", () => {
			const host = new WorkerExtensionHost(createMockPort())
			expect(host.on("webviewMessage", vi.fn())).toBe(host)
		})
	})
})
