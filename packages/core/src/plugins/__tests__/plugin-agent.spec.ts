import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { createInMemoryHost, setHost, type PluginContext, type ShoferPlugin } from "@shofer/types"

import { PluginManager, type PluginFsHost, type PluginStateStore } from "../plugin-manager.js"
import { pluginRegistry } from "../plugin-registry.js"
import type { PluginCodeLoader, PluginCodeSource } from "../plugin-loader.js"
import type { PluginAgentProvider } from "../plugin-agent.js"
import { createPluginAgent, createDeniedPluginAgent } from "../plugin-agent.js"

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

/** A recording agent provider standing in for the host task-injection seam. */
function makeAgentProvider(): PluginAgentProvider & {
	calls: { message: string; mode?: string; taskId?: string }[]
} {
	const calls: { message: string; mode?: string; taskId?: string }[] = []
	return {
		calls,
		async notify(message, opts) {
			calls.push({ message, mode: opts?.mode, taskId: opts?.taskId })
		},
	}
}

const agentManifest = (name: string) => ({
	name,
	version: "1.0.0",
	main: "index.js",
	permissions: { agent: true },
})

describe("plugin-agent — createPluginAgent / createDeniedPluginAgent (P7 unit)", () => {
	it("live surface delegates message + opts to the host provider", async () => {
		const provider = makeAgentProvider()
		const agent = createPluginAgent("p", provider)
		await agent.notify("deploy failed", { mode: "queue" })
		await agent.notify("start over", { mode: "spawn", taskId: "t1" })
		expect(provider.calls).toEqual([
			{ message: "deploy failed", mode: "queue", taskId: undefined },
			{ message: "start over", mode: "spawn", taskId: "t1" },
		])
		// Surface exposes ONLY notify — no host internals leak through.
		expect(Object.keys(agent)).toEqual(["notify"])
	})

	it("surfaces + warns on a provider failure", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		const provider: PluginAgentProvider = {
			async notify() {
				throw new Error("boom")
			},
		}
		const agent = createPluginAgent("p", provider)
		await expect(agent.notify("x")).rejects.toThrow(/boom/)
		warnSpy.mockRestore()
	})

	it("denied surface throws + warns on notify", async () => {
		const warn = vi.fn()
		const agent = createDeniedPluginAgent("p", warn)
		await expect(agent.notify("x")).rejects.toThrow(/denied/)
		expect(warn).toHaveBeenCalledOnce()
	})
})

describe("PluginManager — ctx.agent gating (P7)", () => {
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
		const provider = makeAgentProvider()
		const manager = new PluginManager({
			fs,
			pluginDirs: [{ dir: "/plugins", scope: "global" }],
			stateStore: new MemoryStore(opts.enabled),
			codeLoader: loader,
			host: createInMemoryHost(),
			agentProvider: opts.withProvider === false ? undefined : provider,
		})
		await manager.discover()
		await manager.activateCodePlugins()
		return { manager, captured, provider }
	}

	it("grants a live ctx.agent to a granted plugin — notify reaches the host seam", async () => {
		const { captured, provider } = await build({ manifest: agentManifest("p"), enabled: ["p"] })
		const agent = captured()?.agent
		expect(agent).toBeDefined()
		await agent!.notify("the deploy just failed")
		expect(provider.calls).toEqual([{ message: "the deploy just failed", mode: undefined, taskId: undefined }])
	})

	it("queues into the (stub) task via the seam and spawns on mode:spawn", async () => {
		const { captured, provider } = await build({ manifest: agentManifest("p"), enabled: ["p"] })
		const agent = captured()!.agent!
		await agent.notify("look here", { mode: "queue" })
		await agent.notify("new investigation", { mode: "spawn" })
		expect(provider.calls).toEqual([
			{ message: "look here", mode: "queue", taskId: undefined },
			{ message: "new investigation", mode: "spawn", taskId: undefined },
		])
	})

	it("denies ctx.agent (stub throws + warns) for a plugin WITHOUT permissions.agent", async () => {
		const { captured, provider } = await build({
			manifest: { name: "p", version: "1.0.0", main: "index.js", permissions: { tools: true } },
			enabled: ["p"],
		})
		const agent = captured()?.agent
		expect(agent).toBeDefined() // present-but-denying, distinct from absent
		await expect(agent!.notify("try to steer")).rejects.toThrow(/denied/)
		// The host seam was NEVER reached — no steering attempted.
		expect(provider.calls).toEqual([])
	})

	it("omits ctx.agent entirely when no host agent seam is wired (headless)", async () => {
		const { captured } = await build({
			manifest: agentManifest("p"),
			enabled: ["p"],
			withProvider: false,
		})
		expect(captured()?.agent).toBeUndefined()
	})
})
