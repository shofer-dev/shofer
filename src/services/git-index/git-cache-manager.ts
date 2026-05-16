import * as vscode from "vscode"
import crypto from "crypto"

/**
 * Current schema version of the git index cache file.
 * Increment when the cache structure changes so stale/corrupt caches
 * are detected and discarded rather than silently used.
 */
const GIT_CACHE_SCHEMA_VERSION = 1

/**
 * Serialized cache structure with a schema version field.
 * Per the Versioned Snapshot Rule, all persisted JSON snapshots
 * must carry an integer `version` so schema changes can be detected.
 */
interface GitCachePayload {
	version: number
	hashes: Record<string, string>
}

/**
 * Per-commit SHA-256 hash cache stored in VS Code globalStorage.
 *
 * Tracks content hashes of already-indexed commits so that re-indexing
 * can skip unchanged commits. The cache is keyed by the workspace path
 * hash to isolate different workspaces.
 */
export class GitCacheManager {
	private readonly _cachePath: vscode.Uri
	private _contentHashes: Record<string, string> = {}

	/**
	 * @param context - VS Code extension context
	 * @param workspacePath - Path to the workspace
	 */
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
			} else {
				// Stale or corrupt — discard and start fresh
				this._contentHashes = {}
			}
		} catch {
			this._contentHashes = {}
		}
	}

	/**
	 * Persist the current cache to disk with a version tag.
	 */
	async persist(): Promise<void> {
		const payload: GitCachePayload = {
			version: GIT_CACHE_SCHEMA_VERSION,
			hashes: this._contentHashes,
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
	}

	/**
	 * Get all cached hashes for debugging/testing.
	 */
	getAllHashes(): Record<string, string> {
		return { ...this._contentHashes }
	}
}
