import fs from "fs/promises"
import * as path from "path"

import { globalSettingsSchema } from "@shofer/types"

import {
	mergeLayeredConfig,
	type LayeredConfigInput,
	type LayeredSettings,
	type LockedManifest,
} from "./layered-config.js"
import { loadLockedManifestFromDisk, type ScopeRoots } from "./scope-roots.js"

/**
 * layered-settings-file — the disk half of the three-scope `.shofer/settings.json`
 * overlay: read each scope's file, parse it fail-closed, and hand the parsed layers
 * to the pure merge engine ({@link mergeLayeredConfig}).
 *
 * This lives in `@shofer/core` rather than in the VS Code host because **two hosts
 * need the same answer**: the extension host (`ContextProxy`, which serves the
 * overlay to every `getValue`) and the CLI host (`shofer serve`, which must know
 * which settings its node's own configuration already decides before it seeds any
 * default of its own). A second copy would drift on the one thing that must never
 * drift — what a scope file says. No `vscode` import; pure fs + path + zod.
 *
 * The read path is deliberately **additive**: a scope with no `settings.json`
 * contributes an empty layer, so when no files exist anywhere the merged overlay is
 * `{}` and every consumer falls back to whatever it did before the overlay existed.
 */

/** The per-scope settings filename inside a `.shofer/` scope root. */
export const SCOPE_SETTINGS_FILE = "settings.json"

/**
 * Read and parse one scope's `settings.json`, failing closed: a missing file,
 * unreadable path, malformed JSON, or schema-invalid content all yield `{}`
 * (Schema-First Persistence Rule). Unknown/extra keys are stripped by the partial
 * schema rather than aborting the whole scope.
 */
export async function readScopeSettingsFile(root: string | undefined): Promise<LayeredSettings> {
	if (!root) {
		return {}
	}

	let raw: string
	try {
		raw = await fs.readFile(path.join(root, SCOPE_SETTINGS_FILE), "utf8")
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
 * Read the three scopes' `settings.json` files (plus the global scope's
 * `locked.json`) and return them **unmerged**.
 *
 * Callers that only want the effective value use {@link loadLayeredOverlay}. This
 * variant exists for callers that must distinguish *which* scope declared a key —
 * e.g. reporting the provenance of a node's approval posture — because the merged
 * result cannot answer that.
 */
export async function loadLayeredScopes(
	roots: ScopeRoots,
): Promise<{ scopes: LayeredConfigInput; manifest: LockedManifest }> {
	const [global, user, project, manifest] = await Promise.all([
		readScopeSettingsFile(roots.global),
		readScopeSettingsFile(roots.user),
		readScopeSettingsFile(roots.project),
		loadLockedManifestFromDisk(roots.global),
	])

	return { scopes: { global, user, project }, manifest }
}

/**
 * Load the merged layered overlay from disk for the given scope roots. Returns the
 * effective `.shofer/settings.json` overlay (a partial `ShoferSettings`); `{}` when
 * no scope has a readable settings file.
 */
export async function loadLayeredOverlay(roots: ScopeRoots): Promise<LayeredSettings> {
	const { scopes, manifest } = await loadLayeredScopes(roots)
	return mergeLayeredConfig(scopes, manifest)
}
