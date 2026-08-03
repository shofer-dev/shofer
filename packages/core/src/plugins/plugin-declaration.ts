import * as nodeFs from "fs/promises"
import * as path from "path"

import { pluginManifestSchema } from "@shofer/types"
import { z } from "zod"

import { EMPTY_LOCKED_MANIFEST, isPathLocked, type LockedManifest } from "../config/layered-config.js"
import { fetchPluginArchive, isPluginUrl, unpackPlugin } from "./plugin-pack.js"

/**
 * plugin-declaration — the `.shofer/plugins.json` *declaration* of which plugins a
 * scope wants, from where, and at which version — plus the resolver that
 * materializes each declared `source@version` into a content-addressed cache dir
 * (todos/config-cleanup.md Part F: "plugins as `.shofer/` declarations — declare,
 * don't vendor").
 *
 * The gap Part F fills: plugin *code* is already `.shofer/`-hosted and plugin
 * *config* already flows through `.shofer/settings.json`, but there was no
 * **declaration** of the plugin set/source/version — a plugin was just an
 * installed directory with its own `plugin.json`. This module is that declaration
 * layer:
 *
 *   1. {@link pluginDeclarationSchema} — the on-disk `.shofer/plugins.json` shape
 *      (Zod, versioned, fail-closed), parsed via {@link parsePluginDeclaration}.
 *   2. {@link mergePluginDeclarations} — the pure three-scope cross-merge, reusing
 *      the same locked-vs-default engine as `layered-config` (a plugin whose
 *      `plugins/<name>` path is org-locked has the global scope's entry win and be
 *      final; unlocked entries follow more-specific-wins, `project > user > global`).
 *   3. {@link resolvePluginDeclaration} — the resolver/installer: it materializes
 *      each declared `source@version` into `<cacheBaseDir>/<name>@<version>/` (the
 *      **bytes are never committed to `.shofer/`** — only the declaration is), so
 *      `.shofer/` stays text-only, reproducible, and zip/overlay-able.
 *
 * This module is **standalone**: it is NOT yet wired into `ShoferProvider` /
 * `PluginManager` (that is the next pass). The host will consume
 * {@link resolvePluginDeclaration}'s output to seed `pluginDirs` /
 * `pluginConfigs` / enablement. Node-only (uses `node:fs`/`node:path` and the
 * `unpackPlugin` archive path, like `plugin-pack.ts`) — it imports no `vscode`.
 */

/**
 * Current on-disk version of `.shofer/plugins.json`. Bump when the declaration
 * shape changes; a mismatched version is discarded (Versioned Snapshot Rule).
 */
export const PLUGIN_DECLARATION_VERSION = 1

/**
 * One plugin's declaration entry (Schema-First Persistence Rule). `source` is a
 * local directory path, a local `.shofer-plugin` archive path, or an **http(s)
 * URL** to such an archive. A content-addressed URL
 * (`.../sha256-<hex>.shofer-plugin`) additionally pins the bytes: the resolver
 * verifies the digest and refuses a mismatch. `version` is the author-declared version the resolver
 * materializes under. `config` is the user's config overrides for the plugin
 * (merged with manifest defaults downstream); `enabled` defaults to `true`.
 */
export const pluginDeclarationEntrySchema = z
	.object({
		source: z.string().min(1),
		version: z.string().min(1),
		config: z.record(z.string(), z.unknown()).optional(),
		enabled: z.boolean().optional(),
	})
	.strict()

export type PluginDeclarationEntry = z.infer<typeof pluginDeclarationEntrySchema>

/**
 * Schema for `.shofer/plugins.json` (design Part F). Validated fail-closed: unknown
 * keys are rejected and a mismatched `version` is discarded on load. `plugins` maps
 * a plugin **name** to its {@link PluginDeclarationEntry}.
 */
export const pluginDeclarationSchema = z
	.object({
		version: z.literal(PLUGIN_DECLARATION_VERSION),
		plugins: z.record(z.string(), pluginDeclarationEntrySchema),
	})
	.strict()

