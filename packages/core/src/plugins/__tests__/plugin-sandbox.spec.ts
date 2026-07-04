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
