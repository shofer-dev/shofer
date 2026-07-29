import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

import {
	createInMemoryHost,
	setHost,
	getAllModes,
	resolveModeConfig,
	defaultModeSlug,
	type ModeConfig,
} from "@shofer/types"

import { PluginManager, createNodePluginFs, setSharedPluginManager, type PluginStateStore } from "../plugin-manager.js"
import { effectiveModes } from "../plugin-modes.js"

/**
 * Shofer's built-in configuration — the six default modes AND the two shipped
 * workflows — ships as ONE bundled plugin (`plugins/builtin-config/`) rather than as
 * constants/files inside core. These specs pin what that must keep true: the modes
 * are contributed under their **canonical slugs** (`code`, `architect`, …, not
 * `builtin-config:code`), the `.slang` sources are contributed by the plugin, all of
 * it is on out of the box, a user or project definition still overrides one by
 * slug/name, and an org can still take the whole set away.
 */

const PLUGIN_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../../plugins/builtin-config")
const PLUGINS_PARENT = path.dirname(PLUGIN_DIR)

const EXPECTED_SLUGS = ["code", "architect", "debug", "code-search", "web-search", "reviewer"]

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

async function build(opts: { forceDisabled?: string[]; disabled?: string[] } = {}) {
	const manager = new PluginManager({
		fs: createNodePluginFs(),
		pluginDirs: [{ dir: PLUGINS_PARENT, scope: "bundled" }],
		stateStore: new MemoryStore([], opts.disabled ?? []),
		forceDisabledPlugins: opts.forceDisabled,
	})
	await manager.discover()
	setSharedPluginManager(manager)
	return manager
}

describe("builtin-config plugin", () => {
	beforeEach(() => setHost(createInMemoryHost()))
	afterEach(() => setSharedPluginManager(undefined))

	it("contributes the six modes under their canonical slugs, enabled out of the box", async () => {
		const manager = await build()
		expect(manager.isEnabled("builtin-config")).toBe(true)

		const modes = manager.getContributedModes()
		// Unqualified: every setting, mode link, `switch_mode` call and doc names these
		// slugs. Namespacing them to `builtin-config:code` would rename the platform.
		expect(modes.map((m) => m.slug)).toEqual(EXPECTED_SLUGS)
		expect(modes.every((m) => m.source === "plugin" && m.pluginName === "builtin-config")).toBe(true)
	})

	it("keeps `code` first, so it is the default mode the platform falls back to", async () => {
		await build()
		const modes = effectiveModes([])
		expect(modes[0]!.slug).toBe(defaultModeSlug)
		expect(resolveModeConfig("a-mode-nobody-defined", modes).slug).toBe("code")
	})

	it("carries the full mode definition, not just a name", async () => {
		await build()
		const debug = effectiveModes([]).find((m) => m.slug === "debug")!

		expect(debug.name).toBe("🪲 Debug")
		expect(debug.roleDefinition).toBe(
			"You are Shofer, an expert software debugger specializing in systematic problem diagnosis and resolution.",
		)
		expect(debug.tools).toEqual([
			"read",
			"write",
			"execute",
			"browser",
			"mcp",
			"subtasks",
			"questions",
			"uncategorized",
		])
		expect(debug.customInstructions).toContain("Reflect on 5-7 different possible sources of the problem")

		// Architect's write access is restricted to markdown by a file-regex tuple.
		const architect = effectiveModes([]).find((m) => m.slug === "architect")!
		expect(architect.tools).toContainEqual(["write", { fileRegex: "\\.md$", description: "Markdown files only" }])
	})

	it("lets a user mode override one by slug, in place", async () => {
		await build()
		const mine: ModeConfig = {
			slug: "code",
			name: "My Code",
			roleDefinition: "Mine",
			tools: ["read"],
			source: "project",
		}
		const modes = effectiveModes([mine])

		// Overridden, not duplicated, and still first — the mode picker does not reorder
		// because the user customised a mode.
		expect(modes.filter((m) => m.slug === "code")).toHaveLength(1)
		expect(modes[0]).toEqual(mine)
		expect(modes.map((m) => m.slug)).toEqual(EXPECTED_SLUGS)
	})

	it("appends a user's own new mode after the platform's", async () => {
		await build()
		const modes = effectiveModes([
			{ slug: "mine", name: "Mine", roleDefinition: "r", tools: ["read"], source: "global" },
		])
		expect(modes.map((m) => m.slug)).toEqual([...EXPECTED_SLUGS, "mine"])
	})

	it("contributes nothing when an org suppressed it", async () => {
		// `SHOFER_DISABLED_PLUGINS=builtin-config` — an org can define the entire
		// mode/workflow set through a config bundle.
		const manager = await build({ forceDisabled: ["builtin-config"] })
		expect(manager.isEnabled("builtin-config")).toBe(false)
		expect(manager.getContributedModes()).toEqual([])
		expect(manager.getContributedWorkflowDirs()).toEqual([])

		// Only the org's own modes remain — the built-ins are not silently re-added.
		const orgModes: ModeConfig[] = [
			{ slug: "org", name: "Org", roleDefinition: "r", tools: ["read"], source: "global" },
		]
		expect(getAllModes(effectiveModes(orgModes)).map((m) => m.slug)).toEqual(["org"])
	})

	it("cannot be re-enabled by the user once an org suppressed it", async () => {
		const manager = await build({ forceDisabled: ["builtin-config"] })
		await manager.setEnabled("builtin-config", true)
		expect(manager.isEnabled("builtin-config")).toBe(false)
	})

	it("drops the modes when the user disables it", async () => {
		const manager = await build({ disabled: ["builtin-config"] })
		expect(manager.isEnabled("builtin-config")).toBe(false)
		expect(effectiveModes([])).toEqual([])
	})

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
		expect(manager.isEnabled("builtin-config")).toBe(true)
		expect(manager.getContributedWorkflowDirs()).toEqual([
			{ pluginName: "builtin-config", dir: path.join(PLUGIN_DIR, "workflows") },
		])
	})
})
