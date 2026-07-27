import * as nodeFs from "fs/promises"
import * as path from "path"

import {
	type HostBridge,
	type HostDisposable,
	type ModeConfig,
	type PluginContext,
	type PluginLocaleBundle,
	type PluginManifest,
	type PluginSearch,
	pluginManifestSchema,
	type PluginUiContribution,
	type PluginUiRegion,
	type ShoferPlugin,
} from "@shofer/types"

import { configLog } from "../logging/subsystems.js"
import { pluginRegistry } from "./plugin-registry.js"
import type { PluginCodeLoader } from "./plugin-loader.js"
import { createPluginSandbox } from "./plugin-sandbox.js"
import { type PluginAiProvider, createPluginAi, createDeniedPluginAi } from "./plugin-ai.js"
import { type PluginUiProvider, createPluginUi } from "./plugin-ui.js"
import { type PluginAgentProvider, createPluginAgent, createDeniedPluginAgent } from "./plugin-agent.js"
import { type PluginTaskProvider, createPluginTaskControl, createDeniedPluginTaskControl } from "./plugin-task.js"
import { type PluginSearchProvider, createPluginSearch, createDeniedPluginSearch } from "./plugin-search.js"
import { createPluginStorage } from "./plugin-storage.js"
import { PluginServiceSupervisor } from "./plugin-services.js"
import { buildPluginUiRegistry, type UiContributingPlugin } from "./ui-registry.js"
import { warnPlugin, warnPluginConflict } from "./plugin-warnings.js"
import { getPluginLogger } from "./plugin-log.js"

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
	/** Immediate file names in `dir`. Returns `[]` when `dir` is missing. */
	listFiles(dir: string): Promise<string[]>
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
	/**
	 * Names the user has explicitly **turned off**. Only meaningful for a bundled
	 * plugin declaring `defaultEnabled` — it is on unless it appears here, so an
	 * explicit "off" must be recorded as its own fact (an absent name means "no
	 * decision yet", which for that plugin means on).
	 *
	 * Optional: a store that doesn't implement it cannot remember an off decision, so
	 * the manager ignores `defaultEnabled` entirely there rather than resurrecting a
	 * plugin the user disabled.
	 */
	getDisabledPlugins?(): string[] | Promise<string[]>
	/** Persist the explicitly-disabled set. */
	setDisabledPlugins?(names: string[]): void | Promise<void>
}

/**
 * Persistence seam for the set of plugins the user has consented to make **billed** AI
 * calls (design §6.11 G1, §8; Phase 6). Separate from {@link PluginStateStore} (enable)
 * so consent is an independent, explicit gate on `ctx.ai`.
 */
export interface PluginAiConsentStore {
	/** Names of plugins the user has AI-consented (billed calls allowed). */
	getAiConsentedPlugins(): string[] | Promise<string[]>
	/** Persist the new AI-consented set. */
	setAiConsentedPlugins(names: string[]): void | Promise<void>
}

/**
 * A plugin's provenance:
 * - `"bundled"` — a **first-party** plugin shipped inside the extension itself
 *   (the packaged `plugins/` dir). Discovered like the others but non-uninstallable
 *   (it is part of the install, not user-added) and lowest-precedence, so a
 *   same-named global/project plugin can shadow it.
 * - `"global"` — installed into `~/.shofer/plugins`.
 * - `"project"` — installed into `<cwd>/.shofer/plugins` (highest precedence).
 */
export type PluginScope = "bundled" | "global" | "project"

