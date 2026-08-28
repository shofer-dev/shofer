/**
 * taskMessages.ts — per-task `shoferMessages` (UI messages) persistence (§5).
 *
 * A FACADE over the task store this host SELECTED (`backend.ts`), not over any
 * particular store. Every function here resolves the backend for the given
 * `globalStoragePath` and delegates to its {@link MessagePersistencePort}
 * methods, so a host running a shared store (several processes serving one pool
 * of tasks) reads and writes the same transcript through these free functions as
 * it does through `Task.getPersistence()`.
 *
 * That equivalence is the whole point, and its absence was a live bug: these
 * functions used to call the SQLite store directly, so a parent asking
 * `wait` about a child driven by another process read an empty
 * transcript from a local `.db` file the child had never written to — reporting
 * the child's status with no result, silently, exactly the failure
 * `backend.ts`'s selection is documented to refuse.
 *
 * Signatures are unchanged, and on the default local host the behaviour is
 * byte-identical: the selected backend IS `SqliteMessagePersistence`. In-place
 * updates (partial→final, `isAnswered` flips, streaming `api_req_started`
 * mutations) re-append the same `ts`, which the store collapses to the latest
 * (last-write-wins per ts).
 */

import type { ShoferMessage } from "@shofer/types"

import { resolveTaskPersistence } from "./backend.js"

export type ReadTaskMessagesOptions = {
	taskId: string
	globalStoragePath: string
}

export async function readTaskMessages({
	taskId,
	globalStoragePath,
}: ReadTaskMessagesOptions): Promise<ShoferMessage[]> {
	return (await resolveTaskPersistence(globalStoragePath)).readTaskMessages(taskId)
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
	await (await resolveTaskPersistence(globalStoragePath)).appendTaskMessage(taskId, message)
}

export type SaveTaskMessagesOptions = {
	messages: ShoferMessage[]
	taskId: string
	globalStoragePath: string
	/** Accepted for signature compatibility; unused (no backend needs a pre-serialized payload). */
	serialized?: string
}

/** Replace the full UI-message set (compaction / overwrite). */
export async function saveTaskMessages({
	messages,
	taskId,
	globalStoragePath,
}: SaveTaskMessagesOptions): Promise<void> {
	await (await resolveTaskPersistence(globalStoragePath)).saveTaskMessages(taskId, messages)
}

export type DisposeAppendHandleForTaskOptions = {
	taskId: string
	globalStoragePath: string
}

/** Release whatever per-task handle the selected backend holds (a no-op for SQLite). */
export async function disposeAppendHandleForTask({
	taskId,
	globalStoragePath,
}: DisposeAppendHandleForTaskOptions): Promise<void> {
	await (await resolveTaskPersistence(globalStoragePath)).disposeAppendHandleForTask(taskId)
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
	return (await resolveTaskPersistence(globalStoragePath)).readTaskMessagesTail(taskId, maxMessages)
}
