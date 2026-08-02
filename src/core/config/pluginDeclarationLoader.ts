import fs from "fs/promises"
import * as path from "path"

import {
	EMPTY_PLUGIN_DECLARATION,
	isPathLocked,
	mergePluginDeclarations,
	parsePluginDeclaration,
	PluginResolveError,
	resolvePluginDeclaration,
	type LockedManifest,
	type PluginDeclaration,
	type PluginDir,
	type ResolvedPlugin,
} from "@shofer/core"

import { loadLockedManifest, type ScopeRoots } from "./layeredSettingsLoader"

/**
 * pluginDeclarationLoader — the **host-side** (filesystem) half of Part F
 * ("plugins as `.shofer/` declarations", todos/config-cleanup.md). The pure
 * declaration/merge/resolve engine lives in `@shofer/core`
 * (`plugins/plugin-declaration.ts`) and knows nothing about disk or scope roots;
 * this module supplies the host concerns: reading each scope's
 * `.shofer/plugins.json` (and the global scope's `locked.json`), merging them
 * under the same locked-vs-default rule as `layeredSettingsLoader`, resolving each
 * declared `source@version` into the content-addressed plugin cache, and folding
 * the result into `PluginManager` discovery inputs.
 *
 * The read path is deliberately **additive**: a scope with no `.shofer/plugins.json`
 * contributes an empty declaration, so when no file exists anywhere
 * {@link loadPluginDeclarations} resolves nothing and {@link computePluginDeclarationWiring}
 * produces zero additions — behavior is byte-for-byte the same as before Part F.
 */

/** The per-scope plugin-declaration filename inside `.shofer/`. */
const PLUGINS_FILE = "plugins.json"

/** The result of reading + resolving the three scopes' plugin declarations. */
export interface LoadedPluginDeclarations {
	/** Plugins that materialized and validated into the cache — safe to consume. */
	resolved: ResolvedPlugin[]
	/** The global scope's lock manifest, threaded on so the caller can gate locked plugins. */
	manifest: LockedManifest
	/** Human-readable per-plugin resolution failures (skips + unsupported sources); never throws. */
	errors: string[]
}

/**
 * Read and parse one scope's `.shofer/plugins.json`, failing closed (Schema-First
 * Persistence Rule): a missing file, unreadable path, malformed JSON, or a
 * shape/version mismatch all yield {@link EMPTY_PLUGIN_DECLARATION} rather than
 * throwing.
 */
async function readScopeDeclaration(root: string | undefined): Promise<PluginDeclaration> {
	if (!root) {
		return EMPTY_PLUGIN_DECLARATION
	}
	let raw: string
	try {
		raw = await fs.readFile(path.join(root, PLUGINS_FILE), "utf8")
	} catch {
		return EMPTY_PLUGIN_DECLARATION
	}
	return parsePluginDeclaration(raw)
}

/**
 * Load, merge, and resolve the three scopes' plugin declarations for the given
 * scope roots. Each declared plugin is resolved **independently** so one
 * unsupported source (an http(s) ref, which
 * {@link resolvePluginDeclaration} rejects with a whole-batch
 * {@link PluginResolveError}) cannot abort discovery of the rest — the failure is
 * captured into {@link LoadedPluginDeclarations.errors} and the remaining plugins
 * still resolve.
 */
export async function loadPluginDeclarations(
	roots: ScopeRoots,
	cacheBaseDir: string,
): Promise<LoadedPluginDeclarations> {
	const [global, user, project, manifest] = await Promise.all([
		readScopeDeclaration(roots.global),
		readScopeDeclaration(roots.user),
		readScopeDeclaration(roots.project),
		loadLockedManifest(roots.global),
	])

	const merged = mergePluginDeclarations({ global, user, project }, manifest)

	const resolved: ResolvedPlugin[] = []
	const errors: string[] = []
	for (const [name, entry] of Object.entries(merged.plugins)) {
		const single: PluginDeclaration = { version: merged.version, plugins: { [name]: entry } }
		try {
			const result = await resolvePluginDeclaration(single, cacheBaseDir)
			resolved.push(...result.resolved)
			for (const warning of result.errors) {
				errors.push(`${warning.name}: ${warning.message}`)
			}
		} catch (error) {
			// A PluginResolveError (unsupported remote URL source) is a hard,
			// per-source failure — isolate it so a single bad declaration does not kill
			// discovery of the physically-present and locally-sourced plugins.
			errors.push(error instanceof PluginResolveError ? error.message : `${name}: ${String(error)}`)
		}
	}

	return { resolved, manifest, errors }
}

