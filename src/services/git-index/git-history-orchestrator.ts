import { v5 as uuidv5 } from "uuid"

import type { GitCommitBlock } from "./interfaces/git"
import type { IEmbedder } from "../code-index/interfaces/embedder"
import type { IVectorStore } from "../code-index/interfaces/vector-store"

import { GitHistoryStateManager } from "./git-state-manager"
import { GitLogExtractor } from "./processors/git-log-extractor"
import { GitWatcher } from "./processors/git-watcher"
import { GitCacheManager } from "./git-cache-manager"

import { BATCH_SEGMENT_THRESHOLD } from "../code-index/constants"
import { logger } from "../../utils/logging"

const LOG_PREFIX = "[GitHistoryOrchestrator]"

/**
 * UUID v5 namespace for git commit block Qdrant point IDs.
 * Separate from QDRANT_CODE_BLOCK_NAMESPACE to avoid ID collisions.
 */
const QDRANT_GIT_NAMESPACE = "a1b2c3d4-e5f6-4789-ab12-cd34ef567890"

/**
 * Default configuration values for git indexing.
 */
const DEFAULT_GIT_MAX_HISTORY_DAYS = 365
const DEFAULT_GIT_MAX_COMMITS = 10000

/**
 * Default poll interval in milliseconds (5 minutes).
 */
const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000

/**
 * Drives the git history indexing pipeline: extract → embed → upsert.
 *
 * Coordinates between GitLogExtractor, GitCacheManager, the embedder,
 * the QdrantVectorStore, and the GitWatcher to build and maintain
 * the git commit history index.
 *
 * Owned by GitIndexManager; not instantiated directly.
 */
export class GitHistoryOrchestrator {
	private readonly _logExtractor: GitLogExtractor
	private _watcher: GitWatcher | null = null
	private _isProcessing = false
	private _watcherSubscription: { dispose(): void } | null = null
	private readonly _pollIntervalMs: number

	constructor(
		private readonly workspacePath: string,
		private readonly stateManager: GitHistoryStateManager,
		private readonly cacheManager: GitCacheManager,
		private readonly embedder: IEmbedder,
		private readonly vectorStore: IVectorStore,
		pollIntervalMs?: number,
	) {
		this._logExtractor = new GitLogExtractor()
		this._pollIntervalMs = pollIntervalMs && pollIntervalMs > 0 ? pollIntervalMs : DEFAULT_POLL_INTERVAL_MS
	}

	/**
	 * Whether the orchestrator is currently performing an indexing run.
	 */
	public get isProcessing(): boolean {
		return this._isProcessing
	}

	/**
	 * Start or restart the git history indexing process.
	 *
	 * Pipeline:
	 *  1. Catch-up: if cache has lastCommitDate, do incremental scan first
	 *  2. Full scan: extract commits via `git log` (GitLogExtractor)
	 *  3. Filter by cache — skip unchanged commits
	 *  4. Batch embed + upsert to Qdrant (git-specific collection)
	 *  5. Update cache with hashes + lastCommitDate
	 *  6. Start GitWatcher for ongoing incremental updates
	 *
	 * @param maxHistoryDays - Maximum days of history to index
	 * @param maxCommits - Hard cap on number of commits to index
	 */
	public async startIndexing(maxHistoryDays: number, maxCommits: number): Promise<void> {
		if (this._isProcessing) return

		this._isProcessing = true
		const effectiveMaxDays = maxHistoryDays > 0 ? maxHistoryDays : DEFAULT_GIT_MAX_HISTORY_DAYS
		const effectiveMaxCommits = maxCommits > 0 ? maxCommits : DEFAULT_GIT_MAX_COMMITS

		try {
			// 1. Ensure the vector store collection exists before any upserts.
			//    This handles the case where clearIndexData() was called but
			//    lastCommitDate is still in cache — without initialize(), the
			//    catch-up path would attempt upserts into a non-existent collection.
			await this.vectorStore.initialize()

			// 2. Catch-up: if we have a lastCommitDate, pull new commits first
			const lastDate = this.cacheManager.lastCommitDate
			if (lastDate) {
				await this._catchUpIncremental(lastDate)
			}

			// 3. Full scan: extract all commits within the configured window
			this.stateManager.setSystemState("Indexing", "Extracting git commit history...")

			const commits = await this._logExtractor.extractCommits(
				this.workspacePath,
				effectiveMaxDays,
				effectiveMaxCommits,
			)

			if (commits.length === 0) {
				this.stateManager.setSystemState("Indexed", "No commits found to index.")
				this._startWatcher()
				return
			}

			// 4. Filter by cache — skip commits whose content hash is unchanged
			const newCommits = commits.filter((c) => !this.cacheManager.isUnchanged(c.commit_hash, c.contentHash))

			if (newCommits.length === 0) {
				this.stateManager.setSystemState("Indexed", "All commits already indexed (no changes).")
				this.cacheManager.updateLastCommitDateFromBatch(commits)
				await this.cacheManager.persist()
				this._startWatcher()
				return
			}

			this.stateManager.setSystemState("Indexing", `Indexing ${newCommits.length} commits...`)

			// 5. Process in batches
			await this._processBatches(newCommits)

			// 6. Update lastCommitDate from the full batch
			this.cacheManager.updateLastCommitDateFromBatch(commits)
			await this.cacheManager.persist()

			// 7. Start watcher for ongoing incremental updates
			this._startWatcher()

			this.stateManager.setSystemState("Indexed", `Indexed ${newCommits.length} commits.`)
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			this.stateManager.setSystemState("Error", message)

			logger.error(`${LOG_PREFIX} startIndexing failed: ${message}`, {
				ctx: "git-index",
				error: error instanceof Error ? error.message : String(error),
			})

			throw error
		} finally {
			this._isProcessing = false
		}
	}

