import { describe, it, expect } from "vitest"

import type { HostBridge } from "../host.js"
import { createInMemoryHost, RecordingNotifier } from "../host-memory.js"
import { createSplitHost, dispatchHostCall, type HostRpcChannel } from "../host-rpc.js"

/**
 * Category I over RPC — a remote executor's split host proxies the front-end-bound
 * capabilities (notifier/lsp/workspace) back to the controller, while the
 * workspace-scoped ones (fs/config/env/watcher) stay local.
 */
const flush = () => new Promise((resolve) => setTimeout(resolve))

function setup() {
	const notifier = new RecordingNotifier()
	notifier.choiceResponse = "Yes"
	const diag = { filePath: "/a.ts", line: 1, column: 1, severity: "error" as const, message: "boom" }
	const base = createInMemoryHost()
	const controller: HostBridge = {
		...base,
		notifier,
		lsp: { ...base.lsp, getDiagnostics: async () => [diag] },
		workspace: {
			openFolder: async () => {},
			executeCommand: async <T>(command: string): Promise<T> => `ran:${command}` as unknown as T,
			workspaceRoots: () => [],
			activeEditorFile: () => undefined,
			workspaceFolderFor: () => undefined,
		},
	}
	const calls: Array<[string, string, unknown[]]> = []
	const channel: HostRpcChannel = {
		invoke: (cap, method, params) => {
			calls.push([cap, method, params])
			return dispatchHostCall(controller, cap, method, params)
		},
	}
	const local = createInMemoryHost()
	const executor = createSplitHost({ local, channel })
	return { controller, notifier, executor, local, calls, diag }
}

describe("createSplitHost (Category I over RPC)", () => {
	it("proxies fire-and-forget notifier calls to the controller", async () => {
		const { notifier, executor } = setup()
		executor.notifier.warn("hi")
		await flush()
		expect(notifier.messages).toContainEqual({ level: "warn", message: "hi" })
	})

	it("proxies showChoice and returns the controller's response", async () => {
		const { executor } = setup()
		expect(await executor.notifier.showChoice("q", ["Yes"])).toBe("Yes")
	})

	it("proxies lsp.getDiagnostics to the controller", async () => {
		const { executor, diag } = setup()
		expect(await executor.lsp.getDiagnostics()).toEqual([diag])
	})

	it("proxies workspace.executeCommand to the controller", async () => {
		const { executor, calls } = setup()
		expect(await executor.workspace.executeCommand("foo")).toBe("ran:foo")
		expect(calls).toContainEqual(["workspace", "executeCommand", ["foo"]])
	})

	it("keeps workspace-scoped capabilities local (not proxied)", () => {
		const { executor, local } = setup()
		expect(executor.fs).toBe(local.fs)
		expect(executor.config).toBe(local.config)
		expect(executor.env).toBe(local.env)
		expect(executor.watcher).toBe(local.watcher)
	})

	it("dispatchHostCall rejects an unknown method", async () => {
		const { controller } = setup()
		await expect(dispatchHostCall(controller, "lsp", "nope", [])).rejects.toThrow(/Unknown host call/)
	})
})
