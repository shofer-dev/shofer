import { describe, it, expect, vi, beforeEach } from "vitest"

import { vscode } from "@src/utils/vscode"

import { postPluginUiMessage, subscribePluginUiMessages } from "../pluginUiChannel"

vi.mock("@src/utils/vscode", () => ({
	vscode: { postMessage: vi.fn() },
}))

/** Simulate the extension posting a scoped plugin-UI message into the webview. */
function dispatchFromExtension(pluginName: string, message: unknown) {
	window.dispatchEvent(new MessageEvent("message", { data: { type: "pluginUiMessage", pluginUiMessage: { pluginName, message } } }))
}

describe("pluginUiChannel (scoped, namespaced — §6.8)", () => {
	beforeEach(() => {
		vi.mocked(vscode.postMessage).mockClear()
	})

	it("postPluginUiMessage sends a scoped envelope to the extension", () => {
		postPluginUiMessage("ci", { type: "deploy" })
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "pluginUiMessage",
			pluginUiMessage: { pluginName: "ci", message: { type: "deploy" } },
		})
	})

	it("delivers inbound messages only to the addressed plugin (namespacing)", () => {
		const aSeen: unknown[] = []
		const bSeen: unknown[] = []
		const offA = subscribePluginUiMessages("a", (m) => aSeen.push(m))
		const offB = subscribePluginUiMessages("b", (m) => bSeen.push(m))

		dispatchFromExtension("a", { n: 1 })
		expect(aSeen).toEqual([{ n: 1 }])
		expect(bSeen).toEqual([]) // b must not observe a's channel

		dispatchFromExtension("b", { n: 2 })
		expect(bSeen).toEqual([{ n: 2 }])
		expect(aSeen).toEqual([{ n: 1 }])

		offA()
		offB()
	})

	it("round-trips: an outbound post + an inbound reply for the same plugin", () => {
		const seen: unknown[] = []
		const off = subscribePluginUiMessages("echo", (m) => seen.push(m))
		postPluginUiMessage("echo", "ping")
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "pluginUiMessage",
			pluginUiMessage: { pluginName: "echo", message: "ping" },
		})
		dispatchFromExtension("echo", "pong")
		expect(seen).toEqual(["pong"])
		off()
	})

	it("ignores non-plugin messages and unsubscribes cleanly", () => {
		const seen: unknown[] = []
		const off = subscribePluginUiMessages("a", (m) => seen.push(m))
		window.dispatchEvent(new MessageEvent("message", { data: { type: "state" } }))
		expect(seen).toEqual([])
		off()
		dispatchFromExtension("a", { n: 1 })
		expect(seen).toEqual([]) // no delivery after unsubscribe
	})
})
