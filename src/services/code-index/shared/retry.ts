/**
 * Retry a function with exponential backoff, capped at a maximum delay.
 *
 * Used at the orchestrator and manager level to recover from transient
 * infrastructure outages (Ollama / Qdrant being temporarily down). This is
 * separate from the per-batch retry in {@link DirectoryScanner.processBatch}
 * and the per-request retry in individual embedders.
 *
 * Naming: `maxAttempts` counts *total* invocations of `fn` — not just the
 * retries after the first. With `maxAttempts: 5` and `initialDelayMs: 2000`,
 * the call sleeps between attempts 1→2, 2→3, 3→4, 4→5 and never sleeps after
 * the final attempt.
 *
 * Backoff schedule (defaults, maxAttempts=5):
 *   sleep before attempt 2 → 2000 ms, before 3 → 4000 ms,
 *   before 4 → 8000 ms,    before 5 → 16000 ms
 *   total wall-time ≈ 30 s of sleeping plus 5×fn() runtime
 *
 * Logging is the caller's responsibility — pass an `onRetry` callback to
 * surface per-attempt diagnostics. The helper itself emits no logs so callers
 * are not double-logged.
 *
 * @param fn         The async function to retry.
 * @param options    Retry parameters.
 * @returns          The result of the first successful invocation of `fn`.
 * @throws           The last error if all attempts are exhausted, or an
 *                   AbortError if the signal fires between attempts.
 */
export async function retryWithBackoff<T>(
	fn: () => Promise<T>,
	options: {
		/** Total number of attempts (≥ 1). With `maxAttempts: N` the helper sleeps `N-1` times. */
		maxAttempts: number
		initialDelayMs: number
		maxBackoffMs: number
		signal?: AbortSignal
		/** Called before each retry-sleep; receives the 1-indexed attempt that just failed. */
		onRetry?: (attempt: number, error: Error, delayMs: number) => void
	},
): Promise<T> {
	let lastError: Error | undefined

	for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
		// Honour an abort that fired between iterations (e.g. during a sleep
		// that resolved at the same tick as the abort signal).
		if (options.signal?.aborted) {
			throw new DOMException("Retry aborted", "AbortError")
		}

		try {
			return await fn()
		} catch (err: any) {
			lastError = err instanceof Error ? err : new Error(String(err))

			// Never retry on abort — the caller explicitly cancelled.
			if (lastError.name === "AbortError" || options.signal?.aborted) {
				throw lastError
			}

			if (attempt < options.maxAttempts) {
				const delayMs = Math.min(options.maxBackoffMs, options.initialDelayMs * Math.pow(2, attempt - 1))
				options.onRetry?.(attempt, lastError, delayMs)

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
