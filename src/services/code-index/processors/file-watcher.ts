import * as vscode from "vscode"
import {
	QDRANT_CODE_BLOCK_NAMESPACE,
	MAX_FILE_SIZE_BYTES,
	BATCH_SEGMENT_THRESHOLD,
	MAX_BATCH_RETRIES,
	INITIAL_RETRY_DELAY_MS,
} from "../constants"
import { createHash } from "crypto"
import { ShoferIgnoreController } from "../../../core/ignore/ShoferIgnoreController"
import { v5 as uuidv5 } from "uuid"
import { scannerExtensions } from "../shared/supported-extensions"
import type { IIgnoreFilter } from "../shared/git-ignore-filter"
import { makeSingleflightRefresh } from "../shared/git-ignore-filter"
import {
	IFileWatcher,
	FileProcessingResult,
	IEmbedder,
	IVectorStore,
	PointStruct,
	BatchProcessingSummary,
} from "../interfaces"
import { codeParser } from "./parser"
import { CacheManager } from "../cache-manager"
import { generateNormalizedAbsolutePath, generateRelativeFilePath } from "../shared/get-relative-path"
import { isPathInIgnoredDirectory } from "../../glob/ignore-utils"
import { TelemetryService } from "@shofer/telemetry"
import { TelemetryEventName } from "@shofer/types"
import { sanitizeErrorMessage } from "../shared/validation-helpers"
import { Package } from "../../../shared/package"
import { codeIndexLog } from "../../../utils/logging/subsystems"

/**
 * Implementation of the file watcher interface
 */
export class FileWatcher implements IFileWatcher {
	private ignoreInstance?: IIgnoreFilter
	private refreshIgnoreSnapshot: () => Promise<void> = () => Promise.resolve()
	private fileWatcher?: vscode.FileSystemWatcher
	private ignoreController: ShoferIgnoreController
	private accumulatedEvents: Map<string, { uri: vscode.Uri; type: "create" | "change" | "delete" }> = new Map()
	private batchProcessDebounceTimer?: NodeJS.Timeout
	private _batchInFlight: boolean = false
	private readonly BATCH_DEBOUNCE_DELAY_MS = 500
	private readonly FILE_PROCESSING_CONCURRENCY_LIMIT = 10
	private readonly batchSegmentThreshold: number

	private readonly _onDidStartBatchProcessing = new vscode.EventEmitter<string[]>()
	private readonly _onBatchProgressUpdate = new vscode.EventEmitter<{
		processedInBatch: number
		totalInBatch: number
		currentFile?: string
	}>()
	private readonly _onDidFinishBatchProcessing = new vscode.EventEmitter<BatchProcessingSummary>()

	/**
	 * Event emitted when a batch of files begins processing
	 */
	public readonly onDidStartBatchProcessing = this._onDidStartBatchProcessing.event

	/**
	 * Event emitted to report progress during batch processing
	 */
	public readonly onBatchProgressUpdate = this._onBatchProgressUpdate.event

	/**
	 * Event emitted when a batch of files has finished processing
	 */
	public readonly onDidFinishBatchProcessing = this._onDidFinishBatchProcessing.event

	/**
	 * Creates a new file watcher
	 * @param workspacePath Path to the workspace
	 * @param context VS Code extension context
	 * @param embedder Optional embedder
	 * @param vectorStore Optional vector store
	 * @param cacheManager Cache manager
	 */
	constructor(
		private workspacePath: string,
		private context: vscode.ExtensionContext,
		private readonly cacheManager: CacheManager,
		private embedder?: IEmbedder,
		private vectorStore?: IVectorStore,
		ignoreInstance?: IIgnoreFilter,
		ignoreController?: ShoferIgnoreController,
		batchSegmentThreshold?: number,
	) {
		this.ignoreController = ignoreController || new ShoferIgnoreController(workspacePath)
		if (ignoreInstance) {
			this.ignoreInstance = ignoreInstance
			this.refreshIgnoreSnapshot = makeSingleflightRefresh(ignoreInstance)
		}
		// Get the configurable batch size from VSCode settings, fallback to default
		// If not provided in constructor, try to get from VSCode settings
		if (batchSegmentThreshold !== undefined) {
			this.batchSegmentThreshold = batchSegmentThreshold
		} else {
			try {
				this.batchSegmentThreshold = vscode.workspace
					.getConfiguration(Package.name)
					.get<number>("codeIndex.embeddingBatchSize", BATCH_SEGMENT_THRESHOLD)
			} catch {
				// In test environment, vscode.workspace might not be available
				this.batchSegmentThreshold = BATCH_SEGMENT_THRESHOLD
			}
		}
	}

