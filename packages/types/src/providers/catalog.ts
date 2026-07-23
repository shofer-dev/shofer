import type { ModelInfo } from "../model.js"
import type { ProviderName } from "../provider-settings.js"

import { anthropicModels, anthropicDefaultModelId } from "./anthropic.js"
import { basetenModels, basetenDefaultModelId } from "./baseten.js"
import { bedrockModels, bedrockDefaultModelId } from "./bedrock.js"
import { dashScopeModels, dashScopeDefaultModelId } from "./dashscope.js"
import { deepSeekModels, deepSeekDefaultModelId } from "./deepseek.js"
import { fireworksModels, fireworksDefaultModelId } from "./fireworks.js"
import { geminiModels, geminiDefaultModelId } from "./gemini.js"
import { minimaxModels, minimaxDefaultModelId } from "./minimax.js"
import { mistralModels, mistralDefaultModelId } from "./mistral.js"
import { moonshotModels, moonshotDefaultModelId } from "./moonshot.js"
import { openAiCodexModels, openAiCodexDefaultModelId } from "./openai-codex.js"
import { openAiNativeModels, openAiNativeDefaultModelId } from "./openai.js"
import { qwenCodeModels, qwenCodeDefaultModelId } from "./qwen-code.js"
import { sambaNovaModels, sambaNovaDefaultModelId } from "./sambanova.js"
import { vertexModels, vertexDefaultModelId } from "./vertex.js"
import { vscodeLlmModels, vscodeLlmDefaultModelId } from "./vscode-llm.js"
import { xaiModels, xaiDefaultModelId } from "./xai.js"
import { xiaomiModels, xiaomiDefaultModelId } from "./xiaomi.js"
import { internationalZAiModels, internationalZAiDefaultModelId } from "./zai.js"

/**
 * Data-driven model catalog (v3 architecture §7).
 *
 * Each provider already declares its models as a `Record<modelId, ModelInfo>` in
 * its own file. This registry collects the **statically-known** providers into a
 * single queryable surface — one place to look up `(provider, modelId) →
 * ModelInfo`, enumerate a provider's models, or read its default — instead of
 * importing each provider's record and switching on the provider name.
 *
 * It is also the seam for making the catalog truly data-driven (Part E #4): a
 * models.dev-backed source (bundled snapshot + live refresh + local overrides)
 * can populate/extend this registry without changing call sites.
 *
 * Dynamic providers (openrouter, requesty, litellm, ollama, lmstudio, unbound,
 * vercel-ai-gateway, …) fetch their model lists at runtime and are intentionally
 * absent here; `lookupStaticModel` returns `undefined` for them.
 */
export interface CatalogEntry {
	/** All statically-known models for the provider, keyed by model id. */
	models: Record<string, ModelInfo>
	/** The provider's default model id. */
	defaultModelId: string
}

export const STATIC_MODEL_CATALOG = {
	anthropic: { models: anthropicModels, defaultModelId: anthropicDefaultModelId },
	baseten: { models: basetenModels, defaultModelId: basetenDefaultModelId },
	bedrock: { models: bedrockModels, defaultModelId: bedrockDefaultModelId },
	dashscope: { models: dashScopeModels, defaultModelId: dashScopeDefaultModelId },
	deepseek: { models: deepSeekModels, defaultModelId: deepSeekDefaultModelId },
	fireworks: { models: fireworksModels, defaultModelId: fireworksDefaultModelId },
	gemini: { models: geminiModels, defaultModelId: geminiDefaultModelId },
	minimax: { models: minimaxModels, defaultModelId: minimaxDefaultModelId },
	mistral: { models: mistralModels, defaultModelId: mistralDefaultModelId },
	moonshot: { models: moonshotModels, defaultModelId: moonshotDefaultModelId },
	"openai-codex": { models: openAiCodexModels, defaultModelId: openAiCodexDefaultModelId },
	"openai-native": { models: openAiNativeModels, defaultModelId: openAiNativeDefaultModelId },
	"qwen-code": { models: qwenCodeModels, defaultModelId: qwenCodeDefaultModelId },
	sambanova: { models: sambaNovaModels, defaultModelId: sambaNovaDefaultModelId },
	vertex: { models: vertexModels, defaultModelId: vertexDefaultModelId },
	"vscode-lm": { models: vscodeLlmModels, defaultModelId: vscodeLlmDefaultModelId },
	xai: { models: xaiModels, defaultModelId: xaiDefaultModelId },
	// z.ai ships separate international/mainland catalogs; the international set is
	// the catalog default (mainland is selected at the provider layer via isChina).
	xiaomi: { models: xiaomiModels, defaultModelId: xiaomiDefaultModelId },
	zai: { models: internationalZAiModels, defaultModelId: internationalZAiDefaultModelId },
} as const satisfies Partial<Record<ProviderName, CatalogEntry>>

