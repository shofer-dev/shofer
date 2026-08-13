import {
	createInMemoryHost,
	setHost,
	type McpToolCallResponse,
	type PluginContext,
	type ShoferPlugin,
} from "@shofer/types"

import { PluginManager, type PluginFsHost, type PluginStateStore } from "../plugin-manager.js"
import { pluginRegistry } from "../plugin-registry.js"
import type { PluginCodeLoader, PluginCodeSource } from "../plugin-loader.js"
import type { PluginMcpProvider } from "../plugin-mcp.js"
import { createPluginMcp, createDeniedPluginMcp } from "../plugin-mcp.js"

/** In-memory {@link PluginFsHost} for manifest discovery only. */
class MemoryFs implements PluginFsHost {
	files = new Map<string, string>()
	dirs = new Set<string>()
	addManifest(root: string, manifest: unknown): void {
		this.dirs.add(root)
		this.files.set(`${root}/plugin.json`, JSON.stringify(manifest))
	}
	async listDirs(dir: string): Promise<string[]> {
		const prefix = `${dir}/`
		const names = new Set<string>()
		for (const d of this.dirs) {
			if (d.startsWith(prefix)) {
				const rest = d.slice(prefix.length)
				if (!rest.includes("/")) names.add(rest)
			}
		}
		return [...names]
	}
	async listFiles(dir: string): Promise<string[]> {
		const prefix = `${dir}/`
		const names = new Set<string>()
		for (const f of this.files.keys()) {
			if (f.startsWith(prefix)) {
				const rest = f.slice(prefix.length)
				if (!rest.includes("/")) names.add(rest)
			}
		}
		return [...names]
	}
	async readFile(p: string): Promise<string> {
		const c = this.files.get(p)
		if (c === undefined) throw new Error(`ENOENT: ${p}`)
		return c
	}
	async exists(p: string): Promise<boolean> {
		return this.files.has(p) || this.dirs.has(p)
	}
	async removeDir(): Promise<void> {}
}

class MemoryStore implements PluginStateStore {
	constructor(public names: string[] = []) {}
	getEnabledPlugins(): string[] {
		return [...this.names]
	}
	setEnabledPlugins(names: string[]): void {
		this.names = [...names]
	}
}

/** A codeLoader whose plugin captures the context it is initialized with. */
function makeCapturingLoader(): { loader: PluginCodeLoader; captured: () => PluginContext | undefined } {
	let captured: PluginContext | undefined
	const loader: PluginCodeLoader = {
		load: async (source: PluginCodeSource): Promise<ShoferPlugin> => ({
			name: source.name,
			initialize(ctx) {
				captured = ctx
			},
		}),
	}
	return { loader, captured: () => captured }
}

const okResult: McpToolCallResponse = { content: [{ type: "text", text: "pong" }] }

/** A recording MCP provider standing in for the host `McpHub.callTool` seam. */
function makeMcpProvider(): PluginMcpProvider & {
	calls: { serverName: string; toolName: string; args?: Record<string, unknown>; taskId?: string }[]
} {
	const calls: { serverName: string; toolName: string; args?: Record<string, unknown>; taskId?: string }[] = []
	return {
		calls,
		async callTool(serverName, toolName, args, opts) {
			calls.push({ serverName, toolName, args, taskId: opts?.taskId })
			return okResult
		},
	}
}

const mcpManifest = (name: string) => ({
	name,
	version: "1.0.0",
	main: "index.js",
	permissions: { mcpInvoke: true },
})

