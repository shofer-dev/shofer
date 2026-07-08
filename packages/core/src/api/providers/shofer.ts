/**
 * Shofer Router provider — delegates to OpenRouter and injects a per-request
 * `conversation_id` field that the local llm-router requires on every
 * `/v1/chat/completions` call.
 *
 * This provider is designed for connecting Shofer to a locally-running
 * llm-router instance via `--base-url`.  It behaves identically to OpenRouter
 * except that every `createMessage` call stamps the request body with
 * `metadata.taskId` (the per-task UUID v7 identifier) as `conversation_id`.
 *
 * Conversation IDs are per-session (per task), not per-provider-instance,
 * because a single provider/handler is shared across all concurrent tasks.
 * Using `metadata.taskId` gives each task its own stable conversation identity
 * for the lifetime of that task.
 */

import { Anthropic } from "@anthropic-ai/sdk"
import type { ModelRecord } from "@shofer/types"
import type { ApiHandlerOptions } from "./_deps.js"
import type { ApiHandlerCreateMessageMetadata } from "../api-handler-types.js"
import { ApiStream } from "./_deps.js"

import { getModels } from "./fetchers/modelCache.js"
import { OpenRouterHandler } from "./openrouter.js"

export class ShoferHandler extends OpenRouterHandler {
	constructor(options: ApiHandlerOptions) {
		// Map shofer-specific options onto the openrouter handler surface.
		// The canonical model field for the shofer provider is `apiModelId`
		// (the same field the webview's useSelectedModel and the CLI write to);
		// base URL and API key use dedicated shofer-prefixed fields so they do
		// not collide with the openrouter fields the parent handler also reads.
		const shoferBaseUrl = options.shoferBaseUrl
		const shoferApiKey = options.shoferApiKey
		const shoferModelId = options.apiModelId
		const resolvedOptions: ApiHandlerOptions = {
			...options,
			openRouterBaseUrl: shoferBaseUrl ?? options.openRouterBaseUrl ?? "http://localhost:30081/v1",
			openRouterApiKey: shoferApiKey ?? options.openRouterApiKey ?? "shofer",
			openRouterModelId: shoferModelId ?? options.openRouterModelId,
		}
		super(resolvedOptions)
	}

	/**
	 * @inheritdoc
	 *
	 * Unlike OpenRouter, the Shofer provider has no default model. The model is
	 * always supplied explicitly (via `--model` on the CLI or the model field in
	 * settings). Falling back to OpenRouter's default (`anthropic/claude-sonnet-4.5`)
	 * silently misroutes every request to a model the user never asked for, so we
	 * fail loudly instead.
	 */
	override getModel() {
		if (!this.options.openRouterModelId) {
			throw new Error(
				"No model configured for the Shofer provider. Specify a model explicitly " +
					"(e.g. `--model deepseek/deepseek-v4-pro` on the CLI, or the model field in " +
					"settings) — the Shofer provider has no default model.",
			)
		}
		return super.getModel()
	}

	/**
	 * @inheritdoc
	 *
	 * The Shofer provider talks to a local llm-router, not openrouter.ai, so its
	 * model catalog must be fetched from that router (`getModels({ provider: "shofer" })`).
	 * The inherited OpenRouter implementation fetches from openrouter.ai, whose
	 * catalog never contains Shofer-router model ids (e.g. `zhipu/glm-5.2`) — that
	 * miss silently falls back to {@link openRouterDefaultModelInfo} (a 200k-context,
	 * 8k-max-output Claude Sonnet stand-in), which makes context management condense
	 * far too early (e.g. at ~20% of glm-5.2's real 1M window) and caps output tokens
	 * incorrectly. The Shofer router exposes no per-provider endpoints API, so we
	 * return an empty endpoints map.
	 */
	protected override async loadModelsAndEndpoints(): Promise<{ models: ModelRecord; endpoints: ModelRecord }> {
		const models = await getModels({
			provider: "shofer",
			baseUrl: this.options.openRouterBaseUrl,
			apiKey: this.options.openRouterApiKey,
		})

		return { models, endpoints: {} }
	}

	/** @inheritdoc */
	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		// Derive conversation_id from the per-task metadata.  Every regular
		// code path passes metadata with taskId; this will not be undefined
		// in practice.  If it were missing, llm-router would reject the request
		// with HTTP 400, which is the correct behaviour — we want to know.
		const conversationId = metadata!.taskId

		// Patch the OpenAI client so every downstream `chat.completions.create`:
		//  1. carries `conversation_id` (llm-router requires it), and
		//  2. (streaming only) has its chain-of-thought surfaced. GLM/DeepSeek/Moonshot/
		//     Qwen stream thinking as `delta.reasoning_content` (the direct OpenAI-
		//     compatible convention), which llm-router forwards verbatim — but the
		//     inherited OpenRouter loop only reads `delta.reasoning`. We normalize it
		//     here rather than in OpenRouterHandler because reasoning_content does NOT
		//     apply to OpenRouter.ai (it emits `reasoning`); direct OpenAI-compatible
		//     endpoints use the "OpenAI Compatible" provider, which already handles it.
		const originalCreate = this["client"].chat.completions.create.bind(this["client"].chat.completions)
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		this["client"].chat.completions.create = ((params: any, options?: any) => {
			const body = { conversation_id: conversationId, ...params }
			const result = originalCreate(body, options)
			// Non-streaming (completePrompt) needs no transform — pass it through.
			if (!params?.stream) return result
			// `create` is cast to `any` below; `result` is the streaming Promise<Stream>.
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			return (async () => normalizeReasoningStream(await (result as any)))()
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		}) as any

		yield* super.createMessage(systemPrompt, messages, metadata)
	}
}

/**
 * Wrap a streaming chat-completion so each chunk's `delta.reasoning_content`
 * (GLM/DeepSeek/Moonshot/Zhipu convention, forwarded by llm-router) is mirrored
 * into `delta.reasoning` — the field {@link OpenRouterHandler}'s stream loop reads.
 * Only fills `reasoning` when absent so a chunk carrying both never doubles up. The
 * parent consumes the stream purely via `Symbol.asyncIterator`, so an async generator
 * is a drop-in replacement (abort still flows through the request's AbortSignal).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function* normalizeReasoningStream(stream: AsyncIterable<any>): AsyncGenerator<any> {
	for await (const chunk of stream) {
		const delta = chunk?.choices?.[0]?.delta
		if (delta && delta.reasoning == null && typeof delta.reasoning_content === "string") {
			delta.reasoning = delta.reasoning_content
		}
		yield chunk
	}
}
