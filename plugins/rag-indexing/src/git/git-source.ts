/**
 * Git-aware narrowing for the incremental scan — over the `git` CLI.
 *
 * The startup scan can skip hashing every file if git can say which ones moved since the
 * commit the index was built from. That is what this provides: HEAD, a diff against a base
 * commit, the current dirty set, and the same for each submodule.
 *
 * It used to wrap VS Code's built-in Git extension. A plugin has no access to another
 * extension's exports — and shouldn't: shelling out to `git` is what the git-history half
 * of this plugin already does, it works headless (`shofer serve`, where that extension does
 * not exist at all), and it removes the "the git extension hasn't activated yet, fall back
 * to full hashing" case that made the optimisation miss on the first scan after a restart.
 *
 * Every method **fails soft**: no git, a base commit that no longer exists after a rebase,
 * an uninitialised submodule — all answer "I don't know", and the caller falls back to
 * hashing. Narrowing is an optimisation; being wrong about it must never mean indexing the
 * wrong files.
 */

import { execFile } from "child_process"
import fs from "fs/promises"
import path from "path"
import { promisify } from "util"

import { codeIndexLog } from "../logging.js"

const execFileAsync = promisify(execFile)

/** Where a repository lives — the handle every method takes. */
export interface GitRepository {
	/** Absolute path of the repository root. */
	rootPath: string
}

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

/** Cap on a single git invocation's output — a repository-wide diff can be large. */
const MAX_BUFFER = 32 * 1024 * 1024

async function git(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: MAX_BUFFER })
	return stdout
}

export class GitSource {
	/**
	 * Given a workspace directory, resolve the MAIN repository path when it is a git
	 * worktree (its `.git` is a file pointing at `…/.git/worktrees/<name>`), else return
	 * the path unchanged. Filesystem-only — no git invocation.
	 */
	static async resolveWorktreeMainRepoPath(workspacePath: string): Promise<string> {
		try {
			const gitPath = path.join(workspacePath, ".git")
			const stat = await fs.stat(gitPath)
			if (!stat.isFile()) {
				return workspacePath // regular repo with a .git directory
			}
			const content = await fs.readFile(gitPath, "utf8")
			const match = content.match(/^gitdir:\s*(.+)$/m)
			if (!match) {
				return workspacePath
			}
			const gitdirTarget = match[1]!.trim()
			// gitdirTarget is like /path/to/main/.git/worktrees/name — the main repo root
			// is everything before `/.git/worktrees/`.
			const worktreesIdx = gitdirTarget.lastIndexOf("/.git/worktrees/")
			if (worktreesIdx === -1) {
				return workspacePath
			}
			return gitdirTarget.substring(0, worktreesIdx)
		} catch {
			return workspacePath
		}
	}

	/** The repository containing `folderPath`, or undefined when it is not in one. */
	async getRepository(folderPath: string): Promise<GitRepository | undefined> {
		try {
			const root = (await git(folderPath, ["rev-parse", "--show-toplevel"])).trim()
			return root ? { rootPath: root } : undefined
		} catch {
			return undefined
		}
	}

	/** Current HEAD commit sha, or undefined (an unborn branch, or not a repository). */
	async getHeadCommit(repo: GitRepository): Promise<string | undefined> {
		try {
			const head = (await git(repo.rootPath, ["rev-parse", "HEAD"])).trim()
			return head || undefined
		} catch {
			return undefined
		}
	}

	/**
	 * Diff the working tree **and** the index against `baseCommit`.
	 *
	 * Throws when the base commit is unknown (a rebase, a shallow clone that dropped it):
	 * the caller catches and falls back to hashing, which is the only safe answer when git
	 * cannot say what changed.
	 */
	async diffSince(repo: GitRepository, baseCommit: string): Promise<DiffResult> {
		// The committed delta alone would miss uncommitted work, so merge the dirty set:
		// together they answer "how does the working tree differ from the commit we
		// indexed", which is the question the scan is asking.
		const committed = this.parseNameStatus(await git(repo.rootPath, ["diff", "--name-status", baseCommit]), repo)
		const dirty = await this.getDirtyChanges(repo)
		return {
			changed: [...new Set([...committed.changed, ...dirty.changed])],
			deleted: [...new Set([...committed.deleted, ...dirty.deleted])],
		}
	}