export type PluginDeclaration = z.infer<typeof pluginDeclarationSchema>

/** An empty declaration — nothing declared. Returned when parsing fails closed. */
export const EMPTY_PLUGIN_DECLARATION: PluginDeclaration = { version: PLUGIN_DECLARATION_VERSION, plugins: {} }

/**
 * Parse raw `.shofer/plugins.json` content into a {@link PluginDeclaration}, failing
 * closed (Schema-First Persistence Rule + Versioned Snapshot Rule): corrupt JSON, a
 * shape mismatch, or a version mismatch all yield {@link EMPTY_PLUGIN_DECLARATION}
 * rather than throwing. Accepts either the raw file **string** (JSON-parsed here) or
 * an already-parsed object.
 */
export function parsePluginDeclaration(raw: unknown): PluginDeclaration {
	let json: unknown = raw
	if (typeof raw === "string") {
		try {
			json = JSON.parse(raw)
		} catch {
			return EMPTY_PLUGIN_DECLARATION
		}
	}
	const result = pluginDeclarationSchema.safeParse(json)
	return result.success ? result.data : EMPTY_PLUGIN_DECLARATION
}

/** The three scope layers of `.shofer/plugins.json`, least- to most-specific. */
export interface PluginDeclarationLayers {
	/** Org-global scope (read-only; the sole lock authority via `locked.json`). */
	global?: PluginDeclaration
	/** Per-user scope (`~/.shofer/`), overrides global when unlocked. */
	user?: PluginDeclaration
	/** Project scope (`<workspace>/.shofer/`), most specific, wins when unlocked. */
	project?: PluginDeclaration
}

/**
 * Cross-merge the three scopes' plugin declarations, per plugin name, under the same
 * locked-vs-default rule as `layered-config` (todos/config-cleanup.md Part E/F). For
 * each declared name:
 *
 *   - **Locked** (`plugins/<name>` in the global scope's `locked.json`) **and** the
 *     global scope declares it → the **global** entry wins and is final; user/project
 *     entries for that name are dropped. "These plugins, these versions — non-negotiable."
 *   - **Unlocked** (or global does not declare it) → more-specific wins:
 *     `project ?? user ?? global` (whole-entry replacement).
 *   - A user/project may always **add** plugins the global scope did not declare —
 *     locking a name global never set is meaningless and falls back to the unlocked merge.
 *
 * Pure and non-mutating: inputs are untouched, the result is a fresh
 * {@link PluginDeclaration}. Reuses {@link isPathLocked} from `layered-config` — the
 * lock predicate is not re-implemented here.
 */
export function mergePluginDeclarations(
	layers: PluginDeclarationLayers,
	manifest: LockedManifest = EMPTY_LOCKED_MANIFEST,
): PluginDeclaration {
	const globalPlugins = layers.global?.plugins ?? {}
	const userPlugins = layers.user?.plugins ?? {}
	const projectPlugins = layers.project?.plugins ?? {}

	const names = new Set<string>([
		...Object.keys(globalPlugins),
		...Object.keys(userPlugins),
		...Object.keys(projectPlugins),
	])

	const merged: Record<string, PluginDeclarationEntry> = {}
	for (const name of names) {
		const globalEntry = globalPlugins[name]
		if (globalEntry !== undefined && isPathLocked(`plugins/${name}`, manifest)) {
			// Org-locked and defined by global → global wins, final.
			merged[name] = globalEntry
			continue
		}
		// Unlocked (or not declared by global) → more-specific wins.
		const winner = projectPlugins[name] ?? userPlugins[name] ?? globalEntry
		if (winner !== undefined) merged[name] = winner
	}

	return { version: PLUGIN_DECLARATION_VERSION, plugins: merged }
}

/**
 * A declared plugin materialized into the cache and validated — the shape the host
 * adds to `pluginDirs` and uses to seed `pluginConfigs` / enablement (the wiring is
 * a later pass).
 */
