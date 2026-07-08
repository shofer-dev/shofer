import * as path from "path"

/**
 * Outside-workspace path allowlist matching (design §4).
 *
 * Two ordered lists of absolute directory prefixes trust file access outside the
 * workspace without an approval prompt:
 *   - `allowedReadPaths`  — subtrees trusted for READ,
 *   - `allowedWritePaths` — subtrees trusted for READ+WRITE (write ⊇ read).
 *
 * Matching is lexical on the `path.resolve`'d candidate (so `..` traversal can't
 * smuggle a path past a prefix) and segment-boundary safe (so `/foo` never trusts
 * `/foobar`). Allow-only: an empty list trusts nothing.
 */

/** True if `absPath` is `entry` itself or lives under it (segment-boundary safe, resolves `..`). */
function isUnder(absPath: string, entry: string): boolean {
	const p = path.resolve(absPath)
	const e = path.resolve(entry)
	return p === e || p.startsWith(e + path.sep)
}

/**
 * Whether a path is auto-approved by the outside-workspace allowlist (design §4).
 *
 * read → allowedWritePaths ∪ allowedReadPaths (write implies read); write → allowedWritePaths only.
 */
export function isPathAutoApproved(
	absPath: string,
	group: "read" | "write",
	allowedReadPaths: string[],
	allowedWritePaths: string[],
): boolean {
	if (!absPath) return false
	const trusted = group === "write" ? allowedWritePaths : [...allowedWritePaths, ...allowedReadPaths]
	return trusted.some((entry) => isUnder(absPath, entry))
}
