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
		// Derive conversation_id from the per-task metadata.  Every regular
		// code path passes metadata with taskId; this will not be undefined
		// in practice.  If it were missing, llm-router would reject the request
		// with HTTP 400, which is the correct behaviour — we want to know.
		const conversationId = metadata!.taskId

		// Patch the OpenAI client so every downstream call to
		// `chat.completions.create` includes `conversation_id`.
		// Also wrap the stream's async iterator to break the esbuild CJS
		// async-generator delegation chain.  The OpenAI SDK Stream iterator is
		// an esbuild-CJS async generator; when its next() is consumed from another
		// CJS async generator (attemptApiRequest), the state-machine delegation
		// silently hangs.  Capturing the raw iterator in a closure and wrapping
		// it in a plain-object iterator breaks the chain.
		// See todos/done/cli-print-stream-hang.md for full investigation.
		const originalCreate = this["client"].chat.completions.create.bind(this["client"].chat.completions)
		this["client"].chat.completions.create = (async (params: any, options?: any) => {
			const body = { conversation_id: conversationId, ...params }
			const stream = (await originalCreate(body, options)) as any
			// Replace Symbol.asyncIterator with a non-state-machine wrapper
			const rawIter = stream[Symbol.asyncIterator]()
			stream[Symbol.asyncIterator] = () => ({
				next: () => rawIter.next(),
				return: rawIter.return?.bind(rawIter),
				[Symbol.asyncIterator]() {
					return this
				},
			})
			return stream
		}) as any

		yield* super.createMessage(systemPrompt, messages, metadata)
	}
}