	/**
	 * Initializes the file watcher
	 */
	async initialize(): Promise<void> {
		// Create file watcher
		const globSuffix = `**/*{${scannerExtensions.map((e) => e.substring(1)).join(",")}}`
		const filePattern = new vscode.RelativePattern(this.workspacePath, globSuffix)
		this.fileWatcher = vscode.workspace.createFileSystemWatcher(filePattern)

		codeIndexLog.debug(`initialize: workspace=${this.workspacePath} glob=${globSuffix}`)

		// Register event handlers
		this.fileWatcher.onDidCreate(this.handleFileCreated.bind(this))
		this.fileWatcher.onDidChange(this.handleFileChanged.bind(this))
		this.fileWatcher.onDidDelete(this.handleFileDeleted.bind(this))
	}

	/**
	 * Disposes the file watcher
	 */
	dispose(): void {
		this.fileWatcher?.dispose()
		if (this.batchProcessDebounceTimer) {
			clearTimeout(this.batchProcessDebounceTimer)
		}
		this._onDidStartBatchProcessing.dispose()
		this._onBatchProgressUpdate.dispose()
		this._onDidFinishBatchProcessing.dispose()
		this.accumulatedEvents.clear()
	}

	/**
	 * Handles file creation events
	 * @param uri URI of the created file
	 */
	private async handleFileCreated(uri: vscode.Uri): Promise<void> {
		codeIndexLog.debug(`event create: ${generateRelativeFilePath(uri.fsPath, this.workspacePath)}`)
		this.accumulatedEvents.set(uri.fsPath, { uri, type: "create" })
		this.scheduleBatchProcessing()
	}

	/**
	 * Handles file change events
	 * @param uri URI of the changed file
	 */
	private async handleFileChanged(uri: vscode.Uri): Promise<void> {
		codeIndexLog.debug(`event change: ${generateRelativeFilePath(uri.fsPath, this.workspacePath)}`)
		this.accumulatedEvents.set(uri.fsPath, { uri, type: "change" })
		this.scheduleBatchProcessing()
	}

	/**
	 * Handles file deletion events
	 * @param uri URI of the deleted file
	 */
	private async handleFileDeleted(uri: vscode.Uri): Promise<void> {
		codeIndexLog.debug(`event delete: ${generateRelativeFilePath(uri.fsPath, this.workspacePath)}`)
		this.accumulatedEvents.set(uri.fsPath, { uri, type: "delete" })
		this.scheduleBatchProcessing()
	}

	/**
	 * Schedules batch processing with debounce
	 */
	private scheduleBatchProcessing(): void {
		if (this.batchProcessDebounceTimer) {
			clearTimeout(this.batchProcessDebounceTimer)
		}
		this.batchProcessDebounceTimer = setTimeout(() => this.triggerBatchProcessing(), this.BATCH_DEBOUNCE_DELAY_MS)
	}

