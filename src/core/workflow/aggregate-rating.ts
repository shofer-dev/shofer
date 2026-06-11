import type { CompletionRating } from "@shofer/types"

/**
 * Aggregate-rating policy for a WorkflowTask.
 *
 * A workflow's completion rating is derived from its committed child agent
 * ratings using the **minimum-common-denominator** rule: the workflow is only
 * as good as its weakest committed agent. Two agents rated `"excellent"` and
 * one rated `"well"` → workflow rating `"well"`; a single `"poor"` pulls the
 * whole workflow down to `"poor"`.
 *
 * Kept as a standalone pure module (no `vscode` / provider dependencies) so the
 * policy is unit-testable in isolation; `WorkflowTask.aggregateChildRatings`
 * reads the committed children's ratings and delegates the reduction here.
 */

/** Total order over completion ratings: `poor` < `well` < `excellent`. */
export const RATING_ORDER: Record<CompletionRating, number> = {
	poor: 0,
	well: 1,
	excellent: 2,
}

/**
 * Reduce a set of child ratings to the workflow's aggregate rating (the
 * minimum). Returns `"poor"` for an empty set — the case where no committed
 * agent produced a rating (e.g. all errored), so there is no evidence the
 * workflow succeeded.
 */
export function aggregateRatings(ratings: CompletionRating[]): CompletionRating {
	if (ratings.length === 0) {
		return "poor"
	}
	return ratings.reduce((min, r) => (RATING_ORDER[r] < RATING_ORDER[min] ? r : min))
}
