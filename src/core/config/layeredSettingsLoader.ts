import fs from "fs/promises"
import * as path from "path"

import { globalSettingsSchema } from "@shofer/types"
import {
	EMPTY_LOCKED_MANIFEST,
	mergeLayeredConfig,
	parseLockedManifest,
	type LayeredSettings,
	type LockedManifest,
} from "@shofer/core"

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
 * It is deliberately **additive and read-only**: a scope with no
 * `.shofer/settings.json` contributes an empty layer, so when no files exist
 * anywhere the merged overlay is `{}` and `ContextProxy.getValue` falls back to
 * `globalState` exactly as before. Writes are NOT handled here — they still go
 * through `globalState`/`setValue` (Part E4/UI owns file writes).
 */

/** The `.shofer/` sub-directory name that holds a scope's config files. */
const SHOFER_DIR = ".shofer"

/** The per-scope settings filename inside `.shofer/`. */
const SETTINGS_FILE = "settings.json"

/** The global-scope-only lock manifest filename inside `.shofer/`. */
const LOCKED_FILE = "locked.json"

/**
 * The three resolved scope-root directories (each the `.shofer/` dir itself,
 * i.e. the directory that directly contains `settings.json`). Any root may be
 * `undefined` — an unresolved/absent scope contributes an empty layer.
 */
export interface ScopeRoots {
	/** Org-global scope (read-only; also the sole `locked.json` authority). */
	global?: string
	/** Per-user scope (`~/.shofer/`). */
	user?: string
	/** Project scope (`<workspace>/.shofer/`). */
	project?: string
}

/** The base inputs from which the scope roots are derived. */
export interface ScopeRootInputs {
	/** `context.globalStorageUri.fsPath` — the standalone global-scope default. */
	globalStorageFsPath?: string
	/** `os.homedir()` — the base of the user scope. */
	homeDir?: string
	/** The first workspace folder path, if any — the base of the project scope. */
	workspaceFolder?: string
}

/**
 * Resolve the three `.shofer/` scope roots from the host's base paths, honoring
 * the doc's rules (Part E1/E6):
 *   - **global** = env `SHOFER_GLOBAL_DIR` if set (it IS the scope's `.shofer/`
 *     dir — a RO ConfigMap mount in SaaS), else `<globalStorage>/.shofer`.
 *   - **user** = `<homeDir>/.shofer`.
 *   - **project** = `<workspaceFolder>/.shofer`, only when a workspace is open.
 */
export function resolveScopeRoots(inputs: ScopeRootInputs): ScopeRoots {
	const globalDirEnv = process.env.SHOFER_GLOBAL_DIR
	const global = globalDirEnv
		? globalDirEnv
		: inputs.globalStorageFsPath
			? path.join(inputs.globalStorageFsPath, SHOFER_DIR)
			: undefined

	const user = inputs.homeDir ? path.join(inputs.homeDir, SHOFER_DIR) : undefined
	const project = inputs.workspaceFolder ? path.join(inputs.workspaceFolder, SHOFER_DIR) : undefined

	return { global, user, project }
}

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
 * Read and parse the global scope's `locked.json`, failing closed to
 * {@link EMPTY_LOCKED_MANIFEST} (nothing locked) on any error. Only the global
 * scope's manifest is honored — user/project `locked.json` is never read.
 */
async function readLockedManifest(globalRoot: string | undefined): Promise<LockedManifest> {
	if (!globalRoot) {
		return EMPTY_LOCKED_MANIFEST
	}

	try {
		const raw = await fs.readFile(path.join(globalRoot, LOCKED_FILE), "utf8")
		return parseLockedManifest(JSON.parse(raw))
	} catch {
		return EMPTY_LOCKED_MANIFEST
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
		readLockedManifest(roots.global),
	])

	return mergeLayeredConfig({ global, user, project }, manifest)
}
