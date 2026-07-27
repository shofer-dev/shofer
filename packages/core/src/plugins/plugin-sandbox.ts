/**
 * plugin-sandbox — the enforcement half of the plugin permission model (design §8;
 * Phase 2, step 2.4).
 *
 * Phase 1 lets a plugin *declare* `permissions` in its manifest; this module makes
 * those declarations binding. {@link createPluginSandbox} wraps a full
 * {@link HostBridge} into the restricted {@link PluginHost} handed to a plugin via
 * `PluginContext.host`, and every capability call is checked against the manifest:
 *
 * - `fs`   — only paths inside the `permissions.filesystem` allowlist (resolved
 *            against the plugin root and the workspace). Out-of-scope ⇒ deny + warn.
 * - `fetch`— only URLs whose origin is in the `permissions.network` allowlist.
 * - `notifier` / `env` — always allowed (surfacing messages / reading metadata is
 *            inherently side-effect-free from a security standpoint).
 *
 * This is a **capability wrapper**, not VM/worker isolation (owner decision #1:
 * "no iframe sandbox, restricted API surface"). A denied call throws a descriptive
 * error *and* emits a shown+logged warning, so a plugin that oversteps fails loudly
 * without being able to reach an ungranted capability.
 */

import path from "path"

import type {
	FindFilesOptions,
	HostBridge,
	HostDisposable,
	HostEnv,
	HostFileSystem,
	NotifyChoiceOptions,
	PluginEditor,
	PluginTelemetry,
	PluginFileDiff,
	PluginHost,
	PluginPermissions,
	PluginSearch,
	PluginWatchEvent,
} from "@shofer/types"

import { warnPlugin } from "./plugin-warnings.js"
import { getPluginLogger } from "./plugin-log.js"
import { TelemetryService } from "@shofer/telemetry"

import { registry } from "../metrics/registry.js"

export interface PluginSandboxOptions {
	/** Plugin name — used in denial warnings for attribution. */
	pluginName: string
	/** The plugin's manifest `permissions` block (absent ⇒ everything scoped denied). */
	permissions?: PluginPermissions
	/** Absolute plugin root — base for resolving relative filesystem allowlist entries. */
	pluginRoot: string
	/** Absolute workspace path — an additional base for relative filesystem entries. */
	workspacePath?: string
	/** The full host to delegate *permitted* calls to. */
	host: HostBridge
	/** Network implementation; defaults to the global `fetch`. Injectable for tests. */
	fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>
	/** Warning sink (shown + logged); defaults to {@link warnPlugin}. Injectable for tests. */
	warn?: (message: string) => void
	/**
	 * Sink for the disposables returned by {@link PluginHost.watch} (P6.G3). The manager
	 * records them per plugin so it can dispose the plugin's watchers when it is disabled/
	 * uninstalled (design §6.11 G3 — "disposed on plugin disable"). Optional; when absent
	 * the plugin is solely responsible for disposing via the returned handle.
	 */
	trackWatch?: (disposable: HostDisposable) => void
	/**
	 * The permission-gated `ctx.host.search` surface (design §6.11). Built + gated by the
	 * {@link PluginManager} (mirroring `ctx.ai`/`ctx.agent`), so the sandbox merely surfaces
	 * it on the restricted host: a live surface for a granted plugin, a denying stub for an
	 * ungranted one, or absent (`undefined`) when the host wired no search provider.
	 */
	search?: PluginSearch
}

/** Whether `target` is inside (or equal to) `root`, after normalization. */
function isWithin(root: string, target: string): boolean {
	const r = path.resolve(root)
	const t = path.resolve(target)
	return t === r || t.startsWith(r + path.sep)
}

/**
 * Compute the absolute allowed filesystem roots from the `permissions.filesystem`
 * allowlist. Absolute entries are used as-is; relative entries are resolved against
 * **both** the plugin root and the workspace (a CI plugin's `./ci-config/` is
 * naturally workspace-relative, while bundled assets are plugin-relative).
 */
function resolveFsRoots(allowlist: string[], pluginRoot: string, workspacePath?: string): string[] {
	const roots: string[] = []
	for (const entry of allowlist) {
		if (path.isAbsolute(entry)) {
			roots.push(path.resolve(entry))
		} else {
			roots.push(path.resolve(pluginRoot, entry))
			if (workspacePath) roots.push(path.resolve(workspacePath, entry))
		}
	}
	return roots
}

