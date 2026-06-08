/**
 * Retry-policy classification for errors raised during a model API request.
 *
 * The task loop auto-retries a failed API request (with exponential backoff)
 * whenever auto-approval is enabled — which is always the case for the CLI in
 * non-interactive mode. That behavior is correct for *transient* failures
 * (HTTP 429 rate limits, 5xx, network blips) but catastrophic for *permanent*
 * client errors: a 401 authentication or 403 authorization failure will never
 * succeed on retry, so the loop spins forever and presents to the user as a
 * hang.
 *
 * `isNonRetryableApiError` identifies those permanent failures so the task loop
 * can fail fast (surface the error and abort) instead of retrying indefinitely.
 * The error shapes are normalized here because providers and the shared
 * `handleProviderError` wrapper expose the HTTP status under several different
 * fields.
 */

/**
 * HTTP status codes that represent a permanent, non-retryable failure.
 * 401 (Unauthorized) and 403 (Forbidden) are authentication/authorization
 * failures that cannot be resolved by retrying the same request.
 */
const NON_RETRYABLE_STATUS_CODES = new Set<number>([401, 403])

/**
 * Extract an HTTP-style status code from the many shapes an API error may take:
 * - OpenAI SDK `APIError.status`
 * - the `handleProviderError` wrapper's preserved `error.status`
 * - OpenRouter's `error.error.code` (numeric HTTP code)
 * - a raw fetch `error.response.status`
 *
 * Returns `undefined` when no numeric status can be determined (e.g. a string
 * error `code` such as "invalid_request_error").
 */
function extractStatus(error: unknown): number | undefined {
	if (!error || typeof error !== "object") {
		return undefined
	}

	const e = error as Record<string, any>
	const raw = e.status ?? e.error?.status ?? e.error?.code ?? e.response?.status ?? e.code

	const numeric = typeof raw === "string" ? Number(raw) : raw
	return typeof numeric === "number" && Number.isFinite(numeric) ? numeric : undefined
}

/**
 * Returns true when the error represents a permanent authentication (401) or
 * authorization (403) failure that must not be auto-retried.
 */
export function isNonRetryableApiError(error: unknown): boolean {
	const status = extractStatus(error)
	return status !== undefined && NON_RETRYABLE_STATUS_CODES.has(status)
}
