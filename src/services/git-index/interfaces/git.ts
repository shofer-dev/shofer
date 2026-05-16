import type { IndexingState } from "../../code-index/interfaces/manager"

/**
 * A parsed commit message segment ready for embedding and storage.
 */
export interface GitCommitBlock {
	/** Full SHA commit hash */
	commit_hash: string
	/** 7-char abbreviated hash */
	short_hash: string
	/** "Name <email>" formatted author */
	author: string
	/** ISO 8601 author date */
	author_date: string
	/** First line of commit message */
	subject: string
	/** Remaining lines of commit message (may be empty) */
	body: string
	/** subject + "\n\n" + body — what gets embedded */
	content: string
	/** SHA-256 of content (for cache skipping) */
	contentHash: string
}

/**
 * Returned by git history search.
 */
export interface GitSearchResult {
	id: string | number
	score: number
	payload: {
		commit_hash: string
		short_hash: string
		author: string
		author_date: string
		subject: string
		body: string
	}
}

/**
 * Extracts commit history from the git repository.
 */
export interface IGitLogExtractor {
	/**
	 * Extract commits from the git repository at `workspacePath`.
	 *
	 * @param workspacePath - Path to the git repository root
	 * @param maxHistoryDays - Maximum number of days of history to extract (from config)
	 * @param maxCommits - Hard cap on number of commits to extract (from config)
	 * @returns Array of parsed commit blocks
	 */
	extractCommits(workspacePath: string, maxHistoryDays: number, maxCommits: number): Promise<GitCommitBlock[]>
}

/**
 * Watches for new commits to incrementally index.
 * Phase 1: no-op stub.
 */
export interface IGitWatcher {
	start(): void
	stop(): void
}

/**
 * Service that embeds a query and searches the git Qdrant collection.
 */
export interface IGitSearchService {
	/**
	 * Search git commit history by semantic similarity.
	 *
	 * @param query - Natural language search query
	 * @param minScore - Minimum cosine similarity threshold for results
	 * @param maxResults - Maximum number of results to return
	 * @returns Array of search results sorted by descending score
	 */
	search(query: string, minScore: number, maxResults: number): Promise<GitSearchResult[]>
}

/**
 * Re-export IndexingState for use by GitHistoryStateManager.
 */
export type { IndexingState }
