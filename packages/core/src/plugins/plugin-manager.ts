import * as nodeFs from "fs/promises"
import * as path from "path"

import { type ModeConfig, type PluginManifest, pluginManifestSchema } from "@shofer/types"

import { configLog } from "../logging/subsystems.js"

/**
 * PluginManager — discovery, validation, permission-gating, and enable/disable
 * for declarative plugins (design §4, §7; Phase 1).
 *
 * This is the **registration path** the seed `PluginRegistry` was missing: it
 * scans plugin directories, validates each `plugin.json` against
 * {@link pluginManifestSchema}, honors the persisted enabled/disabled state, and
 * exposes the *declarative* contributions (modes / skills / commands / MCP
 * servers / rules) of enabled plugins to the subsystems that consume them
 * (`SkillsManager`, `CustomModesManager`, `McpHub`, the command service).
 *
 * It does **not** execute plugin code in Phase 1 — `main` entry points, the
 * `ShoferPlugin` hooks, and permission *enforcement* land in Phase 2. Here the
 * `permissions` block is used only to *gate which declarative contributions are
 * surfaced* (a contribution kind is honored only when its permission is granted).
 *
 * Host-agnostic: filesystem access goes through the injected {@link PluginFsHost}
 * seam (there is no `vscode` import), and enabled-state persistence through the
 * injected {@link PluginStateStore}. The extension/CLI layer supplies concrete
 * implementations and the plugin directory paths.
 */

/**
 * Narrow filesystem seam the manager needs for discovery. `HostFileSystem` has no
 * directory listing, so this is a purpose-built seam (per the design's
 * "add a seam rather than importing vscode into core" guidance). Node- and
 * in-memory-backed implementations both satisfy it.
 */
export interface PluginFsHost {
	/** Immediate subdirectory names of `dir`. Returns `[]` when `dir` is missing. */
	listDirs(dir: string): Promise<string[]>
	/** Read a UTF-8 file. Rejects when the file is missing. */
	readFile(filePath: string): Promise<string>
	/** Whether a path exists (file or directory). */
	exists(filePath: string): Promise<boolean>
	/** Recursively remove a directory (used by uninstall). Missing dir is a no-op. */
	removeDir(dir: string): Promise<void>
}

/** Persistence seam for the set of user-enabled plugins (design §7). */
export interface PluginStateStore {
	/** Names of plugins the user has explicitly enabled. */
	getEnabledPlugins(): string[] | Promise<string[]>
	/** Persist the new enabled set. */
	setEnabledPlugins(names: string[]): void | Promise<void>
}

/** A directory the manager was told to scan, with its scope tag. */
export interface PluginDir {
	dir: string
	scope: "global" | "project"
}

/** Per-kind counts of a plugin's declarative contributions (for UI summaries). */
export interface PluginContributionCounts {
	modes: number
	skills: number
	commands: number
	mcpServers: number
	rules: number
}

/** A validated, discovered plugin (enabled or not). */
export interface DiscoveredPlugin {
	name: string
	version: string
	description?: string
	/** Absolute plugin root directory. */
	root: string
	/** Absolute path to the plugin's `plugin.json`. */
	manifestPath: string
	scope: "global" | "project"
	enabled: boolean
	/** Whether the plugin ships a code entry point (`main`). Not loaded in Phase 1. */
	hasCode: boolean
	manifest: PluginManifest
	contributionCounts: PluginContributionCounts
}

/** A plugin-contributed skills/commands source directory. */
export interface PluginDirContribution {
	pluginName: string
	/** Absolute directory holding the physical files (`<root>/skills` or `<root>/commands`). */
	dir: string
}

/** A plugin-contributed rules file. */
export interface PluginRuleContributionResolved {
	pluginName: string
	/** Absolute path to the rules markdown. */
	path: string
	/** Modes the rules are scoped to, if any. */
	modes?: string[]
}

/** A plugin-contributed MCP server config, tagged with its origin plugin. */
export interface PluginMcpServerContribution {
	pluginName: string
	name: string
	config: Record<string, unknown>
}

export interface PluginManagerOptions {
	fs: PluginFsHost
	stateStore: PluginStateStore
	/** Directories to scan for `<subdir>/plugin.json` candidates, lowest precedence first. */
	pluginDirs: PluginDir[]
}

const MANIFEST_FILENAME = "plugin.json"

export class PluginManager {
	private readonly fs: PluginFsHost
	private readonly stateStore: PluginStateStore
	private readonly pluginDirs: PluginDir[]
	private plugins: DiscoveredPlugin[] = []

	constructor(options: PluginManagerOptions) {
		this.fs = options.fs
		this.stateStore = options.stateStore
		this.pluginDirs = options.pluginDirs
	}

