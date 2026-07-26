import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { createInMemoryHost, setHost, type PluginContext, type ShoferPlugin } from "@shofer/types"

import { PluginManager, type PluginFsHost, type PluginStateStore } from "../plugin-manager.js"
import { pluginRegistry } from "../plugin-registry.js"
import type { PluginCodeLoader, PluginCodeSource } from "../plugin-loader.js"
import type { PluginUiProvider } from "../plugin-ui.js"
import { createPluginUi } from "../plugin-ui.js"

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

/** A recording UI provider standing in for the host webview push seam. */
function makeUiProvider(): PluginUiProvider & { posts: Array<{ name: string; message: unknown }> } {
	const posts: Array<{ name: string; message: unknown }> = []
	return {
		posts,
		post(name, message) {
			posts.push({ name, message })
		},
	}
}

const uiManifest = (name: string) => ({
	name,
	version: "1.0.0",
	main: "index.js",
	permissions: { ui: ["sidebar-panel"] },
})

describe("plugin-ui — createPluginUi (unit)", () => {
	it("tags every push with the plugin name and delegates to the host provider", () => {
		const provider = makeUiProvider()
		const ui = createPluginUi("p", provider)
		ui.postMessage({ type: "state", n: 1 })
		ui.postMessage("hello")
		expect(provider.posts).toEqual([
			{ name: "p", message: { type: "state", n: 1 } },
			{ name: "p", message: "hello" },
		])
		// Surface exposes ONLY the scoped push + panel-open + settings-reveal — no host
		// internals leak.
		expect(Object.keys(ui)).toEqual(["postMessage", "showPanel", "openSettings"])
	})

	it("delegates openSettings to the host provider, name-tagged, and is a safe no-op without one", () => {
		const revealed: string[] = []
		const ui = createPluginUi("p", { post() {}, openSettings: (name) => void revealed.push(name) })
		ui.openSettings()
		expect(revealed).toEqual(["p"])

		// A host with no settings surface (headless): warned no-op, never a throw — a
		// plugin telling the user "approve me here" must be safe to call anywhere.
		expect(() => createPluginUi("p", { post() {} }).openSettings()).not.toThrow()
		expect(() =>
			createPluginUi("p", {
				post() {},
				openSettings() {
					throw new Error("no settings")
				},
			}).openSettings(),
		).not.toThrow()
	})

	it("delegates showPanel to the host provider, name-tagged, and is a safe no-op without one", () => {
		const opened: Array<{ name: string; opts: unknown }> = []
		const provider: PluginUiProvider = {
			post() {},
			showPanel(name, opts) {
				opened.push({ name, opts })
			},
		}
		const ui = createPluginUi("p", provider)
		ui.showPanel({ title: "My Panel" })
		ui.showPanel()
		expect(opened).toEqual([
			{ name: "p", opts: { title: "My Panel" } },
			{ name: "p", opts: undefined },
		])

		// A host with no panel surface: showPanel must never throw (warned no-op).
		const uiNoPanel = createPluginUi("p", { post() {} })
		expect(() => uiNoPanel.showPanel({ title: "x" })).not.toThrow()

		// A throwing/rejecting provider is isolated (a closed webview never breaks the hook).
		const uiThrows = createPluginUi("p", {
			post() {},
			showPanel() {
				throw new Error("panel gone")
			},
		})
		expect(() => uiThrows.showPanel()).not.toThrow()
	})

	it("swallows a delivery failure (a closed webview never breaks the hook)", () => {
		const ui = createPluginUi("p", {
			post() {
				throw new Error("webview gone")
			},
		})
		// Fire-and-forget + error-isolated: a throwing/rejecting provider must never
		// propagate to the plugin's hook (it is logged/warned host-side instead).
		expect(() => ui.postMessage("x")).not.toThrow()
	})
})

describe("PluginManager — ctx.ui gating (§6.8)", () => {
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
		const provider = makeUiProvider()
		const manager = new PluginManager({
			fs,
			pluginDirs: [{ dir: "/plugins", scope: "global" }],
			stateStore: new MemoryStore(opts.enabled),
			codeLoader: loader,
			host: createInMemoryHost(),
			uiProvider: opts.withProvider === false ? undefined : provider,
		})
		await manager.discover()
		await manager.activateCodePlugins()
		return { manager, captured, provider }
	}

	it("grants a live ctx.ui to a permissions.ui plugin — pushes reach the host seam, name-tagged", async () => {
		const { captured, provider } = await build({ manifest: uiManifest("p"), enabled: ["p"] })
		const ui = captured()?.ui
		expect(ui).toBeDefined()
		ui!.postMessage({ type: "state" })
		expect(provider.posts).toEqual([{ name: "p", message: { type: "state" } }])
	})

	it("omits ctx.ui entirely for a plugin WITHOUT any permissions.ui region", async () => {
		const { captured, provider } = await build({
			manifest: { name: "p", version: "1.0.0", main: "index.js", permissions: { tools: true } },
			enabled: ["p"],
		})
		expect(captured()?.ui).toBeUndefined()
		expect(provider.posts).toEqual([])
	})

	it("omits ctx.ui entirely when no host UI seam is wired (headless)", async () => {
		const { captured } = await build({ manifest: uiManifest("p"), enabled: ["p"], withProvider: false })
		expect(captured()?.ui).toBeUndefined()
	})
})
