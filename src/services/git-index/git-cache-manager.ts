import * as vscode from "vscode"
import crypto from "crypto"

/**
 * Current schema version of the git index cache file.
 * Increment when the cache structure changes so stale/corrupt caches
 * are detected and discarded rather than silently used.
 *
 * v1 → v2: added lastCommitDate field for incremental indexing.
 */
const GIT_CACHE_SCHEMA_VERSION = 2

/**
 * Serialized cache structure with a schema version field.
 * Per the Versioned Snapshot Rule, all persisted JSON snapshots
 * must carry an integer `version` so schema changes can be detected.
 */
interface GitCachePayload {
	version: number
	hashes: Record<string, string>
	/** ISO 8601 date string of the most recent indexed commit (Phase 2). */
	lastCommitDate?: string
}

/**
 * Per-commit SHA-256 hash cache stored in VS Code globalStorage.
 *
 * Tracks content hashes of already-indexed commits so that re-indexing
 * can skip unchanged commits. The cache is keyed by the workspace path
 * hash to isolate different workspaces.
 *
 * Phase 2: also tracks `lastCommitDate` — the author date of the most
 * recent commit that was indexed. Used by GitWatcher for incremental
 * `git log --since=<lastCommitDate>` polling.
 */
export class GitCacheManager {
	private readonly _cachePath: vscode.Uri
	private _contentHashes: Record<string, string> = {}
	private _lastCommitDate: string | undefined

	/**
	 * Fires whenever a commit is added/updated in the cache. Used by
	 * `GitIndexManager` to surface "commits indexed" diagnostics in the
	 * popover.
	 */
	private readonly _onCacheUpdated = new vscode.EventEmitter<string>()
	public readonly onCacheUpdated = this._onCacheUpdated.event

	constructor(context: vscode.ExtensionContext, workspacePath: string) {
		const wsHash = crypto.createHash("sha256").update(workspacePath).digest("hex").substring(0, 16)
		this._cachePath = vscode.Uri.joinPath(context.globalStorageUri, `git-index-cache-${wsHash}.json`)
	}

	/**
	 * Load the cache from disk. If the cache file does not exist or has a
	 * mismatched version, initializes an empty cache.
	 */
	async initialize(): Promise<void> {
		try {
			const cacheData = await vscode.workspace.fs.readFile(this._cachePath)
			const payload: GitCachePayload = JSON.parse(cacheData.toString())

			if (payload.version === GIT_CACHE_SCHEMA_VERSION && payload.hashes) {
				this._contentHashes = payload.hashes
				this._lastCommitDate = payload.lastCommitDate ?? undefined
			} else {
				this._contentHashes = {}
				this._lastCommitDate = undefined
			}
		} catch {
			this._contentHashes = {}
			this._lastCommitDate = undefined
		}
	}

	/**
	 * Persist the current cache to disk with a version tag.
	 */
	async persist(): Promise<void> {
		const payload: GitCachePayload = {
			version: GIT_CACHE_SCHEMA_VERSION,
			hashes: this._contentHashes,
			lastCommitDate: this._lastCommitDate,
		}
		const data = Buffer.from(JSON.stringify(payload), "utf-8")
		await vscode.workspace.fs.writeFile(this._cachePath, data)
	}

	/**
	 * Check whether a commit's content has changed since last indexing.
	 */
	isUnchanged(commitHash: string, contentHash: string): boolean {
		return this._contentHashes[commitHash] === contentHash
	}

	/**
	 * Update the cache for a given commit.
	 */
	setHash(commitHash: string, contentHash: string): void {
		this._contentHashes[commitHash] = contentHash
		this._onCacheUpdated.fire(commitHash)
	}

	/**
	 * Returns the cumulative number of commits currently cached. Surfaced
	 * in the popover so users can verify the incremental indexer didn't
	 * silently drop commits.
	 */
	getCommitCount(): number {
		return Object.keys(this._contentHashes).length
	}

	/**
	 * Disposes the cache-updated emitter. Called by `GitIndexManager.dispose()`.
	 */
	dispose(): void {
		this._onCacheUpdated.dispose()
	}

	/**
	 * Get the ISO 8601 date of the most recent indexed commit,
	 * or undefined if no commits have been indexed yet.
	 */
	get lastCommitDate(): string | undefined {
		return this._lastCommitDate
	}

	/**
	 * Update the last commit date from a batch of commits.
	 * Tracks the most recent `author_date` across all processed commits.
	 */
	updateLastCommitDateFromBatch(commits: Array<{ author_date: string }>): void {
		for (const commit of commits) {
			if (!this._lastCommitDate || commit.author_date > this._lastCommitDate) {
				this._lastCommitDate = commit.author_date
			}
		}
	}

	/**
	 * Get all cached hashes for debugging/testing.
	 */
	getAllHashes(): Record<string, string> {
		return { ...this._contentHashes }
	}
}