	/**
	 * Scan every configured plugin directory, validate manifests, and rebuild the
	 * in-memory plugin list. Invalid manifests are skipped with a warning. When two
	 * plugins share a name, the later-scanned directory wins (callers pass
	 * `global` before `project` so a project plugin shadows a global one).
	 */
	async discover(): Promise<void> {
		const enabled = new Set(await this.stateStore.getEnabledPlugins())
		const byName = new Map<string, DiscoveredPlugin>()

		for (const { dir, scope } of this.pluginDirs) {
			let subdirs: string[]
			try {
				subdirs = await this.fs.listDirs(dir)
			} catch {
				continue // Missing/unreadable plugin dir — nothing to discover here.
			}

			for (const subdir of subdirs) {
				const root = path.join(dir, subdir)
				const manifestPath = path.join(root, MANIFEST_FILENAME)
				const discovered = await this.loadPlugin(root, manifestPath, scope, enabled)
				if (discovered) {
					byName.set(discovered.name, discovered)
				}
			}
		}

		this.plugins = Array.from(byName.values())
	}

	private async loadPlugin(
		root: string,
		manifestPath: string,
		scope: "global" | "project",
		enabled: Set<string>,
	): Promise<DiscoveredPlugin | undefined> {
		if (!(await this.fs.exists(manifestPath))) {
			return undefined
		}

		let raw: string
		try {
			raw = await this.fs.readFile(manifestPath)
		} catch (error) {
			configLog.warn(`[plugins] Could not read manifest at ${manifestPath}: ${String(error)}`)
			return undefined
		}

		let json: unknown
		try {
			json = JSON.parse(raw)
		} catch (error) {
			configLog.warn(`[plugins] Invalid JSON in manifest ${manifestPath}: ${String(error)}`)
			return undefined
		}

		const parsed = pluginManifestSchema.safeParse(json)
		if (!parsed.success) {
			const issues = parsed.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ")
			configLog.warn(`[plugins] Skipping invalid manifest ${manifestPath}: ${issues}`)
			return undefined
		}

		const manifest = parsed.data
		const contributes = manifest.contributes ?? {}
		return {
			name: manifest.name,
			version: manifest.version,
			description: manifest.description,
			root,
			manifestPath,
			scope,
			enabled: enabled.has(manifest.name),
			hasCode: typeof manifest.main === "string" && manifest.main.length > 0,
			manifest,
			contributionCounts: {
				modes: contributes.modes?.length ?? 0,
				skills: contributes.skills?.length ?? 0,
				commands: contributes.commands?.length ?? 0,
				mcpServers: contributes.mcpServers ? Object.keys(contributes.mcpServers).length : 0,
				rules: contributes.rules?.length ?? 0,
			},
		}
	}

	/** All discovered plugins (enabled or not), in discovery order. */
	listPlugins(): DiscoveredPlugin[] {
		return [...this.plugins]
	}

	/** Enabled plugins only. */
	enabledPlugins(): DiscoveredPlugin[] {
		return this.plugins.filter((p) => p.enabled)
	}

	getPlugin(name: string): DiscoveredPlugin | undefined {
		return this.plugins.find((p) => p.name === name)
	}

	isEnabled(name: string): boolean {
		return this.getPlugin(name)?.enabled ?? false
	}

	/**
	 * Enable or disable a plugin and persist the new enabled set. Unknown names are
	 * still recorded so state survives a plugin that is temporarily absent.
	 */
	async setEnabled(name: string, enabled: boolean): Promise<void> {
		const current = new Set(await this.stateStore.getEnabledPlugins())
		if (enabled) {
			current.add(name)
		} else {
			current.delete(name)
		}
		await this.stateStore.setEnabledPlugins(Array.from(current))

		const plugin = this.getPlugin(name)
		if (plugin) {
			plugin.enabled = enabled
		}
	}

	/**
	 * Uninstall a plugin: delete its directory and drop it from the enabled set and
	 * the in-memory list. All its contributions disappear on the next read.
	 */
	async uninstall(name: string): Promise<void> {
		const plugin = this.getPlugin(name)
		if (!plugin) {
			return
		}
		await this.fs.removeDir(plugin.root)
		await this.setEnabled(name, false)
		this.plugins = this.plugins.filter((p) => p.name !== name)
	}

	// --- Declarative contributions (enabled + permission-gated) ----------------

	private enabledWithPermission(kind: keyof NonNullable<PluginManifest["permissions"]>): DiscoveredPlugin[] {
		return this.plugins.filter((p) => p.enabled && p.manifest.permissions?.[kind] === true)
	}

