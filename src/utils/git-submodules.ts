import { execFile } from "child_process"
import { promisify } from "util"
import * as fs from "fs/promises"
import * as path from "path"

const execFileAsync = promisify(execFile)

/**
 * Cross-platform helpers for enumerating git submodules of a repository.
 *
 * Used by:
 *  - `services/code-index/shared/git-ignore-filter.ts` to also list untracked
 *    files inside each submodule when building the include-set.
 *  - `services/git-index/git-history-orchestrator.ts` to scan each submodule's
 *    commit history alongside the parent repo.
 *  - `core/prompts/system.ts` to inject submodule structure into the system
 *    prompt's SYSTEM INFORMATION section.
 *
 * Submodule paths are returned as `$displaypath` (relative to `workspacePath`),
 * which is git's canonical workspace-relative form even for nested submodules.
 */

/**
 * A single submodule entry parsed from `.gitmodules`.
 */
export interface SubmoduleEntry {
	/** Workspace-relative path of the submodule (the `path` key in `.gitmodules`). */
	path: string
	/** Remote URL of the submodule repository. */
	url: string
	/** Optional branch declared in `.gitmodules`. */
	branch?: string
}

/**
 * Maximum number of submodules listed in the system prompt before truncation.
 */
const MAX_SUBMODULE_LIST_ENTRIES = 50

/**
 * Parse the `.gitmodules` file at the workspace root into a Map keyed by
 * submodule path.
 *
 * Returns an empty Map when the file doesn't exist or cannot be parsed —
 * callers should treat absence as "no submodule metadata available".
 */
export async function parseGitmodules(workspacePath: string): Promise<Map<string, SubmoduleEntry>> {
	const modulesPath = path.join(workspacePath, ".gitmodules")
	let content: string
	try {
		content = await fs.readFile(modulesPath, "utf-8")
	} catch {
		return new Map()
	}

	const result = new Map<string, SubmoduleEntry>()
	let currentSection: string | null = null
	let currentEntry: SubmoduleEntry | null = null

	for (const rawLine of content.split("\n")) {
		const line = rawLine.trim()

		// Skip blank lines and comments.
		if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) {
			continue
		}

		// Section header: [submodule "..."]
		const sectionMatch = line.match(/^\[submodule\s+"([^"]+)"\]\s*$/)
		if (sectionMatch) {
			// Commit the previous entry before starting a new one.
			if (currentEntry !== null && currentSection !== null) {
				result.set(currentEntry.path, currentEntry)
			}
			currentSection = sectionMatch[1]!
			currentEntry = { path: "", url: "" }
			continue
		}

		// Key-value pair within a submodule section.
		const kvMatch = line.match(/^\s*([a-z]+)\s*=\s*(.+?)\s*$/)
		if (kvMatch && currentEntry !== null && currentSection !== null) {
			const key = kvMatch[1]!
			const value = kvMatch[2]!
			switch (key) {
				case "path":
					currentEntry.path = value
					break
				case "url":
					currentEntry.url = value
					break
				case "branch":
					currentEntry.branch = value
					break
				default:
					// Unknown key — silently ignored.
					break
			}
		}
	}

	// Commit the last entry.
	if (currentEntry !== null && currentSection !== null) {
		result.set(currentEntry.path, currentEntry)
	}

	return result
}

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

/**
 * Build a "WORKSPACE SUBMODULES" block for the system prompt.
 *
 * Returns an empty string when `entries` is empty or undefined — no block
 * should appear in the prompt when there are no submodules.
 *
 * If more than MAX_SUBMODULE_LIST_ENTRIES entries are provided, the listing
 * is truncated with a notice.
 */
export function formatSubmoduleBlock(entries: SubmoduleEntry[] | undefined): string {
	if (!entries || entries.length === 0) {
		return ""
	}

	const truncated = entries.length > MAX_SUBMODULE_LIST_ENTRIES
	const visible = truncated ? entries.slice(0, MAX_SUBMODULE_LIST_ENTRIES) : entries

	const lines: string[] = [
		"",
		"WORKSPACE SUBMODULES",
		"",
		"This workspace contains git submodules. Each submodule is a pointer to a specific commit in a separate repository. When performing git operations inside a submodule, `cd` into that submodule's directory first (e.g., `cd extensions/shofer && git log`). The parent repository tracks submodule pointers, not individual files within them.",
		"",
	]

	for (const entry of visible) {
		const branchSuffix = entry.branch ? ` (branch: ${entry.branch})` : ""
		lines.push(`- \`${entry.path}\` → ${entry.url}${branchSuffix}`)
	}

	if (truncated) {
		lines.push(`- … and ${entries.length - MAX_SUBMODULE_LIST_ENTRIES} more submodules (truncated)`)
	}

	return lines.join("\n")
}
