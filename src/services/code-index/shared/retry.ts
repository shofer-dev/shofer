import { outputWarn } from "../../../utils/outputChannelLogger"

/**
 * Retry a function with exponential backoff, capped at a maximum delay.
 *
 * Used at the orchestrator and manager level to recover from transient
 * infrastructure outages (Ollama / Qdrant being temporarily down). This is
 * separate from the per-batch retry in {@link DirectoryScanner.processBatch}
 * and the per-request retry in individual embedders.
 *
 * Backoff schedule (defaults):
 *   attempt 1 → 2000 ms, 2 → 4000 ms, 3 → 8000 ms, 4 → 16000 ms, 5 → 32000 ms
 *   total ≈ 62 s
 *
 * @param fn         The async function to retry.
 * @param options    Retry parameters.
 * @returns          The result of the first successful invocation of `fn`.
 * @throws           The last error if all retries are exhausted, or an
 *                   AbortError if the signal fires between attempts.
 */
export async function retryWithBackoff<T>(
	fn: () => Promise<T>,
	options: {
		maxRetries: number
		initialDelayMs: number
		maxBackoffMs: number
		signal?: AbortSignal
		/** Called before each retry; useful for logging / state-update callbacks. */
		onRetry?: (attempt: number, error: Error, delayMs: number) => void
	},
): Promise<T> {
	let lastError: Error | undefined

	for (let attempt = 1; attempt <= options.maxRetries; attempt++) {
		try {
			return await fn()
		} catch (err: any) {
			lastError = err instanceof Error ? err : new Error(String(err))

			// Never retry on abort — the caller explicitly cancelled.
			if (lastError.name === "AbortError" || options.signal?.aborted) {
				throw lastError
			}

			if (attempt < options.maxRetries) {
				const delayMs = Math.min(options.maxBackoffMs, options.initialDelayMs * Math.pow(2, attempt - 1))
				options.onRetry?.(attempt, lastError, delayMs)

				outputWarn(
					`[retryWithBackoff] Attempt ${attempt} failed: ${lastError.message}. ` +
						`Retrying in ${delayMs}ms...`,
				)

				await new Promise<void>((resolve, reject) => {
					const timer = setTimeout(resolve, delayMs)
					if (options.signal) {
						options.signal.addEventListener(
							"abort",
							() => {
								clearTimeout(timer)
								reject(new DOMException("Retry aborted", "AbortError"))
							},
							{ once: true },
						)
					}
				})
			}
		}
	}

	throw lastError
}
