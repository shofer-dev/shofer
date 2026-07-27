import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { createInMemoryHost, setHost, type PluginContext, type ShoferPlugin } from "@shofer/types"

import {
	PluginManager,
	type PluginFsHost,
	type PluginStateStore,
	type PluginAiConsentStore,
} from "../plugin-manager.js"
import { pluginRegistry } from "../plugin-registry.js"
import type { PluginCodeLoader, PluginCodeSource } from "../plugin-loader.js"
import type { PluginAiProvider } from "../plugin-ai.js"
import { createPluginAi, createDeniedPluginAi } from "../plugin-ai.js"
import type { ApiHandler } from "../../api/api-handler-types.js"

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

class MemoryConsentStore implements PluginAiConsentStore {
	constructor(public names: string[] = []) {}
	getAiConsentedPlugins(): string[] {
		return [...this.names]
	}
	setAiConsentedPlugins(names: string[]): void {
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

/** A fake ApiHandler — a sentinel so the test can assert it flows through unchanged. */
const FAKE_HANDLER = { __fakeHandler: true } as unknown as ApiHandler

/** A stub AI provider that records calls and never exposes keys. */
function makeAiProvider(): PluginAiProvider & { buildCalls: (string | undefined)[]; embedCalls: string[][] } {
	const buildCalls: (string | undefined)[] = []
	const embedCalls: string[][] = []
	return {
		buildCalls,
		embedCalls,
		async buildHandler(profileRef?: string) {
			buildCalls.push(profileRef)
			return FAKE_HANDLER
		},
		async embed(texts: string[]) {
			embedCalls.push(texts)
			return texts.map((_, i) => [i, i + 1])
		},
	}
}

const aiManifest = (name: string) => ({
	name,
	version: "1.0.0",
	main: "index.js",
	permissions: { ai: true },
})

describe("plugin-ai — createPluginAi / createDeniedPluginAi (P6.G1 unit)", () => {
	it("live surface delegates to the provider and returns the handler (no keys)", async () => {
		const provider = makeAiProvider()
		const ai = createPluginAi("p", provider)
		const handler = await ai.buildHandler("prof")
		expect(handler).toBe(FAKE_HANDLER)
		expect(provider.buildCalls).toEqual(["prof"])
		expect(await ai.embed(["a", "b"])).toEqual([
			[0, 1],
			[1, 2],
		])
		// A live surface reports consent without a billed call (P7 introspection).
		expect(ai.hasConsent()).toBe(true)
		// Surface exposes ONLY buildHandler + embed + hasConsent — no settings/keys leak through.
		expect(Object.keys(ai).sort()).toEqual(["buildHandler", "embed", "hasConsent"])
	})

	it("denied surface throws + warns on every call, and reports no consent", async () => {
		const warn = vi.fn()
		const ai = createDeniedPluginAi("p", warn)
		// hasConsent is read-only + side-effect-free: reflects "not consented" without throwing/warning.
		expect(ai.hasConsent()).toBe(false)
		await expect(ai.buildHandler()).rejects.toThrow(/not consented/)
		await expect(ai.embed(["x"])).rejects.toThrow(/not consented/)
		expect(warn).toHaveBeenCalledTimes(2)
	})
})

describe("PluginManager — ctx.ai gating (P6.G1)", () => {
	beforeEach(() => {
		setHost(createInMemoryHost())
		for (const name of pluginRegistry.list()) pluginRegistry.unregister(name)
	})
	afterEach(() => {
		for (const name of pluginRegistry.list()) pluginRegistry.unregister(name)
	})

	async function build(opts: { manifest: unknown; enabled: string[]; consented?: string[]; withProvider?: boolean }) {
		const fs = new MemoryFs()
		fs.addManifest("/plugins/p", opts.manifest)
		const { loader, captured } = makeCapturingLoader()
		const provider = makeAiProvider()
		const manager = new PluginManager({
			fs,
			pluginDirs: [{ dir: "/plugins", scope: "global" }],
			stateStore: new MemoryStore(opts.enabled),
			codeLoader: loader,
			host: createInMemoryHost(),
			aiProvider: opts.withProvider === false ? undefined : provider,
			aiConsentStore: new MemoryConsentStore(opts.consented ?? []),
		})
		await manager.discover()
		await manager.activateCodePlugins()
		return { manager, captured, provider }
	}

	it("grants a live ctx.ai to a granted + consented plugin", async () => {
		const { captured, provider } = await build({
			manifest: aiManifest("p"),
			enabled: ["p"],
			consented: ["p"],
		})
		const ai = captured()?.ai
		expect(ai).toBeDefined()
		expect(ai!.hasConsent()).toBe(true) // consent introspection reflects granted+consented
		expect(await ai!.buildHandler()).toBe(FAKE_HANDLER)
		expect(provider.buildCalls).toEqual([undefined]) // default profile
	})

	it("denies ctx.ai (stub throws) for a granted but UN-consented plugin", async () => {
		const { captured, provider } = await build({
			manifest: aiManifest("p"),
			enabled: ["p"],
			consented: [],
		})
		const ai = captured()?.ai
		expect(ai).toBeDefined() // present-but-denying, distinct from absent
		expect(ai!.hasConsent()).toBe(false) // introspection reflects granted-but-unconsented
		await expect(ai!.buildHandler()).rejects.toThrow(/not consented/)
		// The provider was NEVER reached — no billed call attempted.
		expect(provider.buildCalls).toEqual([])
	})

	it("omits ctx.ai entirely for a plugin that did not request permissions.ai", async () => {
		const { captured } = await build({
			manifest: { name: "p", version: "1.0.0", main: "index.js", permissions: { tools: true } },
			enabled: ["p"],
			consented: ["p"],
		})
		expect(captured()?.ai).toBeUndefined()
	})

	it("omits ctx.ai when no host AI provider seam is wired (headless)", async () => {
		const { captured } = await build({
			manifest: aiManifest("p"),
			enabled: ["p"],
			consented: ["p"],
			withProvider: false,
		})
		expect(captured()?.ai).toBeUndefined()
	})

	it("setAiConsent flips a denying stub to a live surface (reload)", async () => {
		const { manager, captured, provider } = await build({
			manifest: aiManifest("p"),
			enabled: ["p"],
			consented: [],
		})
		await expect(captured()?.ai?.buildHandler()).rejects.toThrow(/not consented/)
		await manager.setAiConsent("p", true)
		expect(manager.isAiConsented("p")).toBe(true)
		// After the reload the captured context is rebuilt with a live ctx.ai.
		expect(await captured()?.ai?.buildHandler()).toBe(FAKE_HANDLER)
		expect(provider.buildCalls).toEqual([undefined])
	})
})
