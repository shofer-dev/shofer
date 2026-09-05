// npx vitest src/components/plugins/__tests__/pluginUiChannel.request.spec.ts
//
// The REQUEST half of the scoped plugin-UI transport, which the sibling spec
// (namespacing) does not cover: correlation ids, error propagation, and the two
// filters that make the channel safe — a response for another call or another
// PLUGIN is ignored, and the transport's own response envelopes never reach a
// plugin's `onMessage` subscribers.

import { vscode } from "@src/utils/vscode"

import { subscribePluginUiMessages, requestPluginUi } from "../pluginUiChannel"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

const postMessage = vi.mocked(vscode.postMessage)

/** Deliver an extension → UI message synchronously, as the host's port would. */
const deliver = (pluginName: string, message: unknown) =>
	window.dispatchEvent(
		new MessageEvent("message", { data: { type: "pluginUiMessage", pluginUiMessage: { pluginName, message } } }),
	)

/** The request envelope the last `postMessage` carried. */
const lastRequest = () => {
	const call = postMessage.mock.calls.at(-1)![0] as {
		pluginUiMessage: { message: { __pluginRequest: { id: string; method: string; params?: unknown } } }
	}
	return call.pluginUiMessage.message.__pluginRequest
}

const respond = (pluginName: string, id: string, body: Record<string, unknown>) =>
	deliver(pluginName, { __pluginResponse: { id, ...body } })

beforeEach(() => vi.clearAllMocks())

describe("requestPluginUi", () => {
	it("resolves with the plugin's result", async () => {
		const pending = requestPluginUi("worktrees", "listChanges", { taskId: "t1" })
		const { id, method, params } = lastRequest()

		expect(method).toBe("listChanges")
		expect(params).toEqual({ taskId: "t1" })

		respond("worktrees", id, { result: ["a.ts"] })
		await expect(pending).resolves.toEqual(["a.ts"])
	})

	it("rejects with the plugin's error", async () => {
		const pending = requestPluginUi("worktrees", "revert")
		respond("worktrees", lastRequest().id, { error: "no worktree" })

		await expect(pending).rejects.toThrow("no worktree")
	})

	it("carries the mutating flag the caller declared", () => {
		requestPluginUi("worktrees", "revert", undefined, { mutates: true })
		expect(lastRequest()).toMatchObject({ mutates: true })
	})

	it("gives each call its own correlation id", () => {
		requestPluginUi("worktrees", "a")
		const first = lastRequest().id
		requestPluginUi("worktrees", "b")

		expect(lastRequest().id).not.toBe(first)
	})

	it("ignores a response addressed to a different call", async () => {
		const pending = requestPluginUi("worktrees", "listChanges")
		const { id } = lastRequest()

		respond("worktrees", "worktrees:9999", { result: "wrong" })
		respond("worktrees", id, { result: "right" })

		await expect(pending).resolves.toBe("right")
	})

	it("ignores a response from a different plugin", async () => {
		const pending = requestPluginUi("worktrees", "listChanges")
		const { id } = lastRequest()

		respond("live-memory", id, { result: "spoofed" })
		respond("worktrees", id, { result: "genuine" })

		await expect(pending).resolves.toBe("genuine")
	})

	it("ignores ordinary traffic while a call is outstanding", async () => {
		const pending = requestPluginUi("worktrees", "listChanges")
		const { id } = lastRequest()

		deliver("worktrees", { kind: "changed" })
		window.dispatchEvent(new MessageEvent("message", { data: { type: "state" } }))
		respond("worktrees", id, { result: "ok" })

		await expect(pending).resolves.toBe("ok")
	})
})

describe("the subscriber filter", () => {
	it("withholds the transport's own response envelopes from plugin subscribers", () => {
		const listener = vi.fn()
		const unsubscribe = subscribePluginUiMessages("worktrees", listener)

		deliver("worktrees", { __pluginResponse: { id: "worktrees:0", result: 1 } })
		expect(listener).not.toHaveBeenCalled()

		deliver("worktrees", { kind: "changed" })
		expect(listener).toHaveBeenCalledWith({ kind: "changed" })
		unsubscribe()
	})
})
