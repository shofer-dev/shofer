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
	}>()

	/** Event emitted when the indexing progress updates. */
	public readonly onProgressUpdate = this._onProgressUpdate.event

	private _state: IndexingState = "Standby"
	private _message: string = ""

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
	 * Set a new system state and fire the progress update event.
	 *
	 * @param state - New indexing state
	 * @param message - Optional human-readable message
	 */
	public setSystemState(state: IndexingState, message?: string): void {
		this._state = state
		this._message = message ?? ""
		this._onProgressUpdate.fire({ systemStatus: state, message: this._message })
	}

	/**
	 * Dispose the event emitter.
	 */
	public dispose(): void {
		this._onProgressUpdate.dispose()
	}
}
