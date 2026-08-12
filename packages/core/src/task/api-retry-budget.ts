/**
 * The consecutive-failure BOUND on automatic model API retries.
 *
 * The task loop retries a failed API request with exponential backoff whenever
 * auto-approval is on — which is always, headless. Two things stop that loop:
 *
 * 1. the CLASSIFIER (`isNonRetryableApiError`), the fast path for failures we
 *    recognise as permanent — a 401, a 403, a proxy refusing the tunnel;
 * 2. this BOUND, the safety net for everything else.
 *
 * The bound exists because classification can only ever cover the shapes
 * someone has seen. A bare `ECONNREFUSED` carries no evidence of whether the
 * provider will be back in two seconds or never, and guessing "never" would
 * abort tasks that a blip should not kill. So the bound does not classify at
 * all: it counts. After enough CONSECUTIVE failures — with no successful
 * request in between — the task stops and says why, instead of spinning a
 * ~5-minute backoff forever and presenting as a hang.
 *
 * The counter lives on the task and is reset the moment a request completes
 * successfully, so the bound only ever fires on a condition that is not
 * clearing up.
 */

import { MAX_CONSECUTIVE_API_FAILURES } from "../constants.js"

/**
 * Resolve the configured ceiling on consecutive API failures.
 *
 * A missing or nonsensical value (zero, negative, fractional) falls back to the
 * default: there is deliberately no "unlimited" setting, because unlimited is
 * the defect this bound exists to remove.
 */
export function resolveMaxConsecutiveApiFailures(configured: number | undefined): number {
	if (typeof configured !== "number" || !Number.isFinite(configured) || configured < 1) {
		return MAX_CONSECUTIVE_API_FAILURES
	}
	return Math.floor(configured)
}

/**
 * Raised when a task has exhausted its consecutive-failure budget.
 *
 * It carries the provider's own error as `cause` AND quotes it in the message,
 * because the whole point of failing here is to make the reason visible: a
 * headless controller sees only the message on the abort, and "gave up" without
 * "because the proxy refused the tunnel" is barely better than the hang.
 */
export class ApiRetryBudgetExceededError extends Error {
	/** Number of consecutive failures observed (equal to `limit` when thrown). */
	readonly failures: number
	/** The ceiling that was reached. */
	readonly limit: number
	/** HTTP status of the last failure, when it had one. */
	readonly status?: number

	constructor(failures: number, limit: number, cause: unknown) {
		const causeMessage =
			cause instanceof Error
				? cause.message
				: typeof cause === "string"
					? cause
					: String(cause ?? "unknown error")

		super(
			`The model API request failed ${failures} times in a row (limit ${limit}); giving up. ` +
				`Last error: ${causeMessage}`,
		)

		this.name = "ApiRetryBudgetExceededError"
		this.failures = failures
		this.limit = limit
		;(this as Error & { cause?: unknown }).cause = cause

		const status = (cause as { status?: unknown } | null)?.status
		if (typeof status === "number") {
			this.status = status
		}
	}
}
