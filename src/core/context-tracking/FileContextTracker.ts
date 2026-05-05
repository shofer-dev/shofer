import { safeWriteJson } from "../../utils/safeWriteJson"
import * as path from "path"
import * as crypto from "crypto"
import * as vscode from "vscode"
import { getTaskDirectoryPath } from "../../utils/storage"
import { GlobalFileNames } from "../../shared/globalFileNames"
import { fileExistsAtPath } from "../../utils/fs"
import fs from "fs/promises"
import { ContextProxy } from "../config/ContextProxy"
import type { FileMetadataEntry, RecordSource, TaskMetadata } from "./FileContextTrackerTypes"
import { ClineProvider } from "../webview/ClineProvider"

/**
 * Snapshot kind written to the per-task originals/finals stores.
 *  - "absent" : the file did not exist on disk at the moment of capture.
 *  - "text"   : the file existed and its content is captured verbatim.
 *  - "binary" : the file existed but content is not retained (see notes).
 */
export type SnapshotKind = "absent" | "text" | "binary"

export interface FileSnapshot {
	kind: SnapshotKind
	/** Captured text content when kind === "text". */
	content?: string
	/** sha256 of captured bytes (only meaningful when kind === "text"). */
	hash?: string
}

// This class is responsible for tracking file operations that may result in stale context.
// If a user modifies a file outside of Roo, the context may become stale and need to be updated.
// We do not want Roo to reload the context every time a file is modified, so we use this class merely
// to inform Roo that the change has occurred, and tell Roo to reload the file before making
// any changes to it. This fixes an issue with diff editing, where Roo was unable to complete a diff edit.

// FileContextTracker
//
// This class is responsible for tracking file operations.
// If the full contents of a file are passed to Roo via a tool, mention, or edit, the file is marked as active.
// If a file is modified outside of Roo, we detect and track this change to prevent stale context.
export class FileContextTracker {
	readonly taskId: string
	private providerRef: WeakRef<ClineProvider>

	// File tracking and watching
	private fileWatchers = new Map<string, vscode.FileSystemWatcher>()
	private recentlyModifiedFiles = new Set<string>()
	private recentlyEditedByRoo = new Set<string>()
	private checkpointPossibleFiles = new Set<string>()

	constructor(provider: ClineProvider, taskId: string) {
		this.providerRef = new WeakRef(provider)
		this.taskId = taskId
	}

