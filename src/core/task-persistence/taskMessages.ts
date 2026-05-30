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
import { outputWarn } from "../../utils/outputChannelLogger"
import { appendJsonLine, dedupeByKey, readJsonLines, serializeJsonLines, writeJsonLines } from "./jsonlLog"

const LEGACY_UI_MESSAGES = "ui_messages.json"

async function uiMessagesPath(taskId: string, globalStoragePath: string): Promise<string> {
	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
	return path.join(taskDir, GlobalFileNames.uiMessages)
}

async function unlinkLegacyIfPresent(taskDir: string): Promise<void> {
	const legacy = path.join(taskDir, LEGACY_UI_MESSAGES)
	try {
		await fs.unlink(legacy)
		outputWarn(`[readTaskMessages] unlinked legacy ${LEGACY_UI_MESSAGES} (hard cutover to JSONL)`)
	} catch (e: any) {
		if (e && e.code !== "ENOENT") {
			outputWarn(`[readTaskMessages] failed to unlink ${legacy}: ${e.message}`)
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

/** Default window size for the initial webview push (H2). */
export const DEFAULT_WINDOW_LIMIT = 100