	/**
	 * Modes contributed by enabled plugins. Each is tagged `source: "plugin"` +
	 * `pluginName`, and its slug is **namespaced** as `<pluginName>:<slug>` so it
	 * can never collide with a built-in/project/global mode (design §14.7 —
	 * namespacing). The authored (bare) slug is preserved as `baseSlug`-free info
	 * only via the manifest; consumers use the namespaced slug as the identity.
	 */
	getContributedModes(): ModeConfig[] {
		const modes: ModeConfig[] = []
		for (const plugin of this.enabledWithPermission("modes")) {
			for (const mode of plugin.manifest.contributes?.modes ?? []) {
				modes.push({
					...mode,
					slug: `${plugin.name}:${mode.slug}`,
					source: "plugin",
					pluginName: plugin.name,
				})
			}
		}
		return modes
	}

	/** `<root>/skills` directories for enabled plugins that declare skills. */
	getContributedSkillDirs(): PluginDirContribution[] {
		const out: PluginDirContribution[] = []
		for (const plugin of this.enabledWithPermission("skills")) {
			if ((plugin.manifest.contributes?.skills?.length ?? 0) > 0) {
				out.push({ pluginName: plugin.name, dir: path.join(plugin.root, "skills") })
			}
		}
		return out
	}

	/** `<root>/commands` directories for enabled plugins that declare commands. */
	getContributedCommandDirs(): PluginDirContribution[] {
		const out: PluginDirContribution[] = []
		for (const plugin of this.enabledWithPermission("commands")) {
			if ((plugin.manifest.contributes?.commands?.length ?? 0) > 0) {
				out.push({ pluginName: plugin.name, dir: path.join(plugin.root, "commands") })
			}
		}
		return out
	}

	/**
	 * MCP server configs contributed by enabled plugins. On a name collision the
	 * last enabled plugin wins (a warning is logged). `McpHub` re-validates each
	 * config with its own schema before connecting.
	 */
	getContributedMcpServers(): PluginMcpServerContribution[] {
		const seen = new Map<string, string>()
		const out: PluginMcpServerContribution[] = []
		for (const plugin of this.enabledWithPermission("mcpServers")) {
			const servers = plugin.manifest.contributes?.mcpServers ?? {}
			for (const [name, config] of Object.entries(servers)) {
				const prior = seen.get(name)
				if (prior) {
					configLog.warn(
						`[plugins] MCP server "${name}" from plugin "${plugin.name}" overrides the one from "${prior}"`,
					)
					const idx = out.findIndex((s) => s.name === name)
					if (idx !== -1) out.splice(idx, 1)
				}
				seen.set(name, plugin.name)
				out.push({ pluginName: plugin.name, name, config: config as Record<string, unknown> })
			}
		}
		return out
	}

	/** Rules files contributed by enabled plugins, with absolute paths. */
	getContributedRules(): PluginRuleContributionResolved[] {
		const out: PluginRuleContributionResolved[] = []
		for (const plugin of this.enabledWithPermission("rules")) {
			for (const rule of plugin.manifest.contributes?.rules ?? []) {
				out.push({
					pluginName: plugin.name,
					path: path.isAbsolute(rule.path) ? rule.path : path.join(plugin.root, rule.path),
					modes: rule.modes,
				})
			}
		}
		return out
	}
}

// ---------------------------------------------------------------------------
// Node-backed filesystem seam + shared instance
// ---------------------------------------------------------------------------

/** A {@link PluginFsHost} backed by `node:fs/promises` (extension/CLI default). */
export function createNodePluginFs(): PluginFsHost {
	return {
		async listDirs(dir: string): Promise<string[]> {
			try {
				const entries = await nodeFs.readdir(dir, { withFileTypes: true })
				return entries.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name)
			} catch {
				return []
			}
		},
		readFile: (filePath: string) => nodeFs.readFile(filePath, "utf-8"),
		async exists(filePath: string): Promise<boolean> {
			try {
				await nodeFs.access(filePath)
				return true
			} catch {
				return false
			}
		},
		async removeDir(dir: string): Promise<void> {
			await nodeFs.rm(dir, { recursive: true, force: true })
		},
	}
}

/**
 * The process-wide {@link PluginManager}. The extension/CLI layer constructs a
 * concrete manager (node fs + globalState-backed store + the resolved plugin
 * directories), runs {@link PluginManager.discover}, and installs it here.
 * Subsystems read declarative contributions through {@link getSharedPluginManager}
 * — when it is unset (no host wired, or pure-core tests), they see no
 * contributions and behavior is byte-for-byte identical to no plugins.
 */
let sharedPluginManager: PluginManager | undefined

export function setSharedPluginManager(manager: PluginManager | undefined): void {
	sharedPluginManager = manager
}

export function getSharedPluginManager(): PluginManager | undefined {
	return sharedPluginManager
}
