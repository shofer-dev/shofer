import fs from "fs"
import os from "os"
import path from "path"

import { createInMemoryHost, setHost, resolveModeConfig, type ModeConfig } from "@shofer/types"

import { PluginManager, createNodePluginFs, setSharedPluginManager, type PluginStateStore } from "../plugin-manager.js"
import { effectiveModes } from "../plugin-modes.js"

/**
 * The "no bundled plugins" build flavor (`SHOFER_NO_BUNDLED_PLUGINS=1` in
 * `src/esbuild.mjs`) ships an extension whose `dist/plugins` does not exist at all —
 * for hosts that supply their entire plugin set out-of-band (global/project scopes).
 * These specs pin what the runtime must keep true for that flavor: an absent (or
 * empty) bundled scope degrades to "no built-in tier" — discovery does not throw,
 * nothing is discovered there, the other scopes still work, and mode resolution runs
 * entirely off the modes the host's own tiers supply.
 */

class MemoryStore implements PluginStateStore {
	constructor(public names: string[] = []) {}
	getEnabledPlugins(): string[] {
		return [...this.names]
	}
	setEnabledPlugins(names: string[]): void {
		this.names = [...names]
	}
}

/** A minimal global-scope plugin contributing one (namespaced) mode. */
const GLOBAL_PLUGIN_MANIFEST = {
	name: "helper",
	version: "1.0.0",
	permissions: { modes: true },
	contributes: {
		modes: [{ slug: "deploy", name: "Deploy", roleDefinition: "role", tools: ["read"] }],
	},
}

describe("no-bundled-plugins flavor: absent/empty bundled scope degrades to no built-in tier", () => {
	let tmp: string

	beforeEach(() => {
		setHost(createInMemoryHost())
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shofer-no-bundled-"))
	})

	afterEach(() => {
		setSharedPluginManager(undefined)
		fs.rmSync(tmp, { recursive: true, force: true })
	})

	/** Manager whose bundled dir does not exist on disk (the lean-build shape). */
	async function buildWithAbsentBundledDir(enabled: string[] = []) {
		const globalDir = path.join(tmp, "global-plugins")
		fs.mkdirSync(path.join(globalDir, "helper"), { recursive: true })
		fs.writeFileSync(path.join(globalDir, "helper", "plugin.json"), JSON.stringify(GLOBAL_PLUGIN_MANIFEST))
		const manager = new PluginManager({
			fs: createNodePluginFs(),
			pluginDirs: [
				// Never created — exactly what `<extensionPath>/dist/plugins` looks like
				// in a SHOFER_NO_BUNDLED_PLUGINS build.
				{ dir: path.join(tmp, "dist", "plugins"), scope: "bundled" },
				{ dir: globalDir, scope: "global" },
			],
			stateStore: new MemoryStore(enabled),
		})
		await manager.discover()
		return manager
	}

	it("discovers nothing from an absent bundled dir, without throwing, and other scopes still work", async () => {
		const manager = await buildWithAbsentBundledDir()
		expect(manager.listPlugins().map((p) => p.name)).toEqual(["helper"])
		expect(manager.listPlugins().every((p) => p.scope === "global")).toBe(true)
	})

	it("tolerates an existing but empty bundled dir the same way", async () => {
		fs.mkdirSync(path.join(tmp, "empty-bundled"), { recursive: true })
		const manager = new PluginManager({
			fs: createNodePluginFs(),
			pluginDirs: [{ dir: path.join(tmp, "empty-bundled"), scope: "bundled" }],
			stateStore: new MemoryStore(),
		})
		await manager.discover()
		expect(manager.listPlugins()).toEqual([])
		expect(manager.getContributedModes()).toEqual([])
	})

	it("effectiveModes returns the authored modes unchanged — no built-in tier to merge", async () => {
		const manager = await buildWithAbsentBundledDir()
		setSharedPluginManager(manager)

		const authored: ModeConfig[] = [
			{ slug: "org-code", name: "Org Code", roleDefinition: "r", tools: ["read"], source: "global" },
			{ slug: "org-review", name: "Org Review", roleDefinition: "r", tools: ["read"], source: "project" },
		]
		expect(effectiveModes(authored)).toEqual(authored)
		// And with nothing authored either, the list is empty rather than an error.
		expect(effectiveModes([])).toEqual([])
	})

	it("mode resolution runs entirely off host-supplied modes", async () => {
		const manager = await buildWithAbsentBundledDir()
		setSharedPluginManager(manager)

		const authored: ModeConfig[] = [
			{ slug: "org-code", name: "Org Code", roleDefinition: "r", tools: ["read"], source: "global" },
		]
		const modes = effectiveModes(authored)
		expect(resolveModeConfig("org-code", modes).slug).toBe("org-code")
		// No `code` mode exists (builtin-config is not shipped): resolution falls
		// through to the first mode that does, instead of crashing.
		expect(resolveModeConfig("a-mode-nobody-defined", modes).slug).toBe("org-code")
	})

	it("a global-scope plugin still contributes its (namespaced) modes without the bundled tier", async () => {
		const manager = await buildWithAbsentBundledDir(["helper"])
		setSharedPluginManager(manager)

		const modes = effectiveModes([])
		expect(modes.map((m) => m.slug)).toEqual(["helper:deploy"])
	})
})