/** Providers with a static catalog entry. */
export type StaticCatalogProvider = keyof typeof STATIC_MODEL_CATALOG

export function hasStaticCatalog(provider: string): provider is StaticCatalogProvider {
	return provider in STATIC_MODEL_CATALOG
}

/** All statically-known models for a provider, or `undefined` for dynamic providers. */
export function getStaticModelsForProvider(provider: string): Record<string, ModelInfo> | undefined {
	return hasStaticCatalog(provider) ? STATIC_MODEL_CATALOG[provider].models : undefined
}

/** Look up a single model's info, or `undefined` if the provider/model isn't statically known. */
export function lookupStaticModel(provider: string, modelId: string): ModelInfo | undefined {
	return getStaticModelsForProvider(provider)?.[modelId]
}

/**
 * Local catalog overrides (Part E #4 decision: *bundled snapshot + local
 * overrides* now; live models.dev refresh later). A nested map of
 * `provider → modelId → Partial<ModelInfo>` that is merged over the bundled
 * entry, letting config correct pricing/limits/capabilities or register a model
 * the snapshot lacks — without code changes. A live (models.dev) source can
 * populate the same shape later.
 */
export type CatalogOverrides = Record<string, Record<string, Partial<ModelInfo>>>

/**
 * Resolve a model's info from the bundled catalog with local overrides applied.
 * If the model exists only in `overrides`, the override is returned as-is (it
 * must be a complete `ModelInfo`); otherwise the override is shallow-merged over
 * the bundled entry. Returns `undefined` when neither source has the model.
 */
export function lookupModel(provider: string, modelId: string, overrides?: CatalogOverrides): ModelInfo | undefined {
	const base = lookupStaticModel(provider, modelId)
	const override = overrides?.[provider]?.[modelId]
	if (!override) return base
	if (!base) return override as ModelInfo
	return { ...base, ...override }
}

/**
 * A normalized capability/dialect view of a model — the inspectable data §7 wants
 * per-model behavior to be (vision, prompt-cache, context/limits, pricing, and the
 * tool include/exclude dialect) instead of scattered conditionals.
 */
export interface ModelCapabilities {
	contextWindow: number
	maxTokens?: number
	supportsImages: boolean
	supportsPromptCache: boolean
	inputPrice?: number
	outputPrice?: number
	/** Tools this model opts into beyond its mode groups (tool dialect). */
	includedTools: readonly string[]
	/** Tools this model opts out of. */
	excludedTools: readonly string[]
}

export function getModelCapabilities(info: ModelInfo): ModelCapabilities {
	return {
		contextWindow: info.contextWindow,
		maxTokens: info.maxTokens ?? undefined,
		supportsImages: info.supportsImages ?? false,
		supportsPromptCache: info.supportsPromptCache,
		inputPrice: info.inputPrice,
		outputPrice: info.outputPrice,
		includedTools: info.includedTools ?? [],
		excludedTools: info.excludedTools ?? [],
	}
}
