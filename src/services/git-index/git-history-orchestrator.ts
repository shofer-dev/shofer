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
 * and the QdrantVectorStore to build the git commit history index.
 *
 * Owned by GitIndexManager; not instantiated directly.
 */
export class GitHistoryOrchestrator {
	private readonly _logExtractor: GitLogExtractor
	private readonly _watcher: GitWatcher
	private _isProcessing = false

	constructor(
		private readonly workspacePath: string,
		private readonly stateManager: GitHistoryStateManager,
		private readonly cacheManager: GitCacheManager,
		private readonly embedder: IEmbedder,
		private readonly vectorStore: IVectorStore,
	) {
		this._logExtractor = new GitLogExtractor()
		this._watcher = new GitWatcher()
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
	 *  1. Extract commits via `git log` (GitLogExtractor)
	 *  2. Filter by maxHistoryDays (config)
	 *  3. Skip unchanged commits via GitCacheManager
	 *  4. Batch commits (BATCH_SEGMENT_THRESHOLD at a time)
	 *  5. Embed batch content texts
	 *  6. Upsert points to git-specific Qdrant collection
	 *  7. Start GitWatcher for incremental updates (Phase 1 stub)
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
			// 1. Extract commits
			this.stateManager.setSystemState("Indexing", "Extracting git commit history...")

			const commits = await this._logExtractor.extractCommits(
				this.workspacePath,
				effectiveMaxDays,
				effectiveMaxCommits,
			)

			if (commits.length === 0) {
				this.stateManager.setSystemState("Indexed", "No commits found to index.")
				return
			}

			// 2. Filter by cache — skip commits whose content hash is unchanged
			const newCommits = commits.filter((c) => !this.cacheManager.isUnchanged(c.commit_hash, c.contentHash))

			if (newCommits.length === 0) {
				this.stateManager.setSystemState("Indexed", "All commits already indexed (no changes).")
				return
			}

			this.stateManager.setSystemState("Indexing", `Indexing ${newCommits.length} commits...`)

			// 3. Initialize vector store collection
			await this.vectorStore.initialize()

			// 4. Process in batches
			await this._processBatches(newCommits)

			// 5. Persist cache
			await this.cacheManager.persist()

			// 6. Start watcher (Phase 1 stub — no-op)
			this._watcher.start()

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
		this._watcher.stop()
		this.stateManager.setSystemState("Stopping", "Stopping git indexing...")
		this.stateManager.setSystemState("Standby", "Git indexing stopped.")
	}

	/**
	 * Stop only the git watcher (preserves orchestrator state).
	 */
	public stopWatcher(): void {
		this._watcher.stop()
	}

	// --- Private Helpers ---

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
		}
	}
}
