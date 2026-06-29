/**
 * taskMessages.ts — per-task `shoferMessages` (UI messages) persistence (§5).
 *
 * SQLite-backed via the shared message store. Signatures are unchanged so all
 * callers are unaffected; the prior JSONL implementation and its flat-file
 * performance machinery have been removed. In-place updates (partial→final,
 * `isAnswered` flips, streaming `api_req_started` mutations) re-append the same
 * `ts`, which the store collapses to the latest (last-write-wins per ts).
 */

import type { ShoferMessage } from "@shofer/types"

import { storeAppend, storeReadAll, storeReadTail, storeSaveAll } from "./message-store"

export type ReadTaskMessagesOptions = {
	taskId: string
	globalStoragePath: string
}

export async function readTaskMessages({
	taskId,
	globalStoragePath,
}: ReadTaskMessagesOptions): Promise<ShoferMessage[]> {
	return storeReadAll<ShoferMessage>(globalStoragePath, taskId, "ui")
}

export type AppendTaskMessageOptions = {
	message: ShoferMessage
	taskId: string
	globalStoragePath: string
}

/** Append a single `ShoferMessage`. Re-appending the same `ts` updates in place. */
export async function appendTaskMessage({
	message,
	taskId,
	globalStoragePath,
}: AppendTaskMessageOptions): Promise<void> {
	await storeAppend(globalStoragePath, taskId, "ui", message)
}

export type SaveTaskMessagesOptions = {
	messages: ShoferMessage[]
	taskId: string
	globalStoragePath: string
	/** Accepted for signature compatibility; unused (SQLite needs no pre-serialized payload). */
	serialized?: string
}

/** Replace the full UI-message set (compaction / overwrite). */
export async function saveTaskMessages({
	messages,
	taskId,
	globalStoragePath,
}: SaveTaskMessagesOptions): Promise<void> {
	await storeSaveAll(globalStoragePath, taskId, "ui", messages)
}

export type DisposeAppendHandleForTaskOptions = {
	taskId: string
	globalStoragePath: string
}

/** No-op: the SQLite backend keeps no long-lived per-task file handle. Kept for signature compatibility. */
export async function disposeAppendHandleForTask(_options: DisposeAppendHandleForTaskOptions): Promise<void> {
	// nothing to release
}

export type ReadTaskMessagesTailOptions = {
	taskId: string
	globalStoragePath: string
	/** Maximum number of records to read from the tail of the log. */
	maxMessages: number
}

/**
 * Read the last `maxMessages` messages; returns `[messages, hasMore]` (`hasMore`
 * is `true` when older messages exist outside the window).
 */
export async function readTaskMessagesTail({
	taskId,
	globalStoragePath,
	maxMessages,
}: ReadTaskMessagesTailOptions): Promise<[ShoferMessage[], boolean]> {
	return storeReadTail<ShoferMessage>(globalStoragePath, taskId, "ui", maxMessages)
}
