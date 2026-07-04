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

import type { FindFilesOptions, HostBridge, HostEnv, HostFileSystem, PluginHost, PluginPermissions } from "@shofer/types"

import { warnPlugin } from "./plugin-warnings.js"

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
	const warn = options.warn ?? warnPlugin
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
		notifier: {
			info: (m: string) => host.notifier.info(m),
			warn: (m: string) => host.notifier.warn(m),
			error: (m: string) => host.notifier.error(m),
		},
		fetch: restrictedFetch,
	}
}
