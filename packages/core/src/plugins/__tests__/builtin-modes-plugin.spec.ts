import { describe, it, expect, beforeEach, afterEach } from "vitest"
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
 * Shofer's six built-in modes ship as a bundled plugin (`plugins/builtin-modes/`)
 * rather than as a constant in `@shofer/types`. These specs pin what that must keep
 * true: the modes are contributed under their **canonical slugs** (`code`,
 * `architect`, …, not `builtin-modes:code`), they are on out of the box, a user or
 * project mode still overrides one by slug, and an org can still take them all away.
 */

const PLUGIN_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../../plugins/builtin-modes")
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

describe("builtin-modes plugin", () => {
	beforeEach(() => setHost(createInMemoryHost()))
	afterEach(() => setSharedPluginManager(undefined))

	it("contributes the six modes under their canonical slugs, enabled out of the box", async () => {
		const manager = await build()
		expect(manager.isEnabled("builtin-modes")).toBe(true)

		const modes = manager.getContributedModes()
		// Unqualified: every setting, mode link, `switch_mode` call and doc names these
		// slugs. Namespacing them to `builtin-modes:code` would rename the platform.
		expect(modes.map((m) => m.slug)).toEqual(EXPECTED_SLUGS)
		expect(modes.every((m) => m.source === "plugin" && m.pluginName === "builtin-modes")).toBe(true)
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
		// `SHOFER_DISABLE_BUILTIN_MODES` maps to this plugin name, so an org can define
		// the entire mode set through a config bundle.
		const manager = await build({ forceDisabled: ["builtin-modes"] })
		expect(manager.isEnabled("builtin-modes")).toBe(false)
		expect(manager.getContributedModes()).toEqual([])

		// Only the org's own modes remain — the built-ins are not silently re-added.
		const orgModes: ModeConfig[] = [
			{ slug: "org", name: "Org", roleDefinition: "r", tools: ["read"], source: "global" },
		]
		expect(getAllModes(effectiveModes(orgModes)).map((m) => m.slug)).toEqual(["org"])
	})

	it("cannot be re-enabled by the user once an org suppressed it", async () => {
		const manager = await build({ forceDisabled: ["builtin-modes"] })
		await manager.setEnabled("builtin-modes", true)
		expect(manager.isEnabled("builtin-modes")).toBe(false)
	})

	it("drops the modes when the user disables it", async () => {
		const manager = await build({ disabled: ["builtin-modes"] })
		expect(manager.isEnabled("builtin-modes")).toBe(false)
		expect(effectiveModes([])).toEqual([])
	})
})
