import { describe, it, expect, vi } from "vitest"
import { createInMemoryHost, type HostBridge } from "@shofer/types"

import { createPluginSandbox } from "../plugin-sandbox.js"

/** A HostBridge whose fs/fetch record calls, so we can assert delegation happens. */
function makeHost(): { host: HostBridge; reads: string[] } {
	const host = createInMemoryHost() as unknown as HostBridge
	const reads: string[] = []
	// Override the fs so we can observe which reads reached the real host.
	;(host as { fs: unknown }).fs = {
		readFile: async (p: string) => {
			reads.push(p)
			return "content"
		},
		writeFile: async () => {},
		exists: async () => true,
		mkdir: async () => {},
		delete: async () => {},
		findFiles: async () => [],
	}
	return { host, reads }
}

describe("createPluginSandbox (§8 permission enforcement, step 2.4)", () => {
	const pluginRoot = "/plugins/ci"

	it("denies filesystem access when no filesystem permission is granted", async () => {
		const { host, reads } = makeHost()
		const warn = vi.fn()
		const sandbox = createPluginSandbox({ pluginName: "ci", pluginRoot, host, warn })
		await expect(sandbox.fs.readFile("/plugins/ci/data.txt")).rejects.toThrow(/denied/)
		expect(warn).toHaveBeenCalledOnce()
		expect(reads).toEqual([])
	})

	it("allows filesystem access inside the declared allowlist and delegates to the host", async () => {
		const { host, reads } = makeHost()
		const sandbox = createPluginSandbox({
			pluginName: "ci",
			pluginRoot,
			permissions: { filesystem: ["./config/"] },
			host,
			warn: vi.fn(),
		})
		await expect(sandbox.fs.readFile("/plugins/ci/config/app.json")).resolves.toBe("content")
		expect(reads).toEqual(["/plugins/ci/config/app.json"])
	})

	it("denies filesystem access outside the allowlist (path traversal blocked)", async () => {
		const { host } = makeHost()
		const warn = vi.fn()
		const sandbox = createPluginSandbox({
			pluginName: "ci",
			pluginRoot,
			permissions: { filesystem: ["./config/"] },
			host,
			warn,
		})
		await expect(sandbox.fs.readFile("/plugins/ci/config/../../secret")).rejects.toThrow(/denied/)
		expect(warn).toHaveBeenCalledOnce()
	})

	it("resolves relative allowlist entries against the workspace too", async () => {
		const { host, reads } = makeHost()
		const sandbox = createPluginSandbox({
			pluginName: "ci",
			pluginRoot,
			workspacePath: "/work",
			permissions: { filesystem: ["./ci-config/"] },
			host,
			warn: vi.fn(),
		})
		await expect(sandbox.fs.readFile("/work/ci-config/pipeline.yml")).resolves.toBe("content")
		expect(reads).toEqual(["/work/ci-config/pipeline.yml"])
	})

	it("denies network requests when no network permission is granted", async () => {
		const { host } = makeHost()
		const fetchImpl = vi.fn()
		const warn = vi.fn()
		const sandbox = createPluginSandbox({ pluginName: "ci", pluginRoot, host, fetchImpl, warn })
		await expect(sandbox.fetch("https://evil.example.com")).rejects.toThrow(/denied/)
		expect(fetchImpl).not.toHaveBeenCalled()
		expect(warn).toHaveBeenCalledOnce()
	})

	it("allows network requests to an allowlisted origin", async () => {
		const { host } = makeHost()
		const fetchImpl = vi.fn(async () => new Response("ok"))
		const sandbox = createPluginSandbox({
			pluginName: "ci",
			pluginRoot,
			permissions: { network: ["https://jenkins.my-org.com"] },
			host,
			fetchImpl,
			warn: vi.fn(),
		})
		await sandbox.fetch("https://jenkins.my-org.com/api/build")
		expect(fetchImpl).toHaveBeenCalledOnce()
	})

	it("denies a request to a non-allowlisted origin even when others are allowed", async () => {
		const { host } = makeHost()
		const fetchImpl = vi.fn(async () => new Response("ok"))
		const sandbox = createPluginSandbox({
			pluginName: "ci",
			pluginRoot,
			permissions: { network: ["https://jenkins.my-org.com"] },
			host,
			fetchImpl,
			warn: vi.fn(),
		})
		await expect(sandbox.fetch("https://gitlab.com/api")).rejects.toThrow(/denied/)
		expect(fetchImpl).not.toHaveBeenCalled()
	})

	it("always allows the notifier surface", () => {
		const { host } = makeHost()
		const sandbox = createPluginSandbox({ pluginName: "ci", pluginRoot, host, warn: vi.fn() })
		expect(() => sandbox.notifier.info("hi")).not.toThrow()
	})
})