/** Whether `url` is permitted by the `permissions.network` allowlist. */
function isNetworkAllowed(url: string, allowlist: string[]): boolean {
	for (const entry of allowlist) {
		if (url === entry || url.startsWith(entry)) return true
		try {
			if (new URL(url).origin === new URL(entry).origin) return true
		} catch {
			// Non-absolute entry (e.g. a bare host) — the prefix check above governs it.
		}
	}
	return false
}

/**
 * Build the restricted {@link PluginHost} for a plugin. Only the capabilities its
 * manifest grants are reachable; any other access is denied (throw + shown/logged
 * warning). Safe to call with `permissions` undefined (all scoped capabilities are
 * then denied; `notifier`/`env` remain available).
 */
export function createPluginSandbox(options: PluginSandboxOptions): PluginHost {
	const { pluginName, permissions, pluginRoot, workspacePath, host } = options
	// Default deny-warnings to the plugin's own Log category so a plugin's permission
	// denials are filterable alongside the rest of its output.
	const warn = options.warn ?? ((m: string) => warnPlugin(m, pluginName))
	const log = getPluginLogger(pluginName)
	const doFetch = options.fetchImpl ?? ((input, init) => fetch(input, init))

	const fsRoots = resolveFsRoots(permissions?.filesystem ?? [], pluginRoot, workspacePath)
	const networkAllowlist = permissions?.network ?? []

	const denyFs = (targetPath: string, op: string): never => {
		const message =
			`[plugin:${pluginName}] filesystem ${op} of "${targetPath}" denied — ` +
			(fsRoots.length === 0
				? "the plugin did not request any filesystem permissions."
				: "the path is outside the plugin's declared permissions.filesystem allowlist.")
		warn(message)
		throw new Error(message)
	}

	const requireFs = (targetPath: string, op: string): void => {
		if (!fsRoots.some((root) => isWithin(root, targetPath))) {
			denyFs(targetPath, op)
		}
	}

	// `async` so a synchronous permission denial surfaces as a rejected promise
	// (matching the `Promise`-returning `HostFileSystem` contract) rather than a
	// throw at the call site.
	const fs: HostFileSystem = {
		async readFile(p: string) {
			requireFs(p, "read")
			return host.fs.readFile(p)
		},
		async writeFile(p: string, content: string) {
			requireFs(p, "write")
			return host.fs.writeFile(p, content)
		},
		async exists(p: string) {
			requireFs(p, "stat")
			return host.fs.exists(p)
		},
		async mkdir(p: string) {
			requireFs(p, "mkdir")
			return host.fs.mkdir(p)
		},
		async delete(p: string) {
			requireFs(p, "delete")
			return host.fs.delete(p)
		},
		async findFiles(pattern: string, opts: FindFilesOptions) {
			requireFs(opts.cwd, "search")
			return host.fs.findFiles(pattern, opts)
		},
	}

	const env: HostEnv = host.env

	/**
	 * Scoped file-watch (design §6.11 G3, P6.G3; path-carrying since P7). Watches `pattern`
	 * under **each** granted `permissions.filesystem` root (so it can never observe paths the
	 * plugin wasn't granted), wiring create/change/delete → `onChange` with the changed path
	 * and change kind ({@link PluginWatchEvent}). A plugin without a filesystem grant is denied
	 * (warn + no-op disposable). Returns a composite {@link HostDisposable} that disposes every
	 * underlying watcher (and their event subscriptions).
	 */
	const watch = (pattern: string, onChange: (event: PluginWatchEvent) => void): HostDisposable => {
		if (fsRoots.length === 0) {
			warn(
				`[plugin:${pluginName}] file watch of "${pattern}" denied — ` +
					"the plugin did not request any permissions.filesystem paths to watch.",
			)
			return { dispose: () => {} }
		}
		const disposables: HostDisposable[] = []
		for (const root of fsRoots) {
			const watcher = host.watcher.watch(root, pattern)
			disposables.push(watcher.onCreate((path) => onChange({ path, type: "create" })))
			disposables.push(watcher.onChange((path) => onChange({ path, type: "change" })))
			disposables.push(watcher.onDelete((path) => onChange({ path, type: "delete" })))
			disposables.push(watcher)
		}
		const composite: HostDisposable = {
			dispose: () => {
				for (const d of disposables) {
					try {
						d.dispose()
					} catch {
						// Disposing one watcher must not block the rest.
					}
				}
			},
		}
		// Let the manager track it so the plugin's watchers are torn down on disable.
		options.trackWatch?.(composite)
		return composite
	}

	/**
	 * Product telemetry (`permissions.telemetry`).
	 *
	 * Namespaced and scrubbed by {@link TelemetryService.capturePluginEvent}, and — unlike
	 * every other gated capability — a **denied** call warns and returns instead of
	 * throwing. An analytics call is not something a code path should have to guard: a
	 * plugin that reports an error must not fail differently because reporting was
	 * refused.
	 */
	const telemetry: PluginTelemetry = {
		capture(event: string, properties?: Record<string, unknown>): void {
			if (!permissions?.telemetry) {
				warn(
					`[plugin:${pluginName}] ctx.host.telemetry.capture("${event}") dropped — the plugin declares ` +
						`no permissions.telemetry grant. Add "telemetry": true to the manifest permissions.`,
				)
				return
			}
			// A host with no telemetry service at all (a CLI embedding, a test) is not an
			// error either — there is simply nowhere to send it.
			if (!TelemetryService.hasInstance()) return
			TelemetryService.instance.capturePluginEvent(pluginName, event, properties)
		},
	}

	/**
	 * Editor actions (`permissions.editor`). Unlike `ai`/`agent`/`task` this needs no
	 * host provider seam — {@link HostBridge.editor} is already host-agnostic — so the
	 * sandbox gates it directly: granted ⇒ delegate, ungranted ⇒ throw + warn.
	 */
	const editor: PluginEditor = {
		async showMultiFileDiff(title: string, changes: PluginFileDiff[]): Promise<void> {
			if (!permissions?.editor) {
				const message =
					`[plugin:${pluginName}] ctx.host.editor.showMultiFileDiff denied — ` +
					`the plugin declares no permissions.editor grant. Add "editor": true to the manifest permissions.`
				warn(message)
				throw new Error(message)
			}
			await host.editor.showMultiFileDiff(title, changes)
		},
		async openFile(absolutePath: string): Promise<void> {
			if (!permissions?.editor) {
				const message =
					`[plugin:${pluginName}] ctx.host.editor.openFile denied — ` +
					`the plugin declares no permissions.editor grant. Add "editor": true to the manifest permissions.`
				warn(message)
				throw new Error(message)
			}
			await host.editor.openFile(absolutePath)
		},
	}

	const restrictedFetch = (input: string | URL, init?: RequestInit): Promise<Response> => {
		const url = input.toString()
		if (!isNetworkAllowed(url, networkAllowlist)) {
			const message =
				`[plugin:${pluginName}] network request to "${url}" denied — ` +
				(networkAllowlist.length === 0
					? "the plugin did not request any network permissions."
					: "the origin is outside the plugin's declared permissions.network allowlist.")
			warn(message)
			return Promise.reject(new Error(message))
		}
		return doFetch(input, init)
	}

	return {
		fs,
		env,
		// Instruments, namespaced by whatever the plugin calls its metrics. Ungated: a
		// counter is as harmless as a log line, and a plugin that owns a subsystem has to
		// be able to publish the numbers an operator watches.
		metrics: {
			increment: (name, help, labels, amount) => registry.incCounter(name, help, labels, amount ?? 1),
			gauge: (name, help, value, labels) => registry.setGauge(name, help, value, labels),
			observe: (name, help, value, labels) => registry.observeHistogram(name, help, value, undefined, labels),
		},
		notifier: {
			info: (m: string) => host.notifier.info(m),
			warn: (m: string) => host.notifier.warn(m),
			error: (m: string) => host.notifier.error(m),
			showChoice: (m: string, options: string[], opts?: NotifyChoiceOptions) =>
				host.notifier.showChoice(m, options, opts),
		},
		// Plugin-scoped logger → its own `Plugin:<name>` Log category (Settings → Logging).
		log,
		fetch: restrictedFetch,
		watch,
		// Already gated by the manager (live / denying stub / absent); surfaced as-is.
		search: options.search,
		telemetry,
		editor,
	}
}
