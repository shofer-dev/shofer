/**
 * pricing — cost estimation for Helper Agent LLM calls.
 *
 * Prefers authoritative pricing from the underlying ApiHandler's
 * `getModel().info` (populated from each provider's pricing tables).
 * Falls back to a coarse table when the handler reports no price (e.g.
 * local Ollama models, custom OpenAI-compatible deployments).
 *
 * `inputPrice` / `outputPrice` in `ModelInfo` are USD per 1M tokens, the
 * convention used by all upstream providers' published pricing.
 */

import type { ApiHandler } from "../../api"

/** USD per 1M tokens. Conservative defaults used when no model info is available. */
const FALLBACK_INPUT_USD_PER_MTOK = 0.5
const FALLBACK_OUTPUT_USD_PER_MTOK = 2.0
const TOKENS_PER_MILLION = 1_000_000

/**
 * Estimate USD cost for a single Helper Agent request.
 *
 * @param handler - The active ApiHandler (used to read live model info).
 * @param promptTokens - Input tokens reported by the provider.
 * @param completionTokens - Output tokens reported by the provider.
 */
export function estimateUsdCost(
	handler: ApiHandler,
	promptTokens: number,
	completionTokens: number,
): number {
	let inputRate = FALLBACK_INPUT_USD_PER_MTOK
	let outputRate = FALLBACK_OUTPUT_USD_PER_MTOK

	try {
		const { info } = handler.getModel()
		if (typeof info.inputPrice === "number" && info.inputPrice > 0) {
			inputRate = info.inputPrice
		}
		if (typeof info.outputPrice === "number" && info.outputPrice > 0) {
			outputRate = info.outputPrice
		}
	} catch {
		// Handler does not implement getModel() reliably — keep fallbacks.
	}

	return (promptTokens / TOKENS_PER_MILLION) * inputRate + (completionTokens / TOKENS_PER_MILLION) * outputRate
}
