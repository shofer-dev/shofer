import { describe, it, expect, beforeEach } from "vitest"

import { PluginManager, type PluginDir, type PluginFsHost, type PluginStateStore } from "../plugin-manager.js"

/**
 * Deployment **activation** (`forceEnabledPlugins`, delivered as `SHOFER_ENABLED_PLUGINS`).
 *
 * The case it exists for: a pod is provisioned with a plugin because running it is the
 * pod's whole job — a headless Shofer that must register as a Temporal runner before any
 * human is present. There is no Plugins panel there, and the plugin is **global** scope,
 * which `defaultEnabled` deliberately refuses (a non-bundled plugin must never enable
 * itself). Without this seam such a host comes up running nothing, silently.
 */
describe("PluginManager deployment activation", () => {
	const GLOBAL = "/home/.shofer/plugins"

	class MemoryFs implements PluginFsHost {
		files = new Map<string, string>()
		dirs = new Set<string>()

		addManifest(root: string, manifest: unknown): void {
			this.dirs.add(root)
			this.files.set(`${root}/plugin.json`, JSON.stringify(manifest))
		}
		async listDirs(dir: string): Promise<string[]> {
			const prefix = `${dir}/`
			return [...this.dirs].filter((d) => d.startsWith(prefix)).map((d) => d.slice(prefix.length))
		}
		async listFiles(): Promise<string[]> {
			return []
		}
		async readFile(filePath: string): Promise<string> {
			const content = this.files.get(filePath)
			if (content === undefined) throw new Error(`ENOENT: ${filePath}`)
			return content
		}
		async exists(filePath: string): Promise<boolean> {
			return this.files.has(filePath) || this.dirs.has(filePath)
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

	const dirs: PluginDir[] = [{ dir: GLOBAL, scope: "global" }]
	const manifest = (name: string) => ({ name, version: "1.0.0", permissions: { tools: true } })

	let fs: MemoryFs
	let store: MemoryStore

	beforeEach(() => {
		fs = new MemoryFs()
		store = new MemoryStore()
		fs.addManifest(`${GLOBAL}/temporal-runner`, manifest("temporal-runner"))
	})

	it("brings a global-scope plugin up enabled with no user enable state", async () => {
		const pm = new PluginManager({
			fs,
			stateStore: store,
			pluginDirs: dirs,
			forceEnabledPlugins: ["temporal-runner"],
		})
		await pm.discover()

		expect(pm.isEnabled("temporal-runner")).toBe(true)
		// The host said so out-of-band — nothing was written to the user's enable list.
		expect(store.names).toEqual([])
	})

	it("leaves an unlisted plugin alone", async () => {
		fs.addManifest(`${GLOBAL}/other`, manifest("other"))
		const pm = new PluginManager({
			fs,
			stateStore: store,
			pluginDirs: dirs,
			forceEnabledPlugins: ["temporal-runner"],
		})
		await pm.discover()

		expect(pm.isEnabled("other")).toBe(false)
	})

	it("loses to suppression when a name is in both lists", async () => {
		const pm = new PluginManager({
			fs,
			stateStore: store,
			pluginDirs: dirs,
			forceEnabledPlugins: ["temporal-runner"],
			forceDisabledPlugins: ["temporal-runner"],
		})
		await pm.discover()

		expect(pm.isEnabled("temporal-runner")).toBe(false)
	})

	it("cannot be turned off from the panel — the toggle records intent but does not take", async () => {
		const pm = new PluginManager({
			fs,
			stateStore: store,
			pluginDirs: dirs,
			forceEnabledPlugins: ["temporal-runner"],
		})
		await pm.discover()
		await pm.setEnabled("temporal-runner", false)

		expect(pm.isEnabled("temporal-runner")).toBe(true)
	})
})
