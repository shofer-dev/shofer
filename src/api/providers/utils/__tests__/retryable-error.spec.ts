import { isNonRetryableApiError } from "../retryable-error"

describe("isNonRetryableApiError", () => {
	describe("non-retryable auth/authorization errors", () => {
		it("returns true for an OpenAI SDK-style 401 (error.status)", () => {
			const error = new Error("Authentication Fails") as any
			error.status = 401
			expect(isNonRetryableApiError(error)).toBe(true)
		})

		it("returns true for a 403 (error.status)", () => {
			const error = new Error("Forbidden") as any
			error.status = 403
			expect(isNonRetryableApiError(error)).toBe(true)
		})

		it("returns true for an OpenRouter-style nested code (error.error.code)", () => {
			const error = { error: { code: 401, message: "invalid credentials" } }
			expect(isNonRetryableApiError(error)).toBe(true)
		})

		it("returns true for a fetch-style response status (error.response.status)", () => {
			const error = { response: { status: 403 } }
			expect(isNonRetryableApiError(error)).toBe(true)
		})

		it("returns true for a string status code", () => {
			const error = { status: "401" }
			expect(isNonRetryableApiError(error)).toBe(true)
		})
	})

	describe("retryable / transient errors", () => {
		it("returns false for a 429 rate-limit error", () => {
			const error = new Error("Rate limited") as any
			error.status = 429
			expect(isNonRetryableApiError(error)).toBe(false)
		})

		it("returns false for a 500 server error", () => {
			const error = new Error("Internal error") as any
			error.status = 500
			expect(isNonRetryableApiError(error)).toBe(false)
		})

		it("returns false for a 400 bad-request error", () => {
			const error = new Error("Bad request") as any
			error.status = 400
			expect(isNonRetryableApiError(error)).toBe(false)
		})
	})

	describe("indeterminate errors", () => {
		it("returns false for an error without a status", () => {
			expect(isNonRetryableApiError(new Error("API request failed"))).toBe(false)
		})

		it("returns false for a non-numeric string error code", () => {
			expect(isNonRetryableApiError({ code: "invalid_request_error" })).toBe(false)
		})

		it("returns false for null/undefined/primitive inputs", () => {
			expect(isNonRetryableApiError(null)).toBe(false)
			expect(isNonRetryableApiError(undefined)).toBe(false)
			expect(isNonRetryableApiError("boom")).toBe(false)
		})
	})
})
