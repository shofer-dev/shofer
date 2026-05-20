import * as path from "path"

import * as vscode from "vscode"
import type { IGitWatcher, GitCommitBlock } from "../interfaces/git"
import { GitLogExtractor } from "./git-log-extractor"
import { listSubmoduleDisplayPaths } from "../../../utils/git-submodules"
import { logger } from "../../../utils/logging"

const LOG_PREFIX = "[GitWatcher]"

/**
 * Default polling interval in milliseconds (5 minutes).
 */
const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000

/**
 * Hard safety cap for incremental extraction.
 * If the extension goes offline for a long time and a huge merge lands,
 * an unbounded incremental scan could overwhelm the embedder. This cap
 * limits the number of commits fetched in a single incremental poll.
 */
const INCREMENTAL_MAX_COMMITS = 1000

/**
 * Polls for new commits to incrementally index.
 *
 * Phase 2 implementation: uses `setInterval` to run `git log --since=<date>`
 * every N minutes (configurable, default 5). Extracted commits are forwarded
 * to the orchestrator via an event emitter.
 *
 * The `--since` date is obtained from a lazy getter function so that the
 * watcher always uses the freshest boundary after successful incremental
 * indexes (the cache's lastCommitDate is updated after each batch).
 */
export class GitWatcher implements IGitWatcher {
	private readonly _logExtractor: GitLogExtractor
	private _intervalId: ReturnType<typeof setInterval> | null = null
	private _isRunning = false
	private readonly _pollIntervalMs: number
	private _getLastCommitDate: (() => string | undefined) | null = null
	private _getBranch: (() => string) | null = null

	private readonly _onNewCommits = new vscode.EventEmitter<GitCommitBlock[]>()

	/** Event emitted when the watcher discovers new commits to index. */
	public readonly onNewCommits = this._onNewCommits.event

	/**
	 * @param workspacePath - Path to the workspace root
	 * @param pollIntervalMs - Polling interval in milliseconds (from settings)
	 */
	constructor(
		private readonly workspacePath: string,
		pollIntervalMs?: number,
	) {
		this._logExtractor = new GitLogExtractor()
		this._pollIntervalMs = pollIntervalMs && pollIntervalMs > 0 ? pollIntervalMs : DEFAULT_POLL_INTERVAL_MS
	}

	/**
	 * Start polling for new commits.
	 *
	 * @param getLastCommitDate - Lazy getter for the ISO 8601 date of the most
	 *   recent indexed commit. Called on each poll tick so the watcher always
	 *   uses the freshest boundary. Returns undefined to skip the current tick.
	 * @param getBranch - Lazy getter for the configured git ref. Called on each
	 *   poll tick so the watcher picks up Settings → Save changes without a
	 *   restart. Applied to the parent repo only; submodules always poll HEAD.
	 */
	start(getLastCommitDate: () => string | undefined, getBranch: () => string): void {
		if (this._isRunning) return

		// Set _isRunning before firing the immediate tick so that a re-entrant
		// call to start() before the microtask queue drains is correctly guarded.
		this._isRunning = true
		this._getLastCommitDate = getLastCommitDate
		this._getBranch = getBranch

		// Catch up: run an immediate scan for commits since last index date
		this._pollTick().catch(() => {})

		// Schedule periodic polling
		this._intervalId = setInterval(() => {
			this._pollTick().catch(() => {})
		}, this._pollIntervalMs)
	}

	/**
	 * Stop polling.
	 */
	stop(): void {
		if (this._intervalId !== null) {
			clearInterval(this._intervalId)
			this._intervalId = null
		}
		this._isRunning = false
		this._getLastCommitDate = null
		this._getBranch = null
	}

	public get isRunning(): boolean {
		return this._isRunning
	}

	public dispose(): void {
		this.stop()
		this._onNewCommits.dispose()
	}

	// --- Private ---

	private async _pollTick(): Promise<void> {
		const getter = this._getLastCommitDate
		if (!getter) {
			logger.warn(`${LOG_PREFIX} Poll tick skipped: no lastCommitDate getter available`, { ctx: "git-index" })
			return
		}

		const sinceDate = getter()
		if (!sinceDate) {
			logger.info(
				`${LOG_PREFIX} Poll tick skipped: no lastCommitDate cached yet (initial index may still be running)`,
				{
					ctx: "git-index",
				},
			)
			return
		}

		// Resolve branch on every tick so Settings → Save changes take effect
		// without restarting the watcher.
		const branch = this._getBranch?.() ?? ""

		try {
			// Discover submodules every tick so a newly added submodule is picked
			// up without restarting the watcher. Submodule discovery is cheap
			// (one fork+exec) compared to the embed/upsert path that follows.
			const submoduleDisplayPaths = await listSubmoduleDisplayPaths(this.workspacePath)
			const repoPaths = [
				this.workspacePath,
				...submoduleDisplayPaths.map((p) => path.resolve(this.workspacePath, p)),
			]

			logger.info(
				`${LOG_PREFIX} Polling ${repoPaths.length} repo(s) for commits since ${sinceDate}` +
					(submoduleDisplayPaths.length > 0
						? ` (${submoduleDisplayPaths.length} submodule(s): ${submoduleDisplayPaths.join(", ")})`
						: ""),
				{ ctx: "git-index" },
			)

			// Parent (idx 0) honours the configured branch; submodules always
			// follow their own HEAD because the parent's branch name almost
			// never exists in a submodule (which often has detached HEAD or a
			// different default branch).
			const perRepo = await Promise.all(
				repoPaths.map(async (repo, idx) => {
					try {
						const commits = await this._logExtractor.extractCommitsSince(
							repo,
							sinceDate,
							INCREMENTAL_MAX_COMMITS,
							idx === 0 ? branch : "",
						)
						if (commits.length > 0) {
							logger.info(
								`${LOG_PREFIX} Found ${commits.length} new commit(s) in ${path.relative(this.workspacePath, repo) || "."}`,
								{ ctx: "git-index" },
							)
						}
						return commits
					} catch (err) {
						logger.warn(
							`${LOG_PREFIX} Failed to extract commits from ${path.relative(this.workspacePath, repo) || "."}: ${err instanceof Error ? err.message : String(err)}`,
							{ ctx: "git-index" },
						)
						return [] as GitCommitBlock[]
					}
				}),
			)
			const newCommits = perRepo.flat()

			if (newCommits.length > 0) {
				logger.info(`${LOG_PREFIX} Emitting ${newCommits.length} total new commit(s) from poll tick`, {
					ctx: "git-index",
				})
				this._onNewCommits.fire(newCommits)
			} else {
				logger.info(`${LOG_PREFIX} Poll tick complete: no new commits found`, { ctx: "git-index" })
			}
		} catch (error) {
			// Swallow — the polling loop must survive transient failures.
			logger.warn(
				`${LOG_PREFIX} Poll tick failed (non-critical): ${error instanceof Error ? error.message : String(error)}`,
				{ ctx: "git-index" },
			)
		}
	}
}
