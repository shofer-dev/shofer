import * as fs from "node:fs/promises"
import * as path from "node:path"

import type { HistoryItem } from "@shofer/types"

import { GlobalFileNames } from "../shared/globalFileNames.js"
import { safeWriteJson } from "../utils/safeWriteJson.js"
import { getStorageBasePath } from "../utils/storage.js"

/**
 * Task-metadata persistence (v3 architecture §5) — the sibling of the message
 * port.
 *
 * A task's metadata is its {@link HistoryItem}: the record a host needs to LIST
 * a task and to rehydrate it without reading a single message. `taskMetadata.ts`
 * COMPUTES that record from the live message log; this port is where the record
 * is kept. The two are deliberately separate: computing a history item is pure
 * and host-agnostic, storing one is a backend decision.
 *
 * The default backend is a file per task —
 * `<storage>/tasks/<taskId>/history_item.json` — which is exactly what the
 * on-disk layout has always been. It is a port rather than a hard-coded file
 * write because the metadata must travel with the messages: a backend that
 * shares the transcript across processes but leaves the history item on a local
 * disk cannot rehydrate a task anywhere but where it was created, which is the
 * failure the seam exists to prevent.
 */

/** A task's persisted {@link HistoryItem}, keyed by task id. */
export interface TaskMetadataPersistencePort {
	/** The task's history item, or `undefined` when the backend has no record. */
	readTaskMetadata(taskId: string): Promise<HistoryItem | undefined>
	/** Insert or replace a task's history item. `item.id` is the key. */
	writeTaskMetadata(item: HistoryItem): Promise<void>
	/** Remove a task's history item. Removing an absent record is not an error. */
	deleteTaskMetadata(taskId: string): Promise<void>
	/** Every task id the backend holds metadata for, in no particular order. */
	listTaskMetadataIds(): Promise<string[]>
}

/**
 * File-backed metadata: one `history_item.json` per task directory.
 *
 * Writes go through `safeWriteJson`, whose `proper-lockfile` guard is what makes
 * two processes sharing one storage directory safe; reads fail closed (a missing
 * or corrupt file reads as "no record") so a damaged file costs one task's
 * listing rather than the whole store.
 */
export class FileTaskMetadataPersistence implements TaskMetadataPersistencePort {
	constructor(private readonly globalStoragePath: string) {}

	async readTaskMetadata(taskId: string): Promise<HistoryItem | undefined> {
		try {
			const raw = await fs.readFile(await this.filePath(taskId), "utf8")
			const item = JSON.parse(raw) as HistoryItem
			return item?.id ? item : undefined
		} catch {
			return undefined
		}
	}

	async writeTaskMetadata(item: HistoryItem): Promise<void> {
		await safeWriteJson(await this.filePath(item.id), item)
	}

	async deleteTaskMetadata(taskId: string): Promise<void> {
		try {
			await fs.unlink(await this.filePath(taskId))
		} catch {
			// Already gone — the post-condition holds either way.
		}
	}

	/**
	 * Task ids are the SUBDIRECTORY names under `tasks/`, not the files that
	 * happen to carry metadata: the index (`_index.json`) and dotfiles live in
	 * the same directory and are filtered by prefix.
	 */
	async listTaskMetadataIds(): Promise<string[]> {
		try {
			const entries = await fs.readdir(await this.tasksDir())
			return entries.filter((name) => !name.startsWith("_") && !name.startsWith("."))
		} catch {
			return []
		}
	}

	private async tasksDir(): Promise<string> {
		return path.join(await getStorageBasePath(this.globalStoragePath), "tasks")
	}

	private async filePath(taskId: string): Promise<string> {
		return path.join(await this.tasksDir(), taskId, GlobalFileNames.historyItem)
	}
}
