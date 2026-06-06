/**
 * Shofer Router provider — wraps OpenRouter's handler and injects a required
 * conversation_id field that the local llm-router requires on every request.
 *
 * This provider is designed for connecting Shofer to a locally-running
 * llm-router instance via --base-url. It behaves identically to OpenRouter
 * except that it auto-generates a UUID v7 conversation_id for every request
 * and injects it into the HTTP request body.
 */

import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"
import { v7 as uuidv7 } from "uuid"
import type { ModelRecord } from "@shofer/types"
import type { ApiHandlerOptions } from "../../shared/api"
import type { ApiHandlerCreateMessageMetadata } from "../index"
import { ApiStream } from "../transform/stream"

import { OpenRouterHandler } from "./openrouter"

/**
 * ShoferHandler extends OpenRouterHandler to inject conversation_id into
 * every chat completion request body. llm-router requires this field as a
 * hard binding; without it, every request returns HTTP 400.
 */
export class ShoferHandler extends OpenRouterHandler {
	/** Stable conversation identifier auto-generated per handler instance. */
	private readonly conversationId: string

	constructor(options: ApiHandlerOptions) {
		// Map shofer-specific options onto the openrouter handler surface.
		// baseUrl: the llm-router base URL (e.g. http://localhost:30081/v1).
		// apiKey: any non-empty value passes llm-router's auth middleware.
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
		this.conversationId = uuidv7()
	}

	/** @inheritdoc */
	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		// Wrap the OpenAI client's chat.completions.create to inject
		// conversation_id into every request body before dispatch.
		const originalCreate = this["client"].chat.completions.create.bind(this["client"].chat.completions)
		this["client"].chat.completions.create = ((params: any, options?: any) => {
			const body = {
				conversation_id: this.conversationId,
				...params,
			}
			return originalCreate(body, options)
		}) as any

		yield* super.createMessage(systemPrompt, messages, metadata)
	}
}