export interface ResolvedPlugin {
	/** The plugin name (declaration key; also the validated manifest `name`). */
	name: string
	/** Absolute cache directory the plugin was materialized into (`<cacheBaseDir>/<name>@<version>`). */
	dir: string
	/** The declared version the plugin was materialized under. */
	version: string
	/** The user's config overrides for this plugin, if any (from the declaration entry). */
	config?: Record<string, unknown>
	/** Whether the plugin is enabled (declaration `enabled`, defaulting to `true`). */
	enabled: boolean
}

/** A per-plugin resolution failure that did not abort the batch (name/manifest mismatch). */
export interface PluginResolveWarning {
	/** The declaration name that failed to resolve. */
	name: string
	/** Why it was skipped (missing/invalid manifest, or a name mismatch). */
	message: string
}

/** The result of {@link resolvePluginDeclaration}: the resolved plugins plus per-plugin skips. */
export interface ResolvePluginsResult {
	/** Plugins that materialized and validated — safe for the host to consume. */
	resolved: ResolvedPlugin[]
	/** Plugins skipped with a non-fatal error (the batch still returns the rest). */
	errors: PluginResolveWarning[]
}

/**
 * Thrown when a declared source cannot be materialized at all — a missing local
 * path, an unreachable URL, or an archive whose bytes do not match the digest a
 * content-addressed URL pins. A distinct class so a caller can present it as a
 * user error rather than a crash. This is a **hard** failure (it rejects the
 * whole batch), unlike a per-plugin manifest mismatch which is skipped softly:
 * a source that will not materialize is a broken declaration, and a digest
 * mismatch specifically may be a swapped artifact.
 */
export class PluginResolveError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "PluginResolveError"
	}
}

const MANIFEST_FILENAME = "plugin.json"

/** Whether a path exists on disk. */
async function pathExists(target: string): Promise<boolean> {
	try {
		await nodeFs.access(target)
		return true
	} catch {
		return false
	}
}

/**
 * Unpack archive bytes (or a local archive path) into the versioned `cacheDir`.
 *
 * {@link unpackPlugin} installs as `<dest>/<manifestName>`, so it runs against a
 * scratch staging dir which is then renamed onto `cacheDir` — that is what makes
 * the final directory `<cacheBaseDir>/<name>@<version>` regardless of what the
 * manifest calls itself.
 */
async function unpackIntoCacheDir(archive: Buffer | string, cacheDir: string): Promise<void> {
	const staging = `${cacheDir}.staging-${Date.now()}-${Math.random().toString(36).slice(2)}`
	try {
		const installed = await unpackPlugin(archive, staging)
		await nodeFs.rename(installed.dir, cacheDir)
	} finally {
		await nodeFs.rm(staging, { recursive: true, force: true }).catch(() => {})
	}
}

/**
 * Materialize one declared `source` into `cacheDir` (idempotency is the caller's
 * responsibility — it is only invoked when `cacheDir` has no manifest yet).
 *
 * Three source kinds: a **directory** is copied tree-wise; a local
 * **`.shofer-plugin` archive** is unpacked; an **http(s) URL** is downloaded and
 * then unpacked through the very same path, so the archive hardening (manifest
 * validation, zip-slip, link entries) applies identically no matter where the
 * bytes came from. A content-addressed URL additionally pins the bytes by digest
 * — {@link fetchPluginArchive} refuses a mismatch, so a URL that starts serving
 * different code fails the load rather than silently swapping it.
 */
