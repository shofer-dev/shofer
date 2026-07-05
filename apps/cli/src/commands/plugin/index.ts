/**
 * `shofer plugin` — install / list / remove Shofer plugins from the CLI (design §9;
 * Phase 5.2). Thin wrappers over the Phase-1 {@link PluginManager} discovery and the
 * Phase-5.1 archive primitives ({@link installPlugin}, `.shofer-plugin` pack/unpack).
 *
 * Plugins install into the **global** dir (`~/.shofer/plugins/<name>`). The
 * enabled/installed allow-list is persisted in the same global-state file the running
 * agent reads (`<globalStorage>/global-state.json`, key `shofer.plugins.enabledPlugins`),
 * so a plugin installed/removed here is picked up by the agent (and the Plugins
 * settings tab) unchanged.
 */

import * as os from "os"
import * as path from "path"

import {
	PluginManager,
	createNodePluginFs,
	installPlugin,
	installPluginFromUrl,
	isPluginUrl,
	type DiscoveredPlugin,
} from "@shofer/core/cli"
import { VSCodeMockPaths } from "@shofer/vscode-shim"

import { createFileStateStore } from "./state-store.js"

/**
 * The global Shofer directory (`~/.shofer`). Mirrors `@shofer/core`'s
 * `getGlobalShoferDirectory()` but is inlined here so the CLI-safe surface stays lean
 * (importing the core helper drags the ripgrep locator — and its `String.toPosix`
 * augmentation dependency — into the CLI compilation).
 */
function getGlobalShoferDirectory(): string {
	return path.join(os.homedir(), ".shofer")
}

/** Global-state key holding the enabled/installed plugin allow-list (matches ShoferProvider). */
const ENABLED_PLUGINS_KEY = "shofer.plugins.enabledPlugins"

/**
 * Shared knobs for the `plugin` subcommands. All paths default to the real global
 * locations; tests inject temp dirs to exercise the handlers in isolation.
 */
export interface PluginCommandOptions {
	/** Global plugins dir. Default: `~/.shofer/plugins`. */
	pluginsDir?: string
	/** File backing the enabled allow-list. Default: `<globalStorage>/global-state.json`. */
	stateFile?: string
	/** Sink for user-facing output (default `console.log`). */
	log?: (line: string) => void
	/** Emit machine-readable JSON (list only). */
	json?: boolean
	/** Replace an already-installed plugin of the same name (install only). */
	overwrite?: boolean
	/** Enable the plugin immediately after install (install only). */
	enable?: boolean
	/** Permit a plain `http://` URL install from a non-loopback host (install only, URL source). */
	allowInsecureHttp?: boolean
	/** `fetch` override for URL installs (default: global `fetch`). Injected in tests. */
	fetchImpl?: typeof fetch
	/** Max download size (bytes) for URL installs. Default: core's 64 MiB cap. Injected in tests. */
	maxDownloadBytes?: number
}

function resolvePluginsDir(options: PluginCommandOptions): string {
	return options.pluginsDir ?? path.join(getGlobalShoferDirectory(), "plugins")
}

function resolveStateFile(options: PluginCommandOptions): string {
	return options.stateFile ?? path.join(VSCodeMockPaths.getGlobalStorageDir(), "global-state.json")
}

function out(options: PluginCommandOptions): (line: string) => void {
	return options.log ?? ((line: string) => console.log(line))
}

/** Build a discovery-only {@link PluginManager} over the global plugins dir + file store. */
async function buildManager(options: PluginCommandOptions): Promise<PluginManager> {
	const manager = new PluginManager({
		fs: createNodePluginFs(),
		stateStore: createFileStateStore(resolveStateFile(options), ENABLED_PLUGINS_KEY),
		pluginDirs: [{ dir: resolvePluginsDir(options), scope: "global" }],
	})
	await manager.discover()
	return manager
}

