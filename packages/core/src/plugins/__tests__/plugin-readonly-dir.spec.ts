import { describe, it, expect, beforeEach } from "vitest"

import { PluginManager, type PluginDir, type PluginFsHost, type PluginStateStore } from "../plugin-manager.js"

/**
 * Host-provisioned plugin directories (`PluginDir.readOnly`, delivered as
 * `SHOFER_PLUGIN_DIRS`).
 *
 * The case they exist for: a deployment mounts plugin code somewhere the person using
 * the host cannot write, because the plugin may be there to CONSTRAIN that person. Every
 * standard root fails that test — `~/.shofer/plugins` and `<cwd>/.shofer/plugins` are
 * both writable by them — so two properties have to hold, and neither is obvious from
 * the discovery loop alone: a user-writable root must not be able to shadow the name,
 * and uninstall must refuse rather than fail against a read-only mount.
 */
describe("PluginManager read-only plugin directories", () => {
	const USER = "/home/user/.shofer/plugins"
	const PLATFORM = "/etc/shofer/plugins"

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

	// The order the host builds: the user's own root first, the provisioned mount last.
	const dirs: PluginDir[] = [
		{ dir: USER, scope: "global" },
		{ dir: PLATFORM, scope: "global", readOnly: true },
	]
	const manifest = (name: string, version: string) => ({ name, version, permissions: { tools: true } })

	let fs: MemoryFs
	let store: MemoryStore

	beforeEach(() => {
		fs = new MemoryFs()
		store = new MemoryStore()
	})

	it("marks a plugin from a read-only dir, and one from a writable dir not", async () => {
		fs.addManifest(`${USER}/mine`, manifest("mine", "1.0.0"))
		fs.addManifest(`${PLATFORM}/ci-guard`, manifest("ci-guard", "1.0.0"))
		const pm = new PluginManager({ fs, stateStore: store, pluginDirs: dirs })
		await pm.discover()

		expect(pm.getPlugin("ci-guard")?.readOnly).toBe(true)
		expect(pm.getPlugin("mine")?.readOnly).toBe(false)
	})

	it("wins over a same-named plugin the user dropped into their own root", async () => {
		// The whole point: scanning the provisioned mount LAST is what makes the org's
		// copy the one that loads. Reverse the order and the user's shadows it.
		fs.addManifest(`${USER}/ci-guard`, manifest("ci-guard", "9.9.9"))
		fs.addManifest(`${PLATFORM}/ci-guard`, manifest("ci-guard", "1.0.0"))
		const pm = new PluginManager({ fs, stateStore: store, pluginDirs: dirs })
		await pm.discover()

		const found = pm.getPlugin("ci-guard")
		expect(found?.root).toBe(`${PLATFORM}/ci-guard`)
		expect(found?.version).toBe("1.0.0")
		expect(found?.readOnly).toBe(true)
	})

	it("refuses to uninstall a host-provisioned plugin, touching neither disk nor state", async () => {
		fs.addManifest(`${PLATFORM}/ci-guard`, manifest("ci-guard", "1.0.0"))
		store.names = ["ci-guard"]
		const pm = new PluginManager({ fs, stateStore: store, pluginDirs: dirs })
		await pm.discover()

		await pm.uninstall("ci-guard")

		expect(fs.removed).toEqual([])
		expect(store.names).toEqual(["ci-guard"])
		expect(pm.getPlugin("ci-guard")).toBeDefined()
	})

	it("still uninstalls a plugin the user installed themselves", async () => {
		fs.addManifest(`${USER}/mine`, manifest("mine", "1.0.0"))
		store.names = ["mine"]
		const pm = new PluginManager({ fs, stateStore: store, pluginDirs: dirs })
		await pm.discover()

		await pm.uninstall("mine")

		expect(fs.removed).toContain(`${USER}/mine`)
		expect(pm.getPlugin("mine")).toBeUndefined()
	})
})
