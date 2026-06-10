/**
 * Shared definition of trivial reasoning preamble tokens that some models
 * (DeepSeek via deepseek-reasoner, OpenRouter) emit before actual thinking
 * content.  The tokens are never legitimate reasoning — they are a format
 * artifact (bullet + label) mis-emitted at the start of the reasoning stream.
 *
 * SINGLE SOURCE OF TRUTH — imported by provider handlers (deepseek.ts,
 * openrouter.ts) and by the UI guard (ReasoningBlock.tsx).
 */

/**
 * Regex that matches a bullet-prefixed "response" preamble at the start of
 * a reasoning chunk.  Handles all observed and potential variants:
 *   - "•"          (bare bullet)
 *   - "• "         (bullet + trailing space)
 *   - "• response" (bullet + space + "response")
 *   - "•response"  (bullet + "response" without space)
 *   - "•response " (bullet + "response" + trailing space)
 *
 * Case-insensitive on the word so "• Response" is also caught.
 */
export const REASONING_PREAMBLE_RE = /^•\s*response\s*/i

/**
 * Strip the reasoning preamble prefix from a chunk's text.
 * Returns the text unchanged if no preamble is present.
 *
 * @param text — raw reasoning chunk text from the provider
 * @returns text with the preamble prefix removed (may be empty if the chunk
 *          was entirely preamble)
 */
export function stripReasoningPreamble(text: string): string {
	return text.replace(REASONING_PREAMBLE_RE, "")
}

/**
 * Legacy single-chunk equality check retained as a fast-path for the common
 * case.  Only tokens that are known to be entire chunks consisting solely of
 * a preamble marker are listed.  Do NOT add general English words here —
 * those belong in the prefix-strip path.
 *
 * This is an optimisation: we can drop the chunk without running the regex.
 */
const LEGACY_ATOMIC_TOKENS = new Set(["•", "• response", "•response", "answer", "Answer"])

/**
 * Fast-path check: return true when the entire chunk text is a known
 * trivial preamble token (no regex needed).  Callers should still apply
 * {@link stripReasoningPreamble} for chunks that pass this check, to catch
 * glued-preamble cases.
 */
export function isAtomicPreambleToken(text: string): boolean {
	return LEGACY_ATOMIC_TOKENS.has(text) || LEGACY_ATOMIC_TOKENS.has(text.trim())
}

/**
 * Process a reasoning chunk by first checking the atomic-token fast path,
 * then stripping any preamble prefix.  Returns `undefined` when the chunk
 * should be entirely dropped (no content remains after stripping).
 *
 * @param text — raw reasoning chunk text from the provider
 * @param diagnosticLog — optional logger for debugging preamble processing
 * @returns the cleaned text, or undefined if the chunk should be dropped
 */
export function cleanReasoningChunk(text: string, diagnosticLog?: (msg: string) => void): string | undefined {
	// Fast-path: entire chunk is a known trivial token → drop
	if (isAtomicPreambleToken(text)) {
		diagnosticLog?.(`[reasoning-preamble] atomic drop: ${JSON.stringify(text)}`)
		return undefined
	}

	// Strip preamble prefix from accumulated/boundary text
	const cleaned = stripReasoningPreamble(text)
	if (cleaned !== text && cleaned.length === 0) {
		diagnosticLog?.(`[reasoning-preamble] stripped to empty: ${JSON.stringify(text)}`)
		return undefined
	}
	if (cleaned !== text) {
		diagnosticLog?.(`[reasoning-preamble] stripped prefix: ${JSON.stringify(text)} -> ${JSON.stringify(cleaned)}`)
	}
	return cleaned
}
