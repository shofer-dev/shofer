/**
 * Shared definition of trivial reasoning preamble tokens that some models
 * (DeepSeek via deepseek-reasoner, OpenRouter) emit before actual thinking
 * content.  The tokens are never legitimate reasoning — they are a format
 * artifact (bullet + optional label) mis-emitted at the start of the
 * reasoning stream.
 *
 * SINGLE SOURCE OF TRUTH — imported by provider handlers (deepseek.ts,
 * openrouter.ts) and by the UI guard (ReasoningBlock.tsx).
 */

/**
 * Regex that matches a bullet-prefixed preamble at the start of a reasoning
 * chunk.  The "response" segment is optional so a bare bullet glued to real
 * content ("•Okay…") is also caught.
 *
 * Matched variants:
 *   - "•"              (bare bullet)
 *   - "• "             (bullet + trailing space)
 *   - "• response"     (bullet + space + "response")
 *   - "•response"      (bullet + "response" without space)
 *   - "•response "     (bullet + "response" + trailing space)
 *
 * Case-insensitive on the word so "• Response" is also caught.
 */
export const REASONING_PREAMBLE_RE = /^•\s*(?:response\s*)?/i

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
 * Single-chunk equality check retained as a fast-path.  Only tokens known to
 * be entire chunks consisting solely of a preamble marker are listed.
 * English words ("answer", "Answer") are NOT included — a model's genuine
 * first reasoning chunk could literally be the word "answer", and dropping it
 * would silently discard real thinking content.
 *
 * "response" is included because standalone "response" before the actual
 * reasoning is a known artifact from reasoning_details text encoding.
 */
const LEGACY_ATOMIC_TOKENS = new Set(["•", "• response", "•response", "response"])

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
 * should be entirely dropped (no meaningful content remains after stripping).
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

	// Drop chunks that became empty after stripping, and independently drop
	// chunks that were empty or whitespace to begin with (the empty check
	// must NOT be gated on cleaned !== text, or ""/" " returns as-is).
	if (cleaned.trim().length === 0) {
		if (cleaned !== text) {
			diagnosticLog?.(`[reasoning-preamble] stripped to empty: ${JSON.stringify(text)}`)
		}
		return undefined
	}

	if (cleaned !== text) {
		diagnosticLog?.(`[reasoning-preamble] stripped prefix: ${JSON.stringify(text)} -> ${JSON.stringify(cleaned)}`)
	}
	return cleaned
}
