import * as vscode from "vscode"
import { createHash } from "crypto"
import { ICacheManager } from "./interfaces/cache"
import debounce from "lodash.debounce"
import { safeWriteJson } from "../../utils/safeWriteJson"
import { TelemetryService } from "@shofer/telemetry"
import { TelemetryEventName, codebaseIndexCacheSchema, type CodebaseIndexCacheEntry } from "@shofer/types"

/**
 * Manages the cache for code indexing.
 *
 * Stores a versioned on-disk cache mapping file paths to
 * { hash, mtimeMs, size, segmentHashes } entries. Uses a stat()-only fast-path:
 * when mtime+size match the cached values the scanner skips reading and hashing
 * the file entirely. `segmentHashes` enables per-segment deduplication in the
 * file watcher so unchanged segments are not re-embedded on edit.
 *
 * Per the Versioned Snapshot Rule, a mismatch on the version field discards the entire
 * cache and triggers a fresh full scan — no migration.
 */
export class CacheManager implements ICacheManager {
	private cachePath: vscode.Uri
	/** In-memory map of relative file path → cache entry */
	private entries: Record<string, CodebaseIndexCacheEntry> = {}
	private _debouncedSaveCache: () => void

	/**
	 * Fires whenever an entry is added/updated. Used by `CodeIndexManager` to
	 * surface "last file indexed" + cumulative "files indexed" diagnostics
	 * in the popover without having to thread file paths through the scanner
	 * callback signatures.
	 */
	private readonly _onEntryUpdated = new vscode.EventEmitter<string>()
	public readonly onEntryUpdated = this._onEntryUpdated.event

	/**
	 * @param context VS Code extension context
	 * @param workspacePath Path to the workspace
	 */
	constructor(
		private context: vscode.ExtensionContext,
		private workspacePath: string,
	) {
		this.cachePath = vscode.Uri.joinPath(
			context.globalStorageUri,
			`shofer-index-cache-${createHash("sha256").update(workspacePath).digest("hex")}.json`,
		)
		this._debouncedSaveCache = debounce(async () => {
			await this._performSave()
		}, 1500)
	}

	/**
	 * Loads the cache from disk. Validates against the v2 schema via safeParse;
	 * on version mismatch or parse failure discards the cache and starts fresh.
	 */
	/**
	 * Loads the cache from disk. Validates against the v3 schema via safeParse;
	 * on version mismatch or parse failure discards the cache and starts fresh.
	 */
	async initialize(): Promise<void> {
		try {
			const cacheData = await vscode.workspace.fs.readFile(this.cachePath)
			const raw = JSON.parse(cacheData.toString())
			const parsed = codebaseIndexCacheSchema.safeParse(raw)
			if (parsed.success) {
				this.entries = parsed.data.entries
			} else {
				// Version mismatch or corrupt data — discard and re-scan
				this.entries = {}
			}
		} catch {
			// File not found, empty, or unreadable — start fresh
			this.entries = {}
		}
	}

	/**
	 * Saves the cache to disk in version 3 format.
	 */
	private async _performSave(): Promise<void> {
		try {
			await safeWriteJson(this.cachePath.fsPath, {
				version: 3,
				entries: this.entries,
			})
		} catch (error) {
			console.error("Failed to save cache:", error)
			TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				location: "_performSave",
			})
		}
	}

	/**
	 * Clears the cache file and the in-memory entry map.
	 */
	async clearCacheFile(): Promise<void> {
		try {
			await safeWriteJson(this.cachePath.fsPath, { version: 3, entries: {} })
			this.entries = {}
		} catch (error) {
			console.error("Failed to clear cache file:", error, this.cachePath)
			TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				location: "clearCacheFile",
			})
		}
	}

	// ── Entry-level accessors ──

	/**
	 * Returns the full cache entry for a file path, or undefined if not cached.
	 */
	getEntry(filePath: string): CodebaseIndexCacheEntry | undefined {
		return this.entries[filePath]
	}

	/**
	 * Updates the cache entry for a file path and schedules a debounced save.
	 */
	updateEntry(filePath: string, entry: CodebaseIndexCacheEntry): void {
		this.entries[filePath] = entry
		this._debouncedSaveCache()
		this._onEntryUpdated.fire(filePath)
	}

	/**
	 * Deletes the cache entry for a file path.
	 */
	deleteHash(filePath: string): void {
		delete this.entries[filePath]
		this._debouncedSaveCache()
	}

	/**
	 * Returns all cached file paths (for deleted-file detection).
	 */
	getAllPaths(): string[] {
		return Object.keys(this.entries)
	}

	/**
	 * Returns the cumulative number of files currently held in the cache.
	 * Used by the popover to surface a "files indexed" diagnostic so users
	 * can verify the Phase 1/2 fast-path didn't silently drop anything.
	 */
	getEntryCount(): number {
		return Object.keys(this.entries).length
	}

	/**
	 * Returns the set of segment hashes previously stored for a file path,
	 * or an empty set if the file is not cached or has no segments.
	 * Used by the file watcher to determine which segments are unchanged.
	 */
	getSegmentHashes(filePath: string): Set<string> {
		const entry = this.entries[filePath]
		return new Set(entry?.segmentHashes ?? [])
	}

	/**
	 * Flushes any pending debounced cache writes to disk immediately.
	 */
	async flush(): Promise<void> {
		await this._performSave()
	}

	/**
	 * Disposes the entry-updated emitter. Called by `CodeIndexManager.dispose()`.
	 */
	dispose(): void {
		this._onEntryUpdated.dispose()
	}
}
