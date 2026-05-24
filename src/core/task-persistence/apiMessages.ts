/**
 * apiMessages.ts — JSONL persistence for per-task `apiConversationHistory`.
 *
 * Mirrors `taskMessages.ts`: one `ApiMessage` JSON record per line in
 * `api_conversation_history.jsonl`. `appendApiMessage` is the O(1) hot path
 * (`addToApiConversationHistory`, `flushPendingToolResultsToHistory`);
 * `saveApiMessages` is the atomic compaction used by
 * `overwriteApiConversationHistory` and `retrySaveApiConversationHistory`.
 *
 * Hard cutover: both `api_conversation_history.json` and the pre-rename
 * `claude_messages.json` are unlinked on first read and treated as missing.
 */

import * as path from "path"
import * as fs from "fs/promises"

import { Anthropic } from "@anthropic-ai/sdk"

import { GlobalFileNames } from "../../shared/globalFileNames"
import { getTaskDirectoryPath } from "../../utils/storage"
import { outputWarn } from "../../utils/outputChannelLogger"
import { appendJsonLine, dedupeByKey, readJsonLines, serializeJsonLines, writeJsonLines } from "./jsonlLog"

export type ApiMessage = Anthropic.MessageParam & {
	ts?: number
	isSummary?: boolean
	id?: string
	// For reasoning items stored in API history
	type?: "reasoning"
	summary?: any[]
	encrypted_content?: string
	text?: string
	// For OpenRouter reasoning_details array format (used by Gemini 3, etc.)
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

const LEGACY_API_FILES = ["api_conversation_history.json", "claude_messages.json"]

async function apiHistoryPath(taskId: string, globalStoragePath: string): Promise<string> {
	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
	return path.join(taskDir, GlobalFileNames.apiConversationHistory)
}

async function unlinkLegacyIfPresent(taskDir: string): Promise<void> {
	for (const name of LEGACY_API_FILES) {
		const legacy = path.join(taskDir, name)
		try {
			await fs.unlink(legacy)
			outputWarn(`[readApiMessages] unlinked legacy ${name} (hard cutover to JSONL)`)
		} catch (e: any) {
			if (e && e.code !== "ENOENT") {
				outputWarn(`[readApiMessages] failed to unlink ${legacy}: ${e.message}`)
			}
		}
	}
}

export async function readApiMessages({
	taskId,
	globalStoragePath,
}: {
	taskId: string
	globalStoragePath: string
}): Promise<ApiMessage[]> {
	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
	const filePath = path.join(taskDir, GlobalFileNames.apiConversationHistory)
	const parsed = await readJsonLines<ApiMessage>(filePath)
	if (parsed === null) {
		await unlinkLegacyIfPresent(taskDir)
		return []
	}
	return dedupeByKey(parsed, (m) => m.ts)
}

export type AppendApiMessageOptions = {
	message: ApiMessage
	taskId: string
	globalStoragePath: string
}

/**
 * Append a single `ApiMessage` to the JSONL log. O(1) per call.
 * The read path dedupes by `ts`, so callers may safely re-append a mutated
 * message in place (same `ts`).
 */
export async function appendApiMessage({ message, taskId, globalStoragePath }: AppendApiMessageOptions): Promise<void> {
	const filePath = await apiHistoryPath(taskId, globalStoragePath)
	await appendJsonLine(filePath, message)
}

export type SaveApiMessagesOptions = {
	messages: ApiMessage[]
	taskId: string
	globalStoragePath: string
	/**
	 * Optional pre-serialized JSONL payload. See `taskMessages.ts` for H6
	 * snapshot semantics.
	 */
	serialized?: string
}

/**
 * Compaction: atomic full rewrite of the JSONL log.
 */
export async function saveApiMessages({
	messages,
	taskId,
	globalStoragePath,
	serialized,
}: SaveApiMessagesOptions): Promise<void> {
	const filePath = await apiHistoryPath(taskId, globalStoragePath)
	const content = serialized ?? serializeJsonLines(messages)
	await writeJsonLines(filePath, content)
}
