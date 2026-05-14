import * as vscode from "vscode"
import * as path from "path"

/**
 * HelperAgentFileWatcher — watches workspace files for external changes
 * (changes not originating from Shofer tools).
 *
 * Detects create/modify/delete events and notifies the manager so
 * it can evict stale file context entries. Uses VSCode's built-in
 * FileSystemWatcher with debouncing per file.
 */
export class HelperAgentFileWatcher {
	private readonly _workspacePath: string
	private readonly _onFileChanged: (filePath: string, event: "changed" | "deleted") => void
	private _watcher?: vscode.FileSystemWatcher
	private _debounceTimers = new Map<string, NodeJS.Timeout>()
	private readonly _debounceMs = 500

	constructor(workspacePath: string, onFileChanged: (filePath: string, event: "changed" | "deleted") => void) {
		this._workspacePath = workspacePath
		this._onFileChanged = onFileChanged
	}

	/**
	 * Start watching the workspace for file changes.
	 */
	public start(): void {
		if (this._watcher) return

		// Watch all files in the workspace
		const pattern = new vscode.RelativePattern(this._workspacePath, "**/*")
		this._watcher = vscode.workspace.createFileSystemWatcher(pattern, false, true, false)

		const handleEvent = (uri: vscode.Uri, event: "changed" | "deleted") => {
			const filePath = vscode.workspace.asRelativePath(uri, false)

			// Skip hidden directories and worktrees
			if (this._shouldSkip(filePath)) return

			// Debounce per file
			const existing = this._debounceTimers.get(filePath)
			if (existing) clearTimeout(existing)

			this._debounceTimers.set(
				filePath,
				setTimeout(() => {
					this._debounceTimers.delete(filePath)
					this._onFileChanged(filePath, event)
				}, this._debounceMs),
			)
		}

		this._watcher.onDidChange((uri) => handleEvent(uri, "changed"))
		this._watcher.onDidCreate((uri) => handleEvent(uri, "changed"))
		this._watcher.onDidDelete((uri) => handleEvent(uri, "deleted"))
	}

	/**
	 * Stop watching and clean up.
	 */
	public dispose(): void {
		if (this._watcher) {
			this._watcher.dispose()
			this._watcher = undefined
		}

		for (const timer of this._debounceTimers.values()) {
			clearTimeout(timer)
		}
		this._debounceTimers.clear()
	}

	/**
	 * Check if a file path should be skipped (hidden dirs, worktrees, etc.).
	 */
	private _shouldSkip(filePath: string): boolean {
		if (!filePath) return true

		// Skip worktree paths
		if (filePath.startsWith(".shofer/worktrees/") || filePath.startsWith(".shofer/")) {
			return true
		}

		// Skip node_modules and other common exclusions
		const parts = filePath.split("/")
		for (const part of parts) {
			if (SKIP_PARTS.has(part)) return true
		}

		return false
	}
}

/** Path segments to skip. */
const SKIP_PARTS = new Set([
	"node_modules",
	".git",
	"__pycache__",
	".cache",
	"dist",
	"out",
	"build",
	"target",
	".next",
	".turbo",
])
