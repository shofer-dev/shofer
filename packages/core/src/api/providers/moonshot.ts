import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import {
	moonshotModels,
	moonshotDefaultModelId,
	type MoonshotModelId,
	type ModelInfo,
	MOONSHOT_DEFAULT_TEMPERATURE,
} from "@shofer/types"

import { type ApiHandlerOptions, getModelMaxOutputTokens } from "./_deps.js"
import { convertToMoonshotFormat, getMoonshotReasoning } from "./_deps.js"

import type { ApiHandlerCreateMessageMetadata } from "../api-handler-types.js"
import { BaseOpenAiCompatibleProvider } from "./base-openai-compatible-provider.js"
import { normalizeMoonshotToolSchema } from "./moonshot-schema.js"
import { handleOpenAIError } from "./utils/openai-error-handler.js"

/**
 * Moonshot (Kimi) provider handler using the raw OpenAI SDK.
 *
 * Migrated from the Vercel AI SDK path (`OpenAICompatibleHandler`) to the raw
 * OpenAI SDK path (`BaseOpenAiCompatibleProvider`) to fix two issues:
 *
 * 1. **Reasoning content preservation (quota burn).** The AI SDK path's
 *    `convertToAiSdkMessages` silently dropped `{type: "reasoning"}` content
 *    blocks from assistant messages — there was no case for them in the
 *    assistant-message loop. Kimi K2.x/K3 models require `reasoning_content`
 *    to be echoed back on every tool-call turn to continue their thinking
 *    chain; without it, the model re-derives all prior reasoning from scratch
 *    on every round-trip, burning quota and invalidating the server-side
 *    context cache. The raw SDK path uses `convertToMoonshotFormat`, which
 *    extracts reasoning from content blocks and emits it as the top-level
 *    `reasoning_content` field that Moonshot expects.
 *
 * 2. **Usage / cache metrics.** The AI SDK path never sent
 *    `stream_options: { include_usage: true }`, so Moonshot never emitted a
 *    final usage chunk and the TaskHeader showed zero tokens / zero cost. The
 *    raw SDK path inherits `BaseOpenAiCompatibleProvider`'s streaming, which
 *    always sends `include_usage`, so the upstream emits the final usage chunk
 *    carrying cache metrics.
 *
 * This mirrors the Z.ai handler (`zai.ts`) and DeepSeek handler
 * (`deepseek.ts`), which both use the same `reasoning_content` convention.
 */
export class MoonshotHandler extends BaseOpenAiCompatibleProvider<MoonshotModelId> {
	constructor(options: ApiHandlerOptions) {
		super({
			...options,
			providerName: "moonshot",
			baseURL: options.moonshotBaseUrl || "https://api.moonshot.ai/v1",
			apiKey: options.moonshotApiKey ?? "not-provided",
			defaultProviderModelId: moonshotDefaultModelId,
			providerModels: moonshotModels,
			defaultTemperature: MOONSHOT_DEFAULT_TEMPERATURE,
		})
	}

	/**
	 * Request parameters shared by the streaming and single-shot paths: the
	 * resolved model id, the output-token cap, the pinned temperature for
	 * fixed-temperature Kimi models, and an explicit `reasoning_effort`.
	 *
	 * - Temperature: the thinking / coding Kimi models (kimi-k2-thinking,
	 *   kimi-k2.5, k3, kimi-k3) fix temperature at 1 and reject anything else
	 *   with `400 invalid temperature: only 1 is allowed for this model`. These
	 *   models ignore the sampling temperature anyway, so force 1 for any model
	 *   whose catalog default is 1, regardless of profile.
	 * - Reasoning: K3 models take a top-level reasoning_effort
	 *   ("low" | "high" | "max"). Omitting it means the SERVER default "max" —
	 *   maximum thinking effort on every request — so for models that support
	 *   it we always send an explicit value. Kimi recommends keeping it
	 *   constant for the whole conversation to preserve prefix-cache hits, and
	 *   it is resolved from per-profile settings + the model catalog, both
	 *   stable within a task.
	 */
	private baseRequestParams() {
		const { id: model, info } = this.getModel()

		const max_tokens =
			getModelMaxOutputTokens({
				modelId: model,
				model: info,
				settings: this.options,
				format: "openai",
			}) ?? undefined

		const temperature =
			(info as { defaultTemperature?: number }).defaultTemperature === 1
				? 1
				: (this.options.modelTemperature ?? info.defaultTemperature ?? this.defaultTemperature)

		const reasoning = getMoonshotReasoning({
			model: info,
			reasoningBudget: undefined,
			reasoningEffort: this.options.reasoningEffort,
			settings: this.options,
		})

		return {
			model,
			max_tokens,
			temperature,
			// Kimi's "max" is not in the OpenAI SDK's reasoning_effort union.
			...(reasoning && {
				reasoning_effort:
					reasoning.reasoning_effort as OpenAI.Chat.ChatCompletionCreateParams["reasoning_effort"],
			}),
		}
	}

