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
import { ShoferProvider } from "../webview/ShoferProvider"
import { LiveMemoryManager } from "../../services/live-memory/manager"
import { taskLog } from "../../utils/logging/subsystems"

/**
 * Snapshot kind written to the per-task originals/finals stores.
 *  - "absent" : the file did not exist on disk at the moment of capture.
 *  - "text"   : the file existed. Actual content lives in base/<relPath>
 *               (originals) or final/<relPath> (finals).
 *  - "binary" : the file existed but content is not retained.
 */
export type SnapshotKind = "absent" | "text" | "binary"

export interface FileSnapshot {
	kind: SnapshotKind
	/** sha256 of captured bytes (only meaningful when kind === "text"). */
	hash?: string
}

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
	private providerRef: WeakRef<ShoferProvider>

	// File tracking and watching
	private fileWatchers = new Map<string, vscode.FileSystemWatcher>()
	private recentlyModifiedFiles = new Set<string>()
	private recentlyEditedByRoo = new Set<string>()
	private checkpointPossibleFiles = new Set<string>()

	constructor(provider: ShoferProvider, taskId: string) {
		this.providerRef = new WeakRef(provider)
		this.taskId = taskId
	}

	// Gets the current working directory or returns undefined if it cannot be determined
	private getCwd(): string | undefined {
		const cwd = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath).at(0)
		if (!cwd) {
			taskLog.info("No workspace folder available - cannot determine current working directory")
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
			const cwd = this.getCwd()
			if (!cwd) {
				return
			}

			await this.addFileToFileContextTracker(this.taskId, filePath, operation)

			// Set up file watcher for this file
			await this.setupFileWatcher(filePath)
		} catch (error) {
			taskLog.error("Failed to track file operation:", error)
		}
	}

	public getContextProxy(): ContextProxy | undefined {
		const provider = this.providerRef.deref()
		if (!provider) {
			taskLog.error("ShoferProvider reference is no longer valid")
			return undefined
		}
		const context = provider.contextProxy

		if (!context) {
			taskLog.error("Context is not available")
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
			taskLog.error("Failed to read task metadata:", error)
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

				return relevantEntries.length > 0 ? (relevantEntries[0][field] as number) : null
			}

			let newEntry: FileMetadataEntry = {
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
					this.checkpointPossibleFiles.add(filePath)
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

			// Capture the post-edit "final" content snapshot so per-file Redo can
			// re-apply Shofer's last produced state after a Revert. Also notify the
			// provider so the FileChangesPanel updates promptly. These are
			// best-effort and must never propagate errors back to tools.
			if (source === "shofer_edited") {
				this.captureFinal(filePath).catch((err) =>
					taskLog.error(`[FileContextTracker] captureFinal failed:`, err),
				)
				const provider = this.providerRef.deref()
				provider?.scheduleChangedFilesUpdate?.(this.taskId)

				// Notify the live memory so it can attach a "recently modified"
				// hint to the next question (KV-cache preserving).
				this._notifyLiveMemory(filePath)
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

	getAndClearCheckpointPossibleFile(): string[] {
		const files = Array.from(this.checkpointPossibleFiles)
		this.checkpointPossibleFiles.clear()
		return files
	}

	/**
	 * Returns the unique file paths that Shofer has edited during this task,
	 * sorted by most-recent edit first.
	 *
	 * Source of truth is the persisted task metadata (`files_in_context`),
	 * which is appended to whenever {@link addFileToFileContextTracker} is
	 * invoked with `shofer_edited`. This is independent of the shadow-git
	 * checkpoint service and works even when checkpoints are disabled.
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
	 * Notify the live memory that a file was modified by a Shofer tool.
	 * Best-effort — failures are silently ignored.
	 */
	private _notifyLiveMemory(filePath: string): void {
		try {
			const managers = LiveMemoryManager.getAllInstances()
			for (const mgr of managers) {
				mgr.notifyFileModified(filePath)
			}
		} catch {
			// Live Memory manager may not be loaded — best-effort only
		}
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
			taskLog.error(`[FileContextTracker] Failed to read snapshot for ${relPath}:`, err)
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
			hash: crypto.createHash("sha256").update(content).digest("hex"),
		}
	}

	/**
	 * Returns absolute paths to the per-task working-directory `base/` and
	 * `final/` directories (for file copies, not metadata).
	 */
	private async getWorkingDirs(): Promise<{ base: string; final: string } | undefined> {
		const storage = this.getContextProxy()?.globalStorageUri.fsPath
		if (!storage) return undefined
		const taskDir = await getTaskDirectoryPath(storage, this.taskId)
		return {
			base: path.join(taskDir, "base"),
			final: path.join(taskDir, "final"),
		}
	}

	/**
	 * Captures the file's content as it existed BEFORE Shofer's first edit in this
	 * Task. Idempotent: subsequent calls for the same path are no-ops, so
	 * intermediate Shofer edits cannot overwrite the original.
	 *
	 * Should be called from edit infrastructure (e.g. DiffViewProvider.open)
	 * after the original content has been read but before the file is mutated.
	 * Pass `content === undefined` to indicate the file did not exist on disk.
	 *
	 * Writes a lightweight metadata snapshot to `originals/` and a verbatim
	 * file copy to `base/<relPath>`.
	 */
	async captureOriginal(relPath: string, content: string | undefined): Promise<void> {
		try {
			const dirs = await this.getSnapshotDirs()
			if (!dirs) return
			const existing = await this.readSnapshot(dirs.originals, relPath)
			if (existing) return

			const snap = this.buildSnapshotFromContent(content)

			// Write the verbatim base copy FIRST. If it fails the snapshot is
			// never persisted, keeping the capture atomic. The reverse order
			// could leave a dangling snapshot with no corresponding base file.
			if (snap.kind === "text" && content !== undefined) {
				const wdirs = await this.getWorkingDirs()
				if (wdirs) {
					const dest = path.join(wdirs.base, relPath)
					await fs.mkdir(path.dirname(dest), { recursive: true })
					await fs.writeFile(dest, content, "utf8")
				}
			}

			await this.writeSnapshot(dirs.originals, relPath, snap)
		} catch (err) {
			taskLog.error(`[FileContextTracker] captureOriginal failed for ${relPath}:`, err)
		}
	}

	/**
	 * Captures the file's current on-disk content as the latest "final" state
	 * produced by Shofer. Overwrites any prior final snapshot. Used to power Redo
	 * after a per-file Revert.
	 *
	 * Writes a lightweight metadata snapshot to `finals/` and a verbatim
	 * file copy to `final/<relPath>`.
	 */
	async captureFinal(relPath: string): Promise<void> {
		try {
			const dirs = await this.getSnapshotDirs()
			if (!dirs) {
				taskLog.warn(
					`[FileContextTracker] captureFinal skipped for ${relPath}: no snapshot dirs (globalStorage unavailable)`,
				)
				return
			}
			const cwd = this.getCwd()
			if (!cwd) {
				taskLog.warn(
					`[FileContextTracker] captureFinal skipped for ${relPath}: no workspace folder (cwd undefined)`,
				)
				return
			}
			const abs = path.resolve(cwd, relPath)
			let content: string | undefined
			try {
				content = await fs.readFile(abs, "utf8")
			} catch (err: any) {
				if (err?.code !== "ENOENT") {
					taskLog.warn(
						`[FileContextTracker] captureFinal read error for ${relPath}: ${err?.code ?? err?.message ?? err}`,
					)
				}
				content = undefined
			}
			const snap = this.buildSnapshotFromContent(content)
			await this.writeSnapshot(dirs.finals, relPath, snap)

			// Also write a verbatim copy to final/<relPath>.
			const wdirs = await this.getWorkingDirs()
			if (!wdirs) {
				taskLog.warn(
					`[FileContextTracker] captureFinal(${relPath}): metadata snapshot written but working dirs unavailable — verbatim final copy skipped`,
				)
				return
			}
			if (snap.kind === "absent") {
				// Remove any stale final copy when the file was deleted.
				const dest = path.join(wdirs.final, relPath)
				try {
					await fs.unlink(dest)
				} catch {
					/* ok if missing */
				}
			} else if (content !== undefined) {
				const dest = path.join(wdirs.final, relPath)
				await fs.mkdir(path.dirname(dest), { recursive: true })
				await fs.writeFile(dest, content, "utf8")
			}
		} catch (err) {
			taskLog.error(`[FileContextTracker] captureFinal failed for ${relPath}:`, err)
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

	/**
	 * Overwrites the original baseline for a file — both the metadata snapshot
	 * in originals/ and the verbatim copy in base/<relPath>. Used by acceptFile
	 * to promote the final state as the new baseline. Pass content === undefined
	 * to mark the file as absent at baseline.
	 */
	async overwriteOriginalBase(relPath: string, content: string | undefined): Promise<void> {
		const snapDirs = await this.getSnapshotDirs()
		const wdirs = await this.getWorkingDirs()
		if (!snapDirs || !wdirs) return

		const snap = this.buildSnapshotFromContent(content)
		await this.writeSnapshot(snapDirs.originals, relPath, snap)

		const dest = path.join(wdirs.base, relPath)
		if (snap.kind === "absent") {
			try {
				await fs.unlink(dest)
			} catch {
				/* ok if missing */
			}
		} else if (content !== undefined) {
			await fs.mkdir(path.dirname(dest), { recursive: true })
			await fs.writeFile(dest, content, "utf8")
		}
	}

	/**
	 * Removes the final-state snapshot for a file — both the metadata JSON
	 * and the verbatim copy in final/<relPath>. Used by acceptFile after
	 * promoting the final state to the new baseline.
	 */
	async removeFinalSnapshot(relPath: string): Promise<void> {
		const snapDirs = await this.getSnapshotDirs()
		const wdirs = await this.getWorkingDirs()
		if (!snapDirs || !wdirs) return

		const meta = path.join(snapDirs.finals, this.snapshotFileName(relPath))
		try {
			await fs.unlink(meta)
		} catch {
			/* ok if missing */
		}

		const dest = path.join(wdirs.final, relPath)
		try {
			await fs.unlink(dest)
		} catch {
			/* ok if missing */
		}
	}

	/**
	 * Reads the verbatim base file copy from `<taskDir>/base/<relPath>`.
	 * Returns undefined when the file copy does not exist.
	 */
	async getBaseContent(relPath: string): Promise<string | undefined> {
		const wdirs = await this.getWorkingDirs()
		if (!wdirs) return undefined
		try {
			return await fs.readFile(path.join(wdirs.base, relPath), "utf8")
		} catch {
			return undefined
		}
	}

	/**
	 * Reads the verbatim final file copy from `<taskDir>/final/<relPath>`.
	 * Returns undefined when the file copy does not exist.
	 */
	async getFinalContent(relPath: string): Promise<string | undefined> {
		const wdirs = await this.getWorkingDirs()
		if (!wdirs) return undefined
		try {
			return await fs.readFile(path.join(wdirs.final, relPath), "utf8")
		} catch {
			return undefined
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
