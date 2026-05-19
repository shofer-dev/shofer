import * as vscode from "vscode"

/**
 * Minimal type declarations for the VS Code built-in Git extension API (v1).
 * These are not exhaustive — we declare only the fields we consume.
 */

interface GitBranch {
	name?: string
	commit?: string
}

interface GitChange {
	uri: vscode.Uri
	originalUri: vscode.Uri
	status: GitStatus
}

/** Mirror of Status from the vscode.git extension. */
enum GitStatus {
	INDEX_MODIFIED = 0,
	INDEX_ADDED = 1,
	INDEX_DELETED = 2,
	INDEX_RENAMED = 3,
	INDEX_COPIED = 4,
	MODIFIED = 5,
	DELETED = 6,
	UNTRACKED = 7,
	IGNORED = 8,
}

interface GitRepositoryState {
	HEAD?: GitBranch
	workingTreeChanges: GitChange[]
	indexChanges: GitChange[]
}

interface GitRepository {
	rootUri: vscode.Uri
	state: GitRepositoryState
	diffWith(sha: string): Promise<GitChange[]>
}

interface GitAPI {
	getRepository(uri: vscode.Uri): GitRepository | undefined
	repositories: GitRepository[]
}

interface GitExtension {
	getAPI(version: 1): GitAPI
}

/** Deleted = files removed since the base commit. */
const DELETED_STATUSES = new Set<GitStatus>([GitStatus.DELETED, GitStatus.INDEX_DELETED])

export interface DiffResult {
	/** Absolute file paths that were added or modified (need re-indexing). */
	changed: string[]
	/** Absolute file paths that were deleted (need removal from Qdrant + cache). */
	deleted: string[]
}

export interface SubmoduleInfo {
	/** Absolute path to the submodule root directory. */
	path: string
	/** Current HEAD commit sha, or undefined if unavailable. */
	headCommit: string | undefined
}

/**
 * Thin wrapper around the VS Code built-in Git extension.
 *
 * - Falls back gracefully when the git extension is unavailable
 *   (no git installed, non-git workspace, …).
 * - Supports submodules: collects current HEAD commits per submodule
 *   and diffs each submodule from its stored commit.
 */
export class GitSource {
	private api: GitAPI | undefined

	/**
	 * Lazily resolves the VS Code Git extension API.
	 * Returns undefined when the extension is not active.
	 */
	private getApi(): GitAPI | undefined {
		if (this.api) return this.api
		try {
			const ext = vscode.extensions.getExtension<GitExtension>("vscode.git")
			if (!ext) return undefined
			// extension.isActive may be false on first call; activate it
			if (!ext.isActive) {
				// activate() is async, but we return undefined and let the
				// caller fall back to layer A.  Next startup the extension
				// will already be active.
				return undefined
			}
			this.api = ext.exports.getAPI(1)
			return this.api
		} catch {
			return undefined
		}
	}

	/**
	 * Returns the Git repository for the given workspace folder URI,
	 * or undefined if the folder is not a git repository.
	 */
	getRepository(folderUri: vscode.Uri): GitRepository | undefined {
		return this.getApi()?.getRepository(folderUri)
	}

	/**
	 * Returns the current HEAD commit sha of a repository, or undefined.
	 */
	getHeadCommit(repo: GitRepository): string | undefined {
		return repo.state.HEAD?.commit
	}

	/**
	 * Diffs the working tree + index against a base commit.
	 * Returns lists of changed (added/modified) and deleted file paths
	 * relative to the repository root.
	 *
	 * @throws if `diffWith` fails (e.g. "bad object" — base commit not
	 *         in the repo). Callers should catch and fall back to layer A.
	 */
	async diffSince(repo: GitRepository, baseCommit: string): Promise<DiffResult> {
		const changes = await repo.diffWith(baseCommit)
		return this.classifyChanges(changes, repo.rootUri.fsPath)
	}

	/**
	 * Returns the current dirty state (unstaged + staged + untracked)
	 * as if diffing against HEAD.
	 */
	getDirtyChanges(repo: GitRepository): DiffResult {
		const allChanges = [...repo.state.workingTreeChanges, ...repo.state.indexChanges]
		return this.classifyChanges(allChanges, repo.rootUri.fsPath)
	}

