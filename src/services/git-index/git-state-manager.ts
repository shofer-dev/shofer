import * as vscode from "vscode"
import type { IndexingState } from "./interfaces/git"

/**
 * Manages the state of the git history indexing process.
 *
 * Follows the same pattern as `CodeIndexStateManager` but for git history.
 * States: Standby | Indexing | Indexed | Error | Stopping
 */
export class GitHistoryStateManager {
	private _onProgressUpdate = new vscode.EventEmitter<{
		systemStatus: IndexingState
		message?: string
		indexedCommitCount: number
		latestCommitHash: string
	}>()

	/** Event emitted when the indexing progress updates. */
	public readonly onProgressUpdate = this._onProgressUpdate.event

	private _state: IndexingState = "Standby"
	private _message: string = ""
	/** Cumulative number of commits currently held in the cache. */
	private _indexedCommitCount: number = 0
	/** Short (7-char) SHA of the latest indexed commit, or empty. */
	private _latestCommitHash: string = ""

	/**
	 * Current state of the git history indexing process.
	 */
	public get state(): IndexingState {
		return this._state
	}

	/**
	 * Current message associated with the state.
	 */
	public get message(): string {
		return this._message
	}

	/**
	 * Snapshot of the full state including diagnostic fields. Used by
	 * `GitIndexManager.getCurrentStatus()` and the host webview producer.
	 */
	public getCurrentStatus() {
		return {
			systemStatus: this._state,
			message: this._message,
			indexedCommitCount: this._indexedCommitCount,
			latestCommitHash: this._latestCommitHash,
		}
	}

	/**
	 * Set a new system state and fire the progress update event.
	 *
	 * @param state - New indexing state
	 * @param message - Optional human-readable message
	 */
	public setSystemState(state: IndexingState, message?: string): void {
		this._state = state
		this._message = message ?? ""
		this._fire()
	}

	/**
	 * Update cumulative commit-count diagnostic. Cumulative across state
	 * transitions \u2014 not reset by `setSystemState`.
	 */
	public setIndexedCommitCount(count: number): void {
		if (count !== this._indexedCommitCount) {
			this._indexedCommitCount = count
			this._fire()
		}
	}

	/**
	 * Update short-SHA-of-HEAD diagnostic. Expected to be a 7-character SHA.
	 */
	public setLatestCommitHash(hashShort: string): void {
		if (hashShort && hashShort !== this._latestCommitHash) {
			this._latestCommitHash = hashShort
			this._fire()
		}
	}

	private _fire(): void {
		this._onProgressUpdate.fire(this.getCurrentStatus())
	}

	/**
	 * Dispose the event emitter.
	 */
	public dispose(): void {
		this._onProgressUpdate.dispose()
	}
}
