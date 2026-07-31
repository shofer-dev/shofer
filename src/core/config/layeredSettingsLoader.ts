import fs from "fs/promises"
import * as path from "path"

import { globalSettingsSchema } from "@shofer/types"
import {
	EMPTY_LOCKED_MANIFEST,
	isPathLocked,
	loadLockedManifestFromDisk,
	mergeLayeredConfig,
	resolveScopeRoots,
	type LayeredSettings,
	type LockedManifest,
	type ScopeRootInputs,
	type ScopeRoots,
} from "@shofer/core"

// Scope-root resolution and the locked-manifest read live in `@shofer/core`
// (shared with the portable services, e.g. McpHub); re-exported here so the
// host-side config modules keep one import site.
export { resolveScopeRoots, type ScopeRootInputs, type ScopeRoots }

/**
 * layeredSettingsLoader — the **host-side** (filesystem) half of the layered
 * `.shofer/` configuration overlay (todos/config-cleanup.md Part E3).
 *
 * The pure merge engine ({@link mergeLayeredConfig}) lives in `@shofer/core` and
 * knows nothing about disk or scope roots. This module supplies the missing
 * host concerns: resolving the three scope roots, reading each scope's
 * `settings.json` (and the global scope's `locked.json`), parsing them
 * **Schema-First / fail-closed**, and handing the parsed layers to the engine.
 *
 * The read path is deliberately **additive**: a scope with no
 * `.shofer/settings.json` contributes an empty layer, so when no files exist
 * anywhere the merged overlay is `{}` and `ContextProxy.getValue` falls back to
 * `globalState` exactly as before.
 *
 * Part E4 adds the **write** side ({@link writeScopeSetting}): a single
 * globalSettings key is merged into a scope's `settings.json` (default: the
 * writable **user** scope) with an atomic, key-order-stable JSON write, so the
 * file layer becomes authoritative on the next {@link loadLayeredOverlay}. A key
 * the global scope's `locked.json` locks is **not** persisted — the read overlay
 * already makes the global value win, so persisting a shadowed user value would
 * only mislead; the writer skips it and reports `locked: true`. Concurrent writes
 * to the same file are serialized through an in-process lock so a bulk
 * `setValues` cannot lose keys to a read-modify-write race.
 */

/** The per-scope settings filename inside `.shofer/`. */
const SETTINGS_FILE = "settings.json"

/**
 * Read and parse one scope's `settings.json`, failing closed: a missing file,
 * unreadable path, malformed JSON, or schema-invalid content all yield `{}`
 * (Schema-First Persistence Rule). Unknown/extra keys are stripped by the
 * partial schema rather than aborting the whole scope.
 */
async function readScopeSettings(root: string | undefined): Promise<LayeredSettings> {
	if (!root) {
		return {}
	}

	let raw: string
	try {
		raw = await fs.readFile(path.join(root, SETTINGS_FILE), "utf8")
	} catch {
		return {}
	}

	try {
		const parsed = globalSettingsSchema.partial().safeParse(JSON.parse(raw))
		return parsed.success ? (parsed.data as LayeredSettings) : {}
	} catch {
		return {}
	}
}

/**
 * Load the merged layered overlay from disk for the given scope roots. Returns
 * the effective `.shofer/settings.json` overlay (a partial `ShoferSettings`);
 * `{}` when no scope has a readable settings file.
 */
export async function loadLayeredOverlay(roots: ScopeRoots): Promise<LayeredSettings> {
	const [global, user, project, manifest] = await Promise.all([
		readScopeSettings(roots.global),
		readScopeSettings(roots.user),
		readScopeSettings(roots.project),
		loadLockedManifestFromDisk(roots.global),
	])

	return mergeLayeredConfig({ global, user, project }, manifest)
}

/**
 * Read the global scope's `locked.json` (the sole lock authority). Exposed so
 * the writer can consult it before persisting a key. Fails closed to
 * {@link EMPTY_LOCKED_MANIFEST}.
 */
export function loadLockedManifest(globalRoot: string | undefined): Promise<LockedManifest> {
	return loadLockedManifestFromDisk(globalRoot)
}

