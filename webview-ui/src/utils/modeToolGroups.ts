/**
 * Reading tool-category names off mode configurations.
 *
 * A mode's `tools` entries come in three shapes — a bare name (`"read"`), a tuple with
 * options (`["write", { fileRegex: "…" }]`) and a scoped object
 * (`{ read: { allowed: [...] } }`) — and every consumer here only wants the NAME.
 *
 * Matching is plain string comparison, so a dynamic category is listed by a mode
 * exactly like a builtin one: a mode naming `"salesforce"` exposes that category's
 * tools, and a category no mode names is visible nowhere (which the Auto-Approve
 * settings surface as a hint rather than an error — a category's server may simply
 * not have connected yet).
 */

/** The shape of a mode config this module needs; `ModeConfig` satisfies it. */
export type ModeWithTools = {
	slug: string
	tools?: Array<string | [string, unknown] | Record<string, unknown>>
}

/** The category name a single `tools` entry names, whichever shape it takes. */
export function toolGroupNameOfEntry(entry: string | [string, unknown] | Record<string, unknown>): string {
	if (typeof entry === "string") {
		return entry
	}

	if (Array.isArray(entry)) {
		return entry[0]
	}

	return Object.keys(entry)[0]!
}

/**
 * The set of category names the given mode lists, or `undefined` when there is
 * nothing to filter against — an unknown slug, or a mode declaring no `tools`.
 * A caller that gets `undefined` shows every category rather than none.
 */
export function getModeAllowedGroups(
	modeSlug: string | undefined,
	modes: ModeWithTools[] | undefined,
): Set<string> | undefined {
	const mode = modeSlug ? modes?.find((m) => m.slug === modeSlug) : undefined

	if (!mode?.tools) {
		return undefined
	}

	return new Set(mode.tools.map(toolGroupNameOfEntry))
}

/**
 * The union of category names listed by ANY of the given modes.
 *
 * Used to tell whether a dynamic category is reachable at all: declaring a category
 * NARROWS visibility (the tools leave every mode that does not name it), so a category
 * outside this union has an auto-approval toggle but no mode that would ever exercise
 * it.
 */
export function getGroupsListedByAnyMode(modes: ModeWithTools[] | undefined): Set<string> {
	const names = new Set<string>()

	for (const mode of modes ?? []) {
		for (const entry of mode.tools ?? []) {
			names.add(toolGroupNameOfEntry(entry))
		}
	}

	return names
}
