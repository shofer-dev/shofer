import { describe, it, expect, beforeEach } from "vitest"
import { createInMemoryHost, setHost, type Notifier } from "@shofer/types"

import {
	PluginManager,
	type PluginDir,
	type PluginFsHost,
	type PluginStateStore,
} from "../plugin-manager.js"

/** Notifier that records shown messages, for asserting warnings are surfaced. */
interface RecordingNotifier extends Notifier {
	messages: Array<{ level: string; message: string }>
}

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
		// Slug is the natural authored slug (no namespacing, design §14.7).
		expect(modes[0]).toMatchObject({ slug: "deploy", source: "plugin", pluginName: "p1" })

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

describe("PluginManager — fail-closed dependencies (design §14.3, Q3)", () => {
	const PROJECT = "/ws/.shofer/plugins"
	const GLOBAL = "/home/.shofer/plugins"
	const dirs: PluginDir[] = [
		{ dir: GLOBAL, scope: "global" },
		{ dir: PROJECT, scope: "project" },
	]

	let fs: MemoryFs
	let notifier: RecordingNotifier

	beforeEach(() => {
		fs = new MemoryFs()
		// Route getHost().notifier.warn to a recording notifier so we can assert the
		// warning is *shown* (not just logged).
		const host = createInMemoryHost()
		notifier = host.notifier as RecordingNotifier
		setHost(host)
	})

	const shownWarnings = () => notifier.messages.filter((m) => m.level === "warn").map((m) => m.message)

	it("disables a plugin whose dependency is not enabled, and warns (shown + suppressed contributions)", async () => {
		fs.addManifest(`${PROJECT}/base`, modeManifest("base"))
		fs.addManifest(`${PROJECT}/app`, modeManifest("app", { dependencies: ["base"] }))
		// app is enabled, base is NOT.
		const pm = new PluginManager({ fs, stateStore: new MemoryStore(["app"]), pluginDirs: dirs })
		await pm.discover()

		const app = pm.getPlugin("app")!
		expect(app.enabled).toBe(true) // user intent preserved
		expect(app.effectiveEnabled).toBe(false) // but inactive
		expect(app.disabledReason).toMatch(/base/)
		// None of app's contributions surface.
		expect(pm.getContributedModes()).toEqual([])
		expect(pm.getContributedSkillDirs()).toEqual([])
		expect(pm.enabledPlugins()).toEqual([])
		// Warning is shown to the user, naming the missing dependency.
		expect(shownWarnings().some((m) => m.includes("app") && m.includes("base"))).toBe(true)
	})

	it("disables a plugin whose dependency is missing (not discovered)", async () => {
		fs.addManifest(`${PROJECT}/app`, modeManifest("app", { dependencies: ["ghost"] }))
		const pm = new PluginManager({ fs, stateStore: new MemoryStore(["app"]), pluginDirs: dirs })
		await pm.discover()
		const app = pm.getPlugin("app")!
		expect(app.effectiveEnabled).toBe(false)
		expect(app.disabledReason).toMatch(/ghost/)
		expect(shownWarnings().some((m) => m.includes("ghost"))).toBe(true)
	})

	it("registers a plugin whose whole dependency closure is enabled", async () => {
		fs.addManifest(`${PROJECT}/base`, modeManifest("base"))
		fs.addManifest(`${PROJECT}/app`, modeManifest("app", { dependencies: ["base"] }))
		const pm = new PluginManager({ fs, stateStore: new MemoryStore(["base", "app"]), pluginDirs: dirs })
		await pm.discover()
		expect(pm.getPlugin("app")!.effectiveEnabled).toBe(true)
		expect(pm.getPlugin("base")!.effectiveEnabled).toBe(true)
		expect(pm.enabledPlugins().map((p) => p.name).sort()).toEqual(["app", "base"])
		expect(shownWarnings()).toEqual([])
	})

	it("cascades a transitive failure (A→B→C, C disabled ⇒ A and B fail closed)", async () => {
		fs.addManifest(`${PROJECT}/c`, modeManifest("c"))
		fs.addManifest(`${PROJECT}/b`, modeManifest("b", { dependencies: ["c"] }))
		fs.addManifest(`${PROJECT}/a`, modeManifest("a", { dependencies: ["b"] }))
		// a and b enabled; c NOT enabled.
		const pm = new PluginManager({ fs, stateStore: new MemoryStore(["a", "b"]), pluginDirs: dirs })
		await pm.discover()
		expect(pm.getPlugin("a")!.effectiveEnabled).toBe(false)
		expect(pm.getPlugin("b")!.effectiveEnabled).toBe(false)
		expect(pm.getPlugin("a")!.disabledReason).toMatch(/c/)
	})

	it("fails every plugin in a dependency cycle closed (no infinite loop)", async () => {
		fs.addManifest(`${PROJECT}/x`, modeManifest("x", { dependencies: ["y"] }))
		fs.addManifest(`${PROJECT}/y`, modeManifest("y", { dependencies: ["x"] }))
		const pm = new PluginManager({ fs, stateStore: new MemoryStore(["x", "y"]), pluginDirs: dirs })
		await pm.discover()
		expect(pm.getPlugin("x")!.effectiveEnabled).toBe(false)
		expect(pm.getPlugin("y")!.effectiveEnabled).toBe(false)
		expect(pm.getPlugin("x")!.disabledReason).toMatch(/cycle/)
	})

	it("re-resolves on enable: enabling the dependency activates the dependent", async () => {
		fs.addManifest(`${PROJECT}/base`, modeManifest("base"))
		fs.addManifest(`${PROJECT}/app`, modeManifest("app", { dependencies: ["base"] }))
		const store = new MemoryStore(["app"])
		const pm = new PluginManager({ fs, stateStore: store, pluginDirs: dirs })
		await pm.discover()
		expect(pm.getPlugin("app")!.effectiveEnabled).toBe(false)

		await pm.setEnabled("base", true)
		expect(pm.getPlugin("app")!.effectiveEnabled).toBe(true)
		expect(pm.getPlugin("base")!.effectiveEnabled).toBe(true)
	})
})

