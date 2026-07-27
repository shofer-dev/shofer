import { describe, it, expect, beforeEach, afterEach } from "vitest"
import path from "path"
import { createInMemoryHost, setHost, type HostFileSystem, type PluginContext, type ShoferPlugin } from "@shofer/types"

import { createPluginStorage } from "../plugin-storage.js"
import { PluginManager, type PluginFsHost, type PluginStateStore } from "../plugin-manager.js"
import { pluginRegistry } from "../plugin-registry.js"
import type { PluginCodeLoader, PluginCodeSource } from "../plugin-loader.js"

/** A minimal in-memory {@link HostFileSystem} with real path semantics for storage tests. */
class MemoryHostFs implements HostFileSystem {
	files = new Map<string, string>()
	dirs = new Set<string>()
	async readFile(p: string): Promise<string> {
		const c = this.files.get(path.resolve(p))
		if (c === undefined) throw new Error(`ENOENT: ${p}`)
		return c
	}
	async writeFile(p: string, content: string): Promise<void> {
		this.files.set(path.resolve(p), content)
	}
	async exists(p: string): Promise<boolean> {
		const r = path.resolve(p)
		return this.files.has(r) || this.dirs.has(r)
	}
	async mkdir(p: string): Promise<void> {
		this.dirs.add(path.resolve(p))
	}
	async delete(p: string): Promise<void> {
		this.files.delete(path.resolve(p))
	}
	async findFiles(_pattern: string, options: { cwd: string }): Promise<string[]> {
		const base = path.resolve(options.cwd) + path.sep
		return [...this.files.keys()].filter((f) => f.startsWith(base)).sort()
	}
}

describe("plugin-storage — createPluginStorage (P6.G2)", () => {
	it("writes then reads a file under its dir (round-trip)", async () => {
		const fs = new MemoryHostFs()
		const storage = createPluginStorage("p", "/data/p", fs)
		expect(storage.dir).toBe(path.resolve("/data/p"))
		await storage.writeFile("notes/todo.txt", "hello")
		expect(await storage.exists("notes/todo.txt")).toBe(true)
		expect(await storage.readFile("notes/todo.txt")).toBe("hello")
		expect(await storage.list()).toEqual([path.resolve("/data/p/notes/todo.txt")])
		await storage.delete("notes/todo.txt")
		expect(await storage.exists("notes/todo.txt")).toBe(false)
	})

	it("blocks path traversal on every op", async () => {
		const fs = new MemoryHostFs()
		const storage = createPluginStorage("p", "/data/p", fs)
		await expect(storage.readFile("../q/secret")).rejects.toThrow(/escapes/)
		await expect(storage.writeFile("../../etc/passwd", "x")).rejects.toThrow(/escapes/)
		await expect(storage.exists("../q")).rejects.toThrow(/escapes/)
		await expect(storage.delete("../q/secret")).rejects.toThrow(/escapes/)
		await expect(storage.list("../q")).rejects.toThrow(/escapes/)
		// An absolute path that escapes root is denied too.
		await expect(storage.readFile("/etc/passwd")).rejects.toThrow(/escapes/)
	})

	it("isolates two plugins' storage (separate dirs, no cross-read)", async () => {
		const fs = new MemoryHostFs()
		const a = createPluginStorage("a", "/data/a", fs)
		const b = createPluginStorage("b", "/data/b", fs)
		await a.writeFile("x", "from-a")
		await b.writeFile("x", "from-b")
		expect(await a.readFile("x")).toBe("from-a")
		expect(await b.readFile("x")).toBe("from-b")
		// a cannot see b's file — its list is scoped to its own dir.
		expect(await a.list()).toEqual([path.resolve("/data/a/x")])
	})
})

// --- Manager integration: ctx.storage is threaded into a code plugin's context ---

class MemoryFs implements PluginFsHost {
	files = new Map<string, string>()
	dirs = new Set<string>()
	removed: string[] = []
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
	async removeDir(dir: string): Promise<void> {
		this.removed.push(dir)
	}
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

describe("PluginManager — ctx.storage wiring (P6.G2)", () => {
	beforeEach(() => {
		setHost(createInMemoryHost())
		for (const name of pluginRegistry.list()) pluginRegistry.unregister(name)
	})
	afterEach(() => {
		for (const name of pluginRegistry.list()) pluginRegistry.unregister(name)
	})

	it("provides ctx.storage rooted at <storageBaseDir>/<name> when wired", async () => {
		const fs = new MemoryFs()
		fs.addManifest("/plugins/p", { name: "p", version: "1.0.0", main: "index.js" })
		const { loader, captured } = makeCapturingLoader()
		const manager = new PluginManager({
			fs,
			pluginDirs: [{ dir: "/plugins", scope: "global" }],
			stateStore: new MemoryStore(["p"]),
			codeLoader: loader,
			host: createInMemoryHost(),
			storageBaseDir: "/store",
		})
		await manager.discover()
		await manager.activateCodePlugins()
		expect(captured()?.storage?.dir).toBe(path.resolve("/store/p"))
	})

	it("omits ctx.storage when no storageBaseDir is wired", async () => {
		const fs = new MemoryFs()
		fs.addManifest("/plugins/p", { name: "p", version: "1.0.0", main: "index.js" })
		const { loader, captured } = makeCapturingLoader()
		const manager = new PluginManager({
			fs,
			pluginDirs: [{ dir: "/plugins", scope: "global" }],
			stateStore: new MemoryStore(["p"]),
			codeLoader: loader,
			host: createInMemoryHost(),
		})
		await manager.discover()
		await manager.activateCodePlugins()
		expect(captured()?.storage).toBeUndefined()
	})

	it("removes the storage dir on uninstall", async () => {
		const fs = new MemoryFs()
		fs.addManifest("/plugins/p", { name: "p", version: "1.0.0", main: "index.js" })
		const manager = new PluginManager({
			fs,
			pluginDirs: [{ dir: "/plugins", scope: "global" }],
			stateStore: new MemoryStore(["p"]),
			host: createInMemoryHost(),
			storageBaseDir: "/store",
		})
		await manager.discover()
		await manager.uninstall("p")
		expect(fs.removed).toContain(path.join("/store", "p"))
	})
})
