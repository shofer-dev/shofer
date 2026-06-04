import axios from "axios"

import type { ModelInfo } from "@shofer/types"

import { parseApiPrice } from "../../../shared/cost"
import { apiLog } from "../../../utils/logging/subsystems"

interface RawUnboundModel {
	id: string
	max_output_tokens?: number
	context_window?: number
	supports_caching?: boolean
	supports_vision?: boolean
	input_price?: string | number
	output_price?: string | number
	description?: string
	caching_price?: string | number
	cached_price?: string | number
}

export async function getUnboundModels(apiKey?: string | null): Promise<Record<string, ModelInfo>> {
	const models: Record<string, ModelInfo> = {}

	try {
		const headers: Record<string, string> = {}

		if (apiKey) {
			headers["Authorization"] = `Bearer ${apiKey}`
		}

		const response = await axios.get("https://api.getunbound.ai/models", { headers })
		const rawData: unknown = response.data?.data ?? response.data
		const rawModels: RawUnboundModel[] = Array.isArray(rawData) ? (rawData as RawUnboundModel[]) : []

		for (const rawModel of rawModels) {
			const modelInfo: ModelInfo = {
				maxTokens: rawModel.max_output_tokens ?? 8192,
				contextWindow: rawModel.context_window ?? 200_000,
				supportsPromptCache: rawModel.supports_caching ?? false,
				supportsImages: rawModel.supports_vision ?? false,
				inputPrice: parseApiPrice(rawModel.input_price),
				outputPrice: parseApiPrice(rawModel.output_price),
				description: rawModel.description,
				cacheWritesPrice: parseApiPrice(rawModel.caching_price),
				cacheReadsPrice: parseApiPrice(rawModel.cached_price),
			}

			models[rawModel.id] = modelInfo
		}
	} catch (error) {
		apiLog.error(`Error fetching Unbound models: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`)
	}

	return models
}
