import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
	createInMemoryHost,
	setHost,
	type PluginContext,
	type PluginDeliverInput,
	type PluginMailboxTransport,
	type ShoferPlugin,
} from "@shofer/types"

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
	/** Files directly in `dir` (locale bundles are read through this). */
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

/** A recording agent provider standing in for the host delivery seam. */
function makeAgentProvider(): PluginAgentProvider & {
	calls: PluginDeliverInput[]
	transports: PluginMailboxTransport[]
} {
	const calls: PluginDeliverInput[] = []
	const transports: PluginMailboxTransport[] = []
	return {
		calls,
		transports,
		async deliver(input) {
			calls.push(input)
			// The host completes the envelope; the seam returns what the box accepted.
			const { taskId, id, ...fields } = input
			return { ...fields, id: id ?? "host-minted-id", to: taskId ?? "current-task", sent_at: 1_000 }
		},
		registerMailboxTransport(transport) {
			transports.push(transport)
			return () => {
				transports.splice(transports.indexOf(transport), 1)
			}
		},
		async spawn() {
			return {
				taskId: "task-stub",
				result: async () => ({ taskId: "task-stub", status: "completed" as const }),
				onEvent: () => () => {},
				cancel: async () => {},
			}
		},
		async cancel() {},
	}
}

/** A minimal notification envelope, less the fields the host fills in. */
function notification(body: string, taskId?: string): PluginDeliverInput {
	return {
		from: "tag:system-events:test",
		kind: "notification",
		subject: body,
		body,
		deadline: 10_000,
		wake: false,
		plane: "bus",
		...(taskId ? { taskId } : {}),
	}
}

const agentManifest = (name: string) => ({
	name,
	version: "1.0.0",
	main: "index.js",
	permissions: { agent: true },
})

describe("plugin-agent — createPluginAgent / createDeniedPluginAgent (P7 unit)", () => {
	it("live surface delegates the envelope to the host provider and returns what it accepted", async () => {
		const provider = makeAgentProvider()
		const agent = createPluginAgent("p", provider)
		const accepted = await agent.deliver(notification("deploy failed"))
		await agent.deliver(notification("start over", "t1"))
		expect(provider.calls.map((c) => [c.body, c.taskId])).toEqual([
			["deploy failed", undefined],
			["start over", "t1"],
		])
		// The host owns `to` and `sent_at`; the plugin never sets either.
		expect(accepted.to).toBe("current-task")
		expect(accepted.sent_at).toBe(1_000)
		// Surface exposes the one door, the transport seam, and the §14 job-control
		// methods — no host internals leak through.
		expect(Object.keys(agent)).toEqual(["deliver", "registerMailboxTransport", "spawn", "cancel"])
	})

	it("registers a mailbox transport and unregisters it through the returned handle", () => {
		const provider = makeAgentProvider()
		const agent = createPluginAgent("p", provider)
		const transport: PluginMailboxTransport = {
			plane: "a2a" as const,
			canRoute: async () => true,
			send: async () => {},
		}
		const unregister = agent.registerMailboxTransport(transport)
		expect(provider.transports).toEqual([transport])
		unregister()
		expect(provider.transports).toEqual([])
	})

	it("surfaces + warns on a provider failure", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		const provider: PluginAgentProvider = {
			async deliver() {
				throw new Error("boom")
			},
			registerMailboxTransport() {
				throw new Error("boom")
			},
			async spawn() {
				throw new Error("boom")
			},
			async cancel() {
				throw new Error("boom")
			},
		}
		const agent = createPluginAgent("p", provider)
		await expect(agent.deliver(notification("x"))).rejects.toThrow(/boom/)
		expect(() =>
			agent.registerMailboxTransport({
				plane: "a2a" as const,
				canRoute: async () => false,
				send: async () => {},
			}),
		).toThrow(/boom/)
		warnSpy.mockRestore()
	})

	it("denied surface throws + warns on deliver and on registerMailboxTransport", async () => {
		const warn = vi.fn()
		const agent = createDeniedPluginAgent("p", warn)
		await expect(agent.deliver(notification("x"))).rejects.toThrow(/denied/)
		expect(() =>
			agent.registerMailboxTransport({ plane: "a2a" as const, canRoute: async () => true, send: async () => {} }),
		).toThrow(/denied/)
		expect(warn).toHaveBeenCalledTimes(2)
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

	it("grants a live ctx.agent to a granted plugin — deliver reaches the host seam", async () => {
		const { captured, provider } = await build({ manifest: agentManifest("p"), enabled: ["p"] })
		const agent = captured()?.agent
		expect(agent).toBeDefined()
		await agent!.deliver(notification("the deploy just failed"))
		expect(provider.calls.map((c) => c.body)).toEqual(["the deploy just failed"])
	})

	it("delivers to a named task and to the current one through the same door", async () => {
		const { captured, provider } = await build({ manifest: agentManifest("p"), enabled: ["p"] })
		const agent = captured()!.agent!
		await agent.deliver(notification("look here", "t7"))
		await agent.deliver(notification("and here"))
		expect(provider.calls.map((c) => [c.body, c.taskId])).toEqual([
			["look here", "t7"],
			["and here", undefined],
		])
	})

	it("denies ctx.agent (stub throws + warns) for a plugin WITHOUT permissions.agent", async () => {
		const { captured, provider } = await build({
			manifest: { name: "p", version: "1.0.0", main: "index.js", permissions: { tools: true } },
			enabled: ["p"],
		})
		const agent = captured()?.agent
		expect(agent).toBeDefined() // present-but-denying, distinct from absent
		await expect(agent!.deliver(notification("try to steer"))).rejects.toThrow(/denied/)
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
