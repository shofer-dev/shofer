/**
 * Dependency aggregator for the relocated API providers.
 *
 * Modules inside `@shofer/core` MUST NOT import from the `@shofer/core` barrel
 * (self-import → TS2209 "ambiguous project root"). Before the carve-out the
 * providers imported ~50 symbols from `@shofer/core`; this file re-exports every
 * one of them via RELATIVE core paths (plus a `@shofer/types` block), so each
 * moved provider only had to swap `from "@shofer/core"` → `from "./_deps.js"`
 * (`../_deps.js` from the `fetchers/` and `utils/` subdirs).
 *
 * Do NOT re-export the providers barrel or the core root barrel from here — that
 * would create an import cycle.
 */

// ── transform (values) ─────────────────────────────────────────────────────
export { cleanReasoningChunk } from "../transform/reasoning-preamble.js"
export {
	consolidateReasoningDetails,
	convertToOpenAiMessages,
	sanitizeGeminiMessages,
} from "../transform/openai-format.js"
export { convertAnthropicMessageToGemini } from "../transform/gemini-format.js"
export { convertToAiSdkMessages, convertToolsForAiSdk, processAiSdkStreamPart } from "../transform/ai-sdk.js"
export { convertToBedrockConverseMessages } from "../transform/bedrock-converse-format.js"
export { convertToMistralMessages, normalizeMistralToolCallId } from "../transform/mistral-format.js"
export { convertToR1Format } from "../transform/r1-format.js"
export { convertToResponsesApiInput } from "../transform/responses-api-input.js"
export { createUsageNormalizer, processResponsesApiStream } from "../transform/responses-api-stream.js"
export { convertToZAiFormat } from "../transform/zai-format.js"
export { filterNonAnthropicBlocks } from "../transform/anthropic-filter.js"
export { getModelParams } from "../transform/model-params.js"
export { mergeEnvironmentDetailsForMiniMax } from "../transform/minimax-format.js"
export {
	addAnthropicCacheBreakpoints,
	addGeminiCacheBreakpoints,
	addVercelAiGatewayCacheBreakpoints,
	addVertexCacheBreakpoints,
} from "../transform/caching/index.js"
export { MultiPointStrategy } from "../transform/cache-strategy/index.js"

// ── transform (types) ──────────────────────────────────────────────────────
export type {
	ApiStream,
	ApiStreamChunk,
	ApiStreamUsageChunk,
	ApiStreamTextChunk,
	ApiStreamReasoningChunk,
	ApiStreamToolCallPartialChunk,
	GroundingSource,
} from "../transform/stream.js"
export type {
	AnthropicReasoningParams,
	OpenAiReasoningParams,
	OpenRouterReasoningParams,
} from "../transform/reasoning.js"
export type { CacheModelInfo } from "../transform/cache-strategy/index.js"

// ── native-tool converters (values) ────────────────────────────────────────
export {
	convertOpenAIToolsToAnthropic,
	convertOpenAIToolChoiceToAnthropic,
} from "../../prompts/tools/native-tools/converters.js"

// ── logging / package / i18n ───────────────────────────────────────────────
export { apiLog } from "../../logging/subsystems.js"
export { Package } from "../../shared/package.js"
export { t } from "../../i18n/index.js"
export { default as i18n } from "../../i18n/index.js"

// ── assistant-message / utils (values) ─────────────────────────────────────
export { NativeToolCallParser } from "../../assistant-message/NativeToolCallParser.js"
export { TagMatcher } from "../../utils/tag-matcher.js"
export { isMcpTool } from "../../utils/mcp-name.js"
export { normalizeToolSchema } from "../../utils/json-schema.js"
export { countTokens } from "../../utils/token-counter.js"
export { sanitizeOpenAiCallId } from "../../utils/tool-id.js"
export { safeWriteJson } from "../../utils/safeWriteJson.js"
export { toRequestyServiceUrl } from "@shofer/types"
export { fileExistsAtPath } from "../../fs/fs.js"

// ── model-cache-dir seam ───────────────────────────────────────────────────
export { getModelsCacheDir, getModelsCacheDirSync } from "../fetchers-cache-dir.js"

// ── @shofer/types (provider-api surface previously re-exported by @shofer/core)
export {
	getModelMaxOutputTokens,
	shouldUseReasoningBudget,
	shouldUseReasoningEffort,
	safeJsonParse,
	applyCustomPricing,
	calculateApiCostAnthropic,
	calculateApiCostOpenAI,
	parseApiPrice,
} from "@shofer/types"
export type { ApiHandlerOptions, RouterName, GetModelsOptions } from "@shofer/types"
