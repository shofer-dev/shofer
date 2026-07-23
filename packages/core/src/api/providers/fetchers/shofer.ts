/**
 * Shofer Router model discovery.
 *
 * Fetches `{baseUrl}/models` from a running llm-router and maps its catalog into
 * Shofer {@link ModelInfo}. The response is OpenRouter-*shaped* but NOT identical:
 * llm-router prices in **USD per 1,000,000 tokens** (as strings) — already the
 * ModelInfo convention — whereas OpenRouter's `/models` prices per token. Reusing
 * the OpenRouter fetcher here would mis-scale every price by 1,000,000×, so we
 * parse explicitly (no scaling). Per-request *actual* cost still arrives
 * out-of-band via `usage.cost` on the chat stream (handled by the
 * OpenRouter-based ShoferHandler); these prices drive the pre-request estimate +
 * the model picker.
 */

import axios from "axios"
import { z } from "zod"

import type { ModelInfo, ModelRecord } from "@shofer/types"

import { apiLog } from "../_deps.js"

/** Same defaults the ShoferHandler chat path uses (local llm-router, any non-empty bearer). */
export const DEFAULT_SHOFER_BASE_URL = "http://localhost:30081/v1"
const DEFAULT_SHOFER_API_KEY = "shofer"

// Lenient schema — llm-router adds fields over time and we only need a subset.
// `.passthrough()` keeps unknown fields from failing the parse.
const shoferPricingSchema = z
	.object({
		prompt: z.string().optional(),
		completion: z.string().optional(),
		input_cache_read: z.string().optional(),
		input_cache_write: z.string().optional(),
	})
	.passthrough()

const shoferModelSchema = z
	.object({
		id: z.string(),
		name: z.string().optional(),
		description: z.string().optional(),
		pricing: shoferPricingSchema.optional(),
		context_length: z.number().nullish(),
		max_output_tokens: z.number().nullish(),
		top_provider: z
			.object({
				context_length: z.number().nullish(),
				max_completion_tokens: z.number().nullish(),
			})
			.passthrough()
			.optional(),
		capabilities: z
			.object({
				image_input: z.boolean().optional(),
				tool_calling: z.boolean().optional(),
				prompt_cache: z.boolean().optional(),
			})
			.passthrough()
			.optional(),
	})
	.passthrough()

const shoferModelsResponseSchema = z.object({
	data: z.array(shoferModelSchema),
})

/** USD-per-1M-tokens string → number (already the ModelInfo convention). */
function perMillion(price: string | undefined): number | undefined {
	if (price == null) return undefined
	const n = parseFloat(price)
	return Number.isFinite(n) ? n : undefined
}

/**
 * Fetch and normalize the Shofer Router (llm-router) model catalog.
 *
 * @param baseUrl - Router base URL incl. `/v1` (default `http://localhost:30081/v1`).
 * @param apiKey  - Bearer token; the router only requires it be present + non-empty.
 * @returns A {@link ModelRecord} keyed by model id (e.g. `zhipu/glm-5.1`); empty on failure.
 */
export async function getShoferModels(baseUrl?: string, apiKey?: string): Promise<ModelRecord> {
	const models: ModelRecord = {}
	const base = (baseUrl || DEFAULT_SHOFER_BASE_URL).replace(/\/+$/, "")
	const key = apiKey || DEFAULT_SHOFER_API_KEY

	try {
		const response = await axios.get(`${base}/models`, {
			headers: { Authorization: `Bearer ${key}` },
		})

		const parsed = shoferModelsResponseSchema.safeParse(response.data)
		if (!parsed.success) {
			apiLog.error("[Shofer] /models response is invalid", parsed.error.format())
		}
		const data = parsed.success
			? parsed.data.data
			: ((response.data?.data ?? []) as z.infer<typeof shoferModelSchema>[])

		for (const model of data) {
			const contextWindow = model.context_length ?? model.top_provider?.context_length ?? 0
			const maxTokens =
				model.max_output_tokens ??
				model.top_provider?.max_completion_tokens ??
				(contextWindow ? Math.ceil(contextWindow * 0.2) : undefined)

			const cacheReadsPrice = perMillion(model.pricing?.input_cache_read)
			const cacheWritesPrice = perMillion(model.pricing?.input_cache_write)
			// Trust the router's explicit flag; otherwise infer from a cache-read price.
			const supportsPromptCache = model.capabilities?.prompt_cache ?? cacheReadsPrice !== undefined

			const info: ModelInfo = {
				maxTokens: maxTokens ?? null,
				contextWindow: contextWindow || 0,
				supportsImages: model.capabilities?.image_input ?? false,
				supportsPromptCache,
				inputPrice: perMillion(model.pricing?.prompt),
				outputPrice: perMillion(model.pricing?.completion),
				...(cacheReadsPrice !== undefined && { cacheReadsPrice }),
				...(cacheWritesPrice !== undefined && { cacheWritesPrice }),
				description: model.description,
			}

			models[model.id] = info
		}
	} catch (error) {
		apiLog.error(
			`[Shofer] Error fetching models from ${base}/models: ` +
				JSON.stringify(error, Object.getOwnPropertyNames(error as object), 2),
		)
	}

	return models
}
