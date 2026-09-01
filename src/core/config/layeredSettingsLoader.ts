import fs from "fs/promises"
import * as path from "path"

import {
	EMPTY_LOCKED_MANIFEST,
	isPathLocked,
	loadLayeredOverlay,
	loadLockedManifestFromDisk,
	readScopeSettingsFile,
	resolveScopeRoots,
	type LockedManifest,
	type ScopeRootInputs,
	type ScopeRoots,
} from "@shofer/core"

// Scope-root resolution, the locked-manifest read, and the scope-file READ path
// all live in `@shofer/core` — shared with the portable services (McpHub) and with
// the CLI host, which must resolve the same overlay before it seeds a served node's
// approval posture. Re-exported here so the host-side config modules keep one
// import site.
export { loadLayeredOverlay, readScopeSettingsFile, resolveScopeRoots, type ScopeRootInputs, type ScopeRoots }

/**
 * layeredSettingsLoader — the **host-side WRITE** half of the layered `.shofer/`
 * configuration overlay (todos/config-cleanup.md Part E3).
 *
 * The read path — resolving the three scope roots, parsing each scope's
 * `settings.json` **Schema-First / fail-closed**, and merging them under the global
 * scope's `locked.json` — lives entirely in `@shofer/core`
 * (`config/layered-settings-file.ts`, `config/scope-roots.ts`,
 * `config/layered-config.ts`) and is re-exported above, because the CLI host needs
 * the identical answer. This module supplies what only a writing host needs.
 *
 * The read path is deliberately **additive**: a scope with no
 * `.shofer/settings.json` contributes an empty layer, so when no files exist
 * anywhere the merged overlay is `{}` and `ContextProxy.getValue` falls back to
 * `globalState` exactly as before.
 *
 * The **write** side ({@link writeScopeSetting}) merges a single globalSettings
 * key into a scope's `settings.json` (default: the writable **user** scope) with
 * an atomic, key-order-stable JSON write, creating the file on first use — the
 * file layer is the source of truth, `globalState` only the runtime cache.
 * {@link seedScopeSettingsFile} performs the one-time create-only migration of
 * pre-file `globalState` values. A key the global scope's `locked.json` locks is
 * **not** persisted — the read overlay already makes the global value win, so
 * persisting a shadowed user value would only mislead; the writer skips it and
 * reports `locked: true`. Concurrent writes to the same file are serialized
 * through an in-process lock so a bulk `setValues` cannot lose keys to a
 * read-modify-write race.
 */

/** The per-scope settings filename inside `.shofer/`. */
const SETTINGS_FILE = "settings.json"

/**
 * Read the global scope's `locked.json` (the sole lock authority). Exposed so
 * the writer can consult it before persisting a key. Fails closed to
 * {@link EMPTY_LOCKED_MANIFEST}.
 */
export function loadLockedManifest(globalRoot: string | undefined): Promise<LockedManifest> {
	return loadLockedManifestFromDisk(globalRoot)
}

/**
 * Create-only bulk seed of a scope's `settings.json` (Decision 3 of
 * todos/done/config-cleanup.md): writes every given key at once, atomically and
 * key-order-stable, and refuses to touch an existing file — the one-time
 * migration of `globalState`-resident values into the file layer must never
 * clobber a settings file that already exists.
 *
 * @returns true when the file was created; false when one already existed.
 */
export async function seedScopeSettingsFile(root: string, values: Record<string, unknown>): Promise<boolean> {
	const filePath = path.join(root, SETTINGS_FILE)

	return withFileLock(filePath, async () => {
		try {
			await fs.access(filePath)
			return false // already materialized — never overwrite
		} catch {
			// absent — proceed
		}

		const sorted: Record<string, unknown> = {}
		for (const key of Object.keys(values).sort()) {
			sorted[key] = cloneValue(values[key])
		}

		await fs.mkdir(root, { recursive: true })
		const tmpPath = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
		await fs.writeFile(tmpPath, `${JSON.stringify(sorted, null, 2)}\n`, "utf8")
		await fs.rename(tmpPath, filePath)
		return true
	})
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
