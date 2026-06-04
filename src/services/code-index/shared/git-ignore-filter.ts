import { execFile } from "child_process"
import * as path from "path"
import { promisify } from "util"

import { codeIndexLog } from "../../../utils/logging/subsystems"
import { listSubmoduleDisplayPaths } from "../../../utils/git-submodules"

const execFileAsync = promisify(execFile)

/**
 * Shape compatible with the subset of the `ignore` npm package consumed by the
 * code-index scanner and file-watcher. Both call only `ignores(relPath)`, so
 * a single-method interface is sufficient — `GitIgnoreFilter` and a real
 * `Ignore` instance are interchangeable from those call sites' perspective.
 */
export interface IIgnoreFilter {
	ignores(relativeFilePath: string): boolean
	/** Rebuild the included-paths snapshot. No-op implementations are valid. */
	refresh(): Promise<void>
}

/**
 * Single-flight wrapper around {@link IIgnoreFilter.refresh}: concurrent
 * callers share the in-flight promise instead of each spawning their own
 * `git ls-files` process. Returns a no-op resolved promise when the filter
 * is undefined.
 */
export function makeSingleflightRefresh(filter: IIgnoreFilter | undefined): () => Promise<void> {
	let pending: Promise<void> | undefined
	return () => {
		if (!filter) return Promise.resolve()
		if (pending) return pending
		pending = filter.refresh().finally(() => {
			pending = undefined
		})
		return pending
	}
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
 * Implementation: a `git ls-files -z --cached --recurse-submodules` plus
 * `--others --exclude-standard` (parent + per-submodule) returns every
 * workspace path git would consider tracked-or-untracked-but-not-ignored,
 * including files inside initialised submodules. We store those POSIX-relative
 * paths in a Set and `ignores()` is a `!set.has(toPosix(relPath))` check.
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
			codeIndexLog.warn("GitIgnoreFilter.refresh failed; keeping previous snapshot:", error)
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
	 * Enumerate every workspace path git would consider part of the working
	 * tree, walking into submodules so that files inside a submodule
	 * (e.g. `extensions/shofer/delme.md` under a submodule pinned at
	 * `extensions/shofer/`) are surfaced and not silently treated as denied.
	 *
	 * `git ls-files --recurse-submodules` only supports `--cached` (tracked
	 * files); it refuses to combine with `--others`. So we issue three calls
	 * and merge the results:
	 *
	 *   1. `--cached --recurse-submodules` — tracked files, parent + every
	 *      initialised submodule, paths already prefixed with the submodule's
	 *      display path.
	 *   2. `--others --exclude-standard` — untracked-but-not-ignored files
	 *      in the parent repo only.
	 *   3. For each submodule: `git -C <abs-submodule> ls-files --others
	 *      --exclude-standard`, then prepend the submodule's display path so
	 *      the entry is relative to the workspace root.
	 *
	 * Submodule enumeration uses `git submodule foreach --recursive` which
	 * (a) skips uninitialised submodules and (b) gives us `$displaypath`
	 * relative to the parent.
	 */
	private static async listIncludedPaths(workspacePath: string): Promise<Set<string>> {
		const set = new Set<string>()

		// 1. Tracked files, recursing into submodules.
		const trackedRecursive = await GitIgnoreFilter.runGit(workspacePath, [
			"ls-files",
			"-z",
			"--cached",
			"--recurse-submodules",
		])
		GitIgnoreFilter.collectNulSeparated(trackedRecursive, set)

		// 2. Untracked-but-not-ignored, parent repo only.
		const untrackedParent = await GitIgnoreFilter.runGit(workspacePath, [
			"ls-files",
			"-z",
			"--others",
			"--exclude-standard",
		])
		GitIgnoreFilter.collectNulSeparated(untrackedParent, set)

		// 3. Untracked-but-not-ignored, per submodule. Best-effort: if the
		//    enumeration fails (e.g. no submodules, or .gitmodules missing)
		//    we just skip this step — tracked-everywhere + parent-untracked
		//    is already a strict superset of what the old root-only parse
		//    yielded for submodule-free repos.
		try {
			const submodules = await listSubmoduleDisplayPaths(workspacePath)
			for (const displayPath of submodules) {
				const absSub = path.resolve(workspacePath, displayPath)
				const subUntracked = await GitIgnoreFilter.runGit(absSub, [
					"ls-files",
					"-z",
					"--others",
					"--exclude-standard",
				])
				const subPosixPrefix = displayPath.split(path.sep).join("/")
				for (const entry of subUntracked.split("\0")) {
					if (entry.length > 0) set.add(`${subPosixPrefix}/${entry}`)
				}
			}
		} catch {
			// no submodules / git error — non-fatal
		}

		return set
	}

	private static collectNulSeparated(stdout: string, into: Set<string>): void {
		for (const entry of stdout.split("\0")) {
			if (entry.length > 0) into.add(entry)
		}
	}

	private static async runGit(cwd: string, args: string[]): Promise<string> {
		const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
			// Large monorepos can produce many MB of paths; lift the default 1MB cap.
			maxBuffer: 256 * 1024 * 1024,
			windowsHide: true,
		})
		return stdout
	}
}
