import * as path from "path"
import fs from "fs/promises"

import { EMPTY_LOCKED_MANIFEST, parseLockedManifest, type LockedManifest } from "./layered-config.js"

/**
 * scope-roots — resolution of the three `.shofer/` configuration scope roots,
 * shared by every subsystem that reads a per-scope file (layered settings,
 * modes, MCP servers, plugin/worker declarations).
 *
 * Lives in `@shofer/core` because both the VS Code host (`src/core/config`) and
 * the portable services (`McpHub`) need it; a second copy would drift on the one
 * thing that must never drift — where each scope lives. Pure path/env logic plus
 * one fail-closed disk read; no `vscode` import.
 */

/** The `.shofer/` sub-directory name that holds a scope's config files. */
export const SHOFER_DIR = ".shofer"

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
 * Resolve the three `.shofer/` scope roots from the host's base paths:
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
 * The host-registered global-storage base path — the standalone default for the
 * org-global scope. Pure helpers deep inside core (command/skill/rule loaders)
 * have no extension context to derive it from, so the host registers it once at
 * activation and {@link getOrgShoferDirectory} folds it in. Never consulted when
 * `SHOFER_GLOBAL_DIR` is set (the SaaS mount always wins).
 */
let registeredGlobalStorageFsPath: string | undefined

/** Register the host's global-storage base path (called once at activation). */
export function registerGlobalStorageFsPath(fsPath: string): void {
	registeredGlobalStorageFsPath = fsPath
}

/**
 * The org-global scope's `.shofer/` directory for consumers without a context
 * of their own: env `SHOFER_GLOBAL_DIR` if set, else the registered global
 * storage's `.shofer/`, else `undefined` (no org scope).
 */
export function getOrgShoferDirectory(): string | undefined {
	const globalDirEnv = process.env.SHOFER_GLOBAL_DIR
	if (globalDirEnv) {
		return globalDirEnv
	}
	return registeredGlobalStorageFsPath ? path.join(registeredGlobalStorageFsPath, SHOFER_DIR) : undefined
}

/**
 * Read and parse the global scope's `locked.json`, failing closed to
 * {@link EMPTY_LOCKED_MANIFEST} (nothing locked) on any error. Only the global
 * scope's manifest is honored — a user/project `locked.json` is never read.
 */
export async function loadLockedManifestFromDisk(globalRoot: string | undefined): Promise<LockedManifest> {
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
