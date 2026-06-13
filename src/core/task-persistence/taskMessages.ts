/**
 * taskMessages.ts — JSONL persistence for per-task `shoferMessages`.
 *
 * On-disk layout (`ui_messages.jsonl` under the task directory): one
 * `ShoferMessage` JSON record per line. New messages are appended in O(1)
 * via `appendTaskMessage`; in-place updates (partial→final transitions,
 * `isAnswered` flips, streaming `api_req_started.text` mutations) re-append
 * the mutated message with the same `ts` — `readTaskMessages` collapses
 * duplicates via `dedupeByKey`, preserving first-occurrence position.
 *
 * Compaction (full atomic rewrite) happens via `saveTaskMessages` and is
 * triggered at turn boundaries (`_flushSaveShoferMessages`, `dispose`,
 * `abortTask`) and on `overwriteShoferMessages` (checkpoint restore,
 * edit, delete). See §4.1 of `docs/mem-utilization-profiling.md`.
 *
 * Hard cutover: a legacy `ui_messages.json` snapshot (pre-JSONL) is
 * unlinked on first read and treated as missing, per the "No Backward
 * Compatibility Unless Asked" repo rule.
 */

import * as path from "path"
import * as fs from "fs/promises"

import type { ShoferMessage } from "@shofer/types"

import { GlobalFileNames } from "../../shared/globalFileNames"
import { getTaskDirectoryPath } from "../../utils/storage"
import { taskLog } from "../../utils/logging/subsystems"
import {
	appendJsonLine,
	dedupeByKey,
	disposeAppendHandle,
	readJsonLines,
	serializeJsonLines,
	writeJsonLines,
} from "./jsonlLog"

const LEGACY_UI_MESSAGES = "ui_messages.json"

async function uiMessagesPath(taskId: string, globalStoragePath: string): Promise<string> {
	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
	return path.join(taskDir, GlobalFileNames.uiMessages)
}

async function unlinkLegacyIfPresent(taskDir: string): Promise<void> {
	const legacy = path.join(taskDir, LEGACY_UI_MESSAGES)
	try {
		await fs.unlink(legacy)
		taskLog.warn(`[readTaskMessages] unlinked legacy ${LEGACY_UI_MESSAGES} (hard cutover to JSONL)`)
	} catch (e: any) {
		if (e && e.code !== "ENOENT") {
			taskLog.warn(`[readTaskMessages] failed to unlink ${legacy}: ${e.message}`)
		}
	}
}

export type ReadTaskMessagesOptions = {
	taskId: string
	globalStoragePath: string
}

export async function readTaskMessages({
	taskId,
	globalStoragePath,
}: ReadTaskMessagesOptions): Promise<ShoferMessage[]> {
	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
	const filePath = path.join(taskDir, GlobalFileNames.uiMessages)
	const parsed = await readJsonLines<ShoferMessage>(filePath)
	if (parsed === null) {
		// JSONL file absent — opportunistically discard the legacy snapshot
		// if it was left behind from a pre-JSONL build.
		await unlinkLegacyIfPresent(taskDir)
		return []
	}
	return dedupeByKey(parsed, (m) => m.ts)
}

export type AppendTaskMessageOptions = {
	message: ShoferMessage
	taskId: string
	globalStoragePath: string
}

/**
 * Append a single `ShoferMessage` to the task's JSONL log. O(1) per call.
 *
 * Safe to use both for newly created messages (from `addToShoferMessages`)
 * and for mutated existing messages (from `updateShoferMessage`): the read
 * path dedupes by `ts`, so the latest appended copy wins while position is
 * preserved.
 */
export async function appendTaskMessage({
	message,
	taskId,
	globalStoragePath,
}: AppendTaskMessageOptions): Promise<void> {
	const filePath = await uiMessagesPath(taskId, globalStoragePath)
	await appendJsonLine(filePath, message)
}

export type SaveTaskMessagesOptions = {
	messages: ShoferMessage[]
	taskId: string
	globalStoragePath: string
	/**
	 * Optional pre-serialized JSONL payload (already includes trailing
	 * newlines). When provided, the writer skips serialization and writes
	 * this string verbatim. Callers SHOULD build it synchronously via
	 * `serializeJsonLines` against the same `messages` reference to capture
	 * a snapshot the async write cannot race (H6).
	 */
	serialized?: string
}

/**
 * Compaction: atomically replace the JSONL log with the full in-memory
 * array. Used at turn boundaries and from `overwrite*` paths to bound the
 * log size and remove superseded duplicates.
 */
export async function saveTaskMessages({
	messages,
	taskId,
	globalStoragePath,
	serialized,
}: SaveTaskMessagesOptions): Promise<void> {
	const filePath = await uiMessagesPath(taskId, globalStoragePath)
	const content = serialized ?? serializeJsonLines(messages)
	await writeJsonLines(filePath, content)
}

export type DisposeAppendHandleForTaskOptions = {
	taskId: string
	globalStoragePath: string
}

/**
 * Release the long-lived append file handle cached for this task's JSONL log.
 * Safe to call multiple times; no-op if no handle is cached.
 *
 * Called from `Task.dispose()` (reached via `abortTask()`) so the fd is not
 * leaked across task instances.
 */
export async function disposeAppendHandleForTask({
	taskId,
	globalStoragePath,
}: DisposeAppendHandleForTaskOptions): Promise<void> {
	const filePath = await uiMessagesPath(taskId, globalStoragePath)
	disposeAppendHandle(filePath)
}

// ---- Tail-read (T1.B) ----

export type ReadTaskMessagesTailOptions = {
	taskId: string
	globalStoragePath: string
	/** Maximum number of records to read from the tail of the JSONL log. */
	maxMessages: number
}

/**
 * Read the last `maxMessages` *unique* messages from the task's JSONL log.
 *
 * Returns `[messages, hasMore]` — `hasMore` is `true` when there are older
 * messages not included in the returned window. Used on cold task-switch to
 * bound the payload sent to the webview for long tasks.
 *
 * **Windows by deduped message, not by raw line.** The log is append-only and
 * re-appends a line on *every* message mutation (one per streaming chunk, per
 * `api_req_started` usage update, …), so the line count can be many times the
 * unique-message count. A naive line-tail (`readJsonLinesTail`) therefore
 * returned the wrong slice on logs that weren't fully compacted: it could
 * dedupe down to a handful of messages — sometimes only the last — and set
 * `hasMore=true` for tasks with well under `maxMessages` real messages (the
 * spurious "Load older messages" sentinel). We dedupe the full log first, then
 * take the last window. This reads + parses the whole UI-messages file (the
 * api-conversation history is already read in full on this path), trading that
 * read cost for a correct window; the webview still only receives `maxMessages`.
 *
 * Falls back to the full deduped log when `maxMessages` is zero/negative or the
 * task has `<= maxMessages` unique messages.
 */
export async function readTaskMessagesTail({
	taskId,
	globalStoragePath,
	maxMessages,
}: ReadTaskMessagesTailOptions): Promise<[ShoferMessage[], boolean]> {
	const all = await readTaskMessages({ taskId, globalStoragePath })
	if (maxMessages <= 0 || all.length <= maxMessages) {
		return [all, false]
	}
	return [all.slice(-maxMessages), true]
}
