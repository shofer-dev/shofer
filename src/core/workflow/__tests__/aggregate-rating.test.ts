/**
 * Unit tests for the workflow aggregate-rating policy (minimum-common-denominator).
 *
 * Vitest globals (describe/it/expect) are available globally per the Test Layout
 * Rule in AGENTS.md. Naming convention: *.test.ts (Node env).
 */

import type { CompletionRating } from "@shofer/types"

import { aggregateRatings, RATING_ORDER } from "../aggregate-rating"

describe("aggregateRatings", () => {
	it("defaults to 'poor' for an empty set (no committed agent produced a rating)", () => {
		expect(aggregateRatings([])).toBe("poor")
	})

	it("returns the single rating when there is exactly one child", () => {
		expect(aggregateRatings(["excellent"])).toBe("excellent")
		expect(aggregateRatings(["well"])).toBe("well")
		expect(aggregateRatings(["poor"])).toBe("poor")
	})

	it("picks the minimum: 2 excellent + 1 well → well", () => {
		expect(aggregateRatings(["excellent", "excellent", "well"])).toBe("well")
	})

	it("lets a single 'poor' pull the whole workflow down", () => {
		expect(aggregateRatings(["excellent", "well", "poor"])).toBe("poor")
	})

	it("returns 'excellent' only when every child is excellent", () => {
		expect(aggregateRatings(["excellent", "excellent", "excellent"])).toBe("excellent")
	})

	it("is order-independent", () => {
		const ratings: CompletionRating[] = ["well", "poor", "excellent"]
		const forward = aggregateRatings(ratings)
		const reversed = aggregateRatings([...ratings].reverse())
		expect(forward).toBe("poor")
		expect(reversed).toBe("poor")
	})

	it("defines a total order poor < well < excellent", () => {
		expect(RATING_ORDER.poor).toBeLessThan(RATING_ORDER.well)
		expect(RATING_ORDER.well).toBeLessThan(RATING_ORDER.excellent)
	})
})
