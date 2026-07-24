import { z } from "zod"

import type { ShoferSettings } from "@shofer/types"

/**
 * layered-config — the pure merge engine for Shofer's three-scope `.shofer/`
 * configuration overlay (todos/config-cleanup.md Part E1/E2).
 *
 * This module is **standalone and host-agnostic**: it imports no `vscode`, no
 * `ContextProxy`, and touches no filesystem. It takes three already-parsed
 * settings objects — one per scope (`global`, `user`, `project`) — plus the
 * global scope's `locked.json` manifest, and computes the *effective* config by
 * applying the doc's per-key / per-entity **locked-vs-default** rule:
 *
 *   - **Locked** key/entity → the **global** value wins and is final;
 *     user/project contributions to that exact key/entity are dropped. (This
 *     inverts Shofer's usual "project overrides global" for locked entries.)
 *   - **Unlocked** key/entity → normal **more-specific-wins** merge
 *     (`project > user > global`, global as the default). This is Shofer's
 *     existing mode/rules precedence, reused unchanged for the unlocked case.
 *   - A user/project may always **add** keys/entities the global layer does not
 *     define — locking a key global never set is meaningless and falls back to
 *     the unlocked merge.
 *
 * `locked.json` is honored **only** from the global (read-only, out-of-`/home`)
 * scope; a user/project `locked.json` is never passed here (the caller reads it
 * only from the global root), so this engine cannot be tricked into locking
 * against, or unlocking, org policy.
 *
 * The engine is deliberately *not* wired into the live `ContextProxy`/`getValue`
 * path — that is Part E3+. It is exercised only by its co-located unit tests
 * until the file-backed config path is built on top of it.
 */

/**
 * Current on-disk version of `locked.json`. Bump when the manifest shape
 * changes; a mismatched version is discarded (Versioned Snapshot Rule).
 */
export const LOCKED_MANIFEST_VERSION = 1

/**
 * Schema for the global scope's `.shofer/locked.json` (Schema-First Persistence
 * Rule). `locked` is a flat list of locked **paths** and **named entities**,
 * e.g. `["autoApprovalEnabled", "modes/Code", "providers/default", "mcp/foo"]`.
 *
 *   - A bare key (`"autoApprovalEnabled"`) locks that top-level settings key.
 *   - A collection namespace (`"modes"`) locks the entire collection.
 *   - A `"<namespace>/<id>"` entry (`"modes/Code"`) locks a single named entity
 *     within a collection, leaving its siblings on the unlocked merge.
 */
export const lockedManifestSchema = z.object({
	version: z.literal(LOCKED_MANIFEST_VERSION),
	locked: z.array(z.string()),
})

export type LockedManifest = z.infer<typeof lockedManifestSchema>

/** An empty manifest — nothing is locked, everything is an overridable default. */
export const EMPTY_LOCKED_MANIFEST: LockedManifest = { version: LOCKED_MANIFEST_VERSION, locked: [] }

/**
 * Parse raw `locked.json` bytes/JSON into a {@link LockedManifest}, failing
 * closed: corrupt, partial, or version-mismatched input yields an empty
 * manifest (nothing locked) rather than throwing (Schema-First Persistence
 * Rule + Versioned Snapshot Rule).
 */
export function parseLockedManifest(raw: unknown): LockedManifest {
	const result = lockedManifestSchema.safeParse(raw)
	return result.success ? result.data : EMPTY_LOCKED_MANIFEST
}

/**
 * Describes a named-entity collection: which settings key holds it and which
 * field on each entity is its stable identifier. Locking and merging happen
 * **per named entity** for these keys (a locked `modes/Code` locks only the
 * `Code` mode; other modes still follow the unlocked merge).
 */
interface CollectionSpec {
	/** The `ShoferSettings` key holding the array of entities. */
	readonly settingsKey: keyof ShoferSettings
	/** The property on each entity object used as its identity. */
	readonly idField: string
}

/**
 * Named-entity collections known to the merge engine, keyed by the **namespace**
 * used in `locked.json` (`modes/<slug>`, `providers/<name>`). Entries settings.json
 * does not itself hold (e.g. `mcp` lives in `mcp.json`, a separate file merged
 * by the same engine at a higher layer) are intentionally absent here — an
 * unknown namespace in the manifest is simply inert against the settings object.
 */
