/**
 * Normalising an OpenAI-SDK error into something a user can act on.
 *
 * A copy of core's `handleProviderError`, reduced to what an *embedder* needs. Core's
 * version reaches for its logging and i18n singletons through `api/providers/_deps`, which
 * transitively pulls the token counter and its tiktoken WASM — a file that does not exist
 * beside a bundled plugin, so importing it made the plugin fail to load entirely. Twenty
 * lines here beat shipping a 2 MB tokenizer to format an error string.
 *
 * The two behaviours that matter are kept: the ByteString case (an API key with a
 * non-ASCII character, which the SDK reports unintelligibly), and preserving `status` so
 * retry/backoff can still see a 429.
 */

import { codeIndexLog } from "../logging.js"

/** An error carrying the HTTP status the SDK saw, when it had one. */
interface StatusfulError extends Error {
	status?: number
	error?: { metadata?: { raw?: string } }
}

export function handleOpenAIError(error: unknown, providerName: string): Error {
	if (!(error instanceof Error)) {
		return new Error(`${providerName} embeddings error: ${String(error)}`)
	}

	const anyError = error as StatusfulError
	const message = anyError.error?.metadata?.raw || error.message || ""

	codeIndexLog.error(`[${providerName}] API error:`, {
		message,
		name: error.name,
		status: anyError.status,
	})

	const wrapped: StatusfulError = message.includes("Cannot convert argument to a ByteString")
		? new Error(
				`${providerName}: the API key contains characters that cannot be sent in an HTTP header — re-copy it.`,
			)
		: new Error(`${providerName} embeddings error: ${message}`)

	// Preserved so backoff logic can still distinguish a rate limit from a bad key.
	if (anyError.status !== undefined) wrapped.status = anyError.status
	return wrapped
}
