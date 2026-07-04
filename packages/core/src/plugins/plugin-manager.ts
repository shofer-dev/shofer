import * as nodeFs from "fs/promises"
import * as path from "path"

import {
	type HostBridge,
	type ModeConfig,
	type PluginContext,
	type PluginManifest,
	pluginManifestSchema,
	type ShoferPlugin,
} from "@shofer/types"

import { configLog } from "../logging/subsystems.js"
import { pluginRegistry } from "./plugin-registry.js"
import type { PluginCodeLoader } from "./plugin-loader.js"
import { createPluginSandbox } from "./plugin-sandbox.js"
import { warnPlugin, warnPluginConflict } from "./plugin-warnings.js"

// Re-export the shared warning helpers so existing importers of `@shofer/core`
// (SkillsManager, CustomModesManager, plugin-sandbox) keep working unchanged.
export { warnPlugin, warnPluginConflict } from "./plugin-warnings.js"

/**
 * Resolve a plugin's effective config: the user's stored values with the
 * manifest-declared **defaults** filled in for any key the user hasn't set
 * (plugin system design §5 `config` schema / §6.2 `PluginContext.config`).
 *
 * The manifest `config` is a JSON-Schema-ish object (`{ type, properties: { key:
 * { default, ... } } }`). We do a shallow default-merge: for each declared
 * `properties.<key>.default`, seed it unless the stored config already has that
 * key. Stored values always win. Full JSON-Schema *validation* of stored values
 * (type/enum enforcement) is deferred — see step 2.3 notes; this keeps
 * `@shofer/core` free of a JSON-Schema validator while still delivering defaults
 * and a stable object into `PluginContext.config`.
 */
export function resolvePluginConfig(
	manifestConfig: Record<string, unknown> | undefined,
	stored: Record<string, unknown> | undefined,
): Record<string, unknown> {
	const result: Record<string, unknown> = { ...(stored ?? {}) }
	const properties = manifestConfig?.properties
	if (properties && typeof properties === "object") {
		for (const [key, schema] of Object.entries(properties as Record<string, unknown>)) {
			if (key in result) continue
			if (schema && typeof schema === "object" && "default" in schema) {
				result[key] = (schema as { default: unknown }).default
			}
		}
	}
	return result
}

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
	/** The user's persisted intent — did they toggle this plugin on? (design §7). */
	enabled: boolean
	/**
	 * Whether the plugin's contributions actually register. A plugin is effective
	 * only when it is {@link enabled} **and** its full dependency closure is also
	 * enabled+present (design §14.3 — fail-closed dependencies). A user-enabled
	 * plugin with an unmet/missing/cyclic dependency is treated as disabled: none
	 * of its contributions surface. Defaults to `enabled` until {@link resolveDependencies}
	 * runs during {@link discover}.
	 */
	effectiveEnabled: boolean
	/**
	 * Why an enabled plugin is nonetheless inactive (unmet dependency / cycle),
	 * shown in the Plugins settings panel so the user sees *why* it is off. Unset
	 * when the plugin is effective or was never enabled.
	 */
	disabledReason?: string
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
	/**
	 * Code-plugin loader (Phase 2, step 2.1). When omitted, {@link PluginManager.activateCodePlugins}
	 * is a no-op — no plugin code is transpiled/imported/registered, so behavior is
	 * byte-for-byte identical to no code plugins (declarative discovery still runs).
	 */
	codeLoader?: PluginCodeLoader
	/**
	 * Full host used to build each code plugin's **restricted** sandbox host
	 * ({@link PluginContext.host}, design §8). When omitted, code plugins are still
	 * loaded/registered but receive no `host` (their permitted host access is unavailable).
	 */
	host?: HostBridge
	/**
	 * Read the persisted per-plugin config map (`pluginConfigs` from `ContextProxy`),
	 * keyed by plugin name. Merged with manifest defaults into `PluginContext.config`.
	 */
	getPluginConfigs?: () => Record<string, Record<string, unknown>> | undefined
	/** Absolute workspace path threaded into code-plugin contexts (`workspacePath`/`cwd`). */
	workspacePath?: string
}

const MANIFEST_FILENAME = "plugin.json"

