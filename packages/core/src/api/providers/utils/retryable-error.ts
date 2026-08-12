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
 *
 * This is the FAST PATH for KNOWN failures. It is deliberately conservative:
 * an error that carries no permanent-failure signal is classified transient,
 * and a bare connection failure carries none — `ECONNREFUSED`, `ENOTFOUND` and
 * `ETIMEDOUT` are exactly what a recovering network looks like. Guessing
 * "permanent" from those would turn a recoverable blip into an aborted task.
 * The backstop for everything this classifier cannot know is the *consecutive
 * failure bound* in `Task` (see `ApiRetryBudgetExceededError`), which stops the
 * loop on count alone, without classifying anything.
 *
 * ## The shapes, as observed
 *
 * The OpenAI-compatible SDK (openai@5) raises `APIConnectionError` for every
 * transport failure, with NO status field and the real cause nested under
 * `cause`. Captured against openai@5.12.2 on node 22:
 *
 * ```
 * APIConnectionError "Connection error."
 *   └ cause TypeError "fetch failed"
 *       └ cause Error { code: "ECONNREFUSED" | "ENOTFOUND", ... }        // no signal
 *
 * APIConnectionError "Connection error."                                 // squid CONNECT denial
 *   └ cause TypeError "fetch failed"
 *       └ cause DOMException "Request was cancelled."
 *           └ cause Error { name: "AbortError", code: "UND_ERR_ABORTED",
 *                           message: "Proxy response (403) !== 200 when HTTP Tunneling" }
 * ```
 *
 * The second shape is why the chain is walked at all: an intercepting forward
 * proxy that refuses the tunnel DOES report a real HTTP status, but undici
 * carries it only in the message text of an error three `cause` hops down.
 */

/**
 * HTTP status codes that represent a permanent, non-retryable failure.
 * 401 (Unauthorized) and 403 (Forbidden) are authentication/authorization
 * failures that cannot be resolved by retrying the same request; 407
 * (Proxy Authentication Required) is the same refusal made by an intercepting
 * proxy rather than by the model provider.
 */
const NON_RETRYABLE_STATUS_CODES = new Set<number>([401, 403, 407])

/**
 * undici reports a forward proxy's refusal of the `CONNECT` tunnel as message
 * text only — there is no status field anywhere on the error, so the status has
 * to be read out of the string. Matching the message is safe because it is
 * undici's own fixed wording, and the number it carries IS the proxy's HTTP
 * status: a 403 from squid's ACLs is as permanent as a 403 from the provider,
 * while a 503 from the same proxy stays transient.
 */
const PROXY_TUNNEL_STATUS_PATTERN = /Proxy response \((\d{3})\) !== 200 when HTTP Tunneling/i

/** Depth guard for the `cause` walk — chains are 3-4 deep in practice. */
const MAX_CAUSE_DEPTH = 8

/**
 * Flatten an error and everything nested under `cause` (and the first member of
 * an `AggregateError`, which is how node reports a multi-address connect
 * failure) into a list, nearest first.
 *
 * Exported because `handleProviderError` needs the same view: it wraps provider
 * errors in a new `Error`, and a wrapper that drops the chain would hide the
 * only diagnosis the transport gave us.
 */
export function unwrapErrorChain(error: unknown, maxDepth: number = MAX_CAUSE_DEPTH): unknown[] {
	const chain: unknown[] = []
	const seen = new Set<unknown>()

	let current: unknown = error
	while (current !== undefined && current !== null && chain.length < maxDepth) {
		if (seen.has(current)) {
			break
		}
		seen.add(current)
		chain.push(current)

		if (typeof current !== "object") {
			break
		}

		const link = current as { cause?: unknown; errors?: unknown }
		current = link.cause ?? (Array.isArray(link.errors) ? link.errors[0] : undefined)
	}

	return chain
}

/**
 * Extract an HTTP-style status code from ONE link of the error chain:
 * - OpenAI SDK `APIError.status`
 * - the `handleProviderError` wrapper's preserved `error.status`
 * - OpenRouter's `error.error.code` (numeric HTTP code)
 * - a raw fetch `error.response.status`
 * - undici's proxy-tunnel refusal, whose status lives in the message text
 *
 * Returns `undefined` when no plausible HTTP status can be determined (e.g. a
 * string error `code` such as "invalid_request_error" or "ECONNREFUSED").
 */
function extractLinkStatus(error: unknown): number | undefined {
	if (!error || typeof error !== "object") {
		return undefined
	}

	const e = error as {
		status?: unknown
		code?: unknown
		message?: unknown
		response?: { status?: unknown }
		error?: { status?: unknown; code?: unknown }
	}
	const raw = e.status ?? e.error?.status ?? e.error?.code ?? e.response?.status ?? e.code

	const numeric = typeof raw === "string" ? Number(raw) : raw
	if (typeof numeric === "number" && Number.isFinite(numeric) && numeric >= 100 && numeric <= 599) {
		return numeric
	}

	if (typeof e.message === "string") {
		const tunnelStatus = PROXY_TUNNEL_STATUS_PATTERN.exec(e.message)
		if (tunnelStatus) {
			return Number(tunnelStatus[1])
		}
	}

	return undefined
}

/**
 * Extract an HTTP-style status code from an API error, walking the `cause`
 * chain: the SDK's own error object is frequently status-less (every transport
 * failure is an `APIConnectionError`) while the layer that actually refused the
 * request — an intercepting proxy, most often — sits several hops down.
 *
 * The nearest link that yields a status wins.
 */
export function extractStatus(error: unknown): number | undefined {
	for (const link of unwrapErrorChain(error)) {
		const status = extractLinkStatus(link)
		if (status !== undefined) {
			return status
		}
	}
	return undefined
}

/**
 * Returns true when the error represents a permanent authentication (401),
 * authorization (403) or proxy-authentication (407) failure that must not be
 * auto-retried — whether the refusal came from the model provider itself or
 * from an intercepting proxy between us and it.
 */
export function isNonRetryableApiError(error: unknown): boolean {
	const status = extractStatus(error)
	return status !== undefined && NON_RETRYABLE_STATUS_CODES.has(status)
}
