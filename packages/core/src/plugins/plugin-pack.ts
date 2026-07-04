/**
 * plugin-pack — the `.shofer-plugin` archive format: pack a plugin directory into
 * a portable gzip tarball and unpack/install one back onto disk (design §9
 * "Distribution & Discovery"; Phase 5, step 5.1).
 *
 * A `.shofer-plugin` archive is a **gzip-compressed tar** of a plugin directory's
 * contents, rooted at the archive top level (`plugin.json`, code, and asset dirs
 * sit at the root — there is no wrapping directory):
 *
 * ```
 * my-org-ci-1.0.0.shofer-plugin
 *   ├── plugin.json
 *   ├── index.js
 *   ├── skills/
 *   └── commands/
 * ```
 *
 * The archive MUST contain a valid `plugin.json` (validated against the Phase-1
 * {@link pluginManifestSchema}). Unpacking is hardened against zip-slip /
 * path-traversal (absolute paths, `..` segments, symlink/hardlink entries are all
 * rejected) and refuses to overwrite an existing plugin of the same name unless an
 * explicit `overwrite` flag is passed.
 *
 * Node-only (uses `node:fs`, `node:path`, and the portable `tar` library). It lives
 * in `@shofer/core` — never `@shofer/types` — so the browser-safe types package
 * never pulls in an archive lib. Callers: the `shofer plugin` CLI (step 5.2) and the
 * extension-side Marketplace "Plugins" tab handlers (step 5.3).
 */

import * as nodeFs from "fs/promises"
import * as path from "path"

import * as tar from "tar"

import { type PluginManifest, pluginManifestSchema } from "@shofer/types"

/** Canonical archive file extension for a packed plugin. */
export const PLUGIN_ARCHIVE_EXTENSION = ".shofer-plugin"

/** The manifest filename every plugin (packed or on-disk) must contain at its root. */
export const PLUGIN_MANIFEST_FILENAME = "plugin.json"

/** A validated, discovered plugin location after install. */
export interface InstalledPlugin {
	/** The plugin's `name` (from its validated manifest). */
	name: string
	version: string
	/** Absolute directory the plugin was installed into (`<destPluginsDir>/<name>`). */
	dir: string
}

export interface UnpackOptions {
	/**
	 * Replace an existing plugin of the same name instead of rejecting. When set, an
	 * existing `<destPluginsDir>/<name>` is removed before the new content is written
	 * (upgrade path). Default `false` — a name collision throws.
	 */
	overwrite?: boolean
}

/**
 * Thrown when an archive fails validation (bad/missing manifest, zip-slip entry, or
 * a name collision without `overwrite`). A distinct class so callers (CLI / webview
 * handlers) can present these as user errors rather than crashes.
 */
export class PluginPackError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "PluginPackError"
	}
}

/** Validate a raw `plugin.json` string against the Phase-1 schema, or throw. */
function parseManifest(raw: string, where: string): PluginManifest {
	let json: unknown
	try {
		json = JSON.parse(raw)
	} catch (error) {
		throw new PluginPackError(`Invalid JSON in ${where}: ${String(error)}`)
	}
	const parsed = pluginManifestSchema.safeParse(json)
	if (!parsed.success) {
		const issues = parsed.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ")
		throw new PluginPackError(`Invalid plugin manifest in ${where}: ${issues}`)
	}
	return parsed.data
}

/**
 * Reject any tar entry path that could escape the extraction root (zip-slip): an
 * absolute path, a Windows drive/backslash path, or any `..` (or `.`) path segment.
 * Entry paths in a tar are always POSIX (`/`-separated).
 */