/** The discovery-input additions produced from a set of resolved declared plugins. */
export interface PluginDeclarationWiring {
	/** Plugin directories to append to the manager's scan list. */
	pluginDirs: PluginDir[]
	/** The effective `pluginConfigs` map (existing + declared seeds), to persist/use. */
	pluginConfigs: Record<string, Record<string, unknown>>
	/** Whether {@link pluginConfigs} differs from the input (so the caller can skip a write). */
	pluginConfigsChanged: boolean
	/** The effective enabled-plugins set (existing + declared enablements), to persist/use. */
	enabledPlugins: string[]
	/** Whether {@link enabledPlugins} differs from the input. */
	enabledChanged: boolean
}

/**
 * Fold resolved declared plugins into `PluginManager` discovery inputs — the pure,
 * host-side core of Part F wiring:
 *
 *   - **`pluginDirs`**: each resolved plugin's cache dir is appended so the manager
 *     discovers it. Declared dirs are tagged with the existing `"global"` scope
 *     rather than a dedicated `"declared"` one — a new {@link PluginScope} member
 *     would ripple into the webview `PluginView` type and the `settings:plugins.scope.*`
 *     i18n keys for a purely cosmetic gain. Dirs are appended (not deduped here):
 *     name-dedupe is `PluginManager`'s job, and appending keeps a physically-present
 *     same-name plugin resolvable.
 *   - **`pluginConfigs`**: a declared `config` seeds defaults. For an **unlocked**
 *     plugin the user's stored values win per key (declared fills only unset keys);
 *     for a **global-locked** plugin the declaration is authoritative and wins per
 *     key. Only recorded when the merged result actually differs, so a steady state
 *     writes nothing.
 *   - **`enabledPlugins`**: a declared plugin with `enabled !== false` is enabled; a
 *     global-locked declared plugin is **always** enabled. Non-declared plugins are
 *     untouched, preserving the existing consent/disabled-by-default behavior.
 *
 * Pure and non-mutating: inputs are cloned, never edited in place.
 */
export function computePluginDeclarationWiring(
	resolved: ResolvedPlugin[],
	manifest: LockedManifest,
	existingPluginConfigs: Record<string, Record<string, unknown>>,
	existingEnabled: string[],
): PluginDeclarationWiring {
	const pluginDirs: PluginDir[] = []
	const pluginConfigs: Record<string, Record<string, unknown>> = { ...existingPluginConfigs }
	const enabledPlugins = [...existingEnabled]
	let pluginConfigsChanged = false
	let enabledChanged = false

	for (const plugin of resolved) {
		pluginDirs.push({ dir: plugin.dir, scope: "global" })

		const locked = isPathLocked(`plugins/${plugin.name}`, manifest)

		if (plugin.config) {
			const existing = existingPluginConfigs[plugin.name]
			const merged = locked
				? { ...(existing ?? {}), ...plugin.config }
				: { ...plugin.config, ...(existing ?? {}) }
			if (JSON.stringify(merged) !== JSON.stringify(existing)) {
				pluginConfigs[plugin.name] = merged
				pluginConfigsChanged = true
			}
		}

		const shouldEnable = locked || plugin.enabled
		if (shouldEnable && !enabledPlugins.includes(plugin.name)) {
			enabledPlugins.push(plugin.name)
			enabledChanged = true
		}
	}

	return { pluginDirs, pluginConfigs, pluginConfigsChanged, enabledPlugins, enabledChanged }
}