	// Gets the current working directory or returns undefined if it cannot be determined
	private getCwd(): string | undefined {
		const cwd = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath).at(0)
		if (!cwd) {
			console.info("No workspace folder available - cannot determine current working directory")
		}
		return cwd
	}

	// File watchers are set up for each file that is tracked in the task metadata.
	async setupFileWatcher(filePath: string) {
		// Only setup watcher if it doesn't already exist for this file
		if (this.fileWatchers.has(filePath)) {
			return
		}

		const cwd = this.getCwd()
		if (!cwd) {
			return
		}

		// Create a file system watcher for this specific file
		const fileUri = vscode.Uri.file(path.resolve(cwd, filePath))
		const watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(path.dirname(fileUri.fsPath), path.basename(fileUri.fsPath)),
		)

		// Track file changes
		watcher.onDidChange(() => {
			if (this.recentlyEditedByRoo.has(filePath)) {
				this.recentlyEditedByRoo.delete(filePath) // This was an edit by Roo, no need to inform Roo
			} else {
				this.recentlyModifiedFiles.add(filePath) // This was a user edit, we will inform Roo
				this.trackFileContext(filePath, "user_edited") // Update the task metadata with file tracking
			}
		})

		// Store the watcher so we can dispose it later
		this.fileWatchers.set(filePath, watcher)
	}

	// Tracks a file operation in metadata and sets up a watcher for the file
	// This is the main entry point for FileContextTracker and is called when a file is passed to Roo via a tool, mention, or edit.
	async trackFileContext(filePath: string, operation: RecordSource) {
		try {
			const cwd = this.getCwd()
			if (!cwd) {
				return
			}

			await this.addFileToFileContextTracker(this.taskId, filePath, operation)

			// Set up file watcher for this file
			await this.setupFileWatcher(filePath)
		} catch (error) {
			console.error("Failed to track file operation:", error)
		}
	}

	public getContextProxy(): ContextProxy | undefined {
		const provider = this.providerRef.deref()
		if (!provider) {
			console.error("ClineProvider reference is no longer valid")
			return undefined
		}
		const context = provider.contextProxy

		if (!context) {
			console.error("Context is not available")
			return undefined
		}

		return context
	}

	// Gets task metadata from storage
	async getTaskMetadata(taskId: string): Promise<TaskMetadata> {
		const globalStoragePath = this.getContextProxy()?.globalStorageUri.fsPath ?? ""
		const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
		const filePath = path.join(taskDir, GlobalFileNames.taskMetadata)
		try {
			if (await fileExistsAtPath(filePath)) {
				return JSON.parse(await fs.readFile(filePath, "utf8"))
			}
		} catch (error) {
			console.error("Failed to read task metadata:", error)
		}
		return { files_in_context: [] }
	}

	// Saves task metadata to storage
	async saveTaskMetadata(taskId: string, metadata: TaskMetadata) {
		try {
			const globalStoragePath = this.getContextProxy()!.globalStorageUri.fsPath
			const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
			const filePath = path.join(taskDir, GlobalFileNames.taskMetadata)
			await safeWriteJson(filePath, metadata)
		} catch (error) {
			console.error("Failed to save task metadata:", error)
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

				return relevantEntries.length > 0 ? (relevantEntries[0][field] as number) : null
			}

			let newEntry: FileMetadataEntry = {
				path: filePath,
				record_state: "active",
				record_source: source,
				roo_read_date: getLatestDateForField(filePath, "roo_read_date"),
				roo_edit_date: getLatestDateForField(filePath, "roo_edit_date"),
				user_edit_date: getLatestDateForField(filePath, "user_edit_date"),
			}

			switch (source) {
				// user_edited: The user has edited the file
				case "user_edited":
					newEntry.user_edit_date = now
					this.recentlyModifiedFiles.add(filePath)
					break

				// roo_edited: Roo has edited the file
				case "roo_edited":
					newEntry.roo_read_date = now
					newEntry.roo_edit_date = now
					this.checkpointPossibleFiles.add(filePath)
					this.markFileAsEditedByRoo(filePath)
					break

				// read_tool/file_mentioned: Roo has read the file via a tool or file mention
				case "read_tool":
				case "file_mentioned":
					newEntry.roo_read_date = now
					break
			}

			metadata.files_in_context.push(newEntry)
			await this.saveTaskMetadata(taskId, metadata)

			// Capture the post-edit "final" content snapshot so per-file Redo can
			// re-apply Roo's last produced state after a Revert. Also notify the
			// provider so the FileChangesPanel updates promptly. These are
			// best-effort and must never propagate errors back to tools.
			if (source === "roo_edited") {
				this.captureFinal(filePath).catch((err) =>
					console.error(`[FileContextTracker] captureFinal failed:`, err),
				)
				const provider = this.providerRef.deref()
				provider?.scheduleChangedFilesUpdate?.(this.taskId)
			}
		} catch (error) {
			console.error("Failed to add file to metadata:", error)
		}
	}

	// Returns (and then clears) the set of recently modified files
	getAndClearRecentlyModifiedFiles(): string[] {
		const files = Array.from(this.recentlyModifiedFiles)
		this.recentlyModifiedFiles.clear()
		return files
	}

	/**
	 * Gets a list of unique file paths that Roo has read during this task.
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
				// Only include files that were read by Roo (not user edits)
				const isReadByRoo = entry.record_source === "read_tool" || entry.record_source === "file_mentioned"
				if (!isReadByRoo) {
					return false
				}

				// If sinceTimestamp is provided, only include files read after that time
				if (sinceTimestamp && entry.roo_read_date) {
					return entry.roo_read_date >= sinceTimestamp
				}

				return true
			})

			// Sort by roo_read_date descending (most recent first)
			// Entries without a date go to the end
			readEntries.sort((a, b) => {
				const dateA = a.roo_read_date ?? 0
				const dateB = b.roo_read_date ?? 0
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
			console.error("Failed to get files read by Roo:", error)
			return []
		}
	}

	getAndClearCheckpointPossibleFile(): string[] {
		const files = Array.from(this.checkpointPossibleFiles)
		this.checkpointPossibleFiles.clear()
		return files
	}

	/**
	 * Returns the unique file paths that Roo has edited during this task,
	 * sorted by most-recent edit first.
	 *
	 * Source of truth is the persisted task metadata (`files_in_context`),
	 * which is appended to whenever {@link addFileToFileContextTracker} is
	 * invoked with `roo_edited`. This is independent of the shadow-git
	 * checkpoint service and works even when checkpoints are disabled.
	 *
	 * @param sinceTimestamp - Optional epoch ms; only include files edited at/after this time.
	 */
	async getFilesEditedByRoo(sinceTimestamp?: number): Promise<string[]> {
		try {
			const metadata = await this.getTaskMetadata(this.taskId)

			const editEntries = metadata.files_in_context.filter((entry) => {
				if (entry.record_source !== "roo_edited" || !entry.roo_edit_date) {
					return false
				}
				if (sinceTimestamp && entry.roo_edit_date < sinceTimestamp) {
					return false
				}
				return true
			})

			editEntries.sort((a, b) => (b.roo_edit_date ?? 0) - (a.roo_edit_date ?? 0))

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
			console.error("Failed to get files edited by Roo:", error)
			return []
		}
	}

	// Marks a file as edited by Roo to prevent false positives in file watchers
	markFileAsEditedByRoo(filePath: string): void {
		this.recentlyEditedByRoo.add(filePath)
	}

	// ------------------------------------------------------------------
	// Original/final content snapshot store (used by ChangedFilesService)
	// ------------------------------------------------------------------

	/**
	 * Returns absolute paths to the per-task `originals/` and `finals/`
	 * directories. Created on demand by callers that write into them.
	 */
	private async getSnapshotDirs(): Promise<{ originals: string; finals: string } | undefined> {
		const storage = this.getContextProxy()?.globalStorageUri.fsPath
		if (!storage) return undefined
		const taskDir = await getTaskDirectoryPath(storage, this.taskId)
		return {
			originals: path.join(taskDir, "originals"),
			finals: path.join(taskDir, "finals"),
		}
	}

	private snapshotFileName(relPath: string): string {
		// sha1 over the workspace-relative path is enough for collision-resistant
		// per-file storage; the original path is kept inside the JSON payload.
		return crypto.createHash("sha1").update(relPath).digest("hex") + ".json"
	}

	private async readSnapshot(dir: string, relPath: string): Promise<FileSnapshot | undefined> {
		const file = path.join(dir, this.snapshotFileName(relPath))
		if (!(await fileExistsAtPath(file))) return undefined
		try {
			const raw = await fs.readFile(file, "utf8")
			return JSON.parse(raw) as FileSnapshot
		} catch (err) {
			console.error(`[FileContextTracker] Failed to read snapshot for ${relPath}:`, err)
			return undefined
		}
	}

	private async writeSnapshot(dir: string, relPath: string, snap: FileSnapshot): Promise<void> {
		const file = path.join(dir, this.snapshotFileName(relPath))
		await safeWriteJson(file, { ...snap, _path: relPath })
	}

	private buildSnapshotFromContent(content: string | undefined): FileSnapshot {
		if (content === undefined) return { kind: "absent" }
		return {
			kind: "text",
			content,
			hash: crypto.createHash("sha256").update(content).digest("hex"),
		}
	}

	/**
	 * Captures the file's content as it existed BEFORE Roo's first edit in this
	 * Task. Idempotent: subsequent calls for the same path are no-ops, so
	 * intermediate Roo edits cannot overwrite the original.
	 *
	 * Should be called from edit infrastructure (e.g. DiffViewProvider.open)
	 * after the original content has been read but before the file is mutated.
	 * Pass `content === undefined` to indicate the file did not exist on disk.
	 */
	async captureOriginal(relPath: string, content: string | undefined): Promise<void> {
		try {
			const dirs = await this.getSnapshotDirs()
			if (!dirs) return
			const existing = await this.readSnapshot(dirs.originals, relPath)
			if (existing) return
			await this.writeSnapshot(dirs.originals, relPath, this.buildSnapshotFromContent(content))
		} catch (err) {
			console.error(`[FileContextTracker] captureOriginal failed for ${relPath}:`, err)
		}
	}

	/**
	 * Captures the file's current on-disk content as the latest "final" state
	 * produced by Roo. Overwrites any prior final snapshot. Used to power Redo
	 * after a per-file Revert.
	 */
	async captureFinal(relPath: string): Promise<void> {
		try {
			const dirs = await this.getSnapshotDirs()
			if (!dirs) return
			const cwd = this.getCwd()
			if (!cwd) return
			const abs = path.resolve(cwd, relPath)
			let content: string | undefined
			try {
				content = await fs.readFile(abs, "utf8")
			} catch {
				content = undefined
			}
			await this.writeSnapshot(dirs.finals, relPath, this.buildSnapshotFromContent(content))
		} catch (err) {
			console.error(`[FileContextTracker] captureFinal failed for ${relPath}:`, err)
		}
	}

	async getOriginalSnapshot(relPath: string): Promise<FileSnapshot | undefined> {
		const dirs = await this.getSnapshotDirs()
		if (!dirs) return undefined
		return this.readSnapshot(dirs.originals, relPath)
	}

	async getFinalSnapshot(relPath: string): Promise<FileSnapshot | undefined> {
		const dirs = await this.getSnapshotDirs()
		if (!dirs) return undefined
		return this.readSnapshot(dirs.finals, relPath)
	}

	// Disposes all file watchers
	dispose(): void {
		for (const watcher of this.fileWatchers.values()) {
			watcher.dispose()
		}
		this.fileWatchers.clear()
	}
}
