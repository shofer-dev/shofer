import { describe, it, expect, beforeEach } from "vitest"

import {
	PluginManager,
	type PluginDir,
	type PluginFsHost,
	type PluginStateStore,
} from "../plugin-manager.js"

/** In-memory {@link PluginFsHost}: a flat map of file paths + a set of dirs. */
class MemoryFs implements PluginFsHost {
	files = new Map<string, string>()
	dirs = new Set<string>()

	addManifest(root: string, manifest: unknown): void {
		this.dirs.add(root)
		this.files.set(`${root}/plugin.json`, typeof manifest === "string" ? manifest : JSON.stringify(manifest))
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
	async readFile(filePath: string): Promise<string> {
		const c = this.files.get(filePath)
		if (c === undefined) throw new Error(`ENOENT: ${filePath}`)
		return c
	}
	async exists(filePath: string): Promise<boolean> {
		return this.files.has(filePath) || this.dirs.has(filePath)
	}
	async removeDir(dir: string): Promise<void> {
		this.dirs.delete(dir)
		for (const key of [...this.files.keys()]) {
			if (key.startsWith(`${dir}/`)) this.files.delete(key)
		}
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

const modeManifest = (name: string, extra?: Record<string, unknown>) => ({
	name,
	version: "1.0.0",
	permissions: { modes: true, skills: true, commands: true, mcpServers: true, rules: true },
	contributes: {
		modes: [{ slug: "deploy", name: "Deploy", roleDefinition: "role", tools: ["read"] }],
		skills: [{ name: "deploy-skill", description: "a skill" }],
		commands: [{ name: "deploy", description: "a command" }],
		mcpServers: { srv: { type: "stdio", command: "node" } },
		rules: [{ path: "rules/x.md", modes: ["deploy"] }],
	},
	...extra,
})

describe("PluginManager (design §7, Phase 1)", () => {
	const PROJECT = "/ws/.shofer/plugins"
	const GLOBAL = "/home/.shofer/plugins"
	const dirs: PluginDir[] = [
		{ dir: GLOBAL, scope: "global" },
		{ dir: PROJECT, scope: "project" },
	]

	let fs: MemoryFs
	let store: MemoryStore

	beforeEach(() => {
		fs = new MemoryFs()
		store = new MemoryStore()
	})

	it("discovers a valid plugin (disabled by default)", async () => {
		fs.addManifest(`${PROJECT}/p1`, modeManifest("p1"))
		const pm = new PluginManager({ fs, stateStore: store, pluginDirs: dirs })
		await pm.discover()

		expect(pm.listPlugins().map((p) => p.name)).toEqual(["p1"])
		expect(pm.isEnabled("p1")).toBe(false)
		expect(pm.enabledPlugins()).toEqual([])
		// Nothing surfaced while disabled.
		expect(pm.getContributedModes()).toEqual([])
		expect(pm.getContributedSkillDirs()).toEqual([])
	})

	it("skips invalid and unparseable manifests with the rest intact", async () => {
		fs.addManifest(`${PROJECT}/good`, modeManifest("good"))
		fs.addManifest(`${PROJECT}/bad-json`, "{ not json")
		fs.addManifest(`${PROJECT}/bad-schema`, { version: "1.0.0" }) // missing name
		const pm = new PluginManager({ fs, stateStore: store, pluginDirs: dirs })
		await pm.discover()
		expect(pm.listPlugins().map((p) => p.name)).toEqual(["good"])
	})

	it("surfaces declarative contributions once enabled, tagged with the plugin", async () => {
		fs.addManifest(`${PROJECT}/p1`, modeManifest("p1"))
		const pm = new PluginManager({ fs, stateStore: store, pluginDirs: dirs })
		await pm.discover()
		await pm.setEnabled("p1", true)

		const modes = pm.getContributedModes()
		expect(modes).toHaveLength(1)
		// Slug is namespaced <pluginName>:<slug> (collision-free, design §14.7).
		expect(modes[0]).toMatchObject({ slug: "p1:deploy", source: "plugin", pluginName: "p1" })

		expect(pm.getContributedSkillDirs()).toEqual([{ pluginName: "p1", dir: `${PROJECT}/p1/skills` }])
		expect(pm.getContributedCommandDirs()).toEqual([{ pluginName: "p1", dir: `${PROJECT}/p1/commands` }])

		const mcp = pm.getContributedMcpServers()
		expect(mcp).toEqual([{ pluginName: "p1", name: "srv", config: { type: "stdio", command: "node" } }])

		const rules = pm.getContributedRules()
		expect(rules).toEqual([{ pluginName: "p1", path: `${PROJECT}/p1/rules/x.md`, modes: ["deploy"] }])
	})

	it("persists enable/disable across a re-discover", async () => {
		fs.addManifest(`${PROJECT}/p1`, modeManifest("p1"))
		const pm = new PluginManager({ fs, stateStore: store, pluginDirs: dirs })
		await pm.discover()
		await pm.setEnabled("p1", true)
		expect(store.names).toEqual(["p1"])

		const pm2 = new PluginManager({ fs, stateStore: store, pluginDirs: dirs })
		await pm2.discover()
		expect(pm2.isEnabled("p1")).toBe(true)

		await pm2.setEnabled("p1", false)
		expect(store.names).toEqual([])
	})

	it("gates contributions on the matching permission", async () => {
		// permissions.modes omitted → modes not surfaced even though contributed.
		fs.addManifest(`${PROJECT}/p1`, {
			name: "p1",
			version: "1.0.0",
			permissions: { skills: true },
			contributes: {
				modes: [{ slug: "deploy", name: "Deploy", roleDefinition: "role", tools: ["read"] }],
				skills: [{ name: "s", description: "d" }],
			},
		})
		const pm = new PluginManager({ fs, stateStore: store, pluginDirs: dirs })
		await pm.discover()
		await pm.setEnabled("p1", true)
		expect(pm.getContributedModes()).toEqual([])
		expect(pm.getContributedSkillDirs()).toHaveLength(1)
	})

	it("lets a project plugin shadow a global one with the same name", async () => {
		fs.addManifest(`${GLOBAL}/p1`, { ...modeManifest("p1"), version: "0.0.1" })
		fs.addManifest(`${PROJECT}/p1`, { ...modeManifest("p1"), version: "2.0.0" })
		const pm = new PluginManager({ fs, stateStore: store, pluginDirs: dirs })
		await pm.discover()
		const found = pm.listPlugins()
		expect(found).toHaveLength(1)
		expect(found[0]).toMatchObject({ version: "2.0.0", scope: "project" })
	})

	it("resolves MCP name collisions last-enabled-wins", async () => {
		fs.addManifest(`${GLOBAL}/a`, {
			name: "a",
			version: "1.0.0",
			permissions: { mcpServers: true },
			contributes: { mcpServers: { srv: { command: "a" } } },
		})
		fs.addManifest(`${PROJECT}/b`, {
			name: "b",
			version: "1.0.0",
			permissions: { mcpServers: true },
			contributes: { mcpServers: { srv: { command: "b" } } },
		})
		const pm = new PluginManager({ fs, stateStore: new MemoryStore(["a", "b"]), pluginDirs: dirs })
		await pm.discover()
		const mcp = pm.getContributedMcpServers()
		expect(mcp).toEqual([{ pluginName: "b", name: "srv", config: { command: "b" } }])
	})

	it("uninstall deletes the directory and drops all contributions", async () => {
		fs.addManifest(`${PROJECT}/p1`, modeManifest("p1"))
		const pm = new PluginManager({ fs, stateStore: new MemoryStore(["p1"]), pluginDirs: dirs })
		await pm.discover()
		expect(pm.getContributedModes()).toHaveLength(1)

		await pm.uninstall("p1")
		expect(pm.listPlugins()).toEqual([])
		expect(pm.getContributedModes()).toEqual([])
		expect(await fs.exists(`${PROJECT}/p1/plugin.json`)).toBe(false)
	})

	it("reports contribution counts and code flag on each plugin", async () => {
		fs.addManifest(`${PROJECT}/p1`, { ...modeManifest("p1"), main: "index.ts" })
		const pm = new PluginManager({ fs, stateStore: store, pluginDirs: dirs })
		await pm.discover()
		const p = pm.getPlugin("p1")!
		expect(p.hasCode).toBe(true)
		expect(p.contributionCounts).toEqual({ modes: 1, skills: 1, commands: 1, mcpServers: 1, rules: 1 })
	})
})