	/** The current dirty state: unstaged, staged and untracked, as absolute paths. */
	async getDirtyChanges(repo: GitRepository): Promise<DiffResult> {
		try {
			const output = await git(repo.rootPath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
			return this.parsePorcelain(output, repo)
		} catch (error) {
			codeIndexLog.warn(`[GitSource] git status failed in ${repo.rootPath}: ${String(error)}`)
			return { changed: [], deleted: [] }
		}
	}

	/**
	 * The parent's dirty state merged with each submodule's.
	 *
	 * A parent repository reports a submodule as ONE dirty entry (its pointer), never the
	 * files inside it — so a file created inside a submodule while the editor was closed
	 * would otherwise stay invisible to the startup scan until someone touched it.
	 */
	async getDirtyChangesIncludingSubmodules(parentRepo: GitRepository): Promise<DiffResult> {
		const result = await this.getDirtyChanges(parentRepo)
		for (const submodule of await this.discoverSubmodules(parentRepo)) {
			const subDirty = await this.getDirtyChanges({ rootPath: submodule.path })
			result.changed.push(...subDirty.changed)
			result.deleted.push(...subDirty.deleted)
		}
		return result
	}

	/** Initialised submodules of `parentRepo`, with their current HEADs. */
	async discoverSubmodules(parentRepo: GitRepository): Promise<SubmoduleInfo[]> {
		try {
			// One line per submodule: "<sha> <path> (<describe>)", prefixed `-` when it was
			// never initialised (nothing to scan) and `+` when its checkout differs from
			// the pointer. Only the sha and the path matter here.
			const output = await git(parentRepo.rootPath, ["submodule", "status", "--recursive"])
			const submodules: SubmoduleInfo[] = []
			for (const line of output.split("\n")) {
				const match = line.match(/^[\s+U]?([0-9a-f]{7,40})\s+(\S+)/)
				if (!match) continue
				submodules.push({ path: path.resolve(parentRepo.rootPath, match[2]!), headCommit: match[1] })
			}
			return submodules
		} catch {
			return []
		}
	}

	/** Current HEAD per submodule, keyed by absolute path. */
	async getSubmoduleCommits(parentRepo: GitRepository): Promise<Record<string, string>> {
		const result: Record<string, string> = {}
		for (const submodule of await this.discoverSubmodules(parentRepo)) {
			if (submodule.headCommit) result[submodule.path] = submodule.headCommit
		}
		return result
	}

	/** Diff one submodule from `fromCommit` to its current state. */
	async diffSubmoduleSince(
		_parentRepo: GitRepository,
		submoduleRootPath: string,
		fromCommit: string,
	): Promise<DiffResult> {
		return this.diffSince({ rootPath: submoduleRootPath }, fromCommit)
	}

	/** `git diff --name-status` → absolute changed/deleted paths. */
	private parseNameStatus(output: string, repo: GitRepository): DiffResult {
		const changed: string[] = []
		const deleted: string[] = []
		for (const line of output.split("\n")) {
			if (!line.trim()) continue
			const [status, ...rest] = line.split("\t")
			if (!status || rest.length === 0) continue
			// A rename reports both sides: the old path is gone, and the new one holds
			// content that was never embedded under that name.
			const isRename = status.startsWith("R") || status.startsWith("C")
			const from = path.resolve(repo.rootPath, rest[0]!)
			const to = isRename && rest[1] ? path.resolve(repo.rootPath, rest[1]) : undefined
			if (status.startsWith("D")) {
				deleted.push(from)
			} else if (isRename) {
				deleted.push(from)
				if (to) changed.push(to)
			} else {
				changed.push(from)
			}
		}
		return { changed, deleted }
	}

	/** `git status --porcelain=v1 -z` → absolute changed/deleted paths. */
	private parsePorcelain(output: string, repo: GitRepository): DiffResult {
		const changed: string[] = []
		const deleted: string[] = []
		// NUL-separated, so a path with spaces or quotes needs no unescaping; a rename
		// entry is followed by its ORIGINAL path as a separate record.
		const records = output.split("\0").filter((r) => r.length > 0)
		for (let i = 0; i < records.length; i++) {
			const record = records[i]!
			const status = record.slice(0, 2)
			const relative = record.slice(3)
			if (!relative) continue
			const absolute = path.resolve(repo.rootPath, relative)
			if (status[0] === "R" || status[1] === "R") {
				const origin = records[++i]
				if (origin) deleted.push(path.resolve(repo.rootPath, origin))
				changed.push(absolute)
			} else if (status.includes("D")) {
				deleted.push(absolute)
			} else if (status !== "!!") {
				changed.push(absolute)
			}
		}
		return { changed, deleted }
	}
}
