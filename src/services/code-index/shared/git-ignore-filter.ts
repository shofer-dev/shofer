import { execFile } from "child_process"
import * as path from "path"
import { promisify } from "util"

const execFileAsync = promisify(execFile)

/**
 * Shape compatible with the subset of the `ignore` npm package consumed by the
 * code-index scanner and file-watcher. Both call only `ignores(relPath)`, so
 * a single-method interface is sufficient — `GitIgnoreFilter` and a real
 * `Ignore` instance are interchangeable from those call sites' perspective.
 */
export interface IIgnoreFilter {
	ignores(relativeFilePath: string): boolean
}

/**
 * Workspace-wide ignore filter that delegates to git itself, so it honours the
 * full `.gitignore` precedence stack — nested `.gitignore` files, `.git/info/exclude`,
 * the global `core.excludesfile`, negation patterns, the lot. This is the same
 * exclude logic that powers `git status`, `ripgrep`, `fd`, and VS Code's own
 * Search — using it directly is more correct and more obvious to users than
 * re-implementing the rules ourselves with the `ignore` library, which only
 * understands a single flat file.
 *
 * Implementation: a one-shot `git ls-files -z --cached --others --exclude-standard`
 * returns every workspace path git would consider tracked-or-untracked-but-not-
 * ignored. We store those POSIX-relative paths in a Set and `ignores()` is a
 * `!set.has(toPosix(relPath))` check.
 *
 * Failure modes:
 *  - Not a git repo (or `git` binary missing): {@link create} returns `null`
 *    and the caller falls back to the old root-only `.gitignore` parse.
 *  - `git ls-files` errors after the first successful build: the previous
 *    snapshot is retained; a console warning is emitted but indexing continues
 *    against stale data until the next successful {@link refresh}.
 *
 * The set is refreshed on demand via {@link refresh}. The manager wires a
 * `**\/.gitignore` file-system watcher to call it on rule changes.
 */
export class GitIgnoreFilter implements IIgnoreFilter {
	private includedSet: Set<string>

	private constructor(
		private readonly workspacePath: string,
		initialSet: Set<string>,
	) {
		this.includedSet = initialSet
	}

	/**
	 * Construct a filter for `workspacePath`, or return `null` if the directory
	 * is not inside a git working tree (or `git` is unavailable).
	 */
	public static async create(workspacePath: string): Promise<GitIgnoreFilter | null> {
		try {
			const set = await GitIgnoreFilter.listIncludedPaths(workspacePath)
			return new GitIgnoreFilter(workspacePath, set)
		} catch {
			return null
		}
	}

	/**
	 * Rebuild the included-paths set. Tolerates transient errors: on failure
	 * the previous snapshot is kept and a warning is logged.
	 */
	public async refresh(): Promise<void> {
		try {
			this.includedSet = await GitIgnoreFilter.listIncludedPaths(this.workspacePath)
		} catch (error) {
			console.warn("[code-index] GitIgnoreFilter.refresh failed; keeping previous snapshot:", error)
		}
	}

	/**
	 * `true` when git would NOT consider `relativeFilePath` part of the working
	 * tree (i.e. it is ignored, or it has been deleted on disk, or it lives
	 * outside the workspace). Normalises path separators to POSIX before lookup
	 * because git always emits forward slashes.
	 */
	public ignores(relativeFilePath: string): boolean {
		const posix = relativeFilePath.split(path.sep).join("/")
		return !this.includedSet.has(posix)
	}

	/**
	 * Run `git ls-files` with the same flag set ripgrep uses to enumerate every
	 * file git considers part of the working tree. NUL-separated output is the
	 * only safe way to handle filenames containing newlines or backslashes.
	 */
	private static async listIncludedPaths(workspacePath: string): Promise<Set<string>> {
		const { stdout } = await execFileAsync(
			"git",
			["-C", workspacePath, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
			{
				// Large monorepos can produce many MB of paths; lift the default 1MB cap.
				maxBuffer: 256 * 1024 * 1024,
				windowsHide: true,
			},
		)
		const set = new Set<string>()
		// NUL-separated; the final entry is followed by NUL, so split-and-drop-empty.
		for (const entry of stdout.split("\0")) {
			if (entry.length > 0) set.add(entry)
		}
		return set
	}
}