	/**
	 * Returns the parent repo's dirty state merged with each discovered
	 * submodule's dirty state.
	 *
	 * Why: the parent repository sees a submodule as a single "dirty"
	 * entry (the submodule pointer / a `-dirty` marker) and not as the
	 * individual files inside it. Without this merge, a file freshly
	 * created or modified inside a submodule while VS Code was closed is
	 * invisible to the startup incremental scan and only ever gets indexed
	 * the next time the user touches it (which fires the live file watcher).
	 *
	 * Paths are absolute (each sub-repo classifies against its own rootUri),
	 * matching the parent's classification, so callers can deduplicate by
	 * fsPath and feed the merged set into `scanner.scanSpecificFiles`.
	 */
	getDirtyChangesIncludingSubmodules(parentRepo: GitRepository): DiffResult {
		const result = this.getDirtyChanges(parentRepo)
		const api = this.getApi()
		if (!api) return result

		for (const subUri of this.discoverSubmodules(parentRepo)) {
			const subRepo = api.getRepository(subUri)
			if (!subRepo) continue
			const subDirty = this.getDirtyChanges(subRepo)
			result.changed.push(...subDirty.changed)
			result.deleted.push(...subDirty.deleted)
		}

		return result
	}

	/**
	 * Classifies an array of GitChange objects into changed / deleted paths.
	 */
	private classifyChanges(changes: GitChange[], rootPath: string): DiffResult {
		const changed: string[] = []
		const deleted: string[] = []

		for (const change of changes) {
			const fsPath = change.uri.fsPath
			if (DELETED_STATUSES.has(change.status)) {
				deleted.push(fsPath)
			} else if (change.status !== GitStatus.IGNORED) {
				changed.push(fsPath)
			}
		}

		return { changed, deleted }
	}

	// ── Submodule support ──

	/**
	 * Discovers submodules of the given repository.
	 *
	 * Strategy: iterate over VS Code's tracked repositories and find
	 * those whose rootUri is a child of the parent repo's rootUri but
	 * is NOT the parent itself.  This catches submodules that VS Code
	 * has opened as separate git repositories.
	 */
	discoverSubmodules(parentRepo: GitRepository): vscode.Uri[] {
		const api = this.getApi()
		if (!api) return []

		const parentRoot = parentRepo.rootUri.fsPath
		const subs: vscode.Uri[] = []

		for (const repo of api.repositories) {
			if (repo === parentRepo) continue
			const repoPath = repo.rootUri.fsPath
			if (repoPath.startsWith(parentRoot + "/") || repoPath.startsWith(parentRoot + "\\")) {
				// It's a child — likely a submodule
				subs.push(repo.rootUri)
			}
		}

		return subs
	}

	/**
	 * Returns the current HEAD commit for each discovered submodule.
	 */
	getSubmoduleCommits(parentRepo: GitRepository): Record<string, string> {
		const api = this.getApi()
		if (!api) return {}

		const subs = this.discoverSubmodules(parentRepo)
		const result: Record<string, string> = {}

		for (const uri of subs) {
			const subRepo = api.getRepository(uri)
			const head = subRepo?.state.HEAD?.commit
			if (head) {
				result[uri.fsPath] = head
			}
		}

		return result
	}

	/**
	 * Diffs a submodule from a previous commit to its current HEAD.
	 * Returns changed + deleted files within the submodule.
	 *
	 * @throws if the submodule repo is unavailable or diff fails.
	 */
	async diffSubmoduleSince(
		parentRepo: GitRepository,
		submoduleRootPath: string,
		fromCommit: string,
	): Promise<DiffResult> {
		const api = this.getApi()
		if (!api) throw new Error("Git extension unavailable")

		const subRootUri = vscode.Uri.file(submoduleRootPath)
		const subRepo = api.getRepository(subRootUri)
		if (!subRepo) throw new Error(`Submodule repository not found: ${submoduleRootPath}`)

		return this.diffSince(subRepo, fromCommit)
	}
}
