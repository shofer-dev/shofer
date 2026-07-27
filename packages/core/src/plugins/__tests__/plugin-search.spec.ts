import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { createInMemoryHost, setHost, type PluginContext, type ShoferPlugin } from "@shofer/types"

import { PluginManager, type PluginFsHost, type PluginStateStore } from "../plugin-manager.js"
import { pluginRegistry } from "../plugin-registry.js"
import type { PluginCodeLoader, PluginCodeSource } from "../plugin-loader.js"
import type { PluginSearchProvider } from "../plugin-search.js"
import { createPluginSearch, createDeniedPluginSearch } from "../plugin-search.js"

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

/** A recording search provider standing in for the host index/symbol/diagnostics seam. */
function makeSearchProvider(): PluginSearchProvider & { calls: string[] } {
	const calls: string[] = []
	return {
		calls,
		async ragSearch(query) {
			calls.push(`rag:${query}`)
			return [{ filePath: "a.ts", startLine: 1, endLine: 5, score: 0.9, snippet: "code" }]
		},
		async gitSearch(query) {
			calls.push(`git:${query}`)
			return [
				{
					commitHash: "deadbeef",
					shortHash: "dead",
					author: "me",
					authorDate: "2026",
					subject: "fix",
					body: "",
					score: 0.8,
				},
			]
		},
		async codeUsages(symbol) {
			calls.push(`usages:${symbol}`)
			return [{ name: symbol, kind: "Function", filePath: "a.ts", line: 3 }]
		},
		async diagnostics(path) {
			calls.push(`diag:${path ?? "*"}`)
			return [{ filePath: "a.ts", line: 2, column: 1, severity: "error", message: "boom" }]
		},
	}
}

const searchManifest = (name: string) => ({
	name,
	version: "1.0.0",
	main: "index.js",
	permissions: { search: true },
})

describe("plugin-search — createPluginSearch / createDeniedPluginSearch (unit)", () => {
	it("live surface delegates every query to the host provider", async () => {
		const provider = makeSearchProvider()
		const search = createPluginSearch("p", provider)
		expect(await search.ragSearch("q")).toEqual([
			{ filePath: "a.ts", startLine: 1, endLine: 5, score: 0.9, snippet: "code" },
		])
		expect(await search.gitSearch("g")).toHaveLength(1)
		expect(await search.codeUsages("Foo")).toEqual([{ name: "Foo", kind: "Function", filePath: "a.ts", line: 3 }])
		expect(await search.diagnostics("a.ts")).toEqual([
			{ filePath: "a.ts", line: 2, column: 1, severity: "error", message: "boom" },
		])
		expect(provider.calls).toEqual(["rag:q", "git:g", "usages:Foo", "diag:a.ts"])
		// Surface exposes ONLY the four query methods — no host internals leak.
		expect(Object.keys(search).sort()).toEqual(["codeUsages", "diagnostics", "gitSearch", "ragSearch"])
	})

	it("surfaces + warns on a provider failure", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		const provider: PluginSearchProvider = {
			async ragSearch() {
				throw new Error("boom")
			},
			async gitSearch() {
				return []
			},
			async codeUsages() {
				return []
			},
			async diagnostics() {
				return []
			},
		}
		const search = createPluginSearch("p", provider)
		await expect(search.ragSearch("q")).rejects.toThrow(/boom/)
		warnSpy.mockRestore()
	})

	it("denied surface throws + warns on every query", async () => {
		const warn = vi.fn()
		const search = createDeniedPluginSearch("p", warn)
		await expect(search.ragSearch("q")).rejects.toThrow(/denied/)
		await expect(search.gitSearch("q")).rejects.toThrow(/denied/)
		await expect(search.codeUsages("q")).rejects.toThrow(/denied/)
		await expect(search.diagnostics()).rejects.toThrow(/denied/)
		expect(warn).toHaveBeenCalledTimes(4)
	})
})

describe("PluginManager — ctx.host.search gating (§6.11)", () => {
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
		const provider = makeSearchProvider()
		const manager = new PluginManager({
			fs,
			pluginDirs: [{ dir: "/plugins", scope: "global" }],
			stateStore: new MemoryStore(opts.enabled),
			codeLoader: loader,
			host: createInMemoryHost(),
			searchProvider: opts.withProvider === false ? undefined : provider,
		})
		await manager.discover()
		await manager.activateCodePlugins()
		return { manager, captured, provider }
	}

	it("grants a live ctx.host.search to a granted plugin — queries reach the host seam", async () => {
		const { captured, provider } = await build({ manifest: searchManifest("p"), enabled: ["p"] })
		const search = captured()?.host?.search
		expect(search).toBeDefined()
		const results = await search!.ragSearch("where is X")
		expect(results).toEqual([{ filePath: "a.ts", startLine: 1, endLine: 5, score: 0.9, snippet: "code" }])
		expect(provider.calls).toEqual(["rag:where is X"])
	})

	it("denies ctx.host.search (stub throws + warns) for a plugin WITHOUT permissions.search", async () => {
		const { captured, provider } = await build({
			manifest: { name: "p", version: "1.0.0", main: "index.js", permissions: { tools: true } },
			enabled: ["p"],
		})
		const search = captured()?.host?.search
		expect(search).toBeDefined() // present-but-denying, distinct from absent
		await expect(search!.ragSearch("try")).rejects.toThrow(/denied/)
		// The host seam was NEVER reached — no query attempted.
		expect(provider.calls).toEqual([])
	})

	it("omits ctx.host.search entirely when no host search seam is wired (headless)", async () => {
		const { captured } = await build({
			manifest: searchManifest("p"),
			enabled: ["p"],
			withProvider: false,
		})
		expect(captured()?.host?.search).toBeUndefined()
	})
})
