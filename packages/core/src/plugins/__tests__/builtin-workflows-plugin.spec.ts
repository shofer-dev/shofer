import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

import { createInMemoryHost, setHost } from "@shofer/types"

import { PluginManager, createNodePluginFs, setSharedPluginManager, type PluginStateStore } from "../plugin-manager.js"

/**
 * The built-in workflows (Debug, Implement a Feature) ship as a bundled plugin
 * (`plugins/builtin-workflows/`) rather than as files inside the extension bundle.
 * These specs pin what that has to keep true: the `.slang` sources are contributed by
 * the plugin, and an org can still take them away.
 */

const PLUGIN_DIR = path.resolve(
	fileURLToPath(new URL(".", import.meta.url)),
	"../../../../../plugins/builtin-workflows",
)
const PLUGINS_PARENT = path.dirname(PLUGIN_DIR)

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

async function build(opts: { forceDisabled?: string[] } = {}) {
	const manager = new PluginManager({
		fs: createNodePluginFs(),
		pluginDirs: [{ dir: PLUGINS_PARENT, scope: "bundled" }],
		stateStore: new MemoryStore(),
		forceDisabledPlugins: opts.forceDisabled,
	})
	await manager.discover()
	return manager
}

describe("builtin-workflows plugin", () => {
	beforeEach(() => setHost(createInMemoryHost()))
	afterEach(() => setSharedPluginManager(undefined))

	it("ships the two workflows as real .slang files under the plugin", () => {
		const dir = path.join(PLUGIN_DIR, "workflows")
		expect(fs.existsSync(path.join(dir, "debug.slang"))).toBe(true)
		expect(fs.existsSync(path.join(dir, "implement-feature.slang"))).toBe(true)
		// The flow name inside the source is what a workflow is addressed by — the file
		// name only decides which layer wins on override.
		expect(fs.readFileSync(path.join(dir, "debug.slang"), "utf8")).toMatch(/flow\s/i)
	})

	it("contributes its workflows directory, enabled out of the box", async () => {
		const manager = await build()
		expect(manager.isEnabled("builtin-workflows")).toBe(true)
		expect(manager.getContributedWorkflowDirs()).toEqual([
			{ pluginName: "builtin-workflows", dir: path.join(PLUGIN_DIR, "workflows") },
		])
	})

	it("contributes nothing when an org suppressed it", async () => {
		// `SHOFER_DISABLE_BUILTIN_WORKFLOWS` maps to this plugin name, so an org can still
		// define the whole workflow set through a config bundle.
		const manager = await build({ forceDisabled: ["builtin-workflows"] })
		expect(manager.isEnabled("builtin-workflows")).toBe(false)
		expect(manager.getContributedWorkflowDirs()).toEqual([])
	})

	it("cannot be re-enabled by the user once an org suppressed it", async () => {
		const manager = await build({ forceDisabled: ["builtin-workflows"] })
		await manager.setEnabled("builtin-workflows", true)
		expect(manager.isEnabled("builtin-workflows")).toBe(false)
	})
})