export class PluginManager {
	private readonly fs: PluginFsHost
	private readonly stateStore: PluginStateStore
	private readonly pluginDirs: PluginDir[]
	private readonly codeLoader?: PluginCodeLoader
	private readonly host?: HostBridge
	private readonly getPluginConfigs?: () => Record<string, Record<string, unknown>> | undefined
	private readonly workspacePath?: string
	/** Names of code plugins currently loaded + registered into `pluginRegistry`. */
	private readonly loadedCodePlugins = new Set<string>()
	private plugins: DiscoveredPlugin[] = []
	/**
	 * The persisted enabled/install order (the `enabledPlugins` array, in the order
	 * plugins were enabled). Its index is a plugin's **install rank** — later index =
	 * enabled/installed later. This is the deterministic, restart-stable ordering
	 * that drives last-installed-wins conflict resolution (design §14.7). See
	 * {@link installRank}.
	 */
	private enabledOrder: string[] = []

	constructor(options: PluginManagerOptions) {
		this.fs = options.fs
		this.stateStore = options.stateStore
		this.pluginDirs = options.pluginDirs
		this.codeLoader = options.codeLoader
		this.host = options.host
		this.getPluginConfigs = options.getPluginConfigs
		this.workspacePath = options.workspacePath
	}

	/**
	 * Scan every configured plugin directory, validate manifests, and rebuild the
	 * in-memory plugin list. Invalid manifests are skipped with a warning. When two
	 * plugins share a name, the later-scanned directory wins (callers pass
	 * `global` before `project` so a project plugin shadows a global one).
	 */
	async discover(): Promise<void> {
		const enabledList = await this.stateStore.getEnabledPlugins()
		this.enabledOrder = [...enabledList]
		const enabled = new Set(enabledList)
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
		this.resolveDependencies()
	}

	/**
	 * Fail-closed dependency resolution (design §14.3). After discovery, an enabled
	 * plugin is {@link DiscoveredPlugin.effectiveEnabled} only when its **full
	 * dependency closure** is enabled+present; otherwise it is treated as disabled —
	 * none of its contributions register — and a warning (shown + logged) names the
	 * unmet dependency. Handles transitive dependencies and does not infinite-loop
	 * on cycles: any plugin in a dependency cycle is failed closed with a warning.
	 *
	 * `dependencies` are plugin *names* (manifest `dependencies: string[]`). A
	 * dependency counts as satisfied only if it is itself effectively enabled, so a
	 * dependency that is present but transitively broken cascades the failure.
	 */
	private resolveDependencies(): void {
		const byName = new Map(this.plugins.map((p) => [p.name, p]))

		// Depth-first evaluation with the current recursion path as a stack (fresh per
		// plugin) so cycles are detected without memoizing partial results.
		const evaluate = (name: string, stack: string[]): { ok: true } | { ok: false; reason: string } => {
			const plugin = byName.get(name)
			if (!plugin) {
				return { ok: false, reason: `missing dependency "${name}"` }
			}
			if (!plugin.enabled) {
				return { ok: false, reason: `dependency "${name}" is not enabled` }
			}
			if (stack.includes(name)) {
				return { ok: false, reason: `dependency cycle ${[...stack, name].join(" → ")}` }
			}
			for (const dep of plugin.manifest.dependencies ?? []) {
				const depResult = evaluate(dep, [...stack, name])
				if (!depResult.ok) {
					// Surface the *unmet* dependency at the top of the chain, keeping the
					// transitive reason so the user can trace it.
					return { ok: false, reason: `unmet dependency "${dep}" (${depResult.reason})` }
				}
			}
			return { ok: true }
		}

		for (const plugin of this.plugins) {
			if (!plugin.enabled) {
				plugin.effectiveEnabled = false
				plugin.disabledReason = undefined
				continue
			}
			const result = evaluate(plugin.name, [])
			plugin.effectiveEnabled = result.ok
			plugin.disabledReason = result.ok ? undefined : result.reason
			if (!result.ok) {
				warnPlugin(
					`[plugins] Plugin "${plugin.name}" is enabled but disabled by an ${result.reason}; ` +
						`its contributions will not be registered.`,
				)
			}
		}
	}

