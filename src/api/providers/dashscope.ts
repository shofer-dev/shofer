import {
	dashScopeModels,
	dashScopeDefaultModelId,
	DASHSCOPE_DEFAULT_TEMPERATURE,
	DASHSCOPE_THINKING_MODELS,
} from "@shofer/types"

import type { ApiHandlerOptions } from "../../shared/api"

import { getModelParams } from "../transform/model-params"

import { OpenAICompatibleHandler, OpenAICompatibleConfig } from "./openai-compatible"

/**
 * Alibaba DashScope (Qwen) — OpenAI-compatible.
 *
 * International endpoint by default (overridable via `dashScopeBaseUrl`, e.g. the
 * Beijing or US-Virginia compatible-mode host). Qwen3 hybrid models support a
 * thinking mode toggled via the `enable_thinking` body field; we enable it by
 * default for thinking-capable models. Coder/instruct models stay non-thinking.
 */
export class DashScopeHandler extends OpenAICompatibleHandler {
	constructor(options: ApiHandlerOptions) {
		const modelId = options.apiModelId ?? dashScopeDefaultModelId
		const modelInfo =
			dashScopeModels[modelId as keyof typeof dashScopeModels] || dashScopeModels[dashScopeDefaultModelId]

		const config: OpenAICompatibleConfig = {
			providerName: "dashscope",
			baseURL: options.dashScopeBaseUrl || "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
			apiKey: options.dashScopeApiKey ?? "not-provided",
			modelId,
			modelInfo,
			// DashScope expects max_tokens (not max_completion_tokens).
			useMaxTokens: true,
			modelMaxTokens: options.modelMaxTokens ?? undefined,
			temperature: options.modelTemperature ?? undefined,
			// Enable Qwen thinking by default for thinking-capable models. The
			// openai-compatible provider merges fields under its own key into the
			// request body, so this sends `enable_thinking: true`.
			...(DASHSCOPE_THINKING_MODELS.has(modelId) && {
				providerOptions: { dashscope: { enable_thinking: true } },
			}),
		}

		super(options, config)
	}

	override getModel() {
		const id = this.options.apiModelId ?? dashScopeDefaultModelId
		const info = dashScopeModels[id as keyof typeof dashScopeModels] || dashScopeModels[dashScopeDefaultModelId]
		const params = getModelParams({
			format: "openai",
			modelId: id,
			model: info,
			settings: this.options,
			defaultTemperature: DASHSCOPE_DEFAULT_TEMPERATURE,
		})
		return { id, info, ...params }
	}
}
