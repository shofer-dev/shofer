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
import { ApiStream, ApiStreamChunk } from "../transform/stream"

import { OpenRouterHandler } from "./openrouter"

/**
 * Wrap an AsyncGenerator into a runtime-constructed AsyncIterable to break
 * esbuild CJS async-generator state-machine delegation chains.
 *
 * When two esbuild-CJS async generators are linked via yield*, esbuild's
 * state-machine transform creates a delegation chain that silently hangs
 * when the outermost iterator is consumed from yet another CJS async generator.
 * Converting the inner generator into a plain function-based async iterator
 * (no compile-time state machine) breaks the chain.
 *
 * See todos/cli_hang_bug.md for full investigation.
 */
function _wrapAsyncGenerator<T>(gen: AsyncGenerator<T>): AsyncGenerator<T> {
	const iter = gen[Symbol.asyncIterator]()
	return {
		next: () => iter.next(),
		return: iter.return?.bind(iter),
		throw: iter.throw?.bind(iter),
		[Symbol.asyncIterator]() {
			return this
		},
	} as AsyncGenerator<T>
}

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
	// eslint-disable-next-line require-yield
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

		// Delegate to the parent async generator via a plain-function-based wrapper
		// to avoid esbuild CJS async-generator state-machine entanglement.
		// yield* between two esbuild-CJS async generators creates a delegation chain
		// that hangs when the outer iterator is consumed from yet another CJS async
		// generator (attemptApiRequest).  Converting the inner generator into a
		// runtime-constructed AsyncIterator object (no compile-time state machine)
		// breaks the chain.  See todos/cli_hang_bug.md.
		return _wrapAsyncGenerator(super.createMessage(systemPrompt, messages, metadata))
	}
}