	/**
	 * Override `createStream` to use Moonshot-specific message conversion that
	 * preserves `reasoning_content` on assistant messages and merges post-tool
	 * text into the last tool message (critical for thinking models).
	 */
	protected override createStream(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
		requestOptions?: OpenAI.RequestOptions,
	) {
		// Use Moonshot format to preserve reasoning_content and merge
		// post-tool text into tool messages.
		const convertedMessages = convertToMoonshotFormat(messages, { mergeToolResultText: true })

		const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
			...this.baseRequestParams(),
			messages: [{ role: "system", content: systemPrompt }, ...convertedMessages],
			stream: true,
			stream_options: { include_usage: true },
			tools: this.convertToolsForOpenAI(metadata?.tools),
			tool_choice: metadata?.tool_choice,
			parallel_tool_calls: metadata?.parallelToolCalls ?? true,
		}

		return this.client.chat.completions.create(params, requestOptions)
	}

	/**
	 * Override the single-shot path (used by e.g. "Enhance prompt") with the
	 * same parameter resolution as the streaming path. The base implementation
	 * sends only `{model, messages}`, which on Kimi K3 means the server-default
	 * `reasoning_effort: "max"` — maximum thinking effort and quota burn for a
	 * one-shot utility call — and no output-token cap.
	 */
	override async completePrompt(prompt: string): Promise<string> {
		const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
			...this.baseRequestParams(),
			messages: [{ role: "user", content: prompt }],
		}

		try {
			const response = await this.client.chat.completions.create(params)
			return response.choices?.[0]?.message.content || ""
		} catch (error) {
			throw handleOpenAIError(error, this.providerName)
		}
	}

	/**
	 * Normalize every tool's parameter schema into the Moonshot-flavored JSON
	 * Schema subset. The Kimi API validates tool schemas and rejects the whole
	 * request (`400 … not a valid moonshot flavored json schema`) for constructs
	 * shofer's generic schemas routinely carry — a `null` enum entry, a nullable
	 * `type: [X, "null"]`, an empty union branch — which surfaces to the user as
	 * "No output generated."
	 */
	protected override convertToolsForOpenAI(
		tools: Parameters<BaseOpenAiCompatibleProvider<MoonshotModelId>["convertToolsForOpenAI"]>[0],
	) {
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
	 *
	 * Moonshot returns `cached_tokens` at the **top level** of the usage object
	 * (not inside `prompt_tokens_details` like standard OpenAI). The base class
	 * reads cache metrics from `prompt_tokens_details.cached_tokens`, so we
	 * normalize the top-level `cached_tokens` into that location and then
	 * delegate to the base implementation for cost calculation.
	 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	protected override processUsageMetrics(usage: any, modelInfo?: ModelInfo) {
		if (usage?.cached_tokens != null) {
			// Normalize Moonshot's top-level cached_tokens into the standard
			// prompt_tokens_details.cached_tokens location so the base class
			// picks it up. Only set if not already present there.
			usage.prompt_tokens_details = {
				...(usage.prompt_tokens_details ?? {}),
				cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens,
			}
		}
		return super.processUsageMetrics(usage, modelInfo)
	}
}