describe("PluginManager — last-installed-wins on mode conflict (design §14.7, Q7)", () => {
	const PROJECT = "/ws/.shofer/plugins"
	const dirs: PluginDir[] = [{ dir: PROJECT, scope: "project" }]

	let fs: MemoryFs
	let notifier: RecordingNotifier

	beforeEach(() => {
		fs = new MemoryFs()
		const host = createInMemoryHost()
		notifier = host.notifier as RecordingNotifier
		setHost(host)
	})

	const modeWith = (pluginName: string, roleDefinition: string) => ({
		name: pluginName,
		version: "1.0.0",
		permissions: { modes: true },
		contributes: {
			// Both plugins contribute the SAME natural slug "deploy".
			modes: [{ slug: "deploy", name: "Deploy", roleDefinition, tools: ["read"] }],
		},
	})

	it("uses the natural slug and lets the last-installed plugin win, with a warning", async () => {
		fs.addManifest(`${PROJECT}/a`, modeWith("a", "role-A"))
		fs.addManifest(`${PROJECT}/b`, modeWith("b", "role-B"))
		// enabledPlugins order = install order: a first, then b ⇒ b is last-installed.
		const pm = new PluginManager({ fs, stateStore: new MemoryStore(["a", "b"]), pluginDirs: dirs })
		await pm.discover()

		const modes = pm.getContributedModes()
		expect(modes).toHaveLength(1)
		// Natural slug (no namespacing); last-installed (b) wins.
		expect(modes[0]).toMatchObject({ slug: "deploy", pluginName: "b", roleDefinition: "role-B" })

		// Warning is shown to the user naming the slug + winner/shadowed plugins.
		const warns = notifier.messages.filter((m) => m.level === "warn").map((m) => m.message)
		expect(warns.some((m) => m.includes("deploy") && m.includes('"b"') && m.includes('"a"'))).toBe(true)
	})

	it("flips the winner when the install order flips (deterministic)", async () => {
		fs.addManifest(`${PROJECT}/a`, modeWith("a", "role-A"))
		fs.addManifest(`${PROJECT}/b`, modeWith("b", "role-B"))
		// b enabled first, then a ⇒ a is last-installed and wins.
		const pm = new PluginManager({ fs, stateStore: new MemoryStore(["b", "a"]), pluginDirs: dirs })
		await pm.discover()
		const modes = pm.getContributedModes()
		expect(modes).toHaveLength(1)
		expect(modes[0]).toMatchObject({ pluginName: "a", roleDefinition: "role-A" })
	})
})
