import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as path from "path"

import type { HistoryItem } from "@shofer/types"

import { GlobalFileNames } from "@shofer/core"
import { safeWriteJson } from "@shofer/core"
import { getStorageBasePath } from "@shofer/core"
import { taskLog } from "@shofer/core"
import { resolveTaskPersistence, type TaskMetadataPersistencePort } from "@shofer/core"

/**
 * Index file format for fast startup reads.
 */
interface HistoryIndex {
	version: number
	updatedAt: number
	entries: HistoryItem[]
}

/**
 * TaskHistoryStore encapsulates all task history persistence logic.
 *
 * Each task's HistoryItem is read and written through the host's task-metadata
 * port (`@shofer/core`'s `TaskMetadataPersistencePort`), which the compiled-in
 * default backs with an individual JSON file in that task's directory
 * (`globalStorage/tasks/<taskId>/history_item.json`). Going through the port is
 * what lets a host whose task store is SHARED between processes list and
 * rehydrate a task it never created — the store owns the record, this class owns
 * the caching and the reconciliation around it.
 *
 * A single index file (`globalStorage/tasks/_index.json`) is maintained
 * as a cache for fast list reads at startup. The index is a local read
 * accelerator in every configuration; the port is the source of truth, and
 * `reconcile()` repairs the cache against it.
 *
 * Cross-process safety on the default backend comes from `safeWriteJson`'s
 * `proper-lockfile` on per-task file writes. Within a single extension host
 * process, an in-process write lock serializes mutations.
 */
/**
 * Options for TaskHistoryStore constructor.
 */
export interface TaskHistoryStoreOptions {
	/**
	 * Optional callback invoked inside the write lock after each mutation
	 * (upsert, delete, deleteMany). Used for serialized write-through to
	 * globalState during the transition period.
	 */
	onWrite?: (items: HistoryItem[]) => Promise<void>

	/**
	 * Metadata port override. Defaults to the host's resolved task store; supply
	 * one to pin a backend (tests, a host that wires its own).
	 */
	metadata?: TaskMetadataPersistencePort
}

export class TaskHistoryStore {
	private readonly globalStoragePath: string
	private readonly onWrite?: (items: HistoryItem[]) => Promise<void>
	private readonly metadataOverride?: TaskMetadataPersistencePort
	private metadataPromise?: Promise<TaskMetadataPersistencePort>
	private cache: Map<string, HistoryItem> = new Map()
	/**
	 * Memoized sorted snapshot of `cache.values()` (newest first). Rebuilt
	 * lazily in {@link getAll} and invalidated by every cache mutation via the
	 * `setCacheEntry`/`deleteCacheEntry`/`clearCache` helpers. Removes the
	 * O(n log n) re-sort that previously ran on every `getAll()` call — notably
	 * once per `getStateToPostToWebview()` state push (every task switch). [perf H25]
	 */
	private _sortedCache: HistoryItem[] | null = null
	/**
	 * Monotonic counter bumped on every cache mutation (add/update/delete/clear,
	 * including reconciliation against disk). Lets callers cheaply detect whether
	 * the history changed since they last observed it without diffing the array —
	 * used to skip re-sending the full taskHistory in unchanged init snapshots. [perf H26]
	 */
	private _mutationVersion = 0
	private writeLock: Promise<void> = Promise.resolve()
	private indexWriteTimer: ReturnType<typeof setTimeout> | null = null
	private fsWatcher: fsSync.FSWatcher | null = null
	private reconcileTimer: ReturnType<typeof setTimeout> | null = null
	private disposed = false

	/**
	 * Promise that resolves when initialization is complete.
	 * Callers can await this to ensure the store is ready before reading.
	 */
	public readonly initialized: Promise<void>
	private resolveInitialized!: () => void

	/** Debounce window for index writes in milliseconds. */
	private static readonly INDEX_WRITE_DEBOUNCE_MS = 2000

	/** Periodic reconciliation interval in milliseconds. */
	private static readonly RECONCILE_INTERVAL_MS = 5 * 60 * 1000

	constructor(globalStoragePath: string, options?: TaskHistoryStoreOptions) {
		this.globalStoragePath = globalStoragePath
		this.onWrite = options?.onWrite
		this.metadataOverride = options?.metadata
		this.initialized = new Promise<void>((resolve) => {
			this.resolveInitialized = resolve
		})
	}

