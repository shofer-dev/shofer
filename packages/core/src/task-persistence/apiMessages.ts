/**
 * apiMessages.ts — per-task `apiConversationHistory` persistence (§5).
 *
 * SQLite-backed via the shared message store. The function signatures are
 * unchanged so all callers (`Task`, `condense`, `context-management`,
 * `WaitForTaskTool`, etc.) are unaffected; the prior JSONL implementation and its
 * flat-file performance machinery have been removed.
 */

import { Anthropic } from "@anthropic-ai/sdk"

import { storeAppend, storeReadAll, storeReadTail, storeSaveAll } from "./message-store.js"

export type ApiMessage = Anthropic.MessageParam & {
	ts?: number
	isSummary?: boolean
	id?: string
	// For reasoning items stored in API history
	type?: "reasoning"
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- provider-specific reasoning payload
	summary?: any[]
	encrypted_content?: string
	text?: string
	// For OpenRouter reasoning_details array format (used by Gemini 3, etc.)
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- provider-specific reasoning payload
	reasoning_details?: any[]
	// For DeepSeek/Z.ai interleaved thinking: reasoning_content that must be preserved during tool call sequences
	// See: https://api-docs.deepseek.com/guides/thinking_mode#tool-calls
	reasoning_content?: string
	// For non-destructive condense: unique identifier for summary messages
	condenseId?: string
	// For non-destructive condense: points to the condenseId of the summary that replaces this message
	// Messages with condenseParent are filtered out when sending to API if the summary exists
	condenseParent?: string
	// For non-destructive truncation: unique identifier for truncation marker messages
	truncationId?: string
	// For non-destructive truncation: points to the truncationId of the marker that hides this message
	// Messages with truncationParent are filtered out when sending to API if the marker exists
	truncationParent?: string
	// Identifies a message as a truncation boundary marker
	isTruncationMarker?: boolean
}

export async function readApiMessages({
	taskId,
	globalStoragePath,
}: {
	taskId: string
	globalStoragePath: string
}): Promise<ApiMessage[]> {
	return storeReadAll<ApiMessage>(globalStoragePath, taskId, "api")
}

export type ReadApiMessagesTailOptions = {
	taskId: string
	globalStoragePath: string
	/** Maximum number of records to read from the tail of the log. */
	maxMessages: number
}

/**
 * Read the last `maxMessages` records of the task's API conversation history.
 * Returns `[messages, hasMore]` — `hasMore` is `true` when older messages exist
 * outside the returned window.
 */
export async function readApiMessagesTail({
	taskId,
	globalStoragePath,
	maxMessages,
}: ReadApiMessagesTailOptions): Promise<[ApiMessage[], boolean]> {
	return storeReadTail<ApiMessage>(globalStoragePath, taskId, "api", maxMessages)
}

export type AppendApiMessageOptions = {
	message: ApiMessage
	taskId: string
	globalStoragePath: string
}

/**
 * Append a single `ApiMessage`. Reads dedupe by `ts`, so callers may safely
 * re-append a mutated message in place (same `ts`).
 */
export async function appendApiMessage({ message, taskId, globalStoragePath }: AppendApiMessageOptions): Promise<void> {
	await storeAppend(globalStoragePath, taskId, "api", message)
}

export type SaveApiMessagesOptions = {
	messages: ApiMessage[]
	taskId: string
	globalStoragePath: string
	/** Accepted for signature compatibility; unused (SQLite needs no pre-serialized payload). */
	serialized?: string
}

/** Replace the full API conversation history (overwrite / recovery). */
export async function saveApiMessages({ messages, taskId, globalStoragePath }: SaveApiMessagesOptions): Promise<void> {
	await storeSaveAll(globalStoragePath, taskId, "api", messages)
}
