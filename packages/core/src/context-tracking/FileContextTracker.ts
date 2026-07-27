import { safeWriteJson } from "../utils/safeWriteJson.js"
import { fileExistsAtPath } from "../fs/fs.js"
import * as path from "path"
import type { HostFileWatcher } from "@shofer/types"
import { getHost } from "@shofer/types"
import { getTaskDirectoryPath } from "../utils/storage.js"
import { GlobalFileNames } from "../shared/globalFileNames.js"
import fs from "fs/promises"
import { pluginRegistry } from "../plugins/plugin-registry.js"
import { type FileMetadataEntry, type RecordSource, type TaskMetadata } from "./FileContextTrackerTypes.js"
import { type TaskProviderLike } from "../task-provider/index.js"
import { taskLog } from "../logging/subsystems.js"

// This class is responsible for tracking file operations that may result in stale context.
// If a user modifies a file outside of Shofer, the context may become stale and need to be updated.
// We do not want Shofer to reload the context every time a file is modified, so we use this class merely
// to inform Shofer that the change has occurred, and tell Shofer to reload the file before making
// any changes to it. This fixes an issue with diff editing, where Shofer was unable to complete a diff edit.

// FileContextTracker
//
// This class is responsible for tracking file operations.
// If the full contents of a file are passed to Shofer via a tool, mention, or edit, the file is marked as active.
// If a file is modified outside of Shofer, we detect and track this change to prevent stale context.
export class FileContextTracker {
	readonly taskId: string
	private providerRef: WeakRef<TaskProviderLike>

	/**
	 * The working directory this task operates in. For ordinary tasks this is the
	 * workspace root; for embedded-worktree tasks (`.shofer/worktrees/<name>/`)
	 * it is the worktree subdirectory. All file reads/writes in this tracker
	 * resolve relative to this path — NOT to the VS Code workspace folder, which
	 * for a worktree task points at the main checkout and would read the wrong
	 * files (the root cause of the `get_changed_files` worktree underreporting
	 * bug).
	 */
	private cwd: string

	// File tracking and watching
	private fileWatchers = new Map<string, HostFileWatcher>()
	private recentlyModifiedFiles = new Set<string>()
	private recentlyEditedByRoo = new Set<string>()

	/**
	 * @param provider  The task provider (host-side services + storage).
	 * @param taskId    The task this tracker is scoped to.
	 * @param cwd       The task's working directory. Must match `task.cwd` so
	 *                  that file reads/writes resolve against the correct tree
	 *                  (the worktree subdirectory for embedded-worktree tasks).
	 */
	constructor(provider: TaskProviderLike, taskId: string, cwd: string) {
		this.providerRef = new WeakRef(provider)
		this.taskId = taskId
		this.cwd = cwd
	}

	// Returns this task's working directory (the worktree subdirectory for
	// embedded-worktree tasks, the workspace root otherwise).
	private getCwd(): string {
		return this.cwd
	}

	/**
	 * Re-points the tracker's working directory. Called by {@link Task.reassignCwd}
	 * when a running WorkflowTask is moved to a different worktree so that
	 * subsequent file-change tracking resolves against the new tree.
	 */
	reassignCwd(newCwd: string): void {
		this.cwd = newCwd
	}

	// File watchers are set up for each file that is tracked in the task metadata.
	async setupFileWatcher(filePath: string) {
		// Only setup watcher if it doesn't already exist for this file
		if (this.fileWatchers.has(filePath)) {
			return
		}

		// Create a file system watcher for this specific file
		const absPath = path.resolve(this.getCwd(), filePath)
		const watcher = getHost().watcher.watch(path.dirname(absPath), path.basename(absPath))

		// Track file changes
		watcher.onChange(() => {
			if (this.recentlyEditedByRoo.has(filePath)) {
				this.recentlyEditedByRoo.delete(filePath) // This was an edit by Shofer, no need to inform Shofer
			} else {
				this.recentlyModifiedFiles.add(filePath) // This was a user edit, we will inform Shofer
				this.trackFileContext(filePath, "user_edited") // Update the task metadata with file tracking
			}
		})

		// Store the watcher so we can dispose it later
		this.fileWatchers.set(filePath, watcher)
	}

	// Tracks a file operation in metadata and sets up a watcher for the file
	// This is the main entry point for FileContextTracker and is called when a file is passed to Shofer via a tool, mention, or edit.
	async trackFileContext(filePath: string, operation: RecordSource) {
		try {
			await this.addFileToFileContextTracker(this.taskId, filePath, operation)

			// Set up file watcher for this file
			await this.setupFileWatcher(filePath)
		} catch (error) {
			taskLog.error("Failed to track file operation:", error)
		}
	}