async function materializeSource(source: string, cacheDir: string): Promise<void> {
	if (isPluginUrl(source)) {
		// Fetch BEFORE clearing the target: a failed download must not destroy an
		// existing materialization.
		const bytes = await fetchPluginArchive(source).catch((error) => {
			throw new PluginResolveError(
				`Cannot resolve plugin from "${source}": ${error instanceof Error ? error.message : String(error)}`,
			)
		})
		await nodeFs.rm(cacheDir, { recursive: true, force: true })
		await nodeFs.mkdir(path.dirname(cacheDir), { recursive: true })
		await unpackIntoCacheDir(bytes, cacheDir)
		return
	}

	const stat = await nodeFs.stat(source).catch(() => {
		throw new PluginResolveError(`Plugin source not found: ${source}`)
	})

	// Start from a clean target so a partial prior materialization cannot leak in.
	await nodeFs.rm(cacheDir, { recursive: true, force: true })
	await nodeFs.mkdir(path.dirname(cacheDir), { recursive: true })

	if (stat.isDirectory()) {
		await nodeFs.cp(source, cacheDir, { recursive: true })
		return
	}

	await unpackIntoCacheDir(source, cacheDir)
}

/**
 * Resolve a merged {@link PluginDeclaration} into installed, validated plugins under
 * `cacheBaseDir` (design Part F resolver/installer). For each declared plugin:
 *
 *   - Materialize `source@version` into `<cacheBaseDir>/<name>@<version>/`,
 *     **idempotently**: if that dir already has a `plugin.json` it is reused as-is
 *     (no re-copy/re-unpack).
 *   - **Local directory** source → copied; **local `.shofer-plugin` archive** →
 *     unpacked; **http(s) URL** → downloaded (https-only unless loopback,
 *     size-capped) and unpacked through the same hardened path. A
 *     content-addressed URL (`.../sha256-<hex>.shofer-plugin`) is verified
 *     against that digest and a mismatch is refused.
 *   - A source that cannot be materialized at all — missing path, unreachable
 *     URL, digest mismatch — raises {@link PluginResolveError}, a hard failure
 *     that rejects the whole batch.
 *   - The materialized dir's `plugin.json` is validated against
 *     {@link pluginManifestSchema} and its `name` checked against the declaration key;
 *     a missing/invalid manifest or a name mismatch **skips that one plugin** with a
 *     {@link PluginResolveWarning} (the batch still returns the rest).
 *
 * Returns the resolved plugins for the host to consume — this pass does NOT itself wire
 * them into `pluginDirs`/`pluginConfigs`/enablement.
 */
export async function resolvePluginDeclaration(
	decl: PluginDeclaration,
	cacheBaseDir: string,
): Promise<ResolvePluginsResult> {
	const resolved: ResolvedPlugin[] = []
	const errors: PluginResolveWarning[] = []

	for (const [name, entry] of Object.entries(decl.plugins)) {
		const cacheDir = path.join(cacheBaseDir, `${name}@${entry.version}`)
		const manifestPath = path.join(cacheDir, MANIFEST_FILENAME)

		// Idempotent: an already-materialized cache dir (manifest present) is reused.
		if (!(await pathExists(manifestPath))) {
			await materializeSource(entry.source, cacheDir)
		}

		let manifestRaw: string
		try {
			manifestRaw = await nodeFs.readFile(manifestPath, "utf-8")
		} catch {
			errors.push({ name, message: `materialized plugin has no ${MANIFEST_FILENAME} at ${cacheDir}` })
			continue
		}

		let manifestJson: unknown
		try {
			manifestJson = JSON.parse(manifestRaw)
		} catch (error) {
			errors.push({ name, message: `invalid JSON in ${manifestPath}: ${String(error)}` })
			continue
		}

		const parsed = pluginManifestSchema.safeParse(manifestJson)
		if (!parsed.success) {
			const issues = parsed.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ")
			errors.push({ name, message: `invalid manifest in ${manifestPath}: ${issues}` })
			continue
		}

		if (parsed.data.name !== name) {
			errors.push({
				name,
				message: `manifest name "${parsed.data.name}" does not match declared name "${name}"`,
			})
			continue
		}

		resolved.push({
			name,
			dir: cacheDir,
			version: entry.version,
			config: entry.config,
			enabled: entry.enabled ?? true,
		})
	}

	return { resolved, errors }
}
