import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import type { ModelInfo } from "@shofer/types"

import { ApiStream } from "./transform/stream.js"

export interface SingleCompletionHandler {
	completePrompt(prompt: string): Promise<string>
}

export interface ApiHandlerCreateMessageMetadata {
	/**
	 * Task ID used for tracking and provider-specific features:
	 * - Shofer: Sent as X-Shofer-Task-ID header
	 * - Requesty: Sent as trace_id
	 */
	taskId: string
	/**
	 * The task this one was spawned from, when it is a subtask.
	 *
	 * Absent on a root task — a root has no parent — which is the same shape the
	 * task's own `HistoryItem` carries, and providers that forward it must omit
	 * the field rather than substitute the task's own id.
	 */
	parentTaskId?: string
	/**
	 * The top-level task of the tree this one belongs to, when it is a subtask.
	 *
	 * This is the ROOT, at any depth — one hop, never a walk up the parents — so
	 * a grandchild names the same task as its parent does. Absent on a root task,
	 * for the same reason `parentTaskId` is.
	 *
	 * It is per-REQUEST rather than per-handler on purpose: one handler instance
	 * is shared across every concurrent task, so anything the handler remembered
	 * about a task tree would be the wrong tree for the next request through it.
	 */
	rootTaskId?: string
	/**
	 * Current mode slug for provider-specific tracking:
	 * - Requesty: Sent in extra metadata
	 */
	mode?: string
	suppressPreviousResponseId?: boolean
	/**
	 * Controls whether the response should be stored for 30 days in OpenAI's Responses API.
	 * When true (default), responses are stored and can be referenced in future requests
	 * using the previous_response_id for efficient conversation continuity.
	 * Set to false to opt out of response storage for privacy or compliance reasons.
	 * @default true
	 */
	store?: boolean
	/**
	 * Optional array of tool definitions to pass to the model.
	 * For OpenAI-compatible providers, these are ChatCompletionTool definitions.
	 */
	tools?: OpenAI.Chat.ChatCompletionTool[]
	/**
	 * Controls which (if any) tool is called by the model.
	 * Can be "none", "auto", "required", or a specific tool choice.
	 */
	tool_choice?: OpenAI.Chat.ChatCompletionCreateParams["tool_choice"]
	/**
	 * Controls whether the model can return multiple tool calls in a single response.
	 * When true (default), parallel tool calls are enabled (OpenAI's parallel_tool_calls=true).
	 * When false, only one tool call is returned per response.
	 */
	parallelToolCalls?: boolean
	/**
	 * Optional array of tool names that the model is allowed to call.
	 * When provided, all tool definitions are passed to the model (so it can reference
	 * historical tool calls), but only the specified tools can actually be invoked.
	 * This is used when switching modes to prevent model errors from missing tool
	 * definitions while still restricting callable tools to the current mode's permissions.
	 * Only applies to providers that support function calling restrictions (e.g., Gemini).
	 */
	allowedFunctionNames?: string[]
}

export interface ApiHandler {
	createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream

	getModel(): { id: string; info: ModelInfo }

	/**
	 * Counts tokens for content blocks
	 * All providers extend BaseProvider which provides a default tiktoken implementation,
	 * but they can override this to use their native token counting endpoints
	 *
	 * @param content The content to count tokens for
	 * @returns A promise resolving to the token count
	 */
	countTokens(content: Array<Anthropic.Messages.ContentBlockParam>): Promise<number>
}
