import { moonshotModels, moonshotDefaultModelId } from "@shofer/types"

import type { ApiHandlerOptions } from "./_deps.js"

import type { ApiStreamUsageChunk } from "./_deps.js"
import { getModelParams } from "./_deps.js"

import { OpenAICompatibleHandler, OpenAICompatibleConfig } from "./openai-compatible.js"

export class MoonshotHandler extends OpenAICompatibleHandler {
	constructor(options: ApiHandlerOptions) {
		const modelId = options.apiModelId ?? moonshotDefaultModelId
		const modelInfo =
			moonshotModels[modelId as keyof typeof moonshotModels] || moonshotModels[moonshotDefaultModelId]

		const config: OpenAICompatibleConfig = {
			providerName: "moonshot",
			baseURL: options.moonshotBaseUrl || "https://api.moonshot.ai/v1",
			apiKey: options.moonshotApiKey ?? "not-provided",
			modelId,
			modelInfo,
			modelMaxTokens: options.modelMaxTokens ?? undefined,
			temperature: options.modelTemperature ?? undefined,
		}

		super(options, config)
	}

	override getModel() {
		const id = this.options.apiModelId ?? moonshotDefaultModelId
		const info = moonshotModels[id as keyof typeof moonshotModels] || moonshotModels[moonshotDefaultModelId]!
		const params = getModelParams({
			format: "openai",
			modelId: id,
			model: info,
			settings: this.options,
			defaultTemperature: 0,
		})
		// The thinking / coding Kimi models (kimi-k2-thinking, kimi-k2.5, k3,
		// kimi-k3) fix temperature at 1 and reject anything else with
		// `400 invalid temperature: only 1 is allowed for this model`. The base
		// handler always sends a temperature (defaulting to 0) and a profile may
		// carry its own, so a custom/0 value would 400 the request ("No output
		// generated"). These models ignore the sampling temperature anyway, so
		// force 1 for any model whose catalog default is 1, regardless of profile.
		const temperature = (info as { defaultTemperature?: number }).defaultTemperature === 1 ? 1 : params.temperature
		return { id, info, ...params, temperature }
	}

	/**
	 * Override to handle Moonshot's usage metrics, including caching.
	 * Moonshot returns cached_tokens in a different location than standard OpenAI.
	 */
	protected override processUsageMetrics(usage: {
		inputTokens?: number
		outputTokens?: number
		details?: {
			cachedInputTokens?: number
			reasoningTokens?: number
		}
		raw?: Record<string, unknown>
	}): ApiStreamUsageChunk {
		// Moonshot uses cached_tokens at the top level of raw usage data
		const rawUsage = usage.raw as { cached_tokens?: number } | undefined

		return {
			type: "usage",
			inputTokens: usage.inputTokens || 0,
			outputTokens: usage.outputTokens || 0,
			cacheWriteTokens: 0,
			cacheReadTokens: rawUsage?.cached_tokens ?? usage.details?.cachedInputTokens,
		}
	}

	/**
	 * Override to always include max_tokens for Moonshot (not max_completion_tokens).
	 * Moonshot requires max_tokens parameter to be sent.
	 */
	protected override getMaxOutputTokens(): number | undefined {
		const modelInfo = this.config.modelInfo
		// Moonshot always requires max_tokens
		return this.options.modelMaxTokens || modelInfo.maxTokens || undefined
	}
}
