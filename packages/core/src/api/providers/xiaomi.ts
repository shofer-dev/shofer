import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import { xiaomiModels, xiaomiDefaultModelId, type XiaomiModelId, XIAOMI_DEFAULT_TEMPERATURE } from "@shofer/types"

import { type ApiHandlerOptions, getModelMaxOutputTokens } from "./_deps.js"
import { convertToMoonshotFormat } from "./_deps.js"

import type { ApiHandlerCreateMessageMetadata } from "../api-handler-types.js"
import { BaseOpenAiCompatibleProvider } from "./base-openai-compatible-provider.js"

/**
 * Xiaomi MiMo provider handler (OpenAI-compatible endpoint at
 * https://api.xiaomimimo.com/v1).
 *
 * MiMo deviates from the stock OpenAI wire contract in three ways, all handled
 * in `createStream`:
 *
 * 1. **`max_completion_tokens`, not `max_tokens`.** MiMo takes the output cap
 *    via `max_completion_tokens` at the request root.
 * 2. **No `stream_options`.** MiMo rejects `stream_options`; usage arrives on
 *    the final stream chunk without asking for it.
 * 3. **Reasoning preservation.** The thinking models (mimo-v2-pro, mimo-v2-omni
 *    — `preserveReasoning: true` in the catalog) require `reasoning_content`
 *    to be echoed back on every assistant message for multi-turn tool calls,
 *    the same wire convention as Moonshot/Kimi and DeepSeek. We therefore
 *    reuse `convertToMoonshotFormat`, which extracts reasoning blocks into the
 *    top-level `reasoning_content` field, rather than adding another identical
 *    converter. Thinking is default-on for these models upstream; we send an
 *    explicit `thinking: { type: "enabled" }` to pin the behavior.
 */

// MiMo takes a top-level `thinking` toggle, which is not in the OpenAI SDK's
// streaming params type.
type XiaomiChatCompletionParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming & {
	thinking?: { type: "enabled" | "disabled" }
}

export class XiaomiHandler extends BaseOpenAiCompatibleProvider<XiaomiModelId> {
	constructor(options: ApiHandlerOptions) {
		super({
			...options,
			providerName: "Xiaomi",
			baseURL: options.xiaomiBaseUrl || "https://api.xiaomimimo.com/v1",
			apiKey: options.xiaomiApiKey ?? "not-provided",
			defaultProviderModelId: xiaomiDefaultModelId,
			providerModels: xiaomiModels,
			defaultTemperature: XIAOMI_DEFAULT_TEMPERATURE,
		})
	}

	protected override createStream(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
		requestOptions?: OpenAI.RequestOptions,
	) {
		const { id: model, info } = this.getModel()

		const maxTokens =
			getModelMaxOutputTokens({
				modelId: model,
				model: info,
				settings: this.options,
				format: "openai",
			}) ?? undefined

		const temperature = this.options.modelTemperature ?? info.defaultTemperature ?? this.defaultTemperature

		// Preserve reasoning_content on assistant messages and merge post-tool
		// text into tool messages (critical for the thinking models).
		const convertedMessages = convertToMoonshotFormat(messages, { mergeToolResultText: true })

		const params: XiaomiChatCompletionParams = {
			model,
			// MiMo expects the output cap as max_completion_tokens.
			max_completion_tokens: maxTokens,
			temperature,
			messages: [{ role: "system", content: systemPrompt }, ...convertedMessages],
			stream: true,
			// No stream_options: MiMo does not support it; the final stream
			// chunk carries usage regardless.
			tools: this.convertToolsForOpenAI(metadata?.tools),
			tool_choice: metadata?.tool_choice,
			parallel_tool_calls: metadata?.parallelToolCalls ?? true,
			// Thinking models: pin default-on thinking explicitly.
			...(info.preserveReasoning ? { thinking: { type: "enabled" as const } } : {}),
		}

		return this.client.chat.completions.create(params, requestOptions)
	}
}
