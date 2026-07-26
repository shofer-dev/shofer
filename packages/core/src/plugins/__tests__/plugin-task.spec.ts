import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
	createInMemoryHost,
	setHost,
	type PluginContext,
	type PluginMarker,
	type PluginMarkerInput,
	type PluginRewindOptions,
	type ShoferPlugin,
} from "@shofer/types"

import { PluginManager, type PluginFsHost, type PluginStateStore } from "../plugin-manager.js"
import { pluginRegistry } from "../plugin-registry.js"
import type { PluginCodeLoader, PluginCodeSource } from "../plugin-loader.js"
import { type PluginTaskProvider, createPluginTaskControl, createDeniedPluginTaskControl } from "../plugin-task.js"

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
	constructor(
		public names: string[] = [],
		public disabled: string[] = [],
	) {}
	getEnabledPlugins(): string[] {
		return [...this.names]
	}
	setEnabledPlugins(names: string[]): void {
		this.names = [...names]
	}
	getDisabledPlugins(): string[] {
		return [...this.disabled]
	}
	setDisabledPlugins(names: string[]): void {
		this.disabled = [...names]
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

/** A recording task provider standing in for the host timeline seam. */
function makeTaskProvider(): PluginTaskProvider & {
	markers: { plugin: string; input: PluginMarkerInput }[]
	rewinds: { plugin: string; ts: number; opts?: PluginRewindOptions }[]
} {
	const markers: { plugin: string; input: PluginMarkerInput }[] = []
	const rewinds: { plugin: string; ts: number; opts?: PluginRewindOptions }[] = []
	return {
		markers,
		rewinds,
		async marker(plugin, input) {
			markers.push({ plugin, input })
		},
		async listMarkers(plugin): Promise<PluginMarker[]> {
			return markers
				.filter((m) => m.plugin === plugin)
				.map((m, i) => ({ ...m.input, ts: i + 1, pluginName: plugin }))
		},
		async rewind(plugin, ts, opts) {
			rewinds.push({ plugin, ts, opts })
		},
	}
}

const taskManifest = (name: string) => ({
	name,
	version: "1.0.0",
	main: "index.js",
	permissions: { task: true },
})

describe("plugin-task — createPluginTaskControl / createDeniedPluginTaskControl", () => {
	it("tags every call with the plugin name so markers are owner-scoped", async () => {
		const provider = makeTaskProvider()
		const control = createPluginTaskControl("p", provider)
		await control.marker({ kind: "checkpoint", text: "abc123", restorable: true })
		await control.rewind(42, { includeTargetMessage: true })

		expect(provider.markers).toEqual([
			{ plugin: "p", input: { kind: "checkpoint", text: "abc123", restorable: true } },
		])
		expect(provider.rewinds).toEqual([{ plugin: "p", ts: 42, opts: { includeTargetMessage: true } }])
		expect(Object.keys(control)).toEqual(["marker", "listMarkers", "rewind"])
	})

	it("reads back only its own markers", async () => {
		const provider = makeTaskProvider()
		await createPluginTaskControl("mine", provider).marker({ kind: "k", text: "mine-1" })
		await createPluginTaskControl("other", provider).marker({ kind: "k", text: "other-1" })

		const mine = await createPluginTaskControl("mine", provider).listMarkers()
		expect(mine.map((m) => m.text)).toEqual(["mine-1"])
	})

	it("surfaces a provider failure to the plugin (never swallowed)", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		const control = createPluginTaskControl("p", {
			async marker() {
				throw new Error("boom")
			},
			async listMarkers() {
				return []
			},
			async rewind() {},
		})
		await expect(control.marker({ kind: "k", text: "t" })).rejects.toThrow(/boom/)
		warnSpy.mockRestore()
	})

	it("denied surface throws + warns rather than silently no-oping", async () => {
		const warn = vi.fn()
		const control = createDeniedPluginTaskControl("p", warn)
		await expect(control.marker({ kind: "k", text: "t" })).rejects.toThrow(/denied/)
		await expect(control.rewind(1)).rejects.toThrow(/denied/)
		expect(warn).toHaveBeenCalledTimes(2)
	})
})