	/**
	 * Triggers processing of accumulated events.
	 *
	 * Re-entrancy: guarded by {@link _batchInFlight}. A second debounce that
	 * fires while a batch is mid-flight does NOT start a parallel
	 * `processBatch` (that would race on `accumulatedEvents` and on the
	 * git-ignore snapshot refresh); it simply reschedules itself so the
	 * still-arriving events get picked up after the in-flight batch finishes.
	 *
	 * GitIgnore snapshot: refreshed lazily, and only when a `create` event
	 * references a path the current snapshot does not know about (i.e. the
	 * snapshot would `ignores() => true` it and the file would be silently
	 * skipped). Pure change/delete batches don't pay the git-process cost.
	 * The refresh itself is single-flighted so back-to-back batches share
	 * one in-flight `git ls-files`.
	 */
	private async triggerBatchProcessing(): Promise<void> {
		if (this._batchInFlight) {
			// Another invocation owns the batch. Reschedule so new events
			// accumulated during processing are drained on the next debounce.
			this.scheduleBatchProcessing()
			return
		}
		if (this.accumulatedEvents.size === 0) {
			return
		}

		this._batchInFlight = true
		try {
			if (this.ignoreInstance) {
				let needsRefresh = false
				for (const event of this.accumulatedEvents.values()) {
					if (event.type !== "create") continue
					const rel = generateRelativeFilePath(event.uri.fsPath, this.workspacePath)
					if (this.ignoreInstance.ignores(rel)) {
						needsRefresh = true
						break
					}
				}
				if (needsRefresh) {
					await this.refreshIgnoreSnapshot()
				}
			}

			const eventsToProcess = new Map(this.accumulatedEvents)
			this.accumulatedEvents.clear()

			const filePathsInBatch = Array.from(eventsToProcess.keys())
			this._onDidStartBatchProcessing.fire(filePathsInBatch)

			await this.processBatch(eventsToProcess)
		} finally {
			this._batchInFlight = false
			if (this.accumulatedEvents.size > 0) {
				this.scheduleBatchProcessing()
			}
		}
	}

