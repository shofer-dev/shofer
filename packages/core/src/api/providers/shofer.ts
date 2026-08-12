/**
 * Shofer Router provider — delegates to OpenRouter and injects a per-request
 * `task_id` field that the local llm-router requires on every
 * `/v1/chat/completions` call.
 *
 * This provider is designed for connecting Shofer to a locally-running
 * llm-router instance via `--base-url`.  It behaves like OpenRouter except for
 * the three fields llm-router owns on the request body: `task_id`
 * (`metadata.taskId`, the per-task UUID v7 identifier, required), `human_text`
 * (the human's own words on turns that have them) and `reasoning` (the router's
 * thinking directive — see {@link shoferReasoningDirective}).
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
import { humanTextOfLastMessage } from "../../utils/user-message.js"

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
		// Derive task_id from the per-task metadata.  Every regular
		// code path passes metadata with taskId; this will not be undefined
		// in practice.  If it were missing, llm-router would reject the request
		// with HTTP 400, which is the correct behaviour — we want to know.
		const taskId = metadata!.taskId

		// The human's own words in this request's last message, recovered from the
		// block Shofer marked when it assembled the turn (`utils/user-message`).
		// `undefined` for a tool-result round or an environment refresh, which is
		// the honest answer: those turns contain nothing the human typed.
		//
		// It travels as a SIBLING of `task_id`, never inside `messages`: llm-router
		// records it as labelled metadata beside the verbatim content, so its
		// transcript reader looks up a field instead of pattern-matching the
		// `<user_message>` / `<environment_details>` markup out of the prompt. The
		// prompt itself is untouched — llm-router strips both router-internal
		// fields before forwarding upstream, and `messages` is byte-for-byte what
		// it was.
		const humanText = humanTextOfLastMessage(messages)

		// The thinking directive for this request, derived from the user's settings
		// rather than from what the model catalog happens to know (see
		// {@link shoferReasoningDirective}).
		const reasoning = shoferReasoningDirective(this.options)

		// Patch the OpenAI client so every downstream `chat.completions.create`:
		//  1. carries `task_id` (llm-router requires it) and, when this turn has
		//     one, `human_text`, and
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
			// `reasoning` on this wire is OURS alone. The inherited OpenRouter path
			// may also compute one (once a model advertises `supportsReasoningEffort`,
			// and unconditionally as `{ exclude: true }` for Gemini 2.5 Pro ids), but
			// that object speaks OpenRouter's vocabulary — `exclude`, no `enabled` —
			// which llm-router does not accept, and it is computed from the catalog
			// rather than from the user's explicit choice. So drop it and substitute
			// the directive derived below; when we derive none, the field is absent
			// entirely and the router applies the provider default.
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const { reasoning: _openRouterReasoning, ...rest } = (params ?? {}) as any
			const body = {
				task_id: taskId,
				...(humanText ? { human_text: humanText } : {}),
				...rest,
				...(reasoning ? { reasoning } : {}),
			}
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
 * llm-router's reasoning directive, as accepted on `POST /v1/chat/completions`
 * beside `messages` (see llm-router's PROTOCOL.md for the authoritative shape).
 * Every member is optional; the router applies the calling provider's default
 * for whatever the directive leaves unsaid.
 */
export type ShoferReasoningDirective = {
	enabled?: boolean
	effort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "none"
	max_tokens?: number
}

/**
 * Translate Shofer's reasoning settings into llm-router's directive.
 *
 * Two properties of the router make this a deliberate translation rather than a
 * pass-through of the OpenRouter shape the parent handler builds:
 *
 * 1. **Off must be EXPLICIT on the wire.** The router turns thinking ON by
 *    default for several upstream providers, so omitting the field means
 *    "provider default", i.e. thinking. `enableReasoningEffort === false` must
 *    therefore SEND `{ enabled: false }`, and it does so unconditionally —
 *    independent of `supportsReasoningEffort` on the model. Gating the off
 *    switch on the catalog would make "no thinking" contingent on the catalog
 *    knowing the model thinks, which is exactly backwards: a model whose
 *    capability flag is missing is the case where thinking arrives unasked. The
 *    router ignores the directive for a model that cannot think, so sending it
 *    costs nothing.
 * 2. **The vocabularies differ.** Shofer's user-facing setting carries a
 *    `"disable"` sentinel (`reasoningEffortSettingValues` in `@shofer/types`)
 *    that the router does not know; it maps onto the router's `"none"`. Every
 *    other value — `minimal`/`low`/`medium`/`high`/`xhigh`/`none` — is spelled
 *    identically on both sides and passes through unchanged.
 *
 * Precedence, highest first: the explicit off switch, then a selected effort
 * (carrying `max_tokens` alongside when a thinking budget is also set), then a
 * budget on its own. Nothing set yields `undefined` — the field is omitted and
 * the provider's own default stands.
 */
export function shoferReasoningDirective(options: ApiHandlerOptions): ShoferReasoningDirective | undefined {
	if (options.enableReasoningEffort === false) return { enabled: false }

	const budget = options.modelMaxThinkingTokens
	const effort = options.reasoningEffort

	if (effort) {
		return {
			effort: effort === "disable" ? "none" : effort,
			...(budget !== undefined && { max_tokens: budget }),
		}
	}

	if (budget !== undefined) return { max_tokens: budget }

	return undefined
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
