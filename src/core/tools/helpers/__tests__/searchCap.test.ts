/**
 * Tests for the shared search-cap helper.
 *
 * The helper is the single source of truth for how grep_search, git_search,
 * and rag_search interpret the `maxResults` parameter, so it has to handle the
 * full set of values an LLM (or a careless caller) can plausibly emit.
 */

import { describe, expect, it } from "vitest"

import {
	GREP_SEARCH_CAP,
	GIT_SEARCH_CAP,
	RAG_SEARCH_CAP,
	resolveMaxResults,
	formatTruncationHeader,
} from "../searchCap"

describe("searchCap constants", () => {
	it("exposes the documented per-tool caps", () => {
		expect(GREP_SEARCH_CAP).toEqual({ default: 100, max: 1000 })
		expect(GIT_SEARCH_CAP).toEqual({ default: 20, max: 50 })
		expect(RAG_SEARCH_CAP).toEqual({ default: 10, max: 50 })
	})

	it("keeps default <= max for every cap (sanity)", () => {
		for (const cap of [GREP_SEARCH_CAP, GIT_SEARCH_CAP, RAG_SEARCH_CAP]) {
			expect(cap.default).toBeGreaterThan(0)
			expect(cap.default).toBeLessThanOrEqual(cap.max)
		}
	})
})

describe("resolveMaxResults", () => {
	const cap = { default: 20, max: 50 }

	it("returns the default for undefined / null / NaN", () => {
		expect(resolveMaxResults(undefined, cap)).toBe(20)
		expect(resolveMaxResults(null, cap)).toBe(20)
		expect(resolveMaxResults(Number.NaN, cap)).toBe(20)
	})

	it("returns the default for non-positive values", () => {
		expect(resolveMaxResults(0, cap)).toBe(20)
		expect(resolveMaxResults(-1, cap)).toBe(20)
		expect(resolveMaxResults(-100, cap)).toBe(20)
	})

	it("returns the default for non-finite values", () => {
		expect(resolveMaxResults(Number.POSITIVE_INFINITY, cap)).toBe(20)
		expect(resolveMaxResults(Number.NEGATIVE_INFINITY, cap)).toBe(20)
	})

	it("passes through valid in-range integers", () => {
		expect(resolveMaxResults(1, cap)).toBe(1)
		expect(resolveMaxResults(20, cap)).toBe(20)
		expect(resolveMaxResults(49, cap)).toBe(49)
		expect(resolveMaxResults(50, cap)).toBe(50)
	})

	it("floors floats", () => {
		expect(resolveMaxResults(5.9, cap)).toBe(5)
		expect(resolveMaxResults(49.999, cap)).toBe(49)
	})

	it("silently clamps values above cap.max", () => {
		expect(resolveMaxResults(51, cap)).toBe(50)
		expect(resolveMaxResults(10_000, cap)).toBe(50)
	})
})

describe("formatTruncationHeader", () => {
	it("emits the 'Showing first N of more results.' form when truncated", () => {
		expect(formatTruncationHeader({ totalShown: 100, maxResults: 100, truncated: true })).toBe(
			"Showing first 100 of more results.",
		)
	})

	it("emits the 'Found N results.' form when not truncated", () => {
		expect(formatTruncationHeader({ totalShown: 7, maxResults: 100, truncated: false })).toBe("Found 7 results.")
	})

	it("supports a custom noun for tool-specific phrasing", () => {
		expect(formatTruncationHeader({ totalShown: 20, maxResults: 20, truncated: true, noun: "commits" })).toBe(
			"Showing first 20 of more commits.",
		)

		expect(formatTruncationHeader({ totalShown: 3, maxResults: 10, truncated: false, noun: "code snippets" })).toBe(
			"Found 3 code snippets.",
		)
	})
})