describe("plugin-mcp — createPluginMcp / createDeniedPluginMcp (§5.6 unit)", () => {
	it("live surface delegates server, tool, args and options to the host provider", async () => {
		const provider = makeMcpProvider()
		const mcp = createPluginMcp("p", provider)
		const result = await mcp.callTool("memory", "search", { q: "x" }, { taskId: "t1" })
		expect(result).toEqual(okResult)
		expect(provider.calls).toEqual([{ serverName: "memory", toolName: "search", args: { q: "x" }, taskId: "t1" }])
		// The surface is exactly one verb — no hub internals leak through.
		expect(Object.keys(mcp)).toEqual(["callTool"])
	})

	it("forwards the abort signal so a plugin call is cooperatively cancellable", async () => {
		let seen: AbortSignal | undefined
		const provider: PluginMcpProvider = {
			async callTool(_server, _tool, _args, opts) {
				seen = opts?.signal
				return okResult
			},
		}
		const controller = new AbortController()
		await createPluginMcp("p", provider).callTool("memory", "search", undefined, { signal: controller.signal })
		expect(seen).toBe(controller.signal)
	})

	it("surfaces + warns on a provider failure", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		const provider: PluginMcpProvider = {
			async callTool() {
				throw new Error("no connection found for server: memory")
			},
		}
		await expect(createPluginMcp("p", provider).callTool("memory", "search")).rejects.toThrow(/no connection/)
		warnSpy.mockRestore()
	})

	it("denied surface throws + warns, naming the permission", async () => {
		const warn = vi.fn()
		const mcp = createDeniedPluginMcp("p", warn)
		await expect(mcp.callTool("memory", "search")).rejects.toThrow(/permissions\.mcpInvoke/)
		expect(warn).toHaveBeenCalledOnce()
	})
})

describe("PluginManager — ctx.mcp gating (§5.6)", () => {
	beforeEach(() => {
		setHost(createInMemoryHost())
		for (const name of pluginRegistry.list()) pluginRegistry.unregister(name)
	})
	afterEach(() => {
		for (const name of pluginRegistry.list()) pluginRegistry.unregister(name)
	})

	async function build(opts: { manifest: unknown; enabled: string[]; withProvider?: boolean }) {
		const fs = new MemoryFs()
		fs.addManifest("/plugins/p", opts.manifest)
		const { loader, captured } = makeCapturingLoader()
		const provider = makeMcpProvider()
		const manager = new PluginManager({
			fs,
			pluginDirs: [{ dir: "/plugins", scope: "global" }],
			stateStore: new MemoryStore(opts.enabled),
			codeLoader: loader,
			host: createInMemoryHost(),
			mcpProvider: opts.withProvider === false ? undefined : provider,
		})
		await manager.discover()
		await manager.activateCodePlugins()
		return { manager, captured, provider }
	}

	it("grants a live ctx.mcp to a granted plugin — callTool reaches the host hub seam", async () => {
		const { captured, provider } = await build({ manifest: mcpManifest("p"), enabled: ["p"] })
		const mcp = captured()?.mcp
		expect(mcp).toBeDefined()
		await expect(mcp!.callTool("memory", "search", { q: "x" })).resolves.toEqual(okResult)
		expect(provider.calls).toEqual([
			{ serverName: "memory", toolName: "search", args: { q: "x" }, taskId: undefined },
		])
	})

	it("denies ctx.mcp (stub throws + warns) for a plugin WITHOUT permissions.mcpInvoke", async () => {
		const { captured, provider } = await build({
			manifest: { name: "p", version: "1.0.0", main: "index.js", permissions: { tools: true } },
			enabled: ["p"],
		})
		const mcp = captured()?.mcp
		expect(mcp).toBeDefined() // present-but-denying, distinct from absent
		await expect(mcp!.callTool("memory", "search")).rejects.toThrow(/denied/)
		// The hub was NEVER reached — no server saw the call.
		expect(provider.calls).toEqual([])
	})

	it("does not let permissions.mcpServers stand in for the invoke grant", async () => {
		const { captured, provider } = await build({
			manifest: { name: "p", version: "1.0.0", main: "index.js", permissions: { mcpServers: true } },
			enabled: ["p"],
		})
		await expect(captured()!.mcp!.callTool("memory", "search")).rejects.toThrow(/permissions\.mcpInvoke/)
		expect(provider.calls).toEqual([])
	})

	it("omits ctx.mcp entirely when no host MCP seam is wired (pure-core)", async () => {
		const { captured } = await build({
			manifest: mcpManifest("p"),
			enabled: ["p"],
			withProvider: false,
		})
		expect(captured()?.mcp).toBeUndefined()
	})
})
