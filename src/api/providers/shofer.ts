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
import OpenAI from "openai"
import type { ApiHandlerOptions } from "../../shared/api"
import type { ApiHandlerCreateMessageMetadata } from "../index"
import { ApiStream } from "../transform/stream"

import { OpenRouterHandler } from "./openrouter"

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

		// Patch the OpenAI client so every downstream call to
		// `chat.completions.create` includes `conversation_id`.
		const originalCreate = this["client"].chat.completions.create.bind(this["client"].chat.completions)
		this["client"].chat.completions.create = ((params: any, options?: any) => {
			const body = { conversation_id: conversationId, ...params }
			return originalCreate(body, options)
		}) as any

		yield* super.createMessage(systemPrompt, messages, metadata)
	}
}
