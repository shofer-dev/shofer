import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { createInMemoryHost, setHost, type PluginContext, type ShoferPlugin } from "@shofer/types"

import { PluginManager, type PluginFsHost, type PluginStateStore } from "../plugin-manager.js"
import { pluginRegistry } from "../plugin-registry.js"
import type { PluginCodeLoader, PluginCodeSource } from "../plugin-loader.js"

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

/** A codeLoader that returns a plugin capturing the context it is initialized with. */
function makeCapturingLoader(): { loader: PluginCodeLoader; captured: () => PluginContext | undefined } {
	let captured: PluginContext | undefined
	const loader: PluginCodeLoader = {
		load: async (source: PluginCodeSource): Promise<ShoferPlugin> => ({
			name: source.name,
			initialize(ctx) {
				captured = ctx
			},
			registerTools(ctx) {
				return [
					{
						name: "hello",
						description: "greets",
						execute: async () => String(ctx.config?.greeting ?? ""),
					},
				]
			},
			transformSystemPrompt(prompt, ctx) {
				return `${prompt} [${String(ctx.config?.greeting ?? "")}]`
			},
		}),
	}
	return { loader, captured: () => captured }
}

const codeManifest = {
	name: "codeplug",
	version: "1.0.0",
	main: "index.js",
	permissions: { tools: true, systemPrompt: true, network: ["https://ok.example.com"] },
	config: { type: "object", properties: { greeting: { default: "hi" } } },
}

