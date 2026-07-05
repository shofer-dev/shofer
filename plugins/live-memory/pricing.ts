/**
 * pricing — cost estimation for Live Memory LLM calls.
 *
 * Ported from the built-in `packages/core/src/services/live-memory/pricing.ts`. The
 * built-in reads the concrete core `ApiHandler`; the plugin only ever sees the host
 * handler as an opaque value (`PluginAi<unknown>` keeps `@shofer/types` browser-safe),
 * so — exactly like `memory-llm.ts` — this describes the minimal slice it consumes with
 * a structural type and the caller passes the handler built via `ctx.ai.buildHandler`.
 *
 * Prefers authoritative pricing from the handler's `getModel().info`
 * (`inputPrice` / `outputPrice`, USD per 1M tokens — the convention used by all
 * upstream providers' published pricing). Falls back to a coarse table when the handler
 * reports no price (e.g. local Ollama models, custom OpenAI-compatible deployments).
 */

/** USD per 1M tokens. Conservative defaults used when no model info is available. */
const FALLBACK_INPUT_USD_PER_MTOK = 0.5
const FALLBACK_OUTPUT_USD_PER_MTOK = 2.0
const TOKENS_PER_MILLION = 1_000_000

/** The minimal slice of the host `ApiHandler` this estimator reads. */
export interface PricingModelInfo {
	inputPrice?: number
	outputPrice?: number
}
export interface PricingHandler {
	getModel(): { info: PricingModelInfo }
}

/**
 * Estimate USD cost for a single Live Memory request.
 *
 * @param handler - The active host handler (`ctx.ai.buildHandler(...)`) — read for live model info.
 * @param promptTokens - Input tokens reported by the provider.
 * @param completionTokens - Output tokens reported by the provider.
 */
export function estimateUsdCost(handler: PricingHandler, promptTokens: number, completionTokens: number): number {
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
