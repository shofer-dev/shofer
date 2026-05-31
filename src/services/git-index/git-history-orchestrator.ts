import * as path from "path"

import { v5 as uuidv5 } from "uuid"

import type { GitCommitBlock } from "./interfaces/git"
import type { IEmbedder } from "../code-index/interfaces/embedder"
import type { IVectorStore } from "../code-index/interfaces/vector-store"

import { GitHistoryStateManager } from "./git-state-manager"
import { GitLogExtractor } from "./processors/git-log-extractor"
import { GitWatcher } from "./processors/git-watcher"
import { GitCacheManager } from "./git-cache-manager"

import { BATCH_SEGMENT_THRESHOLD } from "../code-index/constants"
import { listSubmoduleDisplayPaths } from "../../utils/git-submodules"
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
 * Auto-recovery constants — when indexing fails due to infrastructure
 * being temporarily down (Ollama / Qdrant not available), the orchestrator
 * will keep trying with ever-increasing backoff instead of staying dead.
 * Same backoff schedule as CodeIndexOrchestrator.
 */
const AUTO_RECOVERY_INITIAL_DELAY_MS = 30_000
const AUTO_RECOVERY_MAX_DELAY_MS = 14_400_000 // 4 hours
const AUTO_RECOVERY_MAX_ATTEMPTS = 10

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
	private _branch = ""

	// ── Auto-recovery ──
	/** Timer that retries startIndexing() after a transient infrastructure outage. */
	private _autoRecoveryTimer: NodeJS.Timeout | null = null
	/** 1-based attempt counter; resets to 0 when indexing succeeds. */
	private _autoRecoveryAttempt = 0

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
	 * @param branch - Git ref (branch name) to index; empty string = HEAD
	 */
	public async startIndexing(maxHistoryDays: number, maxCommits: number, branch: string): Promise<void> {
		if (this._isProcessing) return

		this._isProcessing = true
		this._cancelAutoRecovery()
		this._branch = branch
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

			const commits = await this._extractFromAllRepos((repo, isParent) =>
				this._logExtractor.extractCommits(
					repo,
					effectiveMaxDays,
					effectiveMaxCommits,
					isParent ? this._branch : "",
				),
			)

			if (commits.length === 0) {
				this.stateManager.setSystemState("Indexed", "No commits found to index.")
				this._startWatcher()
				return
			}

			// 4. Filter by cache — skip commits whose content hash is unchanged
			const newCommits = commits.filter((c) => !this.cacheManager.isUnchanged(c.commit_hash, c.contentHash))

			if (newCommits.length === 0) {
				this.stateManager.setSystemState("Indexed", "Including submodules.")
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
			this._stopWatcher()
			this._scheduleAutoRecovery()

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
		this._cancelAutoRecovery()
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
	 * Run an extractor against the parent repo and each initialised submodule,
	 * concatenating the results. Submodules are discovered fresh on each call
	 * (a new one may have been added) and the parent repo is always included
	 * first so its commits sort earliest under the cache's lastCommitDate
	 * heuristic.
	 *
	 * NOTE: the same `commit_hash` could in principle appear in multiple repos
	 * (e.g. cherry-picked across parent/submodule). Because the Qdrant point ID
	 * is `uuidv5(commit_hash, NAMESPACE)`, such duplicates resolve to the same
	 * point and the second upsert is a benign no-op — content is identical.
	 *
	 * The `isParent` flag passed to `extract` lets callers apply the
	 * configured branch only to the parent repo. Submodules almost never have
	 * a ref matching the parent's branch name, so they must always be polled
	 * with their own HEAD.
	 */
	private async _extractFromAllRepos(
		extract: (repoAbsPath: string, isParent: boolean) => Promise<GitCommitBlock[]>,
	): Promise<GitCommitBlock[]> {
		const submoduleDisplayPaths = await listSubmoduleDisplayPaths(this.workspacePath)
		const repoPaths = [this.workspacePath, ...submoduleDisplayPaths.map((p) => path.resolve(this.workspacePath, p))]
		const perRepo = await Promise.all(
			repoPaths.map(async (repo, idx) => {
				try {
					return await extract(repo, idx === 0)
				} catch (err) {
					logger.warn(`${LOG_PREFIX} Commit extraction failed for ${repo}: ${err}`, {
						ctx: "git-index",
					})
					return []
				}
			}),
		)
		return perRepo.flat()
	}

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
			const incrementalCommits = await this._extractFromAllRepos((repo, isParent) =>
				this._logExtractor.extractCommitsSince(
					repo,
					sinceDate,
					500, // Safety cap for catch-up
					isParent ? this._branch : "",
				),
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
			// Persist after every batch so progress survives process restarts.
			// Without this, an interruption mid-indexing discards all in-memory
			// cache writes and the next start re-indexes from scratch.
			await this.cacheManager.persist()
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

		this._watcher.start(
			() => this.cacheManager.lastCommitDate,
			// Lazy getter so Settings → Save changes to `codebaseIndexGitBranch`
			// (propagated via updateBranch() from GitIndexManager) take effect on
			// the next poll tick without restarting the watcher.
			() => this._branch,
		)
	}

	/**
	 * Update the configured branch without restarting the indexing pipeline.
	 * Called from `GitIndexManager.handleSettingsChange` whenever the
	 * `codebaseIndexGitBranch` setting changes. The new value is picked up by
	 * the watcher on its next poll tick (via the `getBranch` getter passed in
	 * `_startWatcher`). In-flight full scans and catch-ups already running
	 * continue with the previous value — acceptable because they finish
	 * within seconds and the watcher will reconcile any drift incrementally.
	 */
	public updateBranch(branch: string): void {
		this._branch = branch
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

	// ── Auto-Recovery ────────────────────────────────────────────────

	/**
	 * Schedule an automatic retry of {@link startIndexing} after the current
	 * Error state. Uses progressive backoff so transient Ollama / Qdrant
	 * restarts are recovered without any user interaction.
	 *
	 * The timer is cancelled when:
	 * - startIndexing succeeds (reset attempt counter to 0)
	 * - the user explicitly stops indexing
	 * - the orchestrator is disposed
	 * - 10 consecutive attempts have failed (stop fighting lost causes)
	 */
	private _scheduleAutoRecovery(): void {
		if (this._autoRecoveryAttempt >= AUTO_RECOVERY_MAX_ATTEMPTS) {
			logger.warn(
				`${LOG_PREFIX} Auto-recovery gave up after ${AUTO_RECOVERY_MAX_ATTEMPTS} attempts. ` +
					`Manual restart required.`,
				{ ctx: "git-index" },
			)
			this._cancelAutoRecovery()
			return
		}

		const delay = Math.min(
			AUTO_RECOVERY_MAX_DELAY_MS,
			AUTO_RECOVERY_INITIAL_DELAY_MS * Math.pow(2, this._autoRecoveryAttempt),
		)
		this._autoRecoveryAttempt++
		logger.info(
			`${LOG_PREFIX} Scheduling auto-recovery attempt ${this._autoRecoveryAttempt} ` +
				`in ${Math.round(delay / 1000)}s...`,
			{ ctx: "git-index" },
		)
		this._cancelAutoRecovery() // clear any stale timer
		this._autoRecoveryTimer = setTimeout(() => {
			this._autoRecoveryTimer = null
			if (this.stateManager.state !== "Error") return // cancelled in the meantime
			// Re-start indexing with the same parameters as initial startup.
			// startIndexing() is public so the recovery path goes through
			// GitIndexManager which supplies the configured limits/branch.
			void this._recoverStart()
		}, delay)
	}

	/**
	 * Cancel any pending auto-recovery timer and reset the attempt counter.
	 * Safe to call even when no timer is active.
	 */
	private _cancelAutoRecovery(): void {
		if (this._autoRecoveryTimer) {
			clearTimeout(this._autoRecoveryTimer)
			this._autoRecoveryTimer = null
		}
		this._autoRecoveryAttempt = 0
	}

	/**
	 * Lightweight re-entry point for auto-recovery that re-runs the full
	 * indexing pipeline on the same branch/limits. Avoids re-entering
	 * startIndexing() with its guard that requires external maxHistoryDays/
	 * maxCommits/branch parameters (which the orchestrator does not store).
	 *
	 * Uses the defaults from GitIndexManager (365 days, 10000 commits) and
	 * whatever branch was last set via updateBranch().
	 */
	private async _recoverStart(): Promise<void> {
		try {
			await this.startIndexing(DEFAULT_GIT_MAX_HISTORY_DAYS, DEFAULT_GIT_MAX_COMMITS, this._branch)
		} catch {
			// Error + recovery scheduling handled inside startIndexing()
		}
	}
}
