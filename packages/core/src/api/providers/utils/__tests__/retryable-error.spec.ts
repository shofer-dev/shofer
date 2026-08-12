import { APIConnectionError, APIError } from "openai"

import { handleProviderError } from "../error-handler.js"
import { isNonRetryableApiError, extractStatus, unwrapErrorChain } from "../retryable-error.js"

/**
 * The error a forward proxy's refusal of the `CONNECT` tunnel actually produces,
 * rebuilt from the SDK's own classes.
 *
 * Captured verbatim from openai@5.12.2 on node 22, calling through an
 * `HTTPS_PROXY` that answers `HTTP/1.1 403 Forbidden` to `CONNECT` — the
 * squid-in-the-untrusted-zone case:
 *
 * ```
 * [0] APIConnectionError  "Connection error."
 * [1] TypeError           "fetch failed"
 * [2] DOMException        "Request was cancelled."
 * [3] Error (AbortError)  "Proxy response (403) !== 200 when HTTP Tunneling"
 *                         { name: "AbortError", code: "UND_ERR_ABORTED" }
 * ```
 *
 * Note what is NOT in there: any numeric status field, at any depth. The only
 * trace of the 403 is undici's message text.
 */
function proxyTunnelRefusal(status = 403): APIConnectionError {
	const undiciAborted = Object.assign(new Error(`Proxy response (${status}) !== 200 when HTTP Tunneling`), {
		name: "AbortError",
		code: "UND_ERR_ABORTED",
	})
	const cancelled = Object.assign(new DOMException("Request was cancelled."), { cause: undiciAborted })
	return new APIConnectionError({ cause: new TypeError("fetch failed", { cause: cancelled }) })
}

/**
 * The error a plain refused/unresolvable connection produces — same captured
 * run, minus the proxy. There is no permanent-failure signal anywhere in it,
 * deliberately: this is what the retry BOUND exists to stop, not the classifier.
 */
function bareConnectionFailure(code = "ECONNREFUSED"): APIConnectionError {
	const syscallError = Object.assign(new Error(`connect ${code} 10.0.0.1:443`), {
		errno: -111,
		code,
		syscall: "connect",
	})
	return new APIConnectionError({ cause: new TypeError("fetch failed", { cause: syscallError }) })
}

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

	describe("real SDK error shapes", () => {
		it("classifies the SDK's own 401 (APIError.generate) as non-retryable", () => {
			const error = APIError.generate(
				401,
				{ error: { message: "No auth credentials found" } },
				undefined,
				new Headers(),
			)
			expect(error.status).toBe(401)
			expect(isNonRetryableApiError(error)).toBe(true)
		})

		it("classifies the SDK's own 403 as non-retryable", () => {
			const error = APIError.generate(403, { error: { message: "forbidden" } }, undefined, new Headers())
			expect(isNonRetryableApiError(error)).toBe(true)
		})

		it("classifies the SDK's own 429/500 as retryable", () => {
			expect(isNonRetryableApiError(APIError.generate(429, undefined, undefined, new Headers()))).toBe(false)
			expect(isNonRetryableApiError(APIError.generate(500, undefined, undefined, new Headers()))).toBe(false)
		})

		it("reads the proxy's 403 out of the nested undici tunnel error", () => {
			const error = proxyTunnelRefusal(403)

			// The SDK error itself carries nothing: this is the gap that made a
			// squid denial look transient and spin the backoff loop forever.
			expect(error.status).toBeUndefined()
			expect(error.message).toBe("Connection error.")

			expect(unwrapErrorChain(error)).toHaveLength(4)
			expect(extractStatus(error)).toBe(403)
			expect(isNonRetryableApiError(error)).toBe(true)
		})

		it("treats a proxy 407 as non-retryable and a proxy 503 as transient", () => {
			expect(isNonRetryableApiError(proxyTunnelRefusal(407))).toBe(true)
			expect(isNonRetryableApiError(proxyTunnelRefusal(503))).toBe(false)
		})

		it("leaves a bare connection failure UNCLASSIFIED (the bound's job, not the classifier's)", () => {
			for (const code of ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET"]) {
				const error = bareConnectionFailure(code)
				expect(extractStatus(error)).toBeUndefined()
				expect(isNonRetryableApiError(error)).toBe(false)
			}
		})

		it("still classifies after handleProviderError has wrapped the SDK error", () => {
			// The task loop never sees the raw SDK error — providers wrap it. The
			// wrapper must therefore carry the chain through.
			const wrapped = handleProviderError(proxyTunnelRefusal(403), "OpenRouter")

			expect(wrapped.message).toContain("OpenRouter completion error: Connection error.")
			expect(wrapped.message).toContain("Proxy response (403) !== 200 when HTTP Tunneling")
			expect(isNonRetryableApiError(wrapped)).toBe(true)
		})

		it("does not invent a status when the wrapped error has none", () => {
			const wrapped = handleProviderError(bareConnectionFailure(), "OpenRouter")
			expect(isNonRetryableApiError(wrapped)).toBe(false)
		})

		it("stops walking a self-referential cause chain", () => {
			const loop = new Error("round") as Error & { cause?: unknown }
			loop.cause = loop
			expect(() => isNonRetryableApiError(loop)).not.toThrow()
			expect(unwrapErrorChain(loop)).toHaveLength(1)
		})
	})
})
