import type { ModelInfo } from "../model.js"

// Alibaba DashScope (Qwen) — OpenAI-compatible API.
// International endpoint by default (overridable via dashScopeBaseUrl).
// Prices are USD per 1M tokens (DashScope base tier; coder models use
// input-length-tiered pricing — the entry tier is listed). qwen3-vl-flash
// pricing is an estimate pending an official rate.

export type DashScopeModelId = keyof typeof dashScopeModels

export const dashScopeDefaultModelId: DashScopeModelId = "qwen3-max"

export const dashScopeModels = {
	"qwen3-max": {
		maxTokens: 65_536,
		contextWindow: 262_144,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 1.2,
		outputPrice: 6.0,
		description: "Alibaba Qwen3-Max — flagship general model. Thinking enabled by default.",
	},
	"qwen3.6-plus": {
		maxTokens: 65_536,
		contextWindow: 1_000_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.5,
		outputPrice: 3.0,
		description: "Alibaba Qwen3.6-Plus — latest flagship-tier model with 1M context. Thinking enabled by default.",
	},
	"qwen3.6-flash": {
		maxTokens: 65_536,
		contextWindow: 1_000_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.19,
		outputPrice: 1.13,
		description: "Alibaba Qwen3.6-Flash — fast, cost-efficient model with 1M context. Thinking enabled by default.",
	},
	"qwen3-coder-plus": {
		maxTokens: 65_536,
		contextWindow: 1_000_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 1.0,
		outputPrice: 5.0,
		description: "Alibaba Qwen3-Coder-Plus — high-performance agentic coding model with 1M context.",
	},
	"qwen3-coder-flash": {
		maxTokens: 65_536,
		contextWindow: 1_000_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.3,
		outputPrice: 1.5,
		description: "Alibaba Qwen3-Coder-Flash — fast coding model with 1M context optimized for speed.",
	},
	"qwen3-vl-plus": {
		maxTokens: 32_768,
		contextWindow: 262_144,
		supportsImages: true,
		supportsPromptCache: false,
		inputPrice: 0.2,
		outputPrice: 1.6,
		description:
			"Alibaba Qwen3-VL-Plus — multimodal vision-language model (high-res image + video) with long context. Thinking enabled by default.",
	},
	"qwen3-vl-flash": {
		maxTokens: 32_768,
		contextWindow: 262_144,
		supportsImages: true,
		supportsPromptCache: false,
		inputPrice: 0.1,
		outputPrice: 0.8,
		description:
			"Alibaba Qwen3-VL-Flash — fast, cost-efficient multimodal vision-language model. Thinking enabled by default.",
	},
} as const satisfies Record<string, ModelInfo>

export const DASHSCOPE_DEFAULT_TEMPERATURE = 0.7

/**
 * Qwen models that support (and default to) thinking mode via
 * extra_body.enable_thinking. Coder/instruct models stay non-thinking.
 */
export const DASHSCOPE_THINKING_MODELS: ReadonlySet<string> = new Set([
	"qwen3-max",
	"qwen3.6-plus",
	"qwen3.6-flash",
	"qwen3-vl-plus",
	"qwen3-vl-flash",
])
