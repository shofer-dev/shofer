import type { ModelInfo } from "../model.js"

// https://platform.moonshot.ai/
export type MoonshotModelId = keyof typeof moonshotModels

export const moonshotDefaultModelId: MoonshotModelId = "kimi-k2-0905-preview"

export const moonshotModels = {
	"kimi-k2-0711-preview": {
		maxTokens: 32_000,
		contextWindow: 131_072,
		supportsImages: false,
		supportsPromptCache: true,
		inputPrice: 0.6, // $0.60 per million tokens (cache miss)
		outputPrice: 2.5, // $2.50 per million tokens
		cacheWritesPrice: 0, // $0 per million tokens (cache miss)
		cacheReadsPrice: 0.15, // $0.15 per million tokens (cache hit)
		description: `Kimi K2 is a state-of-the-art mixture-of-experts (MoE) language model with 32 billion activated parameters and 1 trillion total parameters.`,
	},
	"kimi-k2-0905-preview": {
		maxTokens: 16384,
		contextWindow: 262144,
		supportsImages: false,
		supportsPromptCache: true,
		inputPrice: 0.6,
		outputPrice: 2.5,
		cacheReadsPrice: 0.15,
		description:
			"Kimi K2 model gets a new version update: Agentic coding: more accurate, better generalization across scaffolds. Frontend coding: improved aesthetics and functionalities on web, 3d, and other tasks. Context length: extended from 128k to 256k, providing better long-horizon support.",
	},
	"kimi-k2-turbo-preview": {
		maxTokens: 32_000,
		contextWindow: 262_144,
		supportsImages: false,
		supportsPromptCache: true,
		inputPrice: 2.4, // $2.40 per million tokens (cache miss)
		outputPrice: 10, // $10.00 per million tokens
		cacheWritesPrice: 0, // $0 per million tokens (cache miss)
		cacheReadsPrice: 0.6, // $0.60 per million tokens (cache hit)
		description: `Kimi K2 Turbo is a high-speed version of the state-of-the-art Kimi K2 mixture-of-experts (MoE) language model, with the same 32 billion activated parameters and 1 trillion total parameters, optimized for output speeds of up to 60 tokens per second, peaking at 100 tokens per second.`,
	},
	"kimi-k2-thinking": {
		maxTokens: 16_000, // Recommended ≥ 16,000
		contextWindow: 262_144, // 262,144 tokens
		supportsImages: false, // Text-only (no image/vision support)
		supportsPromptCache: true,
		inputPrice: 0.6, // $0.60 per million tokens (cache miss)
		outputPrice: 2.5, // $2.50 per million tokens
		cacheWritesPrice: 0, // $0 per million tokens (cache miss)
		cacheReadsPrice: 0.15, // $0.15 per million tokens (cache hit)
		supportsTemperature: true, // Default temperature: 1.0
		preserveReasoning: true,
		defaultTemperature: 1.0,
		description: `The kimi-k2-thinking model is a general-purpose agentic reasoning model developed by Moonshot AI. Thanks to its strength in deep reasoning and multi-turn tool use, it can solve even the hardest problems.`,
	},
	"kimi-k2.5": {
		maxTokens: 16_384,
		contextWindow: 262_144,
		supportsImages: false,
		supportsPromptCache: true,
		inputPrice: 0.6, // $0.60 per million tokens (cache miss)
		outputPrice: 3.0, // $3.00 per million tokens
		cacheReadsPrice: 0.1, // $0.10 per million tokens (cache hit)
		supportsTemperature: true,
		defaultTemperature: 1.0,
		description:
			"Kimi K2.5 is the latest generation of Moonshot AI's Kimi series, featuring improved reasoning capabilities and enhanced performance across diverse tasks.",
	},
	// K3 is only served by the Kimi-for-Coding subscription plane
	// (base URL https://api.kimi.com/coding/v1, model id `k3`), NOT the global
	// platform api.moonshot.ai. Point moonshotBaseUrl at the coding endpoint and
	// authenticate with a Kimi subscription key (sk-kimi-…) to use it. Billing is
	// the flat membership quota, so per-token prices are 0 here. Thinking is always
	// on (like kimi-k2-thinking): reasoning_content must be preserved across turns.
	k3: {
		displayName: "kimi-k3 (subscription)",
		maxTokens: 32_000,
		contextWindow: 1_048_576, // 1M-token context
		supportsImages: true, // vision-capable (image_in)
		supportsPromptCache: true,
		inputPrice: 0,
		outputPrice: 0,
		cacheWritesPrice: 0,
		cacheReadsPrice: 0,
		supportsTemperature: true,
		defaultTemperature: 1.0,
		preserveReasoning: true,
		description:
			"Kimi K3 (subscription) — Moonshot AI's agentic coding model, served via the Kimi-for-Coding subscription endpoint (api.kimi.com/coding/v1) with a Kimi subscription key. 1M-token context, always-on thinking, vision-capable. Membership-billed, so prices are 0.",
	},
	// The SAME model on the pay-as-you-go platform (default api.moonshot.ai/v1)
	// uses a DIFFERENT id — `kimi-k3` — and a platform (not subscription) key.
	"kimi-k3": {
		displayName: "kimi-k3",
		maxTokens: 32_000,
		contextWindow: 1_048_576,
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 0,
		outputPrice: 0,
		cacheWritesPrice: 0,
		cacheReadsPrice: 0,
		supportsTemperature: true,
		defaultTemperature: 1.0,
		preserveReasoning: true,
		description:
			"Kimi K3 on the pay-as-you-go platform (api.moonshot.ai). 1M-token context, always-on thinking, vision-capable.",
	},
} as const satisfies Record<string, ModelInfo>

export const MOONSHOT_DEFAULT_TEMPERATURE = 0.6