describe("PluginManager.activateCodePlugins (step 2.5)", () => {
	beforeEach(() => {
		setHost(createInMemoryHost())
		// Ensure a clean shared registry per test.
		for (const name of pluginRegistry.list()) pluginRegistry.unregister(name)
	})
	afterEach(() => {
		for (const name of pluginRegistry.list()) pluginRegistry.unregister(name)
	})

	it("loads an enabled code plugin, registers it, and its hooks fire with config", async () => {
		const fs = new MemoryFs()
		fs.addManifest("/plugins/codeplug", codeManifest)
		const { loader, captured } = makeCapturingLoader()
		const manager = new PluginManager({
			fs,
			pluginDirs: [{ dir: "/plugins", scope: "global" }],
			stateStore: new MemoryStore(["codeplug"]),
			codeLoader: loader,
			host: createInMemoryHost(),
			getPluginConfigs: () => ({ codeplug: { greeting: "yo" } }),
			workspacePath: "/work",
		})
		await manager.discover()
		await manager.activateCodePlugins()

		expect(pluginRegistry.has("codeplug")).toBe(true)
		// Stored config wins over the manifest default.
		expect(captured()?.config).toEqual({ greeting: "yo" })
		// A restricted host sandbox was injected.
		expect(captured()?.host).toBeDefined()
		expect(captured()?.workspacePath).toBe("/work")

		const tools = await pluginRegistry.collectTools()
		expect(tools.map((t) => t.name)).toEqual(["hello"])
		expect(await pluginRegistry.applySystemPromptTransforms("base")).toBe("base [yo]")
	})

	it("replaces a stale cross-manager registration instead of throwing 'already registered'", async () => {
		const fs = new MemoryFs()
		fs.addManifest("/plugins/codeplug", codeManifest)
		const mk = () =>
			new PluginManager({
				fs,
				pluginDirs: [{ dir: "/plugins", scope: "global" }],
				stateStore: new MemoryStore(["codeplug"]),
				codeLoader: makeCapturingLoader().loader,
				host: createInMemoryHost(),
				workspacePath: "/work",
			})

		const a = mk()
		await a.discover()
		await a.activateCodePlugins()
		expect(pluginRegistry.has("codeplug")).toBe(true)

		// A second manager (e.g. a second webview provider, or a concurrent build)
		// activating the same plugin must NOT throw — it replaces the shared entry.
		const b = mk()
		await b.discover()
		await expect(b.activateCodePlugins()).resolves.toBeUndefined()
		expect(pluginRegistry.list().filter((n) => n === "codeplug")).toHaveLength(1)

		// dispose() unregisters this manager's code plugins from the shared registry.
		await b.dispose()
		expect(pluginRegistry.has("codeplug")).toBe(false)
	})

	it("reloadPlugin rebuilds a code plugin's context with updated config", async () => {
		const fs = new MemoryFs()
		fs.addManifest("/plugins/codeplug", codeManifest)
		const { loader, captured } = makeCapturingLoader()
		let cfg: Record<string, unknown> = { greeting: "one" }
		const manager = new PluginManager({
			fs,
			pluginDirs: [{ dir: "/plugins", scope: "global" }],
			stateStore: new MemoryStore(["codeplug"]),
			codeLoader: loader,
			host: createInMemoryHost(),
			getPluginConfigs: () => ({ codeplug: cfg }),
			workspacePath: "/work",
		})
		await manager.discover()
		await manager.activateCodePlugins()
		expect(captured()?.config).toEqual({ greeting: "one" })

		// Simulate the user editing config (Plugins panel → setConfig) then a reload.
		cfg = { greeting: "two" }
		await manager.reloadPlugin("codeplug")
		expect(captured()?.config).toEqual({ greeting: "two" })
		// Reload must not leave a duplicate registration behind.
		expect(pluginRegistry.list().filter((n) => n === "codeplug")).toHaveLength(1)
	})

	it("falls back to the manifest default config when nothing is stored", async () => {
		const fs = new MemoryFs()
		fs.addManifest("/plugins/codeplug", codeManifest)
		const { loader, captured } = makeCapturingLoader()
		const manager = new PluginManager({
			fs,
			pluginDirs: [{ dir: "/plugins", scope: "global" }],
			stateStore: new MemoryStore(["codeplug"]),
			codeLoader: loader,
			host: createInMemoryHost(),
			workspacePath: "/work",
		})
		await manager.discover()
		await manager.activateCodePlugins()
		expect(captured()?.config).toEqual({ greeting: "hi" })
	})

	it("does nothing when no codeLoader is supplied (byte-for-byte identical)", async () => {
		const fs = new MemoryFs()
		fs.addManifest("/plugins/codeplug", codeManifest)
		const manager = new PluginManager({
			fs,
			pluginDirs: [{ dir: "/plugins", scope: "global" }],
			stateStore: new MemoryStore(["codeplug"]),
		})
		await manager.discover()
		await manager.activateCodePlugins()
		expect(pluginRegistry.has("codeplug")).toBe(false)
	})

	it("isolates a code-plugin load failure (warned, not thrown, not registered)", async () => {
		const fs = new MemoryFs()
		fs.addManifest("/plugins/codeplug", codeManifest)
		const failing: PluginCodeLoader = {
			load: async () => {
				throw new Error("boom")
			},
		}
		const manager = new PluginManager({
			fs,
			pluginDirs: [{ dir: "/plugins", scope: "global" }],
			stateStore: new MemoryStore(["codeplug"]),
			codeLoader: failing,
			host: createInMemoryHost(),
		})
		await manager.discover()
		await expect(manager.activateCodePlugins()).resolves.toBeUndefined()
		expect(pluginRegistry.has("codeplug")).toBe(false)
	})

	it("unregisters a code plugin when it is disabled", async () => {
		const fs = new MemoryFs()
		fs.addManifest("/plugins/codeplug", codeManifest)
		const { loader } = makeCapturingLoader()
		const manager = new PluginManager({
			fs,
			pluginDirs: [{ dir: "/plugins", scope: "global" }],
			stateStore: new MemoryStore(["codeplug"]),
			codeLoader: loader,
			host: createInMemoryHost(),
		})
		await manager.discover()
		await manager.activateCodePlugins()
		expect(pluginRegistry.has("codeplug")).toBe(true)

		await manager.setEnabled("codeplug", false) // triggers reconcile
		expect(pluginRegistry.has("codeplug")).toBe(false)
	})

	it("forwards lifecycle hooks and gates them on the manifest permissions.lifecycle grant (P3)", async () => {
		const fs = new MemoryFs()
		// Two plugins that both declare a beforeToolCall lifecycle hook; only one is
		// granted `permissions.lifecycle`.
		fs.addManifest("/plugins/granted", {
			name: "granted",
			version: "1.0.0",
			main: "index.js",
			permissions: { lifecycle: true },
		})
		fs.addManifest("/plugins/ungranted", {
			name: "ungranted",
			version: "1.0.0",
			main: "index.js",
			permissions: { tools: true },
		})
		const loader: PluginCodeLoader = {
			load: async (source: PluginCodeSource): Promise<ShoferPlugin> => ({
				name: source.name,
				lifecycle: { beforeToolCall: () => ({ allow: false, reason: `${source.name} blocked` }) },
			}),
		}
		const manager = new PluginManager({
			fs,
			pluginDirs: [{ dir: "/plugins", scope: "global" }],
			stateStore: new MemoryStore(["granted", "ungranted"]),
			codeLoader: loader,
			host: createInMemoryHost(),
		})
		await manager.discover()
		await manager.activateCodePlugins()

		expect(pluginRegistry.has("granted")).toBe(true)
		expect(pluginRegistry.has("ungranted")).toBe(true)
		// Only the granted plugin participates in lifecycle hooks.
		expect(pluginRegistry.hasLifecycleHook("beforeToolCall")).toBe(true)
		const gate = await pluginRegistry.applyBeforeToolCall("read_file", { path: "x" })
		expect(gate).toEqual({ allow: false, reason: "granted blocked" })
	})

	it("skips a code plugin failed closed by an unmet dependency (no registration)", async () => {
		const fs = new MemoryFs()
		fs.addManifest("/plugins/codeplug", { ...codeManifest, dependencies: ["missing"] })
		const { loader } = makeCapturingLoader()
		const manager = new PluginManager({
			fs,
			pluginDirs: [{ dir: "/plugins", scope: "global" }],
			stateStore: new MemoryStore(["codeplug"]),
			codeLoader: loader,
			host: createInMemoryHost(),
		})
		await manager.discover()
		await manager.activateCodePlugins()
		expect(pluginRegistry.has("codeplug")).toBe(false)
	})
})
