/**
 * Host-agnostic registry for the Category II `GitIndexManager` (VS Code `src`).
 *
 * Mirrors the {@link ../mcp/mcp-hub-factory} seam: the concrete manager needs a
 * `vscode.ExtensionContext`, so the portable core must not import it. Core-resident
 * callers — `GitSearchTool`, `build-tools`, `filter-tools-for-mode` — reach the
 * manager through this registered factory instead.
 *
 * The VS Code extension registers a factory at activation (wrapping the manager's
 * static `getInstance`). Headless hosts leave it unset and the getter returns
 * `undefined`, so git indexing / git_search is simply off.
 */

/**
 * Returned by git history semantic search — the portable shape the core reads.
 * Structurally identical to the concrete `GitSearchResult` in `src`.
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
 * The narrow slice of the concrete `GitIndexManager` the portable core reads.
 * Captures ONLY the members the core-resident callers use.
 */
export interface GitIndexManagerLike {
	readonly isFeatureEnabled: boolean
	readonly isFeatureConfigured: boolean
	readonly isInitialized: boolean
	searchIndex(query: string, maxResults?: number): Promise<GitSearchResult[]>
}

/**
 * Factory mirroring `GitIndexManager.getInstance(context, workspacePath?)`. The
 * opaque `context` is cast back to `vscode.ExtensionContext` in the adapter.
 */
export type GitIndexManagerFactory = (context: unknown, workspacePath?: string) => GitIndexManagerLike | undefined

let factory: GitIndexManagerFactory | undefined

/** Registers the host factory used to reach the git-index manager singleton. */
export function setGitIndexManagerFactory(f: GitIndexManagerFactory): void {
	factory = f
}

/** Returns the registered git-index factory, or `undefined` when unset (headless = feature off). */
export function getGitIndexManagerFactory(): GitIndexManagerFactory | undefined {
	return factory
}
