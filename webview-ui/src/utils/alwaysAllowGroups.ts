/**
 * Helpers for `alwaysAllowGroups` — the per-DYNAMIC-category auto-approval record.
 *
 * The map the webview RENDERS is the effective one: the layered `.shofer/` config
 * deep-merges the global, user and project scopes into it, so an entry in it may have
 * been contributed by a scope this webview does not write to. Posting that whole map
 * back through `updateSettings` would copy those foreign entries into the write
 * scope's own `settings.json`, where they would shadow the contributing scope's later
 * changes forever.
 *
 * So the `alwaysAllowGroups` value in an `updateSettings` payload is defined as a
 * PATCH rather than a value: entries present are set, `null` deletes, entries absent
 * are left untouched. The host merges it into the write scope's OWN map.
 */

/** A per-entry patch: set a category's toggle, or `null` to delete the entry. */
export type AlwaysAllowGroupsPatch = Record<string, boolean | null>

/**
 * Diff an edited `alwaysAllowGroups` map against the snapshot it was seeded from,
 * yielding the per-entry patch to post.
 *
 * Only entries whose value actually moved appear: an entry the user never touched is
 * absent from the patch (so a scope that contributed it keeps owning it), and an entry
 * that disappeared from the edited map is sent as `null` (delete).
 */
export function diffAlwaysAllowGroups(
	original: Record<string, boolean> | undefined,
	next: Record<string, boolean> | undefined,
): AlwaysAllowGroupsPatch {
	const before = original ?? {}
	const after = next ?? {}
	const patch: AlwaysAllowGroupsPatch = {}

	for (const [name, value] of Object.entries(after)) {
		if (before[name] !== value) {
			patch[name] = value
		}
	}

	for (const name of Object.keys(before)) {
		if (!(name in after)) {
			patch[name] = null
		}
	}

	return patch
}

/** True when the patch would change nothing, so the payload can omit the key. */
export function isEmptyAlwaysAllowGroupsPatch(patch: AlwaysAllowGroupsPatch): boolean {
	return Object.keys(patch).length === 0
}

/**
 * Present a patch as the `updateSettings` field type.
 *
 * `ShoferSettings["alwaysAllowGroups"]` is `Record<string, boolean>` — the shape a
 * READER sees. The write side of the same field is wider, because `null` is how a
 * patch deletes an entry. The cast is contained here so exactly one place in the
 * webview knows the two shapes differ.
 */
export function asAlwaysAllowGroupsSetting(patch: AlwaysAllowGroupsPatch): Record<string, boolean> {
	return patch as Record<string, boolean>
}
