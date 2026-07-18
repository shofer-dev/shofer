import { moonshotModels, moonshotDefaultModelId } from "@shofer/types"

import type { ApiHandlerOptions } from "./_deps.js"

import type { ApiStreamUsageChunk } from "./_deps.js"
import { getModelParams } from "./_deps.js"

import { OpenAICompatibleHandler, OpenAICompatibleConfig } from "./openai-compatible.js"
import { normalizeMoonshotToolSchema } from "./moonshot-schema.js"

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
	 * Normalize every tool's parameter schema into the Moonshot-flavored JSON
	 * Schema subset. The Kimi API validates tool schemas and rejects the whole
	 * request (`400 … not a valid moonshot flavored json schema`) for constructs
	 * shofer's generic schemas routinely carry — a `null` enum entry, a nullable
	 * `type: [X, "null"]`, an empty union branch — which surfaces to the user as
	 * "No output generated." Applied AFTER the base conversion so it also covers
	 * MCP / plugin tools (whose schemas the base passes through untouched).
	 */
	protected override convertToolsForOpenAI(tools: Parameters<OpenAICompatibleHandler["convertToolsForOpenAI"]>[0]) {
		const converted = super.convertToolsForOpenAI(tools)
		if (!converted) {
			return converted
		}
		return converted.map((tool) =>
			tool?.type === "function" && tool.function?.parameters
				? {
						...tool,
						function: {
							...tool.function,
							parameters: normalizeMoonshotToolSchema(tool.function.parameters),
						},
					}
				: tool,
		)
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