	// ────────────────────────────── Lifecycle ──────────────────────────────

	/**
	 * Load index, reconcile if needed, start watchers.
	 */
	async initialize(): Promise<void> {
		try {
			const tasksDir = await this.getTasksDir()
			await fs.mkdir(tasksDir, { recursive: true })

			// 1. Load existing index into the cache
			await this.loadIndex()

			// 2. Reconcile cache against actual task directories on disk
			await this.reconcile()

			// 3. Start fs.watch for cross-instance reactivity
			this.startWatcher()

			// 4. Start periodic reconciliation as a defensive fallback
			this.startPeriodicReconciliation()
		} finally {
			// Mark initialization as complete so callers awaiting `initialized` can proceed
			this.resolveInitialized()
		}
	}

	/**
	 * Flush pending writes, clear watchers, release resources.
	 */
	dispose(): void {
		this.disposed = true

		if (this.indexWriteTimer) {
			clearTimeout(this.indexWriteTimer)
			this.indexWriteTimer = null
		}

		if (this.reconcileTimer) {
			clearTimeout(this.reconcileTimer)
			this.reconcileTimer = null
		}

		if (this.fsWatcher) {
			this.fsWatcher.close()
			this.fsWatcher = null
		}

		// Synchronously flush the index (best-effort)
		this.flushIndex().catch((err) => {
			taskLog.error("[TaskHistoryStore] Error flushing index on dispose:", err)
		})
	}

	// ────────────────────────────── Reads ──────────────────────────────

	/**
	 * Get a single history item by task ID.
	 */
	get(taskId: string): HistoryItem | undefined {
		return this.cache.get(taskId)
	}

	/**
	 * Get a single history item by task ID, falling back to a direct disk
	 * read on a cache miss.
	 *
	 * The miss path exists for SHARED task stores — executor replicas
	 * mounting one volume (RWX): a task created or last saved by another
	 * instance after this one loaded its index is on disk but not in this
	 * cache, fs watchers do not fire for another host's writes on network
	 * filesystems, and periodic reconciliation is too slow for a request
	 * already in flight. `invalidate` reads the per-task file and repairs
	 * the cache either way, so a genuine miss stays a miss.
	 */
	async getOrLoad(taskId: string): Promise<HistoryItem | undefined> {
		const cached = this.cache.get(taskId)
		if (cached) {
			return cached
		}
		await this.invalidate(taskId)
		return this.cache.get(taskId)
	}

	/**
	 * Get all history items, sorted by timestamp descending (newest first).
	 *
	 * The sort is memoized in {@link _sortedCache} and invalidated on mutation,
	 * so repeated reads between mutations skip the re-sort. A defensive copy is
	 * returned because some callers (e.g. the public API surface in
	 * `extension/api.ts`) may mutate the result. [perf H25]
	 */
	getAll(): HistoryItem[] {
		if (this._sortedCache === null) {
			this._sortedCache = Array.from(this.cache.values()).sort(
				(a, b) => (b.createdAt ?? b.ts) - (a.createdAt ?? a.ts),
			)
		}
		return this._sortedCache.slice()
	}

	/**
	 * Get history items filtered by workspace path.
	 */
	getByWorkspace(workspace: string): HistoryItem[] {
		return this.getAll().filter((item) => item.workspace === workspace)
	}

	/**
	 * Current mutation version — see {@link _mutationVersion}. Changes whenever
	 * the set of history items changes. [perf H26]
	 */
	getMutationVersion(): number {
		return this._mutationVersion
	}

	// ────────────────────────────── Mutations ──────────────────────────────

	/**
	 * Insert or update a history item.
	 *
	 * Writes the per-task file immediately (source of truth),
	 * updates the in-memory Map, and schedules a debounced index write.
	 */
	async upsert(item: HistoryItem): Promise<HistoryItem[]> {
		return this.withLock(async () => {
			const existing = this.cache.get(item.id)

			// Merge: preserve existing metadata unless explicitly overwritten
			const merged = existing ? { ...existing, ...item } : item

			// Write per-task file (source of truth)
			await this.writeTaskFile(merged)

			// Update in-memory cache
			this.setCacheEntry(merged)

			// Schedule debounced index write
			this.scheduleIndexWrite()

			const all = this.getAll()

			// Call onWrite callback inside the lock for serialized write-through
			if (this.onWrite) {
				await this.onWrite(all)
			}

			return all
		})
	}

