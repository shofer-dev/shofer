import { describe, it, expect, beforeEach, afterEach } from "vitest"
import path from "path"
import { fileURLToPath } from "url"

import { createInMemoryHost, setHost } from "@shofer/types"

import { PluginManager, createNodePluginFs, setSharedPluginManager, type PluginStateStore } from "../plugin-manager.js"
import { effectiveModes } from "../plugin-modes.js"

/**
 * The Second Brain observer ships as the bundled `plugins/second-brain/` plugin, and
 * its detectors are PRIVATE plugin-contributed modes. These specs pin the contract:
 * the manifest passes the strict schema (a rejected manifest silently drops the whole
 * plugin), the nine detector modes come out namespaced (`second-brain:<slug>`) and
 * private, they merge into the effective mode list (spawnable by slug), and the
 * webview-facing filter (`!m.private`) hides every one of them.
 */

const PLUGIN_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../../plugins/second-brain")
const PLUGINS_PARENT = path.dirname(PLUGIN_DIR)

const EXPECTED = [
	"second-brain:repeat-failure",
	"second-brain:standard-questions",
	"second-brain:default",
	"second-brain:goal-drift",
	"second-brain:git-log",
	"second-brain:prior-art",
	"second-brain:constraint-drift",
	"second-brain:static-analysis",
	"second-brain:cross-task-collision",
]

class MemoryStore implements PluginStateStore {
	constructor(public names: string[] = []) {}
	getEnabledPlugins(): string[] {
		return [...this.names]
	}
	setEnabledPlugins(names: string[]): void {
		this.names = [...names]
	}
	getDisabledPlugins(): string[] {
		return []
	}
	setDisabledPlugins(): void {}
}

async function build() {
	const manager = new PluginManager({
		fs: createNodePluginFs(),
		pluginDirs: [{ dir: PLUGINS_PARENT, scope: "bundled" }],
		stateStore: new MemoryStore(),
	})
	await manager.discover()
	setSharedPluginManager(manager)
	return manager
}

describe("second-brain plugin", () => {
	beforeEach(() => setHost(createInMemoryHost()))
	afterEach(() => setSharedPluginManager(undefined))

	it("discovers with a valid manifest and is enabled out of the box", async () => {
		const manager = await build()
		const discovered = manager.listPlugins().find((p) => p.name === "second-brain")
		expect(discovered).toBeDefined()
		expect(manager.isEnabled("second-brain")).toBe(true)
	})

	it("contributes the nine detector modes, namespaced and ALL private", async () => {
		const manager = await build()
		const modes = manager.getContributedModes().filter((m) => m.pluginName === "second-brain")
		expect(modes.map((m) => m.slug)).toEqual(EXPECTED)
		expect(modes.every((m) => m.private === true)).toBe(true)
		expect(modes.every((m) => m.source === "plugin")).toBe(true)
	})

	it("detector modes are in the effective list (spawnable) but hidden by the private filter", async () => {
		await build()
		const modes = effectiveModes([])
		const detectorModes = modes.filter((m) => m.slug.startsWith("second-brain:"))
		expect(detectorModes.length).toBe(EXPECTED.length)
		// The user-facing surfaces filter exactly this way (getStateToPostToWebview,
		// getModes, the MODES prompt section):
		expect(modes.filter((m) => !m.private).some((m) => m.slug.startsWith("second-brain:"))).toBe(false)
	})

	it("carries each detector's prompt and grant on the mode itself", async () => {
		await build()
		const gitLog = effectiveModes([]).find((m) => m.slug === "second-brain:git-log")!
		expect(gitLog.roleDefinition).toContain("history contradicts")
		expect(gitLog.tools).toEqual([
			{ read: { allowed: ["read_file"] } },
			{ execute: { allowed: ["execute_command"] } },
		])
	})
})
