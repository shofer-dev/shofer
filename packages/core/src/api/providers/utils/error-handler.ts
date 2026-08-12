/**
 * General error handler for API provider errors
 * Transforms technical errors into user-friendly messages while preserving metadata
 *
 * This utility ensures consistent error handling across all API providers:
 * - Preserves HTTP status codes for UI-aware error display
 * - Maintains error details for retry logic (e.g., RetryInfo for 429 errors)
 * - Provides consistent error message formatting
 * - Enables telemetry and debugging with complete error context
 */

import { apiLog, i18n } from "../_deps.js"
import { unwrapErrorChain } from "./retryable-error.js"

/**
 * The message of the DEEPEST distinct link of the error's `cause` chain.
 *
 * An SDK transport failure says "Connection error." and nothing else; the layer
 * that actually refused — a DNS resolver, a kernel refusing a connect, an
 * intercepting proxy rejecting the `CONNECT` tunnel — reports the reason
 * several `cause` hops down. Surfacing it turns an unactionable one-liner into
 * a diagnosis.
 *
 * Returns `undefined` when the chain adds nothing the top-level message does
 * not already say.
 */
function describeRootCause(error: unknown, topMessage: string): string | undefined {
	const chain = unwrapErrorChain(error)

	for (let i = chain.length - 1; i > 0; i--) {
		const message = (chain[i] as { message?: unknown } | null)?.message
		if (typeof message === "string" && message.length > 0 && !topMessage.includes(message)) {
			return message
		}
	}

	return undefined
}

/**
 * Handles API provider errors and transforms them into user-friendly messages
 * while preserving important metadata for retry logic and UI display.
 *
 * @param error - The error to handle
 * @param providerName - The name of the provider for context in error messages
 * @param options - Optional configuration for error handling
 * @returns A wrapped Error with preserved metadata (status, errorDetails, code)
 *
 * @example
 * // Basic usage
 * try {
 *   await apiClient.createMessage(...)
 * } catch (error) {
 *   throw handleProviderError(error, "OpenAI")
 * }
 *
 * @example
 * // With custom message prefix
 * catch (error) {
 *   throw handleProviderError(error, "Anthropic", { messagePrefix: "streaming" })
 * }
 */
export function handleProviderError(
	error: unknown,
	providerName: string,
	options?: {
		/** Custom message prefix (default: "completion") */
		messagePrefix?: string
		/** Custom message transformer */
		messageTransformer?: (msg: string) => string
	},
): Error {
	const messagePrefix = options?.messagePrefix || "completion"

	if (error instanceof Error) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const anyErr = error as any
		const msg = anyErr?.error?.metadata?.raw || error.message || ""

		// Log the original error details for debugging
		apiLog.error(`[${providerName}] API error:`, {
			message: msg,
			name: error.name,
			stack: error.stack,
			status: anyErr.status,
		})

		let wrapped: Error

		// Special case: Invalid character/ByteString conversion error in API key
		// This is specific to OpenAI-compatible SDKs
		if (msg.includes("Cannot convert argument to a ByteString")) {
			wrapped = new Error(i18n.t("common:errors.api.invalidKeyInvalidChars"))
		} else if (options?.messageTransformer) {
			wrapped = new Error(options.messageTransformer(msg))
		} else {
			const rootCause = describeRootCause(error, msg)
			wrapped = new Error(
				`${providerName} ${messagePrefix} error: ${msg}` + (rootCause ? ` (cause: ${rootCause})` : ""),
			)
		}

		// Preserve the ORIGINAL error as `cause`. The retry classifier
		// (`isNonRetryableApiError`) reads the nested transport failure to tell a
		// permanent refusal from a transient one, and it only ever sees this
		// wrapper — dropping the chain here would blind it.
		;(wrapped as Error & { cause?: unknown }).cause = error

		// Preserve HTTP status and structured details for retry/backoff + UI
		// These fields are used by Task.backoffAndAnnounce() and ChatRow/ErrorRow
		// to provide status-aware error messages and handling
		if (anyErr.status !== undefined) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			;(wrapped as any).status = anyErr.status
		}
		if (anyErr.errorDetails !== undefined) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			;(wrapped as any).errorDetails = anyErr.errorDetails
		}
		if (anyErr.code !== undefined) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			;(wrapped as any).code = anyErr.code
		}
		// Preserve AWS-specific metadata if present (for Bedrock)
		if (anyErr.$metadata !== undefined) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			;(wrapped as any).$metadata = anyErr.$metadata
		}

		return wrapped
	}

	// Non-Error: wrap with provider-specific prefix
	apiLog.error(`[${providerName}] Non-Error exception: ${String(error)}`)
	const wrapped = new Error(`${providerName} ${messagePrefix} error: ${String(error)}`)

	// Also try to preserve status for non-Error exceptions (e.g., plain objects with status)
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const anyErr = error as any
	if (typeof anyErr?.status === "number") {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		;(wrapped as any).status = anyErr.status
	}

	return wrapped
}

/**
 * Specialized handler for OpenAI-compatible providers
 * Re-exports with OpenAI-specific defaults for backward compatibility
 */
export function handleOpenAIError(error: unknown, providerName: string): Error {
	return handleProviderError(error, providerName, { messagePrefix: "completion" })
}