	/**
	 * Delete a single task's history item.
	 */
	async delete(taskId: string): Promise<void> {
		return this.withLock(async () => {
			this.deleteCacheEntry(taskId)

			await (await this.metadata()).deleteTaskMetadata(taskId)

			this.scheduleIndexWrite()

			// Call onWrite callback inside the lock for serialized write-through
			if (this.onWrite) {
				await this.onWrite(this.getAll())
			}
		})
	}

	/**
	 * Delete multiple tasks' history items in a batch.
	 */
	async deleteMany(taskIds: string[]): Promise<void> {
		return this.withLock(async () => {
			const metadata = await this.metadata()
			for (const taskId of taskIds) {
				this.deleteCacheEntry(taskId)
				await metadata.deleteTaskMetadata(taskId)
			}

			this.scheduleIndexWrite()

			// Call onWrite callback inside the lock for serialized write-through
			if (this.onWrite) {
				await this.onWrite(this.getAll())
			}
		})
	}

	// ────────────────────────────── Reconciliation ──────────────────────────────

	/**
	 * Scan the metadata store vs the cache and fix any drift.
	 *
	 * - Tasks in the store but missing from cache: read and add
	 * - Tasks in cache but missing from the store: remove
	 *
	 * On a SHARED store this is also how a process learns about tasks another
	 * process created — the store's id list spans every writer, so a task
	 * created elsewhere appears here on the next reconciliation rather than
	 * only when someone asks for it by id (`getOrLoad`).
	 */
	async reconcile(): Promise<void> {
		// Run through the write lock to prevent interleaving with upsert/delete
		return this.withLock(async () => {
			const storedIds = await (await this.metadata()).listTaskMetadataIds()

			const onDiskIds = new Set(storedIds)
			const cacheIds = new Set(this.cache.keys())
			let changed = false

			// Tasks in the store but not in cache: read their metadata record
			for (const taskId of onDiskIds) {
				if (!cacheIds.has(taskId)) {
					try {
						const item = await this.readTaskFile(taskId)
						if (item) {
							this.setCacheEntry(item)
							changed = true
						}
					} catch {
						// Corrupted or missing record, skip
					}
				}
			}

			// Tasks in cache but not in the store: remove from cache
			for (const taskId of cacheIds) {
				if (!onDiskIds.has(taskId)) {
					this.deleteCacheEntry(taskId)
					changed = true
				}
			}

			if (changed) {
				this.scheduleIndexWrite()
			}
		})
	}

	// ────────────────────────────── Private: cache mutation helpers ──────────────────────────────

	/**
	 * All `this.cache` mutations funnel through these three helpers so the
	 * memoized {@link _sortedCache} is invalidated, and {@link _mutationVersion}
	 * is bumped, in exactly one place per operation — guarding against a future
	 * mutation site forgetting either. [perf H25, H26]
	 */
	private setCacheEntry(item: HistoryItem): void {
		this.cache.set(item.id, item)
		this._sortedCache = null
		this._mutationVersion++
	}

	private deleteCacheEntry(taskId: string): void {
		this.cache.delete(taskId)
		this._sortedCache = null
		this._mutationVersion++
	}

	private clearCache(): void {
		this.cache.clear()
		this._sortedCache = null
		this._mutationVersion++
	}

	// ────────────────────────────── Cache invalidation ──────────────────────────────

	/**
	 * Invalidate a single task's cache entry (re-read from disk on next access).
	 */
	async invalidate(taskId: string): Promise<void> {
		try {
			const item = await this.readTaskFile(taskId)
			if (item) {
				this.setCacheEntry(item)
			} else {
				this.deleteCacheEntry(taskId)
			}
		} catch {
			this.deleteCacheEntry(taskId)
		}
	}

	/**
	 * Clear all in-memory cache and reload from index.
	 */
	invalidateAll(): void {
		this.clearCache()
	}

