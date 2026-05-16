import * as vscode from "vscode"
import type { IGitWatcher, GitCommitBlock } from "../interfaces/git"
import { GitLogExtractor } from "./git-log-extractor"

/**
 * Polling interval for checking new commits, in milliseconds.
 * Default: 5 minutes.
 */
const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000

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
	private _pollIntervalMs: number
	private _getLastCommitDate: (() => string | undefined) | null = null

	private readonly _onNewCommits = new vscode.EventEmitter<GitCommitBlock[]>()

	/** Event emitted when the watcher discovers new commits to index. */
	public readonly onNewCommits = this._onNewCommits.event

	constructor(private readonly workspacePath: string) {
		this._logExtractor = new GitLogExtractor()

		// Read polling interval from VS Code settings
		try {
			const configured = vscode.workspace
				.getConfiguration("shofer")
				.get<number>("codebaseIndexGitPollIntervalMinutes", DEFAULT_POLL_INTERVAL_MS / 60_000)
			this._pollIntervalMs = (configured && configured > 0 ? configured : 5) * 60 * 1000
		} catch {
			this._pollIntervalMs = DEFAULT_POLL_INTERVAL_MS
		}
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

		this._getLastCommitDate = getLastCommitDate

		// Catch up: run an immediate scan for commits since last index date
		this._pollTick().catch(() => {})

		this._isRunning = true

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

	/**
	 * Whether the watcher is currently running.
	 */
	public get isRunning(): boolean {
		return this._isRunning
	}

	/**
	 * Dispose the event emitter.
	 */
	public dispose(): void {
		this.stop()
		this._onNewCommits.dispose()
	}

	// --- Private ---

	/**
	 * Run a single poll iteration: `git log --since=<currentDate>`, then emit
	 * any new commits found.
	 */
	private async _pollTick(): Promise<void> {
		const getter = this._getLastCommitDate
		if (!getter) return

		const sinceDate = getter()
		if (!sinceDate) return

		try {
			const newCommits = await this._logExtractor.extractCommitsSince(this.workspacePath, sinceDate)

			if (newCommits.length > 0) {
				this._onNewCommits.fire(newCommits)
			}
		} catch (error) {
			console.error("[GitWatcher] Poll iteration failed:", error)
		}
	}
}