/** A controllable fake watcher recording watch() calls and letting a test fire events. */
function makeWatchableHost(): {
	host: HostBridge
	watchCalls: { baseDir: string; pattern: string }[]
	fireChange: (path: string) => void
	fireCreate: (path: string) => void
	disposed: () => number
} {
	const host = createInMemoryHost() as unknown as HostBridge
	const watchCalls: { baseDir: string; pattern: string }[] = []
	const changeHandlers: ((path: string) => void)[] = []
	const createHandlers: ((path: string) => void)[] = []
	let disposeCount = 0
	;(host as { watcher: unknown }).watcher = {
		watch: (baseDir: string, pattern: string) => {
			watchCalls.push({ baseDir, pattern })
			return {
				onCreate: (h: (path: string) => void) => {
					createHandlers.push(h)
					return { dispose: () => {} }
				},
				onChange: (h: (path: string) => void) => {
					changeHandlers.push(h)
					return { dispose: () => {} }
				},
				onDelete: () => ({ dispose: () => {} }),
				dispose: () => {
					disposeCount++
				},
			}
		},
	}
	return {
		host,
		watchCalls,
		fireChange: (path: string) => changeHandlers.forEach((h) => h(path)),
		fireCreate: (path: string) => createHandlers.forEach((h) => h(path)),
		disposed: () => disposeCount,
	}
}

describe("createPluginSandbox — ctx.host.watch (P6.G3)", () => {
	const pluginRoot = "/plugins/ci"

	it("watches within a granted filesystem root and fires the callback with path + kind", () => {
		const { host, watchCalls, fireChange, fireCreate } = makeWatchableHost()
		const sandbox = createPluginSandbox({
			pluginName: "ci",
			pluginRoot,
			permissions: { filesystem: ["./data/"] },
			host,
			warn: vi.fn(),
		})
		const cb = vi.fn()
		const disposable = sandbox.watch!("**/*.json", cb)
		// It watched under the granted root (not an arbitrary path).
		expect(watchCalls).toEqual([{ baseDir: "/plugins/ci/data", pattern: "**/*.json" }])
		// The concrete changed path + change kind are threaded through (P7).
		fireChange("/plugins/ci/data/config.json")
		fireCreate("/plugins/ci/data/new.json")
		expect(cb).toHaveBeenCalledTimes(2)
		expect(cb).toHaveBeenNthCalledWith(1, { path: "/plugins/ci/data/config.json", type: "change" })
		expect(cb).toHaveBeenNthCalledWith(2, { path: "/plugins/ci/data/new.json", type: "create" })
		disposable.dispose()
	})

	it("denies watch (warn + no-op) when no permissions.filesystem is granted", () => {
		const { host, watchCalls } = makeWatchableHost()
		const warn = vi.fn()
		const sandbox = createPluginSandbox({ pluginName: "ci", pluginRoot, host, warn })
		const cb = vi.fn()
		const disposable = sandbox.watch!("**/*", cb)
		expect(warn).toHaveBeenCalledOnce()
		expect(watchCalls).toEqual([]) // never created a host watcher
		expect(() => disposable.dispose()).not.toThrow() // no-op disposable
	})

	it("disposes the underlying host watcher(s) on dispose", () => {
		const { host, disposed } = makeWatchableHost()
		const sandbox = createPluginSandbox({
			pluginName: "ci",
			pluginRoot,
			permissions: { filesystem: ["./a/", "./b/"] },
			host,
			warn: vi.fn(),
		})
		const disposable = sandbox.watch!("*", vi.fn())
		disposable.dispose()
		expect(disposed()).toBe(2) // one per granted root
	})
})
