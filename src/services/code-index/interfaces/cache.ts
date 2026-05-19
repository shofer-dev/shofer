import type { CodebaseIndexCacheEntry } from "@shofer/types"

export interface ICacheManager {
	deleteHash(filePath: string): void
	flush(): Promise<void>

	/** Returns the full cache entry for a file path, or undefined if not cached */
	getEntry(filePath: string): CodebaseIndexCacheEntry | undefined
	/** Updates the cache entry for a file path */
	updateEntry(filePath: string, entry: CodebaseIndexCacheEntry): void
	/** Returns all cached file paths (for deleted-file detection) */
	getAllPaths(): string[]
	/** Returns the set of segment hashes previously stored for a file path. */
	getSegmentHashes(filePath: string): Set<string>
}