	/**
	 * Resolves the extension's global-storage path from the (opaque) provider
	 * context — the same derivation `Task` performs — so this tracker needs no
	 * `ContextProxy` value import and stays portable into `@shofer/core`. Returns
	 * `""` when the provider (or its context) is unavailable; callers treat an
	 * empty path as "no storage" (best-effort).
	 */
	private getGlobalStoragePath(): string {
		const provider = this.providerRef.deref()
		if (!provider) {
			taskLog.error("Task provider reference is no longer valid")
			return ""
		}
		const fsPath = (provider.context as { globalStorageUri?: { fsPath?: string } })?.globalStorageUri?.fsPath
		if (!fsPath) {
			taskLog.error("Global storage path is not available")
			return ""
		}
		return fsPath
	}

	// Gets task metadata from storage
	async getTaskMetadata(taskId: string): Promise<TaskMetadata> {
		const globalStoragePath = this.getGlobalStoragePath()
		const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
		const filePath = path.join(taskDir, GlobalFileNames.taskMetadata)
		try {
			if (await fileExistsAtPath(filePath)) {
				return JSON.parse(await fs.readFile(filePath, "utf8"))
			}
		} catch (error) {
			taskLog.error("Failed to read task metadata:", error)
		}
		return { files_in_context: [] }
	}

	// Saves task metadata to storage
	async saveTaskMetadata(taskId: string, metadata: TaskMetadata) {
		try {
			const globalStoragePath = this.getGlobalStoragePath()
			const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
			const filePath = path.join(taskDir, GlobalFileNames.taskMetadata)
			await safeWriteJson(filePath, metadata)
		} catch (error) {
			taskLog.error("Failed to save task metadata:", error)
		}
	}

	// Adds a file to the metadata tracker
	// This handles the business logic of determining if the file is new, stale, or active.
	// It also updates the metadata with the latest read/edit dates.
	async addFileToFileContextTracker(taskId: string, filePath: string, source: RecordSource) {
		try {
			const metadata = await this.getTaskMetadata(taskId)
			const now = Date.now()

			// Mark existing entries for this file as stale
			metadata.files_in_context.forEach((entry) => {
				if (entry.path === filePath && entry.record_state === "active") {
					entry.record_state = "stale"
				}
			})

			// Helper to get the latest date for a specific field and file
			const getLatestDateForField = (path: string, field: keyof FileMetadataEntry): number | null => {
				const relevantEntries = metadata.files_in_context
					.filter((entry) => entry.path === path && entry[field])
					.sort((a, b) => (b[field] as number) - (a[field] as number))

				return relevantEntries.length > 0 ? (relevantEntries[0]![field] as number) : null
			}

			const newEntry: FileMetadataEntry = {
				path: filePath,
				record_state: "active",
				record_source: source,
				shofer_read_date: getLatestDateForField(filePath, "shofer_read_date"),
				shofer_edit_date: getLatestDateForField(filePath, "shofer_edit_date"),
				user_edit_date: getLatestDateForField(filePath, "user_edit_date"),
			}

			switch (source) {
				// user_edited: The user has edited the file
				case "user_edited":
					newEntry.user_edit_date = now
					this.recentlyModifiedFiles.add(filePath)
					break

				// shofer_edited: Shofer has edited the file
				case "shofer_edited":
					newEntry.shofer_read_date = now
					newEntry.shofer_edit_date = now
					this.markFileAsEditedByRoo(filePath)
					break

				// read_tool/file_mentioned: Shofer has read the file via a tool or file mention
				case "read_tool":
				case "file_mentioned":
					newEntry.shofer_read_date = now
					break
			}

			metadata.files_in_context.push(newEntry)
			await this.saveTaskMetadata(taskId, metadata)

			// Tell plugins the file changed, so one tracking file changes can record what
			// the agent produced. Fire-and-forget: the tool must not wait for it, and a
			// plugin's failure must never surface as a tool error.
			if (source === "shofer_edited") {
				void pluginRegistry
					.applyAfterFileEdit({ path: filePath }, { taskId: this.taskId, cwd: this.getCwd() })
					.catch((err) => taskLog.error(`[FileContextTracker] afterFileEdit dispatch failed:`, err))
			}
		} catch (error) {
			taskLog.error("Failed to add file to metadata:", error)
		}
	}

	// Returns (and then clears) the set of recently modified files
	getAndClearRecentlyModifiedFiles(): string[] {
		const files = Array.from(this.recentlyModifiedFiles)
		this.recentlyModifiedFiles.clear()
		return files
	}

