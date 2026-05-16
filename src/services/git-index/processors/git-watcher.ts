import * as vscode from "vscode"
import type { IGitWatcher, GitCommitBlock } from "../interfaces/git"
import { GitLogExtractor } from "./git-log-extractor"

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
	 */
	start(getLastCommitDate: () => string | undefined): void {
		if (this._isRunning) return

		// Set _isRunning before firing the immediate tick so that a re-entrant
		// call to start() before the microtask queue drains is correctly guarded.
		this._isRunning = true
		this._getLastCommitDate = getLastCommitDate

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
		if (!getter) return

		const sinceDate = getter()
		if (!sinceDate) return

		try {
			const newCommits = await this._logExtractor.extractCommitsSince(
				this.workspacePath,
				sinceDate,
				INCREMENTAL_MAX_COMMITS,
			)

			if (newCommits.length > 0) {
				this._onNewCommits.fire(newCommits)
			}
		} catch (error) {
			// Swallow — the polling loop must survive transient failures.
			// Structured logging is deliberately omitted here to avoid
			// coupling the git-index layer to TelemetryService. Errors
			// during incremental indexing are non-critical.
		}
	}
}