	// ────────────────────────────── Migration ──────────────────────────────

	/**
	 * Migrate from globalState taskHistory array to per-task files.
	 *
	 * For each entry in the globalState array, writes a `history_item.json`
	 * file if one doesn't already exist. This is idempotent and safe to re-run.
	 *
	 * Deliberately file-specific rather than routed through the metadata port:
	 * it migrates an on-disk legacy layout, and its orphan test — "is there
	 * still a task DIRECTORY for this entry" — is a question about that layout
	 * which no other backend can answer. A host on a shared store has no
	 * globalState `taskHistory` to migrate, so it never reaches here.
	 */
	async migrateFromGlobalState(taskHistoryEntries: HistoryItem[]): Promise<void> {
		if (!taskHistoryEntries || taskHistoryEntries.length === 0) {
			return
		}

		for (const item of taskHistoryEntries) {
			if (!item.id) {
				continue
			}

			// Check if task directory exists on disk
			const tasksDir = await this.getTasksDir()
			const taskDir = path.join(tasksDir, item.id)

			try {
				await fs.access(taskDir)
			} catch {
				// Task directory doesn't exist; skip this entry as it's orphaned in globalState
				continue
			}

			// Write history_item.json if it doesn't exist yet
			const filePath = path.join(taskDir, GlobalFileNames.historyItem)
			try {
				await fs.access(filePath)
				// File already exists, skip (don't overwrite existing per-task files)
			} catch {
				// File doesn't exist, write it
				await safeWriteJson(filePath, item)
				this.setCacheEntry(item)
			}
		}

		// Write the index
		await this.writeIndex()
	}

	// ────────────────────────────── Private: Index management ──────────────────────────────

	/**
	 * Load the `_index.json` file into the in-memory cache.
	 */
	private async loadIndex(): Promise<void> {
		const indexPath = await this.getIndexPath()

		try {
			const loadT0 = Date.now()
			const raw = await fs.readFile(indexPath, "utf8")
			const byteSize = Buffer.byteLength(raw, "utf8")
			const index: HistoryIndex = JSON.parse(raw)
			const loadMs = Date.now() - loadT0

			if (process.env.DEBUG) {
				taskLog.info(`[_index] load size=${byteSize} parseMs=${loadMs} entries=${index.entries?.length ?? 0}`)
			}

			if (index.version === 1 && Array.isArray(index.entries)) {
				for (const entry of index.entries) {
					if (entry.id) {
						this.setCacheEntry(entry)
					}
				}
			}
		} catch {
			// Index doesn't exist or is corrupted; cache stays empty.
			// Reconciliation will rebuild it from per-task files.
		}
	}

	/**
	 * Write the full index to disk.
	 */
	private async writeIndex(): Promise<void> {
		const writeT0 = Date.now()
		const indexPath = await this.getIndexPath()
		const entries = this.getAll()
		const index: HistoryIndex = {
			version: 1,
			updatedAt: Date.now(),
			entries,
		}

		await safeWriteJson(indexPath, index)

		if (process.env.DEBUG) {
			const writeMs = Date.now() - writeT0
			taskLog.info(`[_index] write entries=${entries.length} elapsed=${writeMs}ms`)
		}
	}

	/**
	 * Schedule a debounced index write.
	 */
	private scheduleIndexWrite(): void {
		if (this.disposed) {
			return
		}

		if (this.indexWriteTimer) {
			clearTimeout(this.indexWriteTimer)
		}

		this.indexWriteTimer = setTimeout(async () => {
			this.indexWriteTimer = null
			try {
				await this.writeIndex()
			} catch (err) {
				taskLog.error("[TaskHistoryStore] Failed to write index:", err)
			}
		}, TaskHistoryStore.INDEX_WRITE_DEBOUNCE_MS)
	}

	/**
	 * Force an immediate index write (called on dispose/shutdown).
	 */
	async flushIndex(): Promise<void> {
		if (this.indexWriteTimer) {
			clearTimeout(this.indexWriteTimer)
			this.indexWriteTimer = null
		}

		await this.writeIndex()
	}

	// ────────────────────────────── Private: metadata port ──────────────────────────────