	/**
	 * Gets a list of unique file paths that Shofer has read during this task.
	 * Files are sorted by most recently read first, so if there's a character
	 * budget during folded context generation, the most relevant (recent) files
	 * are prioritized.
	 *
	 * @param sinceTimestamp - Optional timestamp to filter files read after this time
	 * @returns Array of unique file paths that have been read, most recent first
	 */
	async getFilesReadByRoo(sinceTimestamp?: number): Promise<string[]> {
		try {
			const metadata = await this.getTaskMetadata(this.taskId)

			const readEntries = metadata.files_in_context.filter((entry) => {
				// Only include files that were read by Shofer (not user edits)
				const isReadByRoo = entry.record_source === "read_tool" || entry.record_source === "file_mentioned"
				if (!isReadByRoo) {
					return false
				}

				// If sinceTimestamp is provided, only include files read after that time
				if (sinceTimestamp && entry.shofer_read_date) {
					return entry.shofer_read_date >= sinceTimestamp
				}

				return true
			})

			// Sort by shofer_read_date descending (most recent first)
			// Entries without a date go to the end
			readEntries.sort((a, b) => {
				const dateA = a.shofer_read_date ?? 0
				const dateB = b.shofer_read_date ?? 0
				return dateB - dateA
			})

			// Deduplicate while preserving order (first occurrence = most recent read)
			const seen = new Set<string>()
			const uniquePaths: string[] = []
			for (const entry of readEntries) {
				if (!seen.has(entry.path)) {
					seen.add(entry.path)
					uniquePaths.push(entry.path)
				}
			}

			return uniquePaths
		} catch (error) {
			taskLog.error("Failed to get files read by Shofer:", error)
			return []
		}
	}

	/**
	 * Returns the unique file paths that Shofer has edited during this task,
	 * sorted by most-recent edit first.
	 *
	 * Source of truth is the persisted task metadata (`files_in_context`),
	 * which is appended to whenever {@link addFileToFileContextTracker} is
	 * invoked with `shofer_edited`. This is independent of any snapshot plugin and
	 * works whether or not one is installed.
	 *
	 * @param sinceTimestamp - Optional epoch ms; only include files edited at/after this time.
	 */
	async getFilesEditedByRoo(sinceTimestamp?: number): Promise<string[]> {
		try {
			const metadata = await this.getTaskMetadata(this.taskId)

			const editEntries = metadata.files_in_context.filter((entry) => {
				if (entry.record_source !== "shofer_edited" || !entry.shofer_edit_date) {
					return false
				}
				if (sinceTimestamp && entry.shofer_edit_date < sinceTimestamp) {
					return false
				}
				return true
			})

			editEntries.sort((a, b) => (b.shofer_edit_date ?? 0) - (a.shofer_edit_date ?? 0))

			const seen = new Set<string>()
			const uniquePaths: string[] = []
			for (const entry of editEntries) {
				if (!seen.has(entry.path)) {
					seen.add(entry.path)
					uniquePaths.push(entry.path)
				}
			}
			return uniquePaths
		} catch (error) {
			taskLog.error("Failed to get files edited by Shofer:", error)
			return []
		}
	}

	// Marks a file as edited by Shofer to prevent false positives in file watchers
	markFileAsEditedByRoo(filePath: string): void {
		this.recentlyEditedByRoo.add(filePath)
	}

	/**
	 * Hand the file's pre-edit content to any plugin tracking file changes, and get out
	 * of the way.
	 *
	 * Called by edit infrastructure (`DiffViewProvider`) and by every tool that writes
	 * files directly, right before the mutation — the only moment the previous content
	 * still exists. `content === undefined` means the file is being created.
	 *
	 * Core keeps no copy: what a baseline is *for* (a change list, a revert, a diff) is
	 * a feature, and it lives in the bundled `file-changes` plugin. Awaited, because a
	 * baseline captured after the write is worthless; never throws into the tool.
	 */
	async captureOriginal(relPath: string, content: string | undefined): Promise<void> {
		try {
			await pluginRegistry.applyBeforeFileEdit(
				{ path: relPath, before: content },
				{ taskId: this.taskId, cwd: this.getCwd() },
			)
		} catch (err) {
			taskLog.error(`[FileContextTracker] beforeFileEdit dispatch failed for ${relPath}:`, err)
		}
	}

	// Disposes all file watchers
	dispose(): void {
		for (const watcher of this.fileWatchers.values()) {
			watcher.dispose()
		}
		this.fileWatchers.clear()
	}
}
