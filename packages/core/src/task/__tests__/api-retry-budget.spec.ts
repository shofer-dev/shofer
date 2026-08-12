// npx vitest run src/task/__tests__/api-retry-budget.spec.ts

import { describe, it, expect } from "vitest"

import { MAX_CONSECUTIVE_API_FAILURES } from "../../constants.js"
import { ApiRetryBudgetExceededError, resolveMaxConsecutiveApiFailures } from "../api-retry-budget.js"

describe("resolveMaxConsecutiveApiFailures", () => {
	it("uses the configured ceiling", () => {
		expect(resolveMaxConsecutiveApiFailures(3)).toBe(3)
		expect(resolveMaxConsecutiveApiFailures(1)).toBe(1)
	})

	it("floors a fractional value", () => {
		expect(resolveMaxConsecutiveApiFailures(4.7)).toBe(4)
	})

	it("falls back to the default for anything that would disable the bound", () => {
		for (const value of [undefined, 0, -1, 0.5, NaN, Infinity]) {
			expect(resolveMaxConsecutiveApiFailures(value as number | undefined)).toBe(MAX_CONSECUTIVE_API_FAILURES)
		}
	})
})

describe("ApiRetryBudgetExceededError", () => {
	it("quotes the provider's error and keeps it as the cause", () => {
		const cause = new Error("OpenRouter completion error: Connection error.")
		const error = new ApiRetryBudgetExceededError(6, 6, cause)

		expect(error.message).toContain("failed 6 times in a row (limit 6)")
		expect(error.message).toContain("Last error: OpenRouter completion error: Connection error.")
		expect(error.failures).toBe(6)
		expect(error.limit).toBe(6)
		expect((error as Error & { cause?: unknown }).cause).toBe(cause)
	})

	it("carries the last failure's HTTP status when it had one", () => {
		const cause = Object.assign(new Error("Server error"), { status: 500 })
		expect(new ApiRetryBudgetExceededError(6, 6, cause).status).toBe(500)
		expect(new ApiRetryBudgetExceededError(6, 6, new Error("no status")).status).toBeUndefined()
	})

	it("survives a non-Error cause", () => {
		expect(new ApiRetryBudgetExceededError(2, 2, "boom").message).toContain("Last error: boom")
		expect(new ApiRetryBudgetExceededError(2, 2, undefined).message).toContain("unknown error")
	})
})
