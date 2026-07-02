/**
 * Shared "max results" cap policy for the search-family of native tools
 * (grep_search, git_search, rag_search).
 *
 * Rationale — see docs/cost-calculation-and-limits.md and the "why maxResults
 * exists" discussion: every search hit becomes tokens in the next LLM turn, so
 * each tool MUST enforce an upper bound on the number of results it serialises
 * back to the model and MUST surface a `truncated` signal when more results
 * existed. This module centralises the three concerns that pattern requires so
 * that the three tools behave identically:
 *
 *   1. A per-tool `{ default, max }` cap so the LLM (and developers reading
 *      the schemas) see one consistent shape.
 *   2. `resolveMaxResults(requested, cap)` — normalises whatever the model
 *      emitted (undefined, null, NaN, negative, absurdly large) into a safe
 *      integer in `[1, cap.max]`. Models occasionally produce strings like
 *      `"100"` or floats; this helper coerces and clamps in one place.
 *   3. `formatTruncationHeader(...)` — the single source of truth for the
 *      "Showing first N of more results." prefix every search tool emits.
 *
 * Keeping these as code constants (rather than VS Code settings) is the
 * "follow grep_search" choice: the cap is a prompt-budget proxy, not a user
 * preference, and matching grep's policy across all three tools is the whole
 * point of this module.
 */

/**
 * Cap policy for a single search tool.
 *
 * - `default` is applied when the model omits `maxResults` (or sends an
 *   invalid value).
 * - `max` is a silent hard ceiling — values above it are clamped down without
 *   raising an error, so a model that asks for 10_000 hits still gets a
 *   bounded response.
 */
export interface SearchCap {
	default: number
	max: number
}

/**
 * Per-tool caps. The numbers reflect the relative per-result token cost:
 *
 * - grep_search: cheap text snippets with small context windows → larger cap.
 * - git_search:  commit metadata + body → medium cap.
 * - rag_search:  semantic chunks are large (up to MAX_BLOCK_CHARS); the cap
 *                is intentionally low so even a fully-saturated response fits
 *                comfortably within a model turn.
 */
export const GREP_SEARCH_CAP: SearchCap = { default: 100, max: 1000 }
export const GIT_SEARCH_CAP: SearchCap = { default: 20, max: 50 }
export const RAG_SEARCH_CAP: SearchCap = { default: 10, max: 50 }

/**
 * Normalise a model-supplied `maxResults` into a safe integer within the cap.
 *
 * The model may emit `undefined`, `null`, `NaN`, a string, a float, zero, or
 * a negative — all of which are treated as "use the default". Anything above
 * `cap.max` is silently clamped to `cap.max`.
 */
export function resolveMaxResults(requested: number | null | undefined, cap: SearchCap): number {
	const raw =
		requested === null || requested === undefined || !Number.isFinite(requested) || requested <= 0
			? cap.default
			: Math.floor(requested)
	return Math.min(raw, cap.max)
}

/**
 * Build the single-line header that prefixes a tool's formatted results.
 *
 * Matches the existing grep_search wording so the three tools speak with one
 * voice; the model has learned to recognise the "Showing first N of more
 * results." pattern as the cue to narrow its query.
 */
export function formatTruncationHeader(opts: {
	totalShown: number
	maxResults: number
	truncated: boolean
	noun?: string
}): string {
	const noun = opts.noun ?? "results"
	return opts.truncated ? `Showing first ${opts.maxResults} of more ${noun}.` : `Found ${opts.totalShown} ${noun}.`
}