describe("PluginManager — ctx.task gating", () => {
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
		const provider = makeTaskProvider()
		const manager = new PluginManager({
			fs,
			pluginDirs: [{ dir: "/plugins", scope: "global" }],
			stateStore: new MemoryStore(opts.enabled),
			codeLoader: loader,
			host: createInMemoryHost(),
			taskProvider: opts.withProvider === false ? undefined : provider,
		})
		await manager.discover()
		await manager.activateCodePlugins()
		return { manager, captured, provider }
	}

	it("grants a live ctx.task to a granted plugin — marker reaches the host seam", async () => {
		const { captured, provider } = await build({ manifest: taskManifest("p"), enabled: ["p"] })
		await captured()!.task!.marker({ kind: "checkpoint", text: "deadbeef" })
		expect(provider.markers).toEqual([{ plugin: "p", input: { kind: "checkpoint", text: "deadbeef" } }])
	})

	it("denies ctx.task (stub throws) for a plugin WITHOUT permissions.task", async () => {
		const { captured, provider } = await build({
			manifest: { name: "p", version: "1.0.0", main: "index.js", permissions: { tools: true } },
			enabled: ["p"],
		})
		const task = captured()?.task
		expect(task).toBeDefined() // present-but-denying, distinct from absent
		await expect(task!.rewind(1)).rejects.toThrow(/denied/)
		expect(provider.rewinds).toEqual([])
	})

	it("omits ctx.task entirely when no host task seam is wired (pure core)", async () => {
		const { captured } = await build({ manifest: taskManifest("p"), enabled: ["p"], withProvider: false })
		expect(captured()?.task).toBeUndefined()
	})
})

describe("PluginManager — defaultEnabled (bundled first-party plugins)", () => {
	beforeEach(() => {
		setHost(createInMemoryHost())
		for (const name of pluginRegistry.list()) pluginRegistry.unregister(name)
	})

	function build(opts: {
		scope: "bundled" | "global"
		defaultEnabled?: boolean
		store: PluginStateStore
	}): PluginManager {
		const fs = new MemoryFs()
		fs.addManifest("/plugins/p", {
			name: "p",
			version: "1.0.0",
			...(opts.defaultEnabled === undefined ? {} : { defaultEnabled: opts.defaultEnabled }),
		})
		return new PluginManager({
			fs,
			pluginDirs: [{ dir: "/plugins", scope: opts.scope }],
			stateStore: opts.store,
		})
	}

	it("enables a bundled defaultEnabled plugin with no recorded decision", async () => {
		const manager = build({ scope: "bundled", defaultEnabled: true, store: new MemoryStore() })
		await manager.discover()
		expect(manager.isEnabled("p")).toBe(true)
	})

	it("keeps it off once the user disabled it — the decision survives re-discovery", async () => {
		const store = new MemoryStore()
		const manager = build({ scope: "bundled", defaultEnabled: true, store })
		await manager.discover()
		await manager.setEnabled("p", false)
		expect(manager.isEnabled("p")).toBe(false)
		expect(store.disabled).toEqual(["p"])

		const rebuilt = build({ scope: "bundled", defaultEnabled: true, store })
		await rebuilt.discover()
		expect(rebuilt.isEnabled("p")).toBe(false)
	})

	it("re-enabling clears the disable record", async () => {
		const store = new MemoryStore([], ["p"])
		const manager = build({ scope: "bundled", defaultEnabled: true, store })
		await manager.discover()
		expect(manager.isEnabled("p")).toBe(false)
		await manager.setEnabled("p", true)
		expect(store.disabled).toEqual([])
		expect(manager.isEnabled("p")).toBe(true)
	})

	it("ignores defaultEnabled for a non-bundled plugin — third parties can't enable themselves", async () => {
		const manager = build({ scope: "global", defaultEnabled: true, store: new MemoryStore() })
		await manager.discover()
		expect(manager.isEnabled("p")).toBe(false)
	})

	it("ignores defaultEnabled when the store cannot record a disable (else it would be un-turn-off-able)", async () => {
		const minimalStore: PluginStateStore = {
			getEnabledPlugins: () => [],
			setEnabledPlugins: () => {},
		}
		const manager = build({ scope: "bundled", defaultEnabled: true, store: minimalStore })
		await manager.discover()
		expect(manager.isEnabled("p")).toBe(false)
	})
})