const COLLECTION_SPECS: Readonly<Record<string, CollectionSpec>> = {
	modes: { settingsKey: "customModes", idField: "slug" },
	providers: { settingsKey: "listApiConfigMeta", idField: "name" },
}

/** Reverse index: settings key → namespace, for collection detection. */
const SETTINGS_KEY_TO_NAMESPACE: Readonly<Record<string, string>> = Object.fromEntries(
	Object.entries(COLLECTION_SPECS).map(([namespace, spec]) => [spec.settingsKey as string, namespace]),
)

/** A partial settings object for one scope layer. */
export type LayeredSettings = Partial<ShoferSettings>

/** The three scope layers, ordered least- to most-specific for the unlocked merge. */
export interface LayeredConfigInput {
	/** Org-global scope (read-only, the default layer; also the sole lock authority). */
	global?: LayeredSettings
	/** Per-user scope (`~/.shofer/`), overrides global when unlocked. */
	user?: LayeredSettings
	/** Project scope (`<workspace>/.shofer/`), the most specific, wins when unlocked. */
	project?: LayeredSettings
}

/** Narrow to a plain (non-array, non-null) object we can deep-merge. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Deep-merge two plain objects, most-specific (`override`) winning per leaf.
 * Nested plain objects recurse; arrays and scalars are replaced wholesale
 * (the more-specific layer's value wins). Neither input is mutated.
 */
function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = { ...base }
	for (const key of Object.keys(override)) {
		const overrideValue = override[key]
		const baseValue = result[key]
		if (isPlainObject(baseValue) && isPlainObject(overrideValue)) {
			result[key] = deepMerge(baseValue, overrideValue)
		} else {
			result[key] = overrideValue
		}
	}
	return result
}

/**
 * True if `path` — a bare key (`"autoApprovalEnabled"`) or an entity path
 * (`"modes/Code"`) — is locked by the manifest. This is the public predicate
 * for "is this key/entity org-locked"; the merge engine consults the same rule
 * internally.
 */
export function isPathLocked(path: string, manifest: LockedManifest): boolean {
	return manifest.locked.includes(path)
}

/**
 * True if the collection at `settingsKey` is locked **as a whole** — i.e. the
 * manifest names either its namespace (`"modes"`) or its raw key
 * (`"customModes"`).
 */
function isWholeCollectionLocked(settingsKey: string, namespace: string, manifest: LockedManifest): boolean {
	return isPathLocked(namespace, manifest) || isPathLocked(settingsKey, manifest)
}

/**
 * True if the single entity `id` within collection `namespace` is locked —
 * either individually (`"modes/Code"` / `"customModes/Code"`) or because the
 * whole collection is locked.
 */
function isEntityLocked(settingsKey: string, namespace: string, id: string, manifest: LockedManifest): boolean {
	return (
		isWholeCollectionLocked(settingsKey, namespace, manifest) ||
		isPathLocked(`${namespace}/${id}`, manifest) ||
		isPathLocked(`${settingsKey}/${id}`, manifest)
	)
}

/** Extract an entity's id, or `undefined` if the entity is malformed. */
function entityId(entity: unknown, idField: string): string | undefined {
	if (!isPlainObject(entity)) return undefined
	const id = entity[idField]
	return typeof id === "string" ? id : undefined
}

/**
 * Merge one named-entity collection across the three layers, per-entity.
 *
 * Ordering is project-first, then user-only, then global-only new ids — matching
 * Shofer's existing `CustomModesManager` precedence (project modes listed ahead
 * of global ones). For each id:
 *   - **Locked** (and global defines it) → global's entity wins, final;
 *     user/project versions are dropped and the entity cannot be removed.
 *   - **Unlocked** (or global does not define it) → more-specific wins:
 *     `project ?? user ?? global` (whole-entity replacement, as modes merge
 *     today — entities are replaced, not deep-merged).
 */