function assertSafeEntryPath(entryPath: string): void {
	// tar emits POSIX paths; a leading `./` is normal and harmless.
	const normalized = entryPath.replace(/^\.\//, "")
	if (normalized === "" || normalized === ".") return
	if (path.posix.isAbsolute(normalized) || /^[a-zA-Z]:[\\/]/.test(normalized) || normalized.includes("\\")) {
		throw new PluginPackError(`Refusing archive entry with an unsafe absolute path: "${entryPath}"`)
	}
	const segments = normalized.split("/")
	if (segments.some((s) => s === "..")) {
		throw new PluginPackError(`Refusing archive entry with a path-traversal segment: "${entryPath}"`)
	}
}

/** A file entry read fully into memory during unpack. */
interface TarFileEntry {
	/** Normalized POSIX path relative to the archive root (leading `./` stripped). */
	path: string
	data: Buffer
}

/**
 * Parse a `.shofer-plugin` archive (gzip tarball) fully into memory, returning its
 * file entries. Directory entries are dropped (recreated implicitly on write);
 * symlink/hardlink entries are rejected as unsafe; every entry path is checked for
 * zip-slip before it is accepted. The `tar` Parser auto-detects the gzip wrapper.
 */
function readArchiveEntries(archive: Buffer): Promise<TarFileEntry[]> {
	return new Promise((resolve, reject) => {
		const entries: TarFileEntry[] = []
		let failed = false
		const fail = (error: Error) => {
			if (failed) return
			failed = true
			reject(error)
		}
		const parser = new tar.Parser()
		parser.on("entry", (entry) => {
			if (failed) {
				entry.resume()
				return
			}
			try {
				assertSafeEntryPath(entry.path)
			} catch (error) {
				entry.resume()
				fail(error as Error)
				return
			}
			if (entry.type === "SymbolicLink" || entry.type === "Link") {
				entry.resume()
				fail(new PluginPackError(`Refusing archive with a link entry: "${entry.path}"`))
				return
			}
			if (entry.type !== "File") {
				// Directory / pax headers / etc. — nothing to persist directly.
				entry.resume()
				return
			}
			const chunks: Buffer[] = []
			entry.on("data", (chunk: Buffer) => chunks.push(chunk))
			entry.on("end", () => {
				entries.push({ path: entry.path.replace(/^\.\//, ""), data: Buffer.concat(chunks) })
			})
			entry.on("error", fail)
		})
		parser.on("end", () => {
			if (!failed) resolve(entries)
		})
		parser.on("error", fail)
		parser.end(archive)
	})
}

/**
 * Pack a plugin directory into a `.shofer-plugin` gzip tarball (in-memory `Buffer`).
 * The directory MUST contain a valid `plugin.json` at its root — it is validated
 * before packing so a malformed plugin never ships. Entries are written rooted at
 * the archive top level (no wrapping directory), reproducibly (`portable`).
 */
export async function packPlugin(pluginDir: string): Promise<Buffer> {
	const manifestPath = path.join(pluginDir, PLUGIN_MANIFEST_FILENAME)
	let raw: string
	try {
		raw = await nodeFs.readFile(manifestPath, "utf-8")
	} catch {
		throw new PluginPackError(`No ${PLUGIN_MANIFEST_FILENAME} found in plugin directory: ${pluginDir}`)
	}
	parseManifest(raw, manifestPath)

	const chunks: Buffer[] = []
	await new Promise<void>((resolve, reject) => {
		const stream = tar.create({ gzip: true, cwd: pluginDir, portable: true }, ["."])
		stream.on("data", (chunk: Buffer) => chunks.push(chunk))
		stream.on("end", () => resolve())
		stream.on("error", reject)
	})
	return Buffer.concat(chunks)
}

/** Pack a plugin directory and write the archive to `outFile`. Returns the manifest name/version. */
export async function packPluginToFile(
	pluginDir: string,
	outFile: string,
): Promise<{ name: string; version: string; path: string }> {
	const raw = await nodeFs.readFile(path.join(pluginDir, PLUGIN_MANIFEST_FILENAME), "utf-8").catch(() => {
		throw new PluginPackError(`No ${PLUGIN_MANIFEST_FILENAME} found in plugin directory: ${pluginDir}`)
	})
	const manifest = parseManifest(raw, path.join(pluginDir, PLUGIN_MANIFEST_FILENAME))
	const archive = await packPlugin(pluginDir)
	await nodeFs.mkdir(path.dirname(outFile), { recursive: true })
	await nodeFs.writeFile(outFile, archive)
	return { name: manifest.name, version: manifest.version, path: outFile }
}

/**
 * Unpack a `.shofer-plugin` archive into `destPluginsDir`, installing it as
 * `<destPluginsDir>/<name>` (name taken from the validated manifest). Rejects
 * zip-slip entries, an archive with no/invalid `plugin.json`, and — unless
 * `overwrite` is set — a name that is already installed.
 *
 * @param archive Either the archive bytes (`Buffer`) or a path to a `.shofer-plugin` file.
 */
export async function unpackPlugin(
	archive: Buffer | string,
	destPluginsDir: string,
	options: UnpackOptions = {},
): Promise<InstalledPlugin> {
	const bytes = typeof archive === "string" ? await nodeFs.readFile(archive) : archive
	const entries = await readArchiveEntries(bytes)

	const manifestEntry = entries.find((e) => e.path === PLUGIN_MANIFEST_FILENAME)
	if (!manifestEntry) {
		throw new PluginPackError(`Archive does not contain a root ${PLUGIN_MANIFEST_FILENAME}`)
	}
	const manifest = parseManifest(manifestEntry.data.toString("utf-8"), PLUGIN_MANIFEST_FILENAME)

	const dest = path.join(destPluginsDir, manifest.name)
	await ensureFreeOrOverwrite(dest, manifest.name, options.overwrite)

	for (const entry of entries) {
		// Defense-in-depth: the resolved target must stay within `dest`.
		const target = path.resolve(dest, ...entry.path.split("/"))
		const destPrefix = path.resolve(dest) + path.sep
		if (target !== path.resolve(dest) && !target.startsWith(destPrefix)) {
			throw new PluginPackError(`Refusing archive entry that escapes the plugin directory: "${entry.path}"`)
		}
		await nodeFs.mkdir(path.dirname(target), { recursive: true })
		await nodeFs.writeFile(target, entry.data)
	}

	return { name: manifest.name, version: manifest.version, dir: dest }
}

/**
 * Install a plugin from an on-disk plugin **directory** (copy it into
 * `destPluginsDir/<name>`). Validates the manifest and applies the same
 * name-collision policy as {@link unpackPlugin}. Lets the CLI accept either an
 * archive or an unpacked directory as an install source without a tar round-trip.
 */
export async function installPluginFromDirectory(
	srcDir: string,
	destPluginsDir: string,
	options: UnpackOptions = {},
): Promise<InstalledPlugin> {
	let raw: string
	try {
		raw = await nodeFs.readFile(path.join(srcDir, PLUGIN_MANIFEST_FILENAME), "utf-8")
	} catch {
		throw new PluginPackError(`No ${PLUGIN_MANIFEST_FILENAME} found in plugin directory: ${srcDir}`)
	}
	const manifest = parseManifest(raw, path.join(srcDir, PLUGIN_MANIFEST_FILENAME))

	const dest = path.join(destPluginsDir, manifest.name)
	await ensureFreeOrOverwrite(dest, manifest.name, options.overwrite)

	await nodeFs.mkdir(path.dirname(dest), { recursive: true })
	await nodeFs.cp(srcDir, dest, { recursive: true })
	return { name: manifest.name, version: manifest.version, dir: dest }
}

/**
 * Install a plugin from an arbitrary source path — either a `.shofer-plugin` archive
 * file or an unpacked plugin directory (the shape `shofer plugin install <path>`
 * accepts). Dispatches to {@link unpackPlugin} or {@link installPluginFromDirectory}.
 */
export async function installPlugin(
	source: string,
	destPluginsDir: string,
	options: UnpackOptions = {},
): Promise<InstalledPlugin> {
	const stat = await nodeFs.stat(source).catch(() => {
		throw new PluginPackError(`Install source not found: ${source}`)
	})
	if (stat.isDirectory()) {
		return installPluginFromDirectory(source, destPluginsDir, options)
	}
	return unpackPlugin(source, destPluginsDir, options)
}

/** Throw if `dest` already exists and `overwrite` is not set; otherwise clear it. */
async function ensureFreeOrOverwrite(dest: string, name: string, overwrite: boolean | undefined): Promise<void> {
	const exists = await nodeFs
		.access(dest)
		.then(() => true)
		.catch(() => false)
	if (exists) {
		if (!overwrite) {
			throw new PluginPackError(
				`A plugin named "${name}" is already installed at ${dest}. Pass overwrite to replace it.`,
			)
		}
		await nodeFs.rm(dest, { recursive: true, force: true })
	}
}
