import { safeWriteJson } from "../../utils/safeWriteJson"
import * as path from "path"
import * as fs from "fs/promises"

import type { ShoferMessage } from "@shofer/types"

import { fileExistsAtPath } from "../../utils/fs"

import { GlobalFileNames } from "../../shared/globalFileNames"
import { getTaskDirectoryPath } from "../../utils/storage"
import { outputWarn } from "../../utils/outputChannelLogger"

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
	const fileExists = await fileExistsAtPath(filePath)

	if (fileExists) {
		try {
			const parsedData = JSON.parse(await fs.readFile(filePath, "utf8"))
			if (!Array.isArray(parsedData)) {
				outputWarn(
					`[readTaskMessages] Parsed data is not an array (got ${typeof parsedData}), returning empty. TaskId: ${taskId}, Path: ${filePath}`,
				)
				return []
			}
			return parsedData
		} catch (error) {
			outputWarn(
				`[readTaskMessages] Failed to parse ${filePath} for task ${taskId}, returning empty: ${error instanceof Error ? error.message : String(error)}`,
			)
			return []
		}
	}

	return []
}

export type SaveTaskMessagesOptions = {
	messages: ShoferMessage[]
	taskId: string
	globalStoragePath: string
	/**
	 * Optional pre-serialized JSON form of `messages`. When provided, the
	 * writer skips serialization and writes this string verbatim to disk.
	 * The caller is responsible for producing it synchronously from the
	 * same `messages` reference (e.g. via `JSON.stringify`) to capture a
	 * snapshot that cannot be mutated mid-write. See H6 in
	 * `todos/performance_optimizations.md`.
	 */
	serialized?: string
}

export async function saveTaskMessages({ messages, taskId, globalStoragePath, serialized }: SaveTaskMessagesOptions) {
	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
	const filePath = path.join(taskDir, GlobalFileNames.uiMessages)
	await safeWriteJson(filePath, messages, serialized !== undefined ? { preSerialized: serialized } : undefined)
}
