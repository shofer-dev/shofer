import * as vscode from "vscode"

export type IndexingState = "Standby" | "Indexing" | "Indexed" | "Error" | "Stopping" | "Disabled"

export class CodeIndexStateManager {
	private _systemStatus: IndexingState = "Standby"
	private _statusMessage: string = ""
	private _processedItems: number = 0
	private _totalItems: number = 0
	private _currentItemUnit: string = "blocks"
	/**
	 * Cumulative number of files currently held in the on-disk cache (and
	 * therefore represented in Qdrant). Distinct from `_processedItems`
	 * which is reset to 0 on every reconciliation pass — this is the
	 * persistent "how much is actually indexed" diagnostic shown in the
	 * popover so users can verify the Phase 1/2 fast-path didn't silently
	 * drop files.
	 */
	private _indexedFileCount: number = 0
	/** Most recent file the orchestrator/watcher (re)indexed, or empty. */
	private _lastFileIndexed: string = ""
	private _progressEmitter = new vscode.EventEmitter<ReturnType<typeof this.getCurrentStatus>>()

	// --- Public API ---

	public readonly onProgressUpdate = this._progressEmitter.event

	public get state(): IndexingState {
		return this._systemStatus
	}

	public getCurrentStatus() {
		return {
			systemStatus: this._systemStatus,
			message: this._statusMessage,
			processedItems: this._processedItems,
			totalItems: this._totalItems,
			currentItemUnit: this._currentItemUnit,
			indexedFileCount: this._indexedFileCount,
			lastFileIndexed: this._lastFileIndexed,
		}
	}

	/**
	 * Updates the persistent "files in cache" diagnostic. Called by the
	 * orchestrator after each reconciliation pass with the current
	 * cacheManager entry count.
	 */
	public setIndexedFileCount(count: number): void {
		if (count !== this._indexedFileCount) {
			this._indexedFileCount = count
			this._progressEmitter.fire(this.getCurrentStatus())
		}
	}

	/**
	 * Records the most recently (re)indexed file path. Called by the
	 * orchestrator/watcher per file. Stores only the relative path; the
	 * UI is responsible for basename presentation.
	 */
	public recordFileIndexed(relPath: string): void {
		if (relPath && relPath !== this._lastFileIndexed) {
			this._lastFileIndexed = relPath
			this._progressEmitter.fire(this.getCurrentStatus())
		}
	}

	// --- State Management ---

	public setSystemState(newState: IndexingState, message?: string): void {
		const stateChanged =
			newState !== this._systemStatus || (message !== undefined && message !== this._statusMessage)

		if (stateChanged) {
			this._systemStatus = newState
			if (message !== undefined) {
				this._statusMessage = message
			}

			// Reset progress counters if moving to a non-indexing state or starting fresh
			if (newState !== "Indexing") {
				this._processedItems = 0
				this._totalItems = 0
				this._currentItemUnit = "blocks" // Reset to default unit
				// Optionally clear the message or set a default for non-indexing states
				if (newState === "Standby" && message === undefined) this._statusMessage = "Ready."
				if (newState === "Indexed" && message === undefined) this._statusMessage = "Index up-to-date."
				if (newState === "Error" && message === undefined) this._statusMessage = "An error occurred."
			}

			this._progressEmitter.fire(this.getCurrentStatus())
		}
	}

	public reportBlockIndexingProgress(processedItems: number, totalItems: number): void {
		const progressChanged = processedItems !== this._processedItems || totalItems !== this._totalItems

		// Don't override Stopping state with progress updates
		if (this._systemStatus === "Stopping") return
		// Update if progress changes OR if the system wasn't already in 'Indexing' state
		if (progressChanged || this._systemStatus !== "Indexing") {
			this._processedItems = processedItems
			this._totalItems = totalItems
			this._currentItemUnit = "blocks"

			const message = `Indexed ${this._processedItems} / ${this._totalItems} ${this._currentItemUnit} found`
			const oldStatus = this._systemStatus
			const oldMessage = this._statusMessage

			this._systemStatus = "Indexing" // Ensure state is Indexing
			this._statusMessage = message

			// Only fire update if status, message or progress actually changed
			if (oldStatus !== this._systemStatus || oldMessage !== this._statusMessage || progressChanged) {
				this._progressEmitter.fire(this.getCurrentStatus())
			}
		}
	}

	public reportFileQueueProgress(processedFiles: number, totalFiles: number, currentFileBasename?: string): void {
		const progressChanged = processedFiles !== this._processedItems || totalFiles !== this._totalItems

		// Don't override Stopping state with progress updates
		if (this._systemStatus === "Stopping") return
		if (progressChanged || this._systemStatus !== "Indexing") {
			this._processedItems = processedFiles
			this._totalItems = totalFiles
			this._currentItemUnit = "files"
			this._systemStatus = "Indexing"

			let message: string
			if (totalFiles > 0 && processedFiles < totalFiles) {
				message = `Processing ${processedFiles} / ${totalFiles} ${this._currentItemUnit}. Current: ${
					currentFileBasename || "..."
				}`
			} else if (totalFiles > 0 && processedFiles === totalFiles) {
				message = `Finished processing ${totalFiles} ${this._currentItemUnit} from queue.`
			} else {
				message = `File queue processed.`
			}

			const oldStatus = this._systemStatus
			const oldMessage = this._statusMessage

			this._statusMessage = message

			if (oldStatus !== this._systemStatus || oldMessage !== this._statusMessage || progressChanged) {
				this._progressEmitter.fire(this.getCurrentStatus())
			}
		}
	}

	public dispose(): void {
		this._progressEmitter.dispose()
	}
}