	/**
	 * The host's task-metadata store, resolved once.
	 *
	 * Resolution is deferred rather than done in the constructor because the
	 * backend may need I/O to build (a connection pool) and the constructor is
	 * synchronous; every caller here is already async.
	 */
	private metadata(): Promise<TaskMetadataPersistencePort> {
		if (this.metadataOverride) {
			return Promise.resolve(this.metadataOverride)
		}
		if (!this.metadataPromise) {
			this.metadataPromise = resolveTaskPersistence(this.globalStoragePath)
		}
		return this.metadataPromise
	}

	/**
	 * Write a HistoryItem to the metadata store.
	 */
	private async writeTaskFile(item: HistoryItem): Promise<void> {
		await (await this.metadata()).writeTaskMetadata(item)
	}

	/**
	 * Read a HistoryItem from the metadata store; `null` when there is no record.
	 */
	private async readTaskFile(taskId: string): Promise<HistoryItem | null> {
		return (await (await this.metadata()).readTaskMetadata(taskId)) ?? null
	}

	// ────────────────────────────── Private: fs.watch ──────────────────────────────

	/**
	 * Watch the tasks directory for changes from other instances.
	 */
	private startWatcher(): void {
		if (this.disposed) {
			return
		}

		// Use a debounced handler to avoid excessive reconciliation
		let watchDebounce: ReturnType<typeof setTimeout> | null = null

		this.getTasksDir()
			.then((tasksDir) => {
				if (this.disposed) {
					return
				}

				try {
					this.fsWatcher = fsSync.watch(tasksDir, { recursive: false }, (_eventType, _filename) => {
						if (this.disposed) {
							return
						}

						// Debounce the reconciliation triggered by fs.watch
						if (watchDebounce) {
							clearTimeout(watchDebounce)
						}
						watchDebounce = setTimeout(() => {
							this.reconcile().catch((err) => {
								taskLog.error("[TaskHistoryStore] Reconciliation after fs.watch failed:", err)
							})
						}, 500)
					})

					this.fsWatcher.on("error", (err) => {
						taskLog.error("[TaskHistoryStore] fs.watch error:", err)
						// fs.watch is unreliable on some platforms; periodic reconciliation
						// serves as the fallback.
					})
				} catch (err) {
					taskLog.error("[TaskHistoryStore] Failed to start fs.watch:", err)
				}
			})
			.catch((err) => {
				taskLog.error("[TaskHistoryStore] Failed to get tasks dir for watcher:", err)
			})
	}

	/**
	 * Start periodic reconciliation as a defensive fallback for platforms
	 * where fs.watch is unreliable.
	 */
	private startPeriodicReconciliation(): void {
		if (this.disposed) {
			return
		}

		this.reconcileTimer = setTimeout(async () => {
			if (this.disposed) {
				return
			}
			try {
				await this.reconcile()
			} catch (err) {
				taskLog.error("[TaskHistoryStore] Periodic reconciliation failed:", err)
			}
			this.startPeriodicReconciliation()
		}, TaskHistoryStore.RECONCILE_INTERVAL_MS)
	}

	// ────────────────────────────── Private: Write lock ──────────────────────────────

	/**
	 * Serializes all read-modify-write operations within a single extension
	 * host process to prevent concurrent interleaving.
	 */
	private withLock<T>(fn: () => Promise<T>): Promise<T> {
		const result = this.writeLock.then(fn, fn)
		this.writeLock = result.then(
			() => {},
			() => {},
		)
		return result
	}

	// ────────────────────────────── Private: Path helpers ──────────────────────────────

	/**
	 * Get the tasks base directory path, resolving custom storage paths.
	 */
	private async getTasksDir(): Promise<string> {
		const basePath = await getStorageBasePath(this.globalStoragePath)
		return path.join(basePath, "tasks")
	}

	/**
	 * Get the path to a task's `history_item.json` file.
	 */
	private async getTaskFilePath(taskId: string): Promise<string> {
		const tasksDir = await this.getTasksDir()
		return path.join(tasksDir, taskId, GlobalFileNames.historyItem)
	}

	/**
	 * Get the path to the `_index.json` file.
	 */
	private async getIndexPath(): Promise<string> {
		const tasksDir = await this.getTasksDir()
		return path.join(tasksDir, GlobalFileNames.historyIndex)
	}
}
