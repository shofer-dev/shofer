import type { IndexingState } from "../../code-index/interfaces/manager"
import * as vscode from "vscode"

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
	 * @param maxHistoryDays - Maximum number of days of history to extract
	 * @param maxCommits - Hard cap on number of commits to extract
	 * @param branch - Git ref (branch name) to index; empty string = HEAD
	 * @returns Array of parsed commit blocks
	 */
	extractCommits(
		workspacePath: string,
		maxHistoryDays: number,
		maxCommits: number,
		branch: string,
	): Promise<GitCommitBlock[]>

	/**
	 * Extract commits since a specific ISO 8601 date (for incremental indexing).
	 *
	 * @param workspacePath - Path to the git repository root
	 * @param sinceDate - ISO 8601 date string (e.g. "2024-01-01T00:00:00+00:00")
	 * @param maxCommits - Hard cap on number of commits returned (safety ceiling)
	 * @param branch - Git ref (branch name) to index; empty string = HEAD
	 * @returns Array of parsed commit blocks since the given date
	 */
	extractCommitsSince(
		workspacePath: string,
		sinceDate: string,
		maxCommits: number,
		branch: string,
	): Promise<GitCommitBlock[]>
}

/**
 * Watches for new commits to incrementally index.
 *
 * Phase 2: polls `git log --since=<last-indexed-date>` every N minutes.
 */
export interface IGitWatcher extends vscode.Disposable {
	/**
	 * Start polling for new commits.
	 * @param getLastCommitDate - Lazy getter for the ISO 8601 date of the most
	 *   recent indexed commit. Called on each poll tick so the watcher always
	 *   uses the freshest boundary.
	 * @param branch - Git ref (branch name) to index; empty string = HEAD
	 */
	start(getLastCommitDate: () => string | undefined, branch: string): void

	/** Stop polling. */
	stop(): void

	/** Whether the watcher is currently running. */
	readonly isRunning: boolean

	/** Event emitted when new commits are discovered. */
	readonly onNewCommits: vscode.Event<GitCommitBlock[]>
}

/**
 * Service that embeds a query and searches the git Qdrant collection.
 */
export interface IGitSearchService {
	/**
	 * Search git commit history by semantic similarity.
	 *
	 * @param query - Natural language search query
	 * @param minScore - Minimum cosine similarity threshold
	 * @param maxResults - Maximum number of results to return
	 * @returns Array of search results sorted by descending score
	 */
	search(query: string, minScore: number, maxResults: number): Promise<GitSearchResult[]>
}

export type { IndexingState }
