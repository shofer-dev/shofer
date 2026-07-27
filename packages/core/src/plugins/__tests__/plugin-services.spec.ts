import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { createInMemoryHost, setHost, type PluginContext, type ShoferPlugin } from "@shofer/types"

import { PluginServiceSupervisor } from "../plugin-services.js"
import { PluginManager, type PluginFsHost, type PluginStateStore } from "../plugin-manager.js"
import { pluginRegistry } from "../plugin-registry.js"
import type { PluginCodeLoader, PluginCodeSource } from "../plugin-loader.js"

describe("PluginServiceSupervisor (P6.G7 unit)", () => {
	it("does not start a service on register — only on startForPlugin", async () => {
		const supervisor = new PluginServiceSupervisor(vi.fn())
		const start = vi.fn()
		supervisor.register("p", { name: "svc", start })
		expect(start).not.toHaveBeenCalled()
		await supervisor.startForPlugin("p")
		expect(start).toHaveBeenCalledOnce()
	})

	it("stops started services on stopForPlugin (and removes them)", async () => {
		const supervisor = new PluginServiceSupervisor(vi.fn())
		const stop = vi.fn()
		supervisor.register("p", { name: "svc", start: vi.fn(), stop })
		await supervisor.startForPlugin("p")
		expect(supervisor.countFor("p")).toBe(1)
		await supervisor.stopForPlugin("p")
		expect(stop).toHaveBeenCalledOnce()
		expect(supervisor.countFor("p")).toBe(0)
	})

	it("isolates a throwing start (warn, never rethrow) and still marks it started", async () => {
		const warn = vi.fn()
		const supervisor = new PluginServiceSupervisor(warn)
		supervisor.register("p", {
			name: "boom",
			start: () => {
				throw new Error("nope")
			},
		})
		await expect(supervisor.startForPlugin("p")).resolves.toBeUndefined()
		expect(warn).toHaveBeenCalledOnce()
		expect(warn.mock.calls[0]![0]).toMatch(/start failed.*isolated/)
	})

	it("isolates a hanging start via the timeout (warn, resolves)", async () => {
		vi.useFakeTimers()
		try {
			const warn = vi.fn()
			const supervisor = new PluginServiceSupervisor(warn)
			supervisor.register("p", { name: "hang", start: () => new Promise<void>(() => {}) })
			const p = supervisor.startForPlugin("p")
			await vi.advanceTimersByTimeAsync(6000)
			await expect(p).resolves.toBeUndefined()
			expect(warn).toHaveBeenCalledOnce()
			expect(warn.mock.calls[0]![0]).toMatch(/exceeded .*ms/)
		} finally {
			vi.useRealTimers()
		}
	})

	it("dispose() from register stops + removes just that service", async () => {
		const supervisor = new PluginServiceSupervisor(vi.fn())
		const stop = vi.fn()
		const handle = supervisor.register("p", { name: "svc", start: vi.fn(), stop })
		await supervisor.startForPlugin("p")
		handle.dispose()
		expect(supervisor.countFor("p")).toBe(0)
	})
})

// --- Manager integration: start-on-enable, stop-on-disable ---

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

/** A loader whose plugin registers a service in `initialize`, recording start/stop. */
function makeServiceLoader(events: string[]): PluginCodeLoader {
	return {
		load: async (source: PluginCodeSource): Promise<ShoferPlugin> => ({
			name: source.name,
			initialize(ctx: PluginContext) {
				ctx.registerService?.({
					name: "bg",
					start: () => {
						events.push(`${source.name}:start`)
					},
					stop: () => {
						events.push(`${source.name}:stop`)
					},
				})
			},
		}),
	}
}

describe("PluginManager — ctx.registerService lifecycle (P6.G7)", () => {
	beforeEach(() => {
		setHost(createInMemoryHost())
		for (const name of pluginRegistry.list()) pluginRegistry.unregister(name)
	})
	afterEach(() => {
		for (const name of pluginRegistry.list()) pluginRegistry.unregister(name)
	})

	it("starts a plugin's service on activation and stops it on disable", async () => {
		const events: string[] = []
		const fs = new MemoryFs()
		fs.addManifest("/plugins/p", { name: "p", version: "1.0.0", main: "index.js" })
		const manager = new PluginManager({
			fs,
			pluginDirs: [{ dir: "/plugins", scope: "global" }],
			stateStore: new MemoryStore(["p"]),
			codeLoader: makeServiceLoader(events),
			host: createInMemoryHost(),
		})
		await manager.discover()
		await manager.activateCodePlugins()
		expect(events).toEqual(["p:start"])

		await manager.setEnabled("p", false) // reconcile → stop
		expect(events).toEqual(["p:start", "p:stop"])
	})

	it("isolates a service whose start throws — plugin still registers, no crash", async () => {
		const fs = new MemoryFs()
		fs.addManifest("/plugins/p", { name: "p", version: "1.0.0", main: "index.js" })
		const loader: PluginCodeLoader = {
			load: async (source: PluginCodeSource): Promise<ShoferPlugin> => ({
				name: source.name,
				initialize(ctx: PluginContext) {
					ctx.registerService?.({
						name: "boom",
						start: () => {
							throw new Error("service kaboom")
						},
					})
				},
			}),
		}
		const manager = new PluginManager({
			fs,
			pluginDirs: [{ dir: "/plugins", scope: "global" }],
			stateStore: new MemoryStore(["p"]),
			codeLoader: loader,
			host: createInMemoryHost(),
		})
		await manager.discover()
		await expect(manager.activateCodePlugins()).resolves.toBeUndefined()
		// The plugin still loaded — a bad service does not fail activation.
		expect(pluginRegistry.has("p")).toBe(true)
	})
})
