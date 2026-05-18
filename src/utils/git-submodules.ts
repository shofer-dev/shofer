import { execFile } from "child_process"
import { promisify } from "util"

const execFileAsync = promisify(execFile)

/**
 * Cross-platform helpers for enumerating git submodules of a repository.
 *
 * Used by:
 *  - `services/code-index/shared/git-ignore-filter.ts` to also list untracked
 *    files inside each submodule when building the include-set.
 *  - `services/git-index/git-history-orchestrator.ts` to scan each submodule's
 *    commit history alongside the parent repo.
 *
 * Submodule paths are returned as `$displaypath` (relative to `workspacePath`),
 * which is git's canonical workspace-relative form even for nested submodules.
 */

/**
 * List the workspace-relative display paths of every initialised submodule,
 * recursively. Returns an empty array when the repo has no submodules, or
 * when git/.gitmodules is unavailable — callers should treat absence as
 * "no submodules to walk" rather than as an error.
 */
export async function listSubmoduleDisplayPaths(workspacePath: string): Promise<string[]> {
	try {
		// `git submodule foreach` prints to stdout once per submodule. NUL
		// terminator avoids ambiguity for submodule paths containing newlines.
		const { stdout } = await execFileAsync(
			"git",
			["-C", workspacePath, "submodule", "foreach", "--quiet", "--recursive", "printf '%s\\0' \"$displaypath\""],
			{
				maxBuffer: 16 * 1024 * 1024,
				windowsHide: true,
			},
		)
		const paths: string[] = []
		for (const entry of stdout.split("\0")) {
			if (entry.length > 0) paths.push(entry)
		}
		return paths
	} catch {
		return []
	}
}