	/**
	 * A plugin's install rank — its index in the persisted enabled/install order
	 * ({@link enabledOrder}). Later-enabled plugins rank higher; this is the
	 * deterministic, restart-stable ordering that decides last-installed-wins on a
	 * slug/name conflict (design §14.7). Returns `-1` for plugins not in the set.
	 */
	installRank(name: string): number {
		return this.enabledOrder.indexOf(name)
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
			// Recomputed by resolveDependencies() right after discovery; seed to the
			// user intent so a manager inspected mid-discovery is never inconsistent.
			effectiveEnabled: enabled.has(manifest.name),
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

	/**
	 * Plugins whose contributions are actually active — enabled **and** with a
	 * satisfied dependency closure (design §14.3). A user-enabled plugin blocked by
	 * an unmet/cyclic dependency is excluded here.
	 */
	enabledPlugins(): DiscoveredPlugin[] {
		return this.plugins.filter((p) => p.effectiveEnabled)
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
		// Maintain the install/enable *order* (append on enable, drop on disable) so
		// installRank() stays meaningful and last-installed-wins is stable across a
		// toggle without a full re-discover (design §14.7).
		const order = (await this.stateStore.getEnabledPlugins()).filter((n) => n !== name)
		if (enabled) {
			order.push(name)
		}
		await this.stateStore.setEnabledPlugins(order)
		this.enabledOrder = order

		const plugin = this.getPlugin(name)
		if (plugin) {
			plugin.enabled = enabled
		}
		// Re-run fail-closed resolution: toggling one plugin can satisfy or break
		// another's dependency closure (design §14.3).
		this.resolveDependencies()
		// Reconcile code plugins so a toggled code plugin is loaded/unloaded now (a
		// disabled plugin's hooks must stop firing). No-op without a codeLoader.
		await this.activateCodePlugins()
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

	// --- Code plugins (Phase 2: load `main`, register into pluginRegistry) ------

	/**
	 * Load every enabled code plugin (`main` entry) and register it into the shared
	 * `pluginRegistry` so its `registerTools`/`transformSystemPrompt`/`onEvent` hooks
	 * fire at the wired sites. Idempotent and reconciling: already-loaded plugins are
	 * skipped, and code plugins that are no longer effectively enabled are
	 * unregistered (their hooks stop firing). A per-plugin load failure is caught,
	 * warned (shown + logged), and skipped — it never crashes activation (design §2.7
	 * safe failure). No-op when no {@link PluginCodeLoader} was supplied, so behavior
	 * with no code plugins is byte-for-byte identical.
	 *
	 * Non-blocking by contract (owner decision #8): the caller kicks this off without
	 * awaiting on the task-start path; hooks simply begin firing once a plugin finishes
	 * loading.
	 */
	async activateCodePlugins(): Promise<void> {
		if (!this.codeLoader) return

		const active = new Set(this.enabledPlugins().filter((p) => p.hasCode).map((p) => p.name))

		// Unregister code plugins that are loaded but no longer active (disabled, or
		// failed closed by a dependency toggle).
		for (const name of [...this.loadedCodePlugins]) {
			if (!active.has(name)) {
				pluginRegistry.unregister(name)
				this.loadedCodePlugins.delete(name)
			}
		}

		for (const plugin of this.enabledPlugins()) {
			if (!plugin.hasCode || this.loadedCodePlugins.has(plugin.name)) continue
			try {
				const raw = await this.codeLoader.load({
					name: plugin.name,
					root: plugin.root,
					main: plugin.manifest.main as string,
					apiVersion: plugin.manifest.shoferPluginApiVersion,
				})
				const wrapped = this.wrapCodePlugin(plugin, raw)
				await pluginRegistry.register(wrapped, this.buildPluginContext(plugin), {
					// Gate lifecycle hooks on the manifest grant (design §6.9, §8): only a
					// plugin that requested `permissions.lifecycle` participates.
					lifecycle: plugin.manifest.permissions?.lifecycle === true,
				})
				this.loadedCodePlugins.add(plugin.name)
			} catch (error) {
				warnPlugin(
					`[plugins] Failed to load code plugin "${plugin.name}": ${String(error)} — plugin disabled.`,
				)
			}
		}
	}

	/**
	 * Build the per-plugin `PluginContext` bits that are constant across hook calls:
	 * the resolved config (manifest defaults merged over stored values) and the
	 * restricted sandbox host (permission-checked; only when a base host was supplied).
	 */
	private buildPluginContext(plugin: DiscoveredPlugin): PluginContext {
		const config = resolvePluginConfig(plugin.manifest.config, this.getPluginConfigs?.()?.[plugin.name])
		const host = this.host
			? createPluginSandbox({
					pluginName: plugin.name,
					permissions: plugin.manifest.permissions,
					pluginRoot: plugin.root,
					workspacePath: this.workspacePath,
					host: this.host,
				})
			: undefined
		return {
			workspacePath: this.workspacePath,
			cwd: this.workspacePath,
			config,
			host,
		}
	}

	/**
	 * Wrap a loaded plugin so each hook receives a context enriched with this
	 * plugin's own `config`/`host` (design §6.2). The registry passes a single shared
	 * context to all plugins at each call site, so per-plugin bits are injected here
	 * via closure — call-site fields (`mode`, `taskId`) survive, this plugin's
	 * `config`/`host`/`workspacePath`/`cwd` are layered on top.
	 */
	private wrapCodePlugin(plugin: DiscoveredPlugin, raw: ShoferPlugin): ShoferPlugin {
		const bits = this.buildPluginContext(plugin)
		// Generic so task-lifecycle contexts (`TaskLifecycleContext`, with `prompt`/`reason`)
		// keep their extra fields through the merge, not just the base `PluginContext`.
		const merge = <T extends PluginContext>(ctx: T): T => ({ ...ctx, ...bits })
		const rawLifecycle = raw.lifecycle
		return {
			name: raw.name,
			initialize: raw.initialize ? (ctx) => raw.initialize!(merge(ctx)) : undefined,
			registerTools: raw.registerTools ? (ctx) => raw.registerTools!(merge(ctx)) : undefined,
			transformSystemPrompt: raw.transformSystemPrompt
				? (prompt, ctx) => raw.transformSystemPrompt!(prompt, merge(ctx))
				: undefined,
			onEvent: raw.onEvent ? (event, ctx) => raw.onEvent!(event, merge(ctx)) : undefined,
			// Forward lifecycle hooks (design §6.9), each with the per-plugin context
			// (config/host/workspace) layered on. The registry additionally gates these on
			// the manifest `permissions.lifecycle` grant passed to `register`.
			lifecycle: rawLifecycle
				? {
						beforeTaskStart: rawLifecycle.beforeTaskStart
							? (ctx) => rawLifecycle.beforeTaskStart!(merge(ctx))
							: undefined,
						afterTaskComplete: rawLifecycle.afterTaskComplete
							? (ctx) => rawLifecycle.afterTaskComplete!(merge(ctx))
							: undefined,
						beforeToolCall: rawLifecycle.beforeToolCall
							? (toolName, args, ctx) => rawLifecycle.beforeToolCall!(toolName, args, merge(ctx))
							: undefined,
						afterToolCall: rawLifecycle.afterToolCall
							? (toolName, args, result, ctx) =>
									rawLifecycle.afterToolCall!(toolName, args, result, merge(ctx))
							: undefined,
						beforeAsk: rawLifecycle.beforeAsk
							? (askType, payload, ctx) => rawLifecycle.beforeAsk!(askType, payload, merge(ctx))
							: undefined,
					}
				: undefined,
		}
	}

	// --- Declarative contributions (enabled + permission-gated) ----------------

	private enabledWithPermission(kind: keyof NonNullable<PluginManifest["permissions"]>): DiscoveredPlugin[] {
		// `effectiveEnabled` (not raw `enabled`) so a plugin failed closed by an unmet
		// dependency contributes nothing (design §14.3). Ordered by install rank
		// ascending so callers that let later entries overwrite earlier ones get
		// last-installed-wins on a conflict (design §14.7).
		return this.plugins
			.filter((p) => p.effectiveEnabled && p.manifest.permissions?.[kind] === true)
			.sort((a, b) => this.installRank(a.name) - this.installRank(b.name))
	}

	/**
	 * Modes contributed by enabled plugins. Each keeps its **natural** authored slug
	 * (no `<pluginName>:` namespacing) and is tagged `source: "plugin"` + `pluginName`
	 * (attribution). On a slug collision *between two plugins*, last-installed-wins
	 * (design §14.7): plugins are iterated in install-rank order (via
	 * {@link enabledWithPermission}) so the later-installed plugin's mode overwrites
	 * the earlier one's, with a warning that is shown + logged. Plugin-vs-file
	 * collisions are resolved by the consumer ({@link CustomModesManager}).
	 */
	getContributedModes(): ModeConfig[] {
		const bySlug = new Map<string, ModeConfig>()
		for (const plugin of this.enabledWithPermission("modes")) {
			for (const mode of plugin.manifest.contributes?.modes ?? []) {
				const prior = bySlug.get(mode.slug)
				if (prior) {
					warnPluginConflict("mode", mode.slug, `plugin "${plugin.name}"`, `plugin "${prior.pluginName}"`)
				}
				bySlug.set(mode.slug, {
					...mode,
					source: "plugin",
					pluginName: plugin.name,
				})
			}
		}
		return Array.from(bySlug.values())
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
