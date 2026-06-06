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
		const shoferBaseUrl = (options as any).shoferBaseUrl as string | undefined
		const shoferApiKey = (options as any).shoferApiKey as string | undefined
		const shoferModelId = (options as any).shoferModelId as string | undefined
		const resolvedOptions: ApiHandlerOptions = {
			...options,
			openRouterBaseUrl: shoferBaseUrl ?? options.openRouterBaseUrl ?? "http://localhost:30081/v1",
			openRouterApiKey: shoferApiKey ?? options.openRouterApiKey ?? "shofer",
			openRouterModelId: shoferModelId ?? options.openRouterModelId,
		}
		super(resolvedOptions)
	}

	/** @inheritdoc */
	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		// Derive conversation_id from the per-task metadata.  Falls back to a
		// UUID v7 if metadata is missing (e.g. internal calls), ensuring llm-router
		// never receives a request without a conversation_id.
		const conversationId = metadata?.taskId ?? crypto.randomUUID()

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
