import type { ModelInfo } from "../model.js"

// Xiaomi MiMo
// OpenAI-compatible /chat/completions API at https://api.xiaomimimo.com/v1.
// API quirks (handled in the core XiaomiHandler): the request must use
// `max_completion_tokens` (not `max_tokens`), `stream_options` is not
// supported, thinking is toggled via a top-level `thinking: {type}` field, and
// thinking models require `reasoning_content` to be echoed back on assistant
// messages for multi-turn tool calls.
//
// The catalog intentionally omits mimo-v2-tts: it is a text-to-speech model
// with no tool calling, which cannot drive an agent loop.
export type XiaomiModelId = keyof typeof xiaomiModels

export const xiaomiDefaultModelId: XiaomiModelId = "mimo-v2-pro"

export const xiaomiModels = {
	"mimo-v2-pro": {
		maxTokens: 131_072,
		contextWindow: 1_000_000,
		supportsImages: false,
		supportsPromptCache: true,
		preserveReasoning: true, // thinking enabled by default; reasoning_content must be echoed back
		inputPrice: 1.0,
		outputPrice: 3.0,
		cacheReadsPrice: 0.2,
		longContextPricing: {
			thresholdTokens: 200_000,
			inputPriceMultiplier: 2,
			outputPriceMultiplier: 2,
		},
		description:
			"Xiaomi MiMo v2 Pro — advanced model with thinking enabled by default and a 1M context window (pricing doubles above 200K input tokens).",
	},
	"mimo-v2-omni": {
		maxTokens: 32_768,
		contextWindow: 256_000,
		supportsImages: true,
		supportsPromptCache: true,
		preserveReasoning: true, // thinking enabled by default; reasoning_content must be echoed back
		inputPrice: 0.4,
		outputPrice: 2.0,
		cacheReadsPrice: 0.08,
		description: "Xiaomi MiMo v2 Omni — omni-modal model (image input) with thinking enabled by default.",
	},
	"mimo-v2-flash": {
		maxTokens: 65_536,
		contextWindow: 256_000,
		supportsImages: false,
		supportsPromptCache: true,
		inputPrice: 0.1,
		outputPrice: 0.3,
		cacheReadsPrice: 0.01,
		description: "Xiaomi MiMo v2 Flash — fast, cost-efficient model with thinking disabled by default.",
	},
} as const satisfies Record<string, ModelInfo>

// MiMo's default-on thinking models follow the reasoning-model convention of
// sampling at temperature 1.
export const XIAOMI_DEFAULT_TEMPERATURE = 1.0