/**
 * True when a scope's `.shofer/settings.json` already exists on disk. The
 * write-through in `ContextProxy.setValue` is gated on this so the layered file
 * path is **strictly opt-in**: until a scope has been materialized (by an
 * import/unzip, or a future migration seed), `setValue` stays byte-for-byte the
 * old `globalState`-only behavior and never creates a file under `~/.shofer` on
 * its own — which also keeps it inert (no real-home writes) in every unit test
 * that does not isolate `$HOME`.
 */
export async function scopeSettingsFileExists(root: string | undefined): Promise<boolean> {
	if (!root) {
		return false
	}
	try {
		await fs.access(path.join(root, SETTINGS_FILE))
		return true
	} catch {
		return false
	}
}

/**
 * In-process per-file write chains. A read-modify-write of `settings.json` is not
 * atomic across the read and the rename, so two concurrent {@link writeScopeSetting}
 * calls (e.g. from a `Promise.all` in `ContextProxy.setValues`) would both read the
 * old file and the later rename would drop the earlier key. Serializing per
 * absolute file path closes that window without a cross-process lock (a single
 * host owns its `~/.shofer`).
 */
const writeChains = new Map<string, Promise<unknown>>()

function withFileLock<T>(filePath: string, task: () => Promise<T>): Promise<T> {
	const prev = writeChains.get(filePath) ?? Promise.resolve()
	const run = prev.then(task, task)
	// Keep the chain alive but never let a rejection poison the next writer.
	writeChains.set(
		filePath,
		run.then(
			() => undefined,
			() => undefined,
		),
	)
	return run
}

/** Outcome of a {@link writeScopeSetting} call. */
export interface WriteScopeSettingResult {
	/** Whether the key was persisted to the file (false only when `locked`). */
	persisted: boolean
	/** True when the key is locked by the global scope, so the write was skipped. */
	locked: boolean
}

/** Deep-ish clone via structuredClone with a JSON fallback, so callers never share refs. */
function cloneValue(value: unknown): unknown {
	if (value === undefined) {
		return undefined
	}
	try {
		return structuredClone(value)
	} catch {
		return JSON.parse(JSON.stringify(value))
	}
}

/**
 * Merge a single settings `key` into `root/settings.json`, creating the directory
 * and file if missing. `value === undefined` removes the key. The write is atomic
 * (temp file + rename) and key-order-stable (keys sorted) so diffs stay small.
 *
 * If `key` is locked by `manifest` (the global scope's `locked.json`), nothing is
 * written — the read overlay makes the global value final regardless, so a user
 * file entry would be dead weight that misrepresents the effective value.
 *
 * Only keys accepted by `globalSettingsSchema` survive a subsequent read; the
 * caller is expected to pass a valid globalSettings key, but no schema pruning is
 * done here beyond preserving whatever is already in the file.
 */
export async function writeScopeSetting(
	root: string,
	key: string,
	value: unknown,
	manifest: LockedManifest = EMPTY_LOCKED_MANIFEST,
): Promise<WriteScopeSettingResult> {
	if (isPathLocked(key, manifest)) {
		return { persisted: false, locked: true }
	}

	const filePath = path.join(root, SETTINGS_FILE)

	return withFileLock(filePath, async () => {
		let current: Record<string, unknown> = {}
		try {
			const raw = await fs.readFile(filePath, "utf8")
			const parsed = JSON.parse(raw)
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				current = parsed as Record<string, unknown>
			}
		} catch {
			current = {}
		}

		if (value === undefined) {
			delete current[key]
		} else {
			current[key] = cloneValue(value)
		}

		const sorted: Record<string, unknown> = {}
		for (const k of Object.keys(current).sort()) {
			sorted[k] = current[k]
		}

		await fs.mkdir(root, { recursive: true })
		const tmpPath = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
		await fs.writeFile(tmpPath, `${JSON.stringify(sorted, null, 2)}\n`, "utf8")
		await fs.rename(tmpPath, filePath)

		return { persisted: true, locked: false }
	})
}