function mergeCollection(
	layers: LayeredConfigInput,
	settingsKey: string,
	namespace: string,
	idField: string,
	manifest: LockedManifest,
): unknown[] {
	const toMap = (arr: unknown): Map<string, unknown> => {
		const map = new Map<string, unknown>()
		if (Array.isArray(arr)) {
			for (const entity of arr) {
				const id = entityId(entity, idField)
				if (id !== undefined && !map.has(id)) map.set(id, entity)
			}
		}
		return map
	}

	const globalMap = toMap((layers.global as Record<string, unknown> | undefined)?.[settingsKey])
	const userMap = toMap((layers.user as Record<string, unknown> | undefined)?.[settingsKey])
	const projectMap = toMap((layers.project as Record<string, unknown> | undefined)?.[settingsKey])

	// Stable id order: project first, then user-only, then global-only.
	const orderedIds: string[] = []
	const seen = new Set<string>()
	for (const map of [projectMap, userMap, globalMap]) {
		for (const id of map.keys()) {
			if (!seen.has(id)) {
				seen.add(id)
				orderedIds.push(id)
			}
		}
	}

	const merged: unknown[] = []
	for (const id of orderedIds) {
		const globalEntity = globalMap.get(id)
		if (globalEntity !== undefined && isEntityLocked(settingsKey, namespace, id, manifest)) {
			merged.push(globalEntity)
			continue
		}
		// Unlocked (or not defined by global): more-specific wins, whole-entity.
		const winner = projectMap.has(id) ? projectMap.get(id) : userMap.has(id) ? userMap.get(id) : globalEntity
		if (winner !== undefined) merged.push(winner)
	}

	return merged
}

/**
 * Merge one non-collection key across the three layers.
 *   - **Locked** (and global defines it) → global's value wins, final.
 *   - **Unlocked** → for plain objects, deep-merge `global ← user ← project`
 *     (most-specific leaf wins); for scalars/arrays, `project ?? user ?? global`
 *     (whole-value replacement). Returns `undefined` if no layer defines it.
 */
function mergeScalarKey(layers: LayeredConfigInput, key: string, manifest: LockedManifest): unknown {
	const globalValue = (layers.global as Record<string, unknown> | undefined)?.[key]
	const userValue = (layers.user as Record<string, unknown> | undefined)?.[key]
	const projectValue = (layers.project as Record<string, unknown> | undefined)?.[key]

	if (globalValue !== undefined && isPathLocked(key, manifest)) {
		return globalValue
	}

	// Deep-merge when every present layer contributes a plain object.
	const present = [globalValue, userValue, projectValue].filter((v) => v !== undefined)
	if (present.length > 0 && present.every(isPlainObject)) {
		let acc: Record<string, unknown> = {}
		for (const value of present) acc = deepMerge(acc, value as Record<string, unknown>)
		return acc
	}

	// Otherwise more-specific wins wholesale.
	if (projectValue !== undefined) return projectValue
	if (userValue !== undefined) return userValue
	return globalValue
}

/**
 * Compute the **effective** config from the three scope layers under the global
 * scope's `locked.json`. Pure: inputs are not mutated, output is a fresh object.
 *
 * @param layers    the three parsed `.shofer/settings.json` scopes
 * @param manifest  the global scope's parsed `locked.json` (default: nothing locked)
 * @returns         the merged effective settings (a partial `ShoferSettings`)
 */
export function mergeLayeredConfig(
	layers: LayeredConfigInput,
	manifest: LockedManifest = EMPTY_LOCKED_MANIFEST,
): LayeredSettings {
	const keys = new Set<string>()
	for (const layer of [layers.global, layers.user, layers.project]) {
		if (layer) for (const key of Object.keys(layer)) keys.add(key)
	}

	const effective: Record<string, unknown> = {}
	for (const key of keys) {
		const namespace = SETTINGS_KEY_TO_NAMESPACE[key]
		const spec = namespace ? COLLECTION_SPECS[namespace] : undefined
		if (namespace && spec) {
			effective[key] = mergeCollection(layers, key, namespace, spec.idField, manifest)
		} else {
			const value = mergeScalarKey(layers, key, manifest)
			if (value !== undefined) effective[key] = value
		}
	}

	return effective as LayeredSettings
}
