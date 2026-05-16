import { v5 as uuidv5 } from "uuid"

import type { GitCommitBlock } from "./interfaces/git"
import type { IEmbedder } from "../code-index/interfaces/embedder"
import type { IVectorStore } from "../code-index/interfaces/vector-store"

import { GitHistoryStateManager } from "./git-state-manager"
import { GitLogExtractor } from "./processors/git-log-extractor"
import { GitWatcher } from "./processors/git-watcher"
import { GitCacheManager } from "./git-cache-manager"

import { BATCH_SEGMENT_THRESHOLD } from "../code-index/constants"
import { TelemetryService } from "@shofer/telemetry"
import { TelemetryEventName } from "@shofer/types"

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
	private readonly _watcher: GitWatcher
	private _isProcessing = false
	private _watcherSubscription: { dispose(): void } | null = null

	constructor(
		private readonly workspacePath: string,
		private readonly stateManager: GitHistoryStateManager,
		private readonly cacheManager: GitCacheManager,
		private readonly embedder: IEmbedder,
		private readonly vectorStore: IVectorStore,
	) {
		this._logExtractor = new GitLogExtractor()
		this._watcher = new GitWatcher(workspacePath)
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
			// 1. Catch-up: if we have a lastCommitDate, pull new commits first
			const lastDate = this.cacheManager.lastCommitDate
			if (lastDate) {
				await this._catchUpIncremental(lastDate)
			}

			// 2. Full scan: extract all commits within the configured window
			this.stateManager.setSystemState("Indexing", "Extracting git commit history...")

			const commits = await this._logExtractor.extractCommits(
				this.workspacePath,
				effectiveMaxDays,
				effectiveMaxCommits,
			)

			if (commits.length === 0) {
				this.stateManager.setSystemState("Indexed", "No commits found to index.")

				// Start watcher anyway — there may be commits in the future
				this._startWatcher()
				return
			}

			// 3. Filter by cache — skip commits whose content hash is unchanged
			const newCommits = commits.filter((c) => !this.cacheManager.isUnchanged(c.commit_hash, c.contentHash))

			if (newCommits.length === 0) {
				this.stateManager.setSystemState("Indexed", "All commits already indexed (no changes).")

				// Update lastCommitDate to the most recent known commit even if unchanged
				this.cacheManager.updateLastCommitDateFromBatch(commits)
				await this.cacheManager.persist()
				this._startWatcher()
				return
			}

			this.stateManager.setSystemState("Indexing", `Indexing ${newCommits.length} commits...`)

			// 4. Initialize vector store collection
			await this.vectorStore.initialize()

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

			try {
				TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
					error: message,
					stack: error instanceof Error ? error.stack : undefined,
					location: "GitHistoryOrchestrator.startIndexing",
				})
			} catch {
				// Telemetry may not be initialized yet.
			}

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
	 */
	private async _catchUpIncremental(sinceDate: string): Promise<void> {
		try {
			const incrementalCommits = await this._logExtractor.extractCommitsSince(this.workspacePath, sinceDate)

			if (incrementalCommits.length === 0) return

			const newCommits = incrementalCommits.filter(
				(c) => !this.cacheManager.isUnchanged(c.commit_hash, c.contentHash),
			)

			if (newCommits.length > 0) {
				await this._processBatches(newCommits)
			}

			// Update lastCommitDate even if nothing was new (avoid re-scanning old commits)
			this.cacheManager.updateLastCommitDateFromBatch(incrementalCommits)
			await this.cacheManager.persist()
		} catch (error) {
			// Catch-up is best-effort; log and continue to full scan
			console.warn("[GitHistoryOrchestrator] Incremental catch-up failed:", error)
		}
	}

	/**
	 * Process commit blocks in batches: embed → create Qdrant points → upsert.
	 */
	private async _processBatches(commits: GitCommitBlock[]): Promise<void> {
		const batchSize = BATCH_SEGMENT_THRESHOLD

		for (let i = 0; i < commits.length; i += batchSize) {
			const batch = commits.slice(i, i + batchSize)

			// Create embeddings for the batch
			const contentTexts = batch.map((c) => c.content)
			const embeddingResponse = await this.embedder.createEmbeddings(contentTexts)
			const vectors = embeddingResponse?.embeddings

			if (!vectors || vectors.length === 0) {
				throw new Error("Failed to create embeddings for git commits.")
			}

			// Create Qdrant points (uuidv5 is a top-level static import)
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

			// Upsert to Qdrant
			await this.vectorStore.upsertPoints(points)

			// Update cache immediately so partial progress is protected
			batch.forEach((c) => this.cacheManager.setHash(c.commit_hash, c.contentHash))
			this.cacheManager.updateLastCommitDateFromBatch(batch)
		}
	}

	/**
	 * Start the git watcher and wire it to the incremental indexing handler.
	 */
	private _startWatcher(): void {
		this._stopWatcher()

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
				const message = error instanceof Error ? error.message : String(error)
				console.error("[GitHistoryOrchestrator] Watcher incremental index failed:", message)
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
		this._watcher.stop()
	}
}