/**
 * `shofer plugin install <source>` — install from a `.shofer-plugin` archive, an
 * unpacked plugin directory, or a direct http(s) URL to a `.shofer-plugin` archive.
 * Validates the manifest, copies/unpacks into the global plugins dir, and reports the
 * installed name/version. A URL source is downloaded (via the host-agnostic core
 * {@link installPluginFromUrl}) and unpacked through the same validation/zip-slip path;
 * https is required unless the host is loopback or `--allow-insecure-http` is passed.
 * With `--enable`, enables it in the allow-list too (otherwise it stays disabled until
 * enabled in the Plugins tab — the per-plugin consent gate, design §14 Q6).
 */
export async function pluginInstall(source: string, options: PluginCommandOptions = {}): Promise<void> {
	const log = out(options)
	const pluginsDir = resolvePluginsDir(options)
	const installed = isPluginUrl(source)
		? await installPluginFromUrl(source, pluginsDir, {
				overwrite: options.overwrite,
				allowInsecureHttp: options.allowInsecureHttp,
				fetchImpl: options.fetchImpl,
				maxBytes: options.maxDownloadBytes,
			})
		: await installPlugin(source, pluginsDir, { overwrite: options.overwrite })
	log(`Installed plugin "${installed.name}" v${installed.version} → ${installed.dir}`)

	if (options.enable) {
		const manager = await buildManager(options)
		await manager.setEnabled(installed.name, true)
		log(`Enabled "${installed.name}".`)
	} else {
		log(`It is disabled by default. Enable it in the Plugins settings tab, or re-run with --enable.`)
	}
}

/** A `plugin list` row (also the shape emitted by `--json`). */
export interface PluginListEntry {
	name: string
	version: string
	description?: string
	scope: "global" | "project"
	enabled: boolean
	/** Enabled but inert (unmet/cyclic dependency), design §14.3. */
	disabledReason?: string
	hasCode: boolean
}

function toEntry(plugin: DiscoveredPlugin): PluginListEntry {
	return {
		name: plugin.name,
		version: plugin.version,
		description: plugin.description,
		scope: plugin.scope,
		enabled: plugin.enabled,
		disabledReason: plugin.disabledReason,
		hasCode: plugin.hasCode,
	}
}

/**
 * `shofer plugin list` — list every discovered plugin in the global dir with its
 * enabled state. `--json` emits the structured list; otherwise a compact text table.
 */
export async function pluginList(options: PluginCommandOptions = {}): Promise<void> {
	const log = out(options)
	const manager = await buildManager(options)
	const entries = manager.listPlugins().map(toEntry)

	if (options.json) {
		log(JSON.stringify(entries, null, 2))
		return
	}

	if (entries.length === 0) {
		log(`No plugins installed in ${resolvePluginsDir(options)}.`)
		return
	}

	for (const e of entries) {
		const state = e.enabled ? (e.disabledReason ? "inactive" : "enabled") : "disabled"
		const flags = [state, e.hasCode ? "code" : "declarative"].join(", ")
		let line = `${e.name}  v${e.version}  [${flags}]`
		if (e.description) line += `\n    ${e.description}`
		if (e.enabled && e.disabledReason) line += `\n    ⚠ ${e.disabledReason}`
		log(line)
	}
}

/**
 * `shofer plugin remove <name>` — delete the plugin's directory and drop it from the
 * enabled allow-list (via {@link PluginManager.uninstall}). No-throw is *not* used: an
 * unknown name is reported as an error so the user knows nothing was removed.
 */
export async function pluginRemove(name: string, options: PluginCommandOptions = {}): Promise<void> {
	const log = out(options)
	const manager = await buildManager(options)
	const plugin = manager.getPlugin(name)
	if (!plugin) {
		throw new Error(`No plugin named "${name}" is installed in ${resolvePluginsDir(options)}.`)
	}
	await manager.uninstall(name)
	log(`Removed plugin "${name}".`)
}