/** A directory the manager was told to scan, with its scope tag. */
export interface PluginDir {
	dir: string
	scope: PluginScope
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
	scope: PluginScope
	/**
	 * Whether this is a **first-party** plugin shipped inside the extension
	 * (`scope: "bundled"`). First-party plugins are non-uninstallable — they are
	 * part of the install, not user-added — and the Plugins panel hides their
	 * uninstall affordance accordingly. They follow the normal enable allow-list
	 * (disabled until the user opts in) unless their manifest declares
	 * `defaultEnabled` — see {@link PluginManager.resolveEnabled}.
	 */
	firstParty: boolean
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
	/**
	 * Authored names (skill dir names / command file basenames) the manifest marked
	 * `private` — resolvable/invocable by qualified name but hidden from user-facing
	 * enumerations. Empty when the plugin declares no private entries of this kind.
	 *
	 * Absent for contribution kinds that have no private concept (workflows, which are
	 * not namespaced and so cannot be "invocable only by qualified name").
	 */
	privateNames?: string[]
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
	/**
	 * Host seam constructing a plugin's `ctx.ai` (design §6.11 G1). When omitted, no
	 * plugin gets AI access (even a granted+consented one) — headless/pure-core stays
	 * host-agnostic. Supplied by the extension where `ProviderSettingsManager` lives.
	 */
	aiProvider?: PluginAiProvider
	/**
	 * Persistence seam for the billed-AI consent set (design §8). When omitted, no
	 * plugin is ever AI-consented, so any `permissions.ai` plugin gets a denying
	 * `ctx.ai` (fail-closed).
	 */
	aiConsentStore?: PluginAiConsentStore
	/**
	 * Host seam constructing a plugin's `ctx.agent` (design §6.11 G8; Phase 7). When
	 * omitted, no plugin gets agent-steering (even a granted one) — headless/pure-core
	 * stays host-agnostic and `ctx.agent` is absent. Supplied by the extension where the
	 * task manager / message queue live.
	 */
	agentProvider?: PluginAgentProvider
	/**
	 * Plugin names an **organization** has suppressed (delivered as pod env vars, see
	 * `config/governance.ts`). Unlike the user's enable/disable these are not a
	 * preference: a listed plugin never loads and the user cannot turn it back on, which
	 * is what lets an org fully define the available mode/workflow set.
	 */
	forceDisabledPlugins?: string[]
	/**
	 * Host seam backing a plugin's `ctx.task` — timeline markers + rewind (design §6.11
	 * G9). When omitted, no plugin gets timeline control (even a granted one), so
	 * pure-core embeddings stay host-agnostic and `ctx.task` is absent. Supplied by the
	 * extension, where the task stack and message persistence live.
	 */
	taskProvider?: PluginTaskProvider
	/**
	 * Host seam running a plugin's `ctx.host.search` queries (design §6.11). When omitted,
	 * no plugin gets search access (even a granted one) — headless/pure-core stays
	 * host-agnostic and `ctx.host.search` is absent. Supplied by the extension where the
	 * `CodeIndexManager` / `GitIndexManager` / symbol provider / diagnostics live; gated on
	 * `permissions.search` inside the manager.
	 */
	searchProvider?: PluginSearchProvider
	/**
	 * Host seam delivering a plugin's `ctx.ui` push (extension→UI, design §6.8). When
	 * omitted, no plugin gets a UI sender (even a `permissions.ui`-granted one) —
	 * headless/pure-core stays host-agnostic and `ctx.ui` is absent. Supplied by the
	 * extension where the webview channel lives (e.g. `ShoferProvider.postPluginUiMessage`);
	 * gated on a granted `permissions.ui` region inside the manager.
	 */
	uiProvider?: PluginUiProvider
	/**
	 * Absolute base dir for per-plugin storage (design §6.11 G2). A plugin's
	 * `ctx.storage.dir` is `<storageBaseDir>/<name>`. When omitted (or when no host fs
	 * is available), `ctx.storage` is absent. Host-provided (e.g. `<globalStorage>/plugins`).
	 */
	storageBaseDir?: string
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
	private readonly aiProvider?: PluginAiProvider
	private readonly aiConsentStore?: PluginAiConsentStore
	private readonly forceDisabled: ReadonlySet<string>
	private readonly agentProvider?: PluginAgentProvider
	private readonly taskProvider?: PluginTaskProvider
	private readonly searchProvider?: PluginSearchProvider
	private readonly uiProvider?: PluginUiProvider
	private readonly storageBaseDir?: string
	/** Plugins the user has AI-consented (billed calls). Loaded in {@link discover}. */
	private aiConsented = new Set<string>()
	/** Plugins the user explicitly turned off — see {@link PluginStateStore.getDisabledPlugins}. */
	private explicitlyDisabled = new Set<string>()
	/** Whether the state store can record an explicit "off" (gates `defaultEnabled`). */
	private canRecordDisable = false
	/** Names of code plugins currently loaded + registered into `pluginRegistry`. */
	private readonly loadedCodePlugins = new Set<string>()
	/** Per-plugin `ctx.host.watch` disposables, torn down when the plugin unloads (P6.G3). */
	private readonly pluginWatchers = new Map<string, HostDisposable[]>()
	/** Supervises plugin-registered background services (P6.G7). */
	private readonly serviceSupervisor = new PluginServiceSupervisor()
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
		this.aiProvider = options.aiProvider
		this.aiConsentStore = options.aiConsentStore
		this.forceDisabled = new Set(options.forceDisabledPlugins ?? [])
		this.agentProvider = options.agentProvider
		this.taskProvider = options.taskProvider
		this.searchProvider = options.searchProvider
		this.uiProvider = options.uiProvider
		this.storageBaseDir = options.storageBaseDir
	}

	/**
	 * Scan every configured plugin directory, validate manifests, and rebuild the
	 * in-memory plugin list. Invalid manifests are skipped with a warning. When two
	 * plugins share a name, the later-scanned directory wins (callers pass
	 * `bundled` before `global` before `project`, so a project plugin shadows a
	 * global one, which in turn shadows a first-party bundled one).
	 */
	async discover(): Promise<void> {
		const enabledList = await this.stateStore.getEnabledPlugins()
		this.enabledOrder = [...enabledList]
		const enabled = new Set(enabledList)
		this.explicitlyDisabled = new Set((await this.stateStore.getDisabledPlugins?.()) ?? [])
		this.canRecordDisable = typeof this.stateStore.setDisabledPlugins === "function"
		// Load the billed-AI consent set (design §8) — an independent gate on `ctx.ai`.
		this.aiConsented = new Set((await this.aiConsentStore?.getAiConsentedPlugins()) ?? [])
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
	 * Whether a discovered plugin is on (design §7).
	 *
	 * The default is the user's allow-list: enabling a plugin is the consent to run its
	 * code at all, so an unlisted plugin is off. The one exception is a **bundled**
	 * (first-party) plugin whose manifest declares `defaultEnabled` — a shipped Shofer
	 * *feature* packaged as a plugin rather than a third-party add-on. It is on until
	 * the user says otherwise, and their "otherwise" is remembered in the
	 * explicitly-disabled set (never inferred from absence, which would resurrect it on
	 * the next discovery).
	 *
	 * `defaultEnabled` is ignored — fail-safe to opt-in — for a non-bundled plugin (a
	 * third party can never enable itself) and when the state store cannot record an
	 * explicit disable, since a plugin the user cannot turn off is worse than one they
	 * have to turn on.
	 */
	private resolveEnabled(manifest: PluginManifest, scope: PluginScope, enabled: Set<string>): boolean {
		// Organization suppression wins over every user choice, including an explicit
		// enable — that is the point of it.
		if (this.forceDisabled.has(manifest.name)) return false
		if (enabled.has(manifest.name)) return true
		if (manifest.defaultEnabled !== true) return false
		if (scope !== "bundled" || !this.canRecordDisable) return false
		return !this.explicitlyDisabled.has(manifest.name)
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
		scope: PluginScope,
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
		const isEnabled = this.resolveEnabled(manifest, scope, enabled)
		return {
			name: manifest.name,
			version: manifest.version,
			description: manifest.description,
			root,
			manifestPath,
			scope,
			firstParty: scope === "bundled",
			enabled: isEnabled,
			// Recomputed by resolveDependencies() right after discovery; seed to the
			// user intent so a manager inspected mid-discovery is never inconsistent.
			effectiveEnabled: isEnabled,
			hasCode: typeof manifest.main === "string" && manifest.main.length > 0,
			manifest,
			// Counts feed the user-facing Plugins settings panel, so **private**
			// modes/skills/commands are excluded (they are hidden from users, though
			// still registered + invocable by qualified name).
			contributionCounts: {
				modes: (contributes.modes ?? []).filter((m) => !m.private).length,
				skills: (contributes.skills ?? []).filter((s) => !s.private).length,
				commands: (contributes.commands ?? []).filter((c) => !c.private).length,
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

		// Record the user's OFF decision as its own fact, so a `defaultEnabled` bundled
		// plugin stays off across restarts instead of being resurrected by its manifest
		// (absence from the enabled list means "no decision" for those plugins).
		if (this.stateStore.setDisabledPlugins) {
			const next = new Set(this.explicitlyDisabled)
			if (enabled) {
				next.delete(name)
			} else {
				next.add(name)
			}
			if (next.size !== this.explicitlyDisabled.size) {
				this.explicitlyDisabled = next
				await this.stateStore.setDisabledPlugins([...next])
			}
		}

		const plugin = this.getPlugin(name)
		if (plugin) {
			// The user's intent is still recorded above (so it takes effect if the org
			// lifts the suppression), but it cannot switch on a plugin the org disabled —
			// otherwise the toggle would appear to work and silently do nothing.
			plugin.enabled = this.forceDisabled.has(name) ? false : enabled
			if (enabled && this.forceDisabled.has(name)) {
				warnPlugin(`[plugins] "${name}" is disabled by your organization and cannot be enabled here.`)
			}
		}
		// Re-run fail-closed resolution: toggling one plugin can satisfy or break
		// another's dependency closure (design §14.3).
		this.resolveDependencies()
		// Reconcile code plugins so a toggled code plugin is loaded/unloaded now (a
		// disabled plugin's hooks must stop firing). No-op without a codeLoader.
		await this.activateCodePlugins()
	}

	/** Whether the user has AI-consented (billed calls) for `name` (design §8). */
	isAiConsented(name: string): boolean {
		return this.aiConsented.has(name)
	}

	/**
	 * Grant or revoke a plugin's billed-AI consent (design §6.11 G1, §8) and persist it.
	 * Consent is an independent gate on `ctx.ai`: this reloads the affected code plugin so
	 * its context is rebuilt with the new consent (a live `ctx.ai` becomes a denying stub
	 * on revoke, and vice versa) rather than serving a stale surface captured at load.
	 */
	async setAiConsent(name: string, consented: boolean): Promise<void> {
		const current = new Set(this.aiConsented)
		if (consented) current.add(name)
		else current.delete(name)
		const next = [...current]
		await this.aiConsentStore?.setAiConsentedPlugins(next)
		this.aiConsented = current
		// Force the affected code plugin to rebuild its context (and thus `ctx.ai`) on the
		// next activation pass. No-op for a declarative/unloaded plugin.
		if (this.loadedCodePlugins.has(name)) {
			pluginRegistry.unregister(name)
			this.loadedCodePlugins.delete(name)
			this.disposePluginWatchers(name)
			// Stop the plugin's services before it re-registers, so the reload doesn't
			// leave the old service running alongside a freshly started one (P6.G7).
			await this.serviceSupervisor.stopForPlugin(name)
		}
		await this.activateCodePlugins()
	}

	/** Dispose and forget a plugin's tracked `ctx.host.watch` disposables (P6.G3). */
	private disposePluginWatchers(name: string): void {
		for (const d of this.pluginWatchers.get(name) ?? []) {
			try {
				d.dispose()
			} catch {
				// One watcher's dispose must not block the rest.
			}
		}
		this.pluginWatchers.delete(name)
	}

	/**
	 * Uninstall a plugin: delete its directory and drop it from the enabled set and
	 * the in-memory list. All its contributions disappear on the next read.
	 *
	 * **First-party (bundled) plugins are never uninstalled** — they ship inside the
	 * extension, so deleting their directory would only have them reappear on the next
	 * build/update and is a category error. The call is a no-op (the panel also hides
	 * the affordance); disabling is the way to turn a bundled plugin off.
	 */
	async uninstall(name: string): Promise<void> {
		const plugin = this.getPlugin(name)
		if (!plugin) {
			return
		}
		if (plugin.firstParty) {
			warnPlugin(
				`[plugins] "${name}" is a bundled first-party plugin and cannot be uninstalled; disable it instead.`,
			)
			return
		}
		await this.fs.removeDir(plugin.root)
		// Remove the plugin's private storage dir too (design §6.11 G2 — removed on uninstall).
		if (this.storageBaseDir) {
			await this.fs.removeDir(path.join(this.storageBaseDir, name)).catch(() => {})
		}
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

		const active = new Set(
			this.enabledPlugins()
				.filter((p) => p.hasCode)
				.map((p) => p.name),
		)

		// Unregister code plugins that are loaded but no longer active (disabled, or
		// failed closed by a dependency toggle).
		for (const name of [...this.loadedCodePlugins]) {
			if (!active.has(name)) {
				pluginRegistry.unregister(name)
				this.loadedCodePlugins.delete(name)
				this.disposePluginWatchers(name)
				// P6.G7 — stop the plugin's supervised services on deactivation.
				await this.serviceSupervisor.stopForPlugin(name)
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
				// The registry is a process-wide singleton but managers are built
				// per-webview-provider. A previous provider that wasn't fully disposed, or
				// a concurrent build, may still hold this plugin. Replace it so THIS
				// manager's context/seams own it, rather than throwing "already registered"
				// (which would disable an otherwise-healthy plugin).
				if (pluginRegistry.has(plugin.name)) {
					pluginRegistry.unregister(plugin.name)
				}
				// `register` runs the plugin's `initialize`, where it may call
				// `ctx.registerService`; the services are then started below (P6.G7).
				await pluginRegistry.register(wrapped, this.buildPluginContext(plugin), {
					// Gate lifecycle hooks on the manifest grant (design §6.9, §8): only a
					// plugin that requested `permissions.lifecycle` participates.
					lifecycle: plugin.manifest.permissions?.lifecycle === true,
					// A manifest may raise its own hook budget (already range-checked by the
					// schema) when a hook does work the agent must genuinely wait for.
					hookTimeoutMs: plugin.manifest.hookTimeoutMs,
				})
				this.loadedCodePlugins.add(plugin.name)
				// Start any services the plugin registered during initialize (supervised,
				// isolated — a throwing/hanging service can never crash activation).
				await this.serviceSupervisor.startForPlugin(plugin.name)
				// Emit under the plugin's own `Plugin:<name>` Log category so it registers
				// as a filterable category in Settings → Logging as soon as it loads.
				getPluginLogger(plugin.name).info("loaded")
			} catch (error) {
				warnPlugin(
					`[plugins] Failed to load code plugin "${plugin.name}": ${String(error)} — plugin disabled.`,
					plugin.name,
				)
			}
		}
	}

	/**
	 * Force a single code plugin to rebuild its `PluginContext` (and thus re-read its
	 * config, `ctx.ai`, etc.). Used after the user edits a plugin's config so the change
	 * takes effect without a full reload. No-op for a declarative/unloaded plugin.
	 */
	async reloadPlugin(name: string): Promise<void> {
		if (this.loadedCodePlugins.has(name)) {
			pluginRegistry.unregister(name)
			this.loadedCodePlugins.delete(name)
			this.disposePluginWatchers(name)
			await this.serviceSupervisor.stopForPlugin(name)
		}
		await this.activateCodePlugins()
	}

	/**
	 * Tear down every code plugin this manager loaded: unregister it from the shared
	 * global registry, stop its supervised services, and dispose its watchers. Called
	 * when the owning webview provider is disposed so a freshly built manager (e.g.
	 * after a reload) re-registers cleanly instead of colliding with a stale entry.
	 */
	async dispose(): Promise<void> {
		for (const name of [...this.loadedCodePlugins]) {
			pluginRegistry.unregister(name)
			this.loadedCodePlugins.delete(name)
			this.disposePluginWatchers(name)
			await this.serviceSupervisor.stopForPlugin(name)
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
					// Permission-gated `ctx.host.search` (design §6.11). Built by the manager
					// (mirroring `ctx.ai`/`ctx.agent`) so the gating stays in one place; the
					// sandbox merely surfaces it on the restricted host.
					search: this.buildPluginSearch(plugin),
					// Track `ctx.host.watch` disposables so they are torn down on disable (P6.G3).
					trackWatch: (disposable) => {
						const list = this.pluginWatchers.get(plugin.name) ?? []
						list.push(disposable)
						this.pluginWatchers.set(plugin.name, list)
					},
				})
			: undefined
		return {
			workspacePath: this.workspacePath,
			cwd: this.workspacePath,
			config,
			host,
			ai: this.buildPluginAi(plugin),
			agent: this.buildPluginAgent(plugin),
			task: this.buildPluginTaskControl(plugin),
			ui: this.buildPluginUi(plugin),
			storage:
				this.storageBaseDir && this.host
					? createPluginStorage(plugin.name, path.join(this.storageBaseDir, plugin.name), this.host.fs)
					: undefined,
			// P6.G7 — register a supervised background service tied to this plugin's lifecycle.
			registerService: (service) => this.serviceSupervisor.register(plugin.name, service),
		}
	}

	/**
	 * Construct a plugin's `ctx.ai` surface (design §6.11 G1, §8). Two fail-closed gates:
	 * `permissions.ai` **ungranted** ⇒ `undefined` (`ctx.ai` absent entirely); granted but
	 * no host {@link PluginAiProvider} wired (headless) ⇒ also `undefined`; granted + wired
	 * but **not** billed-AI-consented ⇒ a denying stub (calls throw + warn). Only a granted,
	 * wired, **consented** plugin gets the live provider-backed surface.
	 */
	private buildPluginAi(plugin: DiscoveredPlugin): PluginContext["ai"] {
		if (plugin.manifest.permissions?.ai !== true) return undefined
		if (!this.aiProvider) return undefined
		if (!this.aiConsented.has(plugin.name)) return createDeniedPluginAi(plugin.name)
		return createPluginAi(plugin.name, this.aiProvider)
	}

	/**
	 * Construct a plugin's `ctx.agent` surface (design §6.11 G8, §8; Phase 7). Fail-closed:
	 * no host {@link PluginAgentProvider} wired (headless/pure-core) ⇒ `undefined` (`ctx.agent`
	 * absent — there is nothing to steer); wired but `permissions.agent` **ungranted** ⇒ a
	 * denying stub (calls throw + warn); wired **and** granted ⇒ the live provider-backed
	 * surface. Steering the agent is billed/behavioral, so an ungranted plugin is denied loudly.
	 */
	private buildPluginAgent(plugin: DiscoveredPlugin): PluginContext["agent"] {
		if (!this.agentProvider) return undefined
		if (plugin.manifest.permissions?.agent !== true) return createDeniedPluginAgent(plugin.name)
		return createPluginAgent(plugin.name, this.agentProvider)
	}

	/**
	 * Construct a plugin's `ctx.task` surface — timeline markers + rewind (design §6.11
	 * G9). Fail-closed, mirroring {@link buildPluginAgent}: no host
	 * {@link PluginTaskProvider} wired ⇒ `undefined` (there is no timeline to control);
	 * wired but `permissions.task` ungranted ⇒ a denying stub; wired **and** granted ⇒
	 * the live surface.
	 */
	private buildPluginTaskControl(plugin: DiscoveredPlugin): PluginContext["task"] {
		if (!this.taskProvider) return undefined
		if (plugin.manifest.permissions?.task !== true) return createDeniedPluginTaskControl(plugin.name)
		return createPluginTaskControl(plugin.name, this.taskProvider)
	}

	/**
	 * Construct a plugin's `ctx.host.search` surface (design §6.11). Fail-closed, mirroring
	 * {@link buildPluginAgent}: no host {@link PluginSearchProvider} wired (headless/pure-core)
	 * ⇒ `undefined` (`ctx.host.search` absent — there is nothing to query); wired but
	 * `permissions.search` **ungranted** ⇒ a denying stub (calls throw + warn); wired **and**
	 * granted ⇒ the live provider-backed surface. Read-only + side-effect-free, so — unlike
	 * `ctx.ai` — the grant alone gates it (no billed-calls consent).
	 */
	private buildPluginSearch(plugin: DiscoveredPlugin): PluginSearch | undefined {
		if (!this.searchProvider) return undefined
		if (plugin.manifest.permissions?.search !== true) return createDeniedPluginSearch(plugin.name)
		return createPluginSearch(plugin.name, this.searchProvider)
	}

	/**
	 * Construct a plugin's `ctx.ui` surface (design §6.8 — the extension→UI push half).
	 * Fail-closed: no host {@link PluginUiProvider} wired (headless/pure-core) ⇒ `undefined`
	 * (`ctx.ui` absent — there is nothing to render into); wired but the plugin granted no
	 * `permissions.ui` region ⇒ also `undefined` (a plugin that renders no UI has nothing to
	 * push to). Pushing to a component is side-effect-free + unbilled, so — unlike `ctx.ai` —
	 * a granted region alone gates it (no consent step, no denying stub).
	 */
	private buildPluginUi(plugin: DiscoveredPlugin): PluginContext["ui"] {
		if (!this.uiProvider) return undefined
		if ((plugin.manifest.permissions?.ui?.length ?? 0) === 0) return undefined
		return createPluginUi(plugin.name, this.uiProvider)
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
			// Forward the plugin-UI channel receiver (design §6.8) with this plugin's context.
			onUiMessage: raw.onUiMessage ? (message, ctx) => raw.onUiMessage!(message, merge(ctx)) : undefined,
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
						onTimelineRewind: rawLifecycle.onTimelineRewind
							? (info, ctx) => rawLifecycle.onTimelineRewind!(info, merge(ctx))
							: undefined,
						onTaskDeleted: rawLifecycle.onTaskDeleted
							? (info, ctx) => rawLifecycle.onTaskDeleted!(info, merge(ctx))
							: undefined,
						onUserMessage: rawLifecycle.onUserMessage
							? (info, ctx) => rawLifecycle.onUserMessage!(info, merge(ctx))
							: undefined,
						beforeFileEdit: rawLifecycle.beforeFileEdit
							? (edit, ctx) => rawLifecycle.beforeFileEdit!(edit, merge(ctx))
							: undefined,
						afterFileEdit: rawLifecycle.afterFileEdit
							? (edit, ctx) => rawLifecycle.afterFileEdit!(edit, merge(ctx))
							: undefined,
					}
				: undefined,
			// Forward the request/response entry (design §5.12) with this plugin's context.
			handleRequest: raw.handleRequest
				? (method, params, ctx) => raw.handleRequest!(method, params, merge(ctx))
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
	 * Modes contributed by enabled plugins. Each is **namespaced** under its plugin
	 * name — the emitted `slug` is `<pluginName>:<authoredSlug>` (design §14.7 →
	 * namespacing) and is tagged `source: "plugin"` + `pluginName` (attribution). The
	 * authored slug the plugin declares in its manifest stays natural; the qualified
	 * form is how the mode is addressed/switched-to. Namespacing makes plugin↔plugin
	 * and plugin↔built-in collisions impossible **by construction**, so there is no
	 * last-installed-wins tie-break here. The only residual collision is a single
	 * plugin declaring the same authored slug twice; that is a manifest bug and is
	 * surfaced with a defensive warning (later entry wins, deterministically).
	 */
	getContributedModes(): ModeConfig[] {
		const bySlug = new Map<string, ModeConfig>()
		for (const plugin of this.enabledWithPermission("modes")) {
			// A bundled first-party plugin may ship the platform's own modes under their
			// authored slugs (`code`, `architect`, …) — see `unqualifiedModes`. Everything
			// else is namespaced, so cross-plugin collisions stay impossible.
			const unqualified = plugin.scope === "bundled" && plugin.manifest.unqualifiedModes === true
			for (const mode of plugin.manifest.contributes?.modes ?? []) {
				const slug = unqualified ? mode.slug : `${plugin.name}:${mode.slug}`
				const prior = bySlug.get(slug)
				if (prior) {
					// Two exempt plugins claiming one slug, or one plugin declaring it twice.
					warnPluginConflict("mode", slug, `plugin "${prior.pluginName}"`, `plugin "${plugin.name}"`)
				}
				bySlug.set(slug, {
					...mode,
					slug,
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
			const skills = plugin.manifest.contributes?.skills ?? []
			if (skills.length > 0) {
				out.push({
					pluginName: plugin.name,
					dir: path.join(plugin.root, "skills"),
					privateNames: skills.filter((s) => s.private).map((s) => s.name),
				})
			}
		}
		return out
	}

	/** `<root>/commands` directories for enabled plugins that declare commands. */
	getContributedCommandDirs(): PluginDirContribution[] {
		const out: PluginDirContribution[] = []
		for (const plugin of this.enabledWithPermission("commands")) {
			const commands = plugin.manifest.contributes?.commands ?? []
			if (commands.length > 0) {
				out.push({
					pluginName: plugin.name,
					dir: path.join(plugin.root, "commands"),
					privateNames: commands.filter((c) => c.private).map((c) => c.name),
				})
			}
		}
		return out
	}

	/**
	 * `<root>/workflows` directories for enabled plugins that ship `.slang` workflows.
	 *
	 * Not namespaced, unlike skills/commands: a workflow is addressed by the flow name
	 * in its source, and discovery is a priority merge where a user's or project's file
	 * of the same name wins — the behaviour the built-in workflows had before they
	 * became a plugin, and what lets someone fork a shipped workflow by copying it.
	 */
	getContributedWorkflowDirs(): PluginDirContribution[] {
		const out: PluginDirContribution[] = []
		for (const plugin of this.enabledWithPermission("workflows")) {
			const workflows = plugin.manifest.contributes?.workflows ?? []
			if (workflows.length > 0) {
				out.push({ pluginName: plugin.name, dir: path.join(plugin.root, "workflows") })
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

	/**
	 * UI contributions (design §6.8, Phase 4) of enabled plugins, permission-gated
	 * through {@link PluginUiRegistry}. A plugin contributes to exactly the regions its
	 * manifest granted in `permissions.ui`; a plugin without that grant contributes
	 * nothing. Plugins are ordered by install rank so the webview renders per-region
	 * contributions deterministically (last-installed last). The extension pushes the
	 * result to the webview, which resolves each `componentId` to a React component.
	 *
	 * **External UI bundles (P4):** when a granted region also has a `contributes.ui`
	 * entry, `resolveSource` (host-supplied) converts that entry's **absolute** module
	 * path to a served URI (`webview.asWebviewUri`); the resulting `source` tells the
	 * webview to dynamic-import the plugin's own bundle instead of the co-bundled
	 * registry. Host-agnostic: this method only builds absolute paths and calls back —
	 * VS Code URI conversion lives in the extension. Without `resolveSource` (CLI/tests)
	 * every `source` is `undefined`, so resolution falls back to co-bundled (safe).
	 */
	getContributedUiContributions(resolveSource?: (entryAbsolutePath: string) => string): PluginUiContribution[] {
		const plugins: UiContributingPlugin[] = this.enabledPlugins()
			.filter((p) => (p.manifest.permissions?.ui?.length ?? 0) > 0)
			.sort((a, b) => this.installRank(a.name) - this.installRank(b.name))
			.map((p) => ({
				name: p.name,
				grantedRegions: p.manifest.permissions?.ui ?? [],
				sources: resolveSource ? this.resolveUiSources(p, resolveSource) : undefined,
			}))
		return buildPluginUiRegistry(plugins).all()
	}

	/**
	 * Build the region→source map for one plugin from its `contributes.ui` entries,
	 * resolving each entry's path (relative to the plugin root) to a served URI via
	 * `resolveSource`. Only entries whose region is *also* granted in `permissions.ui`
	 * survive the permission gate in {@link PluginUiRegistry.add}; entries for
	 * ungranted regions are harmless here (never consumed).
	 */
	private resolveUiSources(
		plugin: DiscoveredPlugin,
		resolveSource: (entryAbsolutePath: string) => string,
	): Partial<Record<PluginUiRegion, string>> {
		const sources: Partial<Record<PluginUiRegion, string>> = {}
		for (const entry of plugin.manifest.contributes?.ui ?? []) {
			sources[entry.region] = resolveSource(path.join(plugin.root, entry.entry))
		}
		return sources
	}

	/**
	 * Each enabled UI-contributing plugin's translations, read from the `locales/*.json`
	 * files it ships (`locales/en.json`, `locales/de.json`, …).
	 *
	 * A plugin's UI bundle cannot reach the host's catalogue — its strings are its own —
	 * so the host carries them to the webview, which registers each as an i18next
	 * namespace (`plugin:<name>`). All shipped languages travel together: they are small
	 * JSON files, and sending them once means switching the display language needs no
	 * round-trip to the extension.
	 *
	 * A plugin with no `locales/` directory contributes nothing, and its UI falls back to
	 * rendering the keys — visible, rather than silently blank.
	 */
	async getContributedLocales(): Promise<PluginLocaleBundle[]> {
		const bundles: PluginLocaleBundle[] = []
		for (const plugin of this.enabledPlugins()) {
			if ((plugin.manifest.permissions?.ui?.length ?? 0) === 0) continue
			const dir = path.join(plugin.root, "locales")
			const resources: Record<string, Record<string, unknown>> = {}
			for (const file of await this.fs.listFiles(dir)) {
				if (!file.endsWith(".json")) continue
				try {
					resources[file.slice(0, -".json".length)] = JSON.parse(await this.fs.readFile(path.join(dir, file)))
				} catch (error) {
					warnPlugin(`[plugins] "${plugin.name}" has an unreadable locale file ${file}: ${String(error)}`)
				}
			}
			if (Object.keys(resources).length > 0) bundles.push({ pluginName: plugin.name, resources })
		}
		return bundles
	}

	/**
	 * Absolute directories the host must expose to the webview (`localResourceRoots`)
	 * so enabled plugins' external UI bundles are servable as `vscode-webview://`
	 * resources. Returns each enabled UI-bundle-shipping plugin's root; the extension
	 * adds these (or their parents) to the webview's resource roots.
	 */
	getUiAssetRoots(): string[] {
		return this.enabledPlugins()
			.filter((p) => (p.manifest.contributes?.ui?.length ?? 0) > 0)
			.map((p) => p.root)
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
		async listFiles(dir: string): Promise<string[]> {
			try {
				const entries = await nodeFs.readdir(dir, { withFileTypes: true })
				return entries.filter((e) => e.isFile()).map((e) => e.name)
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