	/**
	 * Processes a batch of accumulated events
	 * @param eventsToProcess Map of events to process
	 */
	private async _handleBatchDeletions(
		batchResults: FileProcessingResult[],
		processedCountInBatch: number,
		totalFilesInBatch: number,
		pathsToExplicitlyDelete: string[],
	): Promise<{ overallBatchError?: Error; processedCount: number }> {
		let overallBatchError: Error | undefined

		if (pathsToExplicitlyDelete.length > 0 && this.vectorStore) {
			try {
				await this.vectorStore.deletePointsByMultipleFilePaths(pathsToExplicitlyDelete)

				for (const path of pathsToExplicitlyDelete) {
					this.cacheManager.deleteHash(path)
					batchResults.push({ path, status: "success" })
					processedCountInBatch++
					this._onBatchProgressUpdate.fire({
						processedInBatch: processedCountInBatch,
						totalInBatch: totalFilesInBatch,
						currentFile: path,
					})
				}
			} catch (error: any) {
				const errorStatus = error?.status || error?.response?.status || error?.statusCode
				const errorMessage = error instanceof Error ? error.message : String(error)

				// Log telemetry for deletion error
				TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
					error: sanitizeErrorMessage(errorMessage),
					location: "deletePointsByMultipleFilePaths",
					errorType: "deletion_error",
					errorStatus: errorStatus,
				})

				// Mark all paths as error
				overallBatchError = error as Error
				for (const path of pathsToExplicitlyDelete) {
					batchResults.push({ path, status: "error", error: error as Error })
					processedCountInBatch++
					this._onBatchProgressUpdate.fire({
						processedInBatch: processedCountInBatch,
						totalInBatch: totalFilesInBatch,
						currentFile: path,
					})
				}
			}
		}

		return { overallBatchError, processedCount: processedCountInBatch }
	}

	private async _processFilesAndPrepareUpserts(
		filesToUpsertDetails: Array<{ path: string; uri: vscode.Uri; originalType: "create" | "change" }>,
		batchResults: FileProcessingResult[],
		processedCountInBatch: number,
		totalFilesInBatch: number,
		pathsToExplicitlyDelete: string[],
	): Promise<{
		pointsForBatchUpsert: PointStruct[]
		successfullyProcessedForUpsert: Array<{
			path: string
			newHash?: string
			newSegmentHashes?: string[]
			mtimeMs?: number
			size?: number
		}>
		processedCount: number
		allStaleSegmentIds: string[]
	}> {
		const pointsForBatchUpsert: PointStruct[] = []
		const successfullyProcessedForUpsert: Array<{
			path: string
			newHash?: string
			newSegmentHashes?: string[]
			mtimeMs?: number
			size?: number
		}> = []
		const allStaleSegmentIds: string[] = []
		const filesToProcessConcurrently = [...filesToUpsertDetails]

		for (let i = 0; i < filesToProcessConcurrently.length; i += this.FILE_PROCESSING_CONCURRENCY_LIMIT) {
			const chunkToProcess = filesToProcessConcurrently.slice(i, i + this.FILE_PROCESSING_CONCURRENCY_LIMIT)

			const chunkProcessingPromises = chunkToProcess.map(async (fileDetail) => {
				this._onBatchProgressUpdate.fire({
					processedInBatch: processedCountInBatch,
					totalInBatch: totalFilesInBatch,
					currentFile: fileDetail.path,
				})
				try {
					const result = await this.processFile(fileDetail.path)
					return { path: fileDetail.path, result: result, error: undefined }
				} catch (e) {
					const error = e as Error
					codeIndexLog.error(`[FileWatcher] Unhandled exception processing file ${fileDetail.path}:`, e)
					return { path: fileDetail.path, result: undefined, error: error }
				}
			})

			const settledChunkResults = await Promise.allSettled(chunkProcessingPromises)

			for (const settledResult of settledChunkResults) {
				let resultPath: string | undefined

				if (settledResult.status === "fulfilled") {
					const { path, result, error: directError } = settledResult.value
					resultPath = path

					if (directError) {
						batchResults.push({ path, status: "error", error: directError })
					} else if (result) {
						if (result.status === "skipped" || result.status === "local_error") {
							batchResults.push(result)
						} else if (result.status === "processed_for_batching") {
							if (result.pointsToUpsert && result.pointsToUpsert.length > 0) {
								pointsForBatchUpsert.push(...result.pointsToUpsert)
							}
							// Collect stale segment point IDs for targeted deletion
							if (result.staleSegmentIds && result.staleSegmentIds.length > 0) {
								allStaleSegmentIds.push(...result.staleSegmentIds)
							}
							// Always record the file for cache-update, even when all
							// segments were reused (no points to upsert) — the cache
							// must reflect the new full-file hash + segment hashes.
							if (result.path) {
								successfullyProcessedForUpsert.push({
									path: result.path,
									newHash: result.newHash,
									newSegmentHashes: result.newSegmentHashes,
									mtimeMs: result.newMtimeMs,
									size: result.newSize,
								})
							}
						} else {
							batchResults.push({
								path,
								status: "error",
								error: new Error(
									`Unexpected result status from processFile: ${result.status} for file ${path}`,
								),
							})
						}
					} else {
						batchResults.push({
							path,
							status: "error",
							error: new Error(`Fulfilled promise with no result or error for file ${path}`),
						})
					}
				} else {
					const error = settledResult.reason as Error
					const rejectedPath = (settledResult.reason as any)?.path || "unknown"
					codeIndexLog.error("[FileWatcher] A file processing promise was rejected:", settledResult.reason)
					batchResults.push({
						path: rejectedPath,
						status: "error",
						error: error,
					})
				}

				if (!pathsToExplicitlyDelete.includes(resultPath || "")) {
					processedCountInBatch++
				}
				this._onBatchProgressUpdate.fire({
					processedInBatch: processedCountInBatch,
					totalInBatch: totalFilesInBatch,
					currentFile: resultPath,
				})
			}
		}

		return {
			pointsForBatchUpsert,
			successfullyProcessedForUpsert,
			processedCount: processedCountInBatch,
			allStaleSegmentIds,
		}
	}

	private async _executeBatchUpsertOperations(
		pointsForBatchUpsert: PointStruct[],
		successfullyProcessedForUpsert: Array<{
			path: string
			newHash?: string
			newSegmentHashes?: string[]
			mtimeMs?: number
			size?: number
		}>,
		batchResults: FileProcessingResult[],
		overallBatchError?: Error,
	): Promise<Error | undefined> {
		// Update cache even when no points need upserting (all segments reused).
		// This ensures the full-file hash + segment hashes are persisted
		// so the next edit starts from the correct baseline.
		if (pointsForBatchUpsert.length === 0 && successfullyProcessedForUpsert.length > 0) {
			// But NOT when an earlier phase failed (e.g. the stale-point
			// `deletePointsByIds` in Phase 3a threw). Persisting the new
			// segmentHashes here would drop the stale hashes from the cache
			// while their points are still live in Qdrant — orphaning them
			// permanently, since they could never be diffed as stale again.
			// Mark the files as errored so the next save retries the cleanup.
			if (overallBatchError) {
				for (const { path } of successfullyProcessedForUpsert) {
					batchResults.push({ path, status: "error", error: overallBatchError })
				}
				return overallBatchError
			}
			for (const { path, newHash, newSegmentHashes, mtimeMs, size } of successfullyProcessedForUpsert) {
				if (newHash && mtimeMs !== undefined && size !== undefined) {
					this.cacheManager.updateEntry(path, {
						hash: newHash,
						mtimeMs,
						size,
						segmentHashes: newSegmentHashes ?? [],
					})
				}
				batchResults.push({ path, status: "success" })
			}
			return undefined
		}

		if (pointsForBatchUpsert.length > 0 && this.vectorStore && !overallBatchError) {
			try {
				for (let i = 0; i < pointsForBatchUpsert.length; i += this.batchSegmentThreshold) {
					const batch = pointsForBatchUpsert.slice(i, i + this.batchSegmentThreshold)
					let retryCount = 0
					let upsertError: Error | undefined

					while (retryCount < MAX_BATCH_RETRIES) {
						try {
							await this.vectorStore.upsertPoints(batch)
							break
						} catch (error) {
							upsertError = error as Error
							retryCount++
							if (retryCount === MAX_BATCH_RETRIES) {
								// Log telemetry for upsert failure
								TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
									error: sanitizeErrorMessage(upsertError.message),
									location: "upsertPoints",
									errorType: "upsert_retry_exhausted",
									retryCount: MAX_BATCH_RETRIES,
								})
								throw new Error(
									`Failed to upsert batch after ${MAX_BATCH_RETRIES} retries: ${upsertError.message}`,
								)
							}
							await new Promise((resolve) =>
								setTimeout(resolve, INITIAL_RETRY_DELAY_MS * Math.pow(2, retryCount - 1)),
							)
						}
					}
				}

				for (const { path, newHash, newSegmentHashes, mtimeMs, size } of successfullyProcessedForUpsert) {
					if (newHash && mtimeMs !== undefined && size !== undefined) {
						this.cacheManager.updateEntry(path, {
							hash: newHash,
							mtimeMs,
							size,
							segmentHashes: newSegmentHashes ?? [],
						})
					}
					batchResults.push({ path, status: "success" })
				}
			} catch (error) {
				const err = error as Error
				overallBatchError = overallBatchError || err
				// Log telemetry for batch upsert error
				TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
					error: sanitizeErrorMessage(err.message),
					location: "executeBatchUpsertOperations",
					errorType: "batch_upsert_error",
					affectedFiles: successfullyProcessedForUpsert.length,
				})
				for (const { path } of successfullyProcessedForUpsert) {
					batchResults.push({ path, status: "error", error: err })
				}
			}
		} else if (overallBatchError && pointsForBatchUpsert.length > 0) {
			for (const { path } of successfullyProcessedForUpsert) {
				batchResults.push({ path, status: "error", error: overallBatchError })
			}
		}

		return overallBatchError
	}

	private async processBatch(
		eventsToProcess: Map<string, { uri: vscode.Uri; type: "create" | "change" | "delete" }>,
	): Promise<void> {
		const batchResults: FileProcessingResult[] = []
		let processedCountInBatch = 0
		const totalFilesInBatch = eventsToProcess.size
		let overallBatchError: Error | undefined

		// Initial progress update
		this._onBatchProgressUpdate.fire({
			processedInBatch: 0,
			totalInBatch: totalFilesInBatch,
			currentFile: undefined,
		})

		// Categorize events
		const pathsToExplicitlyDelete: string[] = []
		const filesToUpsertDetails: Array<{ path: string; uri: vscode.Uri; originalType: "create" | "change" }> = []

		for (const event of eventsToProcess.values()) {
			if (event.type === "delete") {
				pathsToExplicitlyDelete.push(event.uri.fsPath)
			} else {
				filesToUpsertDetails.push({
					path: event.uri.fsPath,
					uri: event.uri,
					originalType: event.type,
				})
			}
		}

		// Phase 1: Handle explicit file deletions
		const { overallBatchError: deletionError, processedCount: deletionCount } = await this._handleBatchDeletions(
			batchResults,
			processedCountInBatch,
			totalFilesInBatch,
			pathsToExplicitlyDelete,
		)
		overallBatchError = deletionError
		processedCountInBatch = deletionCount

		// Phase 2: Process files and prepare upserts (includes per-segment
		// dedup — each file's processFile() already computed which segments
		// are new vs reused vs stale)
		const {
			pointsForBatchUpsert,
			successfullyProcessedForUpsert,
			allStaleSegmentIds,
			processedCount: upsertCount,
		} = await this._processFilesAndPrepareUpserts(
			filesToUpsertDetails,
			batchResults,
			processedCountInBatch,
			totalFilesInBatch,
			pathsToExplicitlyDelete,
		)
		processedCountInBatch = upsertCount

		// Aggregate per-segment dedup stats across the batch and fire a single
		// telemetry event. Per-file events would be too high-cardinality and
		// would leak file paths; the per-batch aggregate is sufficient to
		// verify the optimization is paying off in production.
		if (filesToUpsertDetails.length > 0) {
			// Derive aggregate stats from what _processFilesAndPrepareUpserts
			// already collected: embedded = upsert count, deleted = stale id
			// count, totalBlocks = sum of newSegmentHashes lengths.
			const embedded = pointsForBatchUpsert.length
			const deleted = allStaleSegmentIds.length
			let totalBlocks = 0
			for (const entry of successfullyProcessedForUpsert) {
				totalBlocks += entry.newSegmentHashes?.length ?? 0
			}
			if (totalBlocks > 0 || deleted > 0) {
				TelemetryService.instance.captureCodeIndexSegmentDedup({
					fileCount: successfullyProcessedForUpsert.length,
					totalBlocks,
					reused: totalBlocks - embedded,
					embedded,
					deleted,
				})
			}
		}

		// Phase 3a: Targeted deletion of stale segment points (replaces the
		// old blanket deletePointsByMultipleFilePaths for change events)
		if (allStaleSegmentIds.length > 0 && this.vectorStore && !overallBatchError) {
			try {
				await this.vectorStore.deletePointsByIds(allStaleSegmentIds)
			} catch (error: any) {
				const err = error as Error
				overallBatchError = err
				TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
					error: sanitizeErrorMessage(err.message),
					location: "deletePointsByIds",
					errorType: "deletion_error",
				})
			}
		}

		// Phase 3b: Execute batch upsert
		overallBatchError = await this._executeBatchUpsertOperations(
			pointsForBatchUpsert,
			successfullyProcessedForUpsert,
			batchResults,
			overallBatchError,
		)

		// Finalize
		this._onDidFinishBatchProcessing.fire({
			processedFiles: batchResults,
			batchError: overallBatchError,
		})
		this._onBatchProgressUpdate.fire({
			processedInBatch: totalFilesInBatch,
			totalInBatch: totalFilesInBatch,
		})

		if (this.accumulatedEvents.size === 0) {
			this._onBatchProgressUpdate.fire({
				processedInBatch: 0,
				totalInBatch: 0,
				currentFile: undefined,
			})
		}
	}

	/**
	 * Processes a file
	 * @param filePath Path to the file to process
	 * @returns Promise resolving to processing result
	 */
	async processFile(filePath: string, signal?: AbortSignal): Promise<FileProcessingResult> {
		try {
			// Get relative path for ignore checks
			const relativeFilePath = generateRelativeFilePath(filePath, this.workspacePath)

			// Check if file is in an ignored directory
			// Use relative path to avoid matching parent directories outside the workspace
			if (isPathInIgnoredDirectory(relativeFilePath)) {
				codeIndexLog.debug(`skip ${relativeFilePath}: in ignored directory`)
				return {
					path: filePath,
					status: "skipped" as const,
					reason: "File is in an ignored directory",
				}
			}

			// Check if file should be ignored
			if (
				!this.ignoreController.validateAccess(filePath) ||
				(this.ignoreInstance && this.ignoreInstance.ignores(relativeFilePath))
			) {
				codeIndexLog.debug(`skip ${relativeFilePath}: ignored by .shoferignore/.gitignore`)
				return {
					path: filePath,
					status: "skipped" as const,
					reason: "File is ignored by .shoferignore or .gitignore",
				}
			}

			// Stat the file for size and mtime + size for cache entry
			const fileStat = await vscode.workspace.fs.stat(vscode.Uri.file(filePath))
			if (fileStat.size > MAX_FILE_SIZE_BYTES) {
				return {
					path: filePath,
					status: "skipped" as const,
					reason: "File is too large",
				}
			}

			// Read file content
			const fileContent = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath))
			const content = fileContent.toString()

			// Calculate hash
			const newHash = createHash("sha256").update(content).digest("hex")

			// Check if file has changed using the full cache entry
			const cached = this.cacheManager.getEntry(filePath)
			if (cached?.hash === newHash) {
				// mtime may have changed — update the cache entry so fast-path works next time.
				// Preserve segmentHashes so the dedup baseline survives mtime-only changes.
				this.cacheManager.updateEntry(filePath, {
					hash: newHash,
					mtimeMs: fileStat.mtime,
					size: fileStat.size,
					segmentHashes: cached.segmentHashes ?? [],
				})
				return {
					path: filePath,
					status: "skipped" as const,
					reason: "File has not changed",
				}
			}

			// Parse file
			const blocks = await codeParser.parseFile(filePath, { content, fileHash: newHash })

			if (blocks.length === 0) {
				// Common causes: file content below MIN_BLOCK_CHARS, parser
				// failure, or a language with no extractable nodes (e.g. an
				// empty markdown file). We do NOT short-circuit here — the cache
				// entry must still be refreshed and any previously-indexed
				// segments must be cleaned up via the dedup path below.
				codeIndexLog.debug(
					`${relativeFilePath}: parser produced 0 blocks (file too small or no parseable content)`,
				)
			}

			// Per-segment dedup: compare new segment hashes against the
			// previously cached set so we only embed and upsert genuinely
			// new or changed segments.
			const prevSegmentHashes = this.cacheManager.getSegmentHashes(filePath)
			const newSegmentHashes = blocks.map((b) => b.segmentHash)
			const newHashSet = new Set(newSegmentHashes)

			// Point IDs of stale segments to delete (removed, moved, or changed)
			const staleSegmentIds = [...prevSegmentHashes]
				.filter((h) => !newHashSet.has(h))
				.map((h) => uuidv5(h, QDRANT_CODE_BLOCK_NAMESPACE))

			// Only embed genuinely new/changed blocks
			const blocksToEmbed = blocks.filter((b) => !prevSegmentHashes.has(b.segmentHash))

			// Prepare points for batch processing
			let pointsToUpsert: PointStruct[] = []
			if (this.embedder && blocksToEmbed.length > 0) {
				const texts = blocksToEmbed.map((block) => block.content)
				const { embeddings } = await this.embedder.createEmbeddings(texts, undefined, signal)

				pointsToUpsert = blocksToEmbed.map((block, index) => {
					// Use segmentHash-based point IDs (matching the scanner)
					// so identical segments share the same Qdrant identity
					// regardless of which code path produced them.
					const pointId = uuidv5(block.segmentHash, QDRANT_CODE_BLOCK_NAMESPACE)

					return {
						id: pointId,
						vector: embeddings[index],
						payload: {
							filePath: generateRelativeFilePath(
								generateNormalizedAbsolutePath(block.file_path, this.workspacePath),
								this.workspacePath,
							),
							codeChunk: block.content,
							startLine: block.start_line,
							endLine: block.end_line,
						},
					}
				})
			}

			return {
				path: filePath,
				status: "processed_for_batching" as const,
				newHash,
				newMtimeMs: fileStat.mtime,
				newSize: fileStat.size,
				newSegmentHashes,
				staleSegmentIds,
				pointsToUpsert,
			}
		} catch (error) {
			return {
				path: filePath,
				status: "local_error" as const,
				error: error as Error,
			}
		}
	}
}
