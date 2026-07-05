/**
 * plugin-storage — a plugin's private persistent data dir, exposed as `ctx.storage`
 * (design §6.11 G2; Phase 6, P6.G2).
 *
 * Each plugin gets its own directory (`<storageBaseDir>/<name>/`) and a scoped fs whose
 * every path is resolved **relative to that dir** and **traversal-blocked** (a `..`
 * escape is denied), so one plugin can neither read nor clobber another's data (nor host
 * files). Created lazily (the dir is `mkdir`-ed on first write), survives restart, and is
 * removed on uninstall by the {@link PluginManager}. Unlike `ctx.host.fs`, storage is the
 * plugin's *own* sandbox — it works regardless of `permissions.filesystem`.
 *
 * Host-agnostic: it operates over the injected {@link HostFileSystem} seam (no `vscode`,
 * no `node:*`), so the same surface works in the extension, the CLI, and tests.
 */

import path from "path"

import type { HostFileSystem, PluginStorage } from "@shofer/types"

/** Whether `target` is inside (or equal to) `root`, after normalization. */
function isWithin(root: string, target: string): boolean {
	const r = path.resolve(root)
	const t = path.resolve(target)
	return t === r || t.startsWith(r + path.sep)
}

/**
 * Build a plugin's {@link PluginStorage} rooted at `dir`, backed by `fs`. `pluginName`
 * is used only in traversal-denial errors for attribution. The directory is created
 * lazily on the first write (so a plugin that never writes leaves no trace).
 */
export function createPluginStorage(pluginName: string, dir: string, fs: HostFileSystem): PluginStorage {
	const root = path.resolve(dir)

	/** Resolve `relativePath` under {@link root}, rejecting any escape (traversal block). */
	const resolve = (relativePath: string, op: string): string => {
		const target = path.resolve(root, relativePath)
		if (!isWithin(root, target)) {
			throw new Error(
				`[plugin:${pluginName}] storage ${op} of "${relativePath}" denied — path escapes the plugin's storage directory.`,
			)
		}
		return target
	}

	/** Ensure the storage dir (and a nested file's parent) exists before a write. */
	const ensureDir = async (target: string): Promise<void> => {
		const parent = path.dirname(target)
		await fs.mkdir(parent)
	}

	return {
		dir: root,
		async readFile(relativePath: string): Promise<string> {
			return fs.readFile(resolve(relativePath, "read"))
		},
		async writeFile(relativePath: string, content: string): Promise<void> {
			const target = resolve(relativePath, "write")
			await ensureDir(target)
			await fs.writeFile(target, content)
		},
		async exists(relativePath: string): Promise<boolean> {
			return fs.exists(resolve(relativePath, "stat"))
		},
		async delete(relativePath: string): Promise<void> {
			await fs.delete(resolve(relativePath, "delete"))
		},
		async list(relativeDir?: string): Promise<string[]> {
			const base = relativeDir ? resolve(relativeDir, "list") : root
			return fs.findFiles("**/*", { cwd: base })
		},
	}
}