	/**
	 * Stop any in-progress indexing and the git watcher.
	 */
	public stopIndexing(): void {
		this._stopWatcher()
		this.stateManager.setSystemState("Stopping", "Stopping git indexing...")
		this.stateManager.setSystemState("Standby", "Git indexing stopped.")
	}

	/**
	 * Stop only the git watcher (preserves orchestrator state).
	 */
	public stopWatcher(): void {
		this._stopWatcher()
	}

	// --- Private Helpers ---

	/**
	 * Catch up on commits that landed since the last index date.
	 * Best-effort: failures are logged and swallowed; the full scan will pick
	 * up any missed commits.
	 */
	private async _catchUpIncremental(sinceDate: string): Promise<void> {
		// Guard against concurrent processing (defensive — currently only
		// called from startIndexing which already sets _isProcessing).
		if (this._isProcessing) return

		try {
			const incrementalCommits = await this._logExtractor.extractCommitsSince(
				this.workspacePath,
				sinceDate,
				500, // Safety cap for catch-up
			)

			if (incrementalCommits.length === 0) return

			const newCommits = incrementalCommits.filter(
				(c) => !this.cacheManager.isUnchanged(c.commit_hash, c.contentHash),
			)

			if (newCommits.length > 0) {
				await this._processBatches(newCommits)
			}

			this.cacheManager.updateLastCommitDateFromBatch(incrementalCommits)
			await this.cacheManager.persist()
		} catch (error) {
			logger.warn(`${LOG_PREFIX} Incremental catch-up failed (non-critical): ${error}`, {
				ctx: "git-index",
			})
		}
	}

	/**
	 * Process commit blocks in batches: embed → create Qdrant points → upsert.
	 */
	private async _processBatches(commits: GitCommitBlock[]): Promise<void> {
		const batchSize = BATCH_SEGMENT_THRESHOLD

		for (let i = 0; i < commits.length; i += batchSize) {
			const batch = commits.slice(i, i + batchSize)

			const contentTexts = batch.map((c) => c.content)
			const embeddingResponse = await this.embedder.createEmbeddings(contentTexts)
			const vectors = embeddingResponse?.embeddings

			if (!vectors || vectors.length === 0) {
				throw new Error("Failed to create embeddings for git commits.")
			}

			const points = batch.map((commit, index) => ({
				id: uuidv5(commit.commit_hash, QDRANT_GIT_NAMESPACE),
				vector: vectors[index],
				payload: {
					commit_hash: commit.commit_hash,
					short_hash: commit.short_hash,
					author: commit.author,
					author_date: commit.author_date,
					subject: commit.subject,
					body: commit.body,
				},
			}))

			await this.vectorStore.upsertPoints(points)

			batch.forEach((c) => this.cacheManager.setHash(c.commit_hash, c.contentHash))
			this.cacheManager.updateLastCommitDateFromBatch(batch)
		}
	}

	/**
	 * Start the git watcher and wire it to the incremental indexing handler.
	 */
	private _startWatcher(): void {
		this._stopWatcher()

		if (!this._watcher) {
			this._watcher = new GitWatcher(this.workspacePath, this._pollIntervalMs)
		}

		this._watcherSubscription = this._watcher.onNewCommits(async (commits: GitCommitBlock[]) => {
			if (this._isProcessing) return

			try {
				this._isProcessing = true
				const newCommits = commits.filter((c) => !this.cacheManager.isUnchanged(c.commit_hash, c.contentHash))

				if (newCommits.length > 0) {
					this.stateManager.setSystemState("Indexing", `Indexing ${newCommits.length} new commits...`)
					await this._processBatches(newCommits)
					this.cacheManager.updateLastCommitDateFromBatch(commits)
					await this.cacheManager.persist()
					this.stateManager.setSystemState("Indexed", `Indexed ${newCommits.length} new commits.`)
				}
			} catch (error) {
				logger.error(`${LOG_PREFIX} Watcher incremental index failed: ${error}`, {
					ctx: "git-index",
					error: error instanceof Error ? error.message : String(error),
				})
			} finally {
				this._isProcessing = false
			}
		})

		this._watcher.start(() => this.cacheManager.lastCommitDate)
	}

	/**
	 * Stop the watcher and dispose its subscription.
	 */
	private _stopWatcher(): void {
		if (this._watcherSubscription) {
			this._watcherSubscription.dispose()
			this._watcherSubscription = null
		}
		this._watcher?.stop()
	}
}
