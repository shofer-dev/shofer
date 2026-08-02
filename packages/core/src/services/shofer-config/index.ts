import * as path from "path"
import * as os from "os"
import fs from "fs/promises"
import * as childProcess from "child_process"
import * as readline from "readline"
import { getHost } from "@shofer/types"
import { getBinPath } from "../../ripgrep/index.js"
import { getOrgShoferDirectory } from "../../config/scope-roots.js"

/**
 * Gets the global .shofer directory path based on the current platform
 *
 * @returns The absolute path to the global .shofer directory
 *
 * @example Platform-specific paths:
 * ```
 * // macOS/Linux: ~/.shofer/
 * // Example: /Users/john/.shofer
 *
 * // Windows: %USERPROFILE%\.shofer\
 * // Example: C:\Users\john\.shofer
 * ```
 *
 * @example Usage:
 * ```typescript
 * const globalDir = getGlobalShoferDirectory()
 * // Returns: "/Users/john/.shofer" (on macOS/Linux)
 * // Returns: "C:\\Users\\john\\.shofer" (on Windows)
 * ```
 */
export function getGlobalShoferDirectory(): string {
	const homeDir = os.homedir()
	return path.join(homeDir, ".shofer")
}

/**
 * Gets the global .agents directory path based on the current platform.
 * This is a shared directory for agent skills across different AI coding tools.
 *
 * @returns The absolute path to the global .agents directory
 *
 * @example Platform-specific paths:
 * ```
 * // macOS/Linux: ~/.agents/
 * // Example: /Users/john/.agents
 *
 * // Windows: %USERPROFILE%\.agents\
 * // Example: C:\Users\john\.agents
 * ```
 *
 * @example Usage:
 * ```typescript
 * const globalAgentsDir = getGlobalAgentsDirectory()
 * // Returns: "/Users/john/.agents" (on macOS/Linux)
 * // Returns: "C:\\Users\\john\\.agents" (on Windows)
 * ```
 */
export function getGlobalAgentsDirectory(): string {
	const homeDir = os.homedir()
	return path.join(homeDir, ".agents")
}

/**
 * Gets the project-local .agents directory path for a given cwd.
 * This is a shared directory for agent skills across different AI coding tools.
 *
 * @param cwd - Current working directory (project path)
 * @returns The absolute path to the project-local .agents directory
 *
 * @example
 * ```typescript
 * const projectAgentsDir = getProjectAgentsDirectoryForCwd('/Users/john/my-project')
 * // Returns: "/Users/john/my-project/.agents"
 * ```
 */
export function getProjectAgentsDirectoryForCwd(cwd: string): string {
	return path.join(cwd, ".agents")
}

/**
 * Gets the project-local .shofer directory path for a given cwd
 *
 * @param cwd - Current working directory (project path)
 * @returns The absolute path to the project-local .shofer directory
 *
 * @example
 * ```typescript
 * const projectDir = getProjectShoferDirectoryForCwd('/Users/john/my-project')
 * // Returns: "/Users/john/my-project/.shofer"
 *
 * const windowsProjectDir = getProjectShoferDirectoryForCwd('C:\\Users\\john\\my-project')
 * // Returns: "C:\\Users\\john\\my-project\\.shofer"
 * ```
 *
 * @example Directory structure:
 * ```
 * /Users/john/my-project/
 * ├── .shofer/                    # Project-local configuration directory
 * │   ├── rules/
 * │   │   └── rules.md
 * │   ├── custom-instructions.md
 * │   └── config/
 * │       └── settings.json
 * ├── src/
 * │   └── index.ts
 * └── package.json
 * ```
 */
export function getProjectShoferDirectoryForCwd(cwd: string): string {
	return path.join(cwd, ".shofer")
}

/**
 * Checks if a directory exists
 */
export async function directoryExists(dirPath: string): Promise<boolean> {
	try {
		const stat = await fs.stat(dirPath)
		return stat.isDirectory()
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	} catch (error: any) {
		// Only catch expected "not found" errors
		if (error.code === "ENOENT" || error.code === "ENOTDIR") {
			return false
		}
		// Re-throw unexpected errors (permission, I/O, etc.)
		throw error
	}
}

/**
 * Checks if a file exists
 */
export async function fileExists(filePath: string): Promise<boolean> {
	try {
		const stat = await fs.stat(filePath)
		return stat.isFile()
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	} catch (error: any) {
		// Only catch expected "not found" errors
		if (error.code === "ENOENT" || error.code === "ENOTDIR") {
			return false
		}
		// Re-throw unexpected errors (permission, I/O, etc.)
		throw error
	}
}

/**
 * Reads a file safely, returning null if it doesn't exist
 */
export async function readFileIfExists(filePath: string): Promise<string | null> {
	try {
		return await fs.readFile(filePath, "utf-8")
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	} catch (error: any) {
		// Only catch expected "not found" errors
		if (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "EISDIR") {
			return null
		}
		// Re-throw unexpected errors (permission, I/O, etc.)
		throw error
	}
}

/**
 * Discovers all .shofer directories in subdirectories of the workspace
 *
 * @param cwd - Current working directory (workspace root)
 * @returns Array of absolute paths to .shofer directories found in subdirectories,
 *          sorted alphabetically. Does not include the root .shofer directory.
 *
 * @example
 * ```typescript
 * const subfolderRoos = await discoverSubfolderRooDirectories('/Users/john/monorepo')
 * // Returns:
 * // [
 * //   '/Users/john/monorepo/package-a/.shofer',
 * //   '/Users/john/monorepo/package-b/.shofer',
 * //   '/Users/john/monorepo/packages/shared/.shofer'
 * // ]
 * ```
 *
 * @example Directory structure:
 * ```
 * /Users/john/monorepo/
 * ├── .shofer/                    # Root .shofer (NOT included - use getProjectShoferDirectoryForCwd)
 * ├── package-a/
 * │   └── .shofer/                # Included
 * │       └── rules/
 * ├── package-b/
 * │   └── .shofer/                # Included
 * │       └── rules-code/
 * └── packages/
 *     └── shared/
 *         └── .shofer/            # Included (nested)
 *             └── rules/
 * ```
 */
export async function discoverSubfolderRooDirectories(cwd: string): Promise<string[]> {
	try {
		// `-g '!/.shofer/**'` is anchored to the search root (cwd) and skips
		// the root .shofer/ entirely so its file count cannot starve the
		// subfolder hits. We still need `-g '**/.shofer/**'` to include any
		// nested .shofer/ at arbitrary depth.
		const args = [
			"--files",
			"--hidden",
			"--follow",
			"-g",
			"**/.shofer/**",
			"-g",
			"!/.shofer/**",
			"-g",
			"!node_modules/**",
			"-g",
			"!.git/**",
			cwd,
		]

		const shoferDirs = new Set<string>()

		await runRipgrepFileList(args, (line) => {
			// Stream-dedupe into the directory set so memory stays O(#.shofer dirs)
			// regardless of how many files live inside any one .shofer/ dir.
			const rel = path.relative(cwd, line)
			const match = rel.match(/^(.+?)[/\\]\.shofer(?:[/\\]|$)/)
			if (match) {
				shoferDirs.add(path.join(cwd, match[1]!, ".shofer"))
			}
		})

		return Array.from(shoferDirs).sort()
	} catch {
		// If discovery fails (e.g., ripgrep not available), return empty array
		return []
	}
}

/**
 * Runs ripgrep in `--files` mode and streams each emitted path to `onLine`.
 *
 * We only need the ripgrep binary locator here, not executeRipgrep — the
 * latter caps results at 500, which is wrong for discovery in repos where a
 * matched directory holds large generated content (e.g. the root .shofer/
 * with agent worktree snapshots): when the cap fires, every result can come
 * from one discarded location and the real hits never surface. The app root
 * (for the bundled ripgrep binary) comes from the host seam so this module
 * stays vscode-free and portable into @shofer/core.
 *
 * @throws when ripgrep is unavailable or exits with an error and no results
 */
async function runRipgrepFileList(args: string[], onLine: (line: string) => void): Promise<void> {
	const rgPath = await getBinPath(getHost().env.appRoot)
	if (!rgPath) {
		throw new Error("ripgrep binary not available")
	}

	let sawLine = false
	await new Promise<void>((resolve, reject) => {
		const proc = childProcess.spawn(rgPath, args)
		const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity })

		rl.on("line", (line) => {
			sawLine = true
			onLine(line)
		})

		let errorOutput = ""
		proc.stderr.on("data", (d) => {
			errorOutput += d.toString()
		})
		rl.on("close", () => {
			if (errorOutput && !sawLine) {
				reject(new Error(`ripgrep process error: ${errorOutput}`))
			} else {
				resolve()
			}
		})
		proc.on("error", (err) => reject(err))
	})
}

/**
 * Discovers subdirectories that carry an agent-rules file (`AGENTS.md`,
 * `AGENT.md`, or `AGENTS.local.md`) — WITHOUT requiring a sibling `.shofer/`
 * folder. A lone `packages/api/AGENTS.md` is enough for `packages/api` to
 * participate in rules loading, matching the Agent Rules standard's "drop a
 * file in the directory it governs" model.
 *
 * Ripgrep respects ignore files here (no `--no-ignore`), so a rules file
 * inside gitignored build output is never picked up. Hidden directories are
 * not searched — an AGENTS.md under `.cache/` or similar is not a rules file.
 * The workspace root is NOT included (callers add it explicitly).
 *
 * @param cwd - Current working directory (workspace root)
 * @returns Absolute paths of subdirectories containing an agent-rules file,
 *          sorted alphabetically
 */
export async function discoverAgentRulesDirectories(cwd: string): Promise<string[]> {
	try {
		const args = [
			"--files",
			"--follow",
			"-g",
			"**/AGENTS.md",
			"-g",
			"**/AGENT.md",
			"-g",
			"**/AGENTS.local.md",
			"-g",
			"!node_modules/**",
			"-g",
			"!.git/**",
			cwd,
		]

		const dirs = new Set<string>()

		await runRipgrepFileList(args, (line) => {
			const rel = path.relative(cwd, line)
			const parentRel = path.dirname(rel)
			// Skip the workspace root's own AGENTS.md (parentRel === ".") and
			// anything that escaped the root.
			if (parentRel && parentRel !== "." && !parentRel.startsWith("..")) {
				dirs.add(path.join(cwd, parentRel))
			}
		})

		return Array.from(dirs).sort()
	} catch {
		// If discovery fails (e.g., ripgrep not available), return empty array
		return []
	}
}

/**
 * Gets the ordered list of .shofer directories to check (global first, then project-local)
 *
 * @param cwd - Current working directory (project path)
 * @returns Array of directory paths to check in order [global, project-local]
 *
 * @example
 * ```typescript
 * // For a project at /Users/john/my-project
 * const directories = getRooDirectoriesForCwd('/Users/john/my-project')
 * // Returns:
 * // [
 * //   '/Users/john/.shofer',           // Global directory
 * //   '/Users/john/my-project/.shofer' // Project-local directory
 * // ]
 * ```
 *
 * @example Directory structure:
 * ```
 * /Users/john/
 * ├── .shofer/                    # Global configuration
 * │   ├── rules/
 * │   │   └── rules.md
 * │   └── custom-instructions.md
 * └── my-project/
 *     ├── .shofer/                # Project-specific configuration
 *     │   ├── rules/
 *     │   │   └── rules.md     # Overrides global rules
 *     │   └── project-notes.md
 *     └── src/
 *         └── index.ts
 * ```
 */
export function getRooDirectoriesForCwd(cwd: string): string[] {
	const directories: string[] = []

	// Org-global scope first (least specific): SHOFER_GLOBAL_DIR / registered
	// global storage. Absent in a bare standalone install.
	const orgDir = getOrgShoferDirectory()
	if (orgDir) {
		directories.push(orgDir)
	}

	// User scope (`~/.shofer`) second
	directories.push(getGlobalShoferDirectory())

	// Project-local scope last (most specific)
	directories.push(getProjectShoferDirectoryForCwd(cwd))

	return directories
}

/**
 * Gets the ordered list of all .shofer directories including subdirectories
 *
 * @param cwd - Current working directory (project path)
 * @returns Array of directory paths in order: [global, project-local, ...subfolders (alphabetically)]
 *
 * @example
 * ```typescript
 * // For a monorepo at /Users/john/monorepo with .shofer in subfolders
 * const directories = await getAllRooDirectoriesForCwd('/Users/john/monorepo')
 * // Returns:
 * // [
 * //   '/Users/john/.shofer',                    // Global directory
 * //   '/Users/john/monorepo/.shofer',           // Project-local directory
 * //   '/Users/john/monorepo/package-a/.shofer', // Subfolder (alphabetical)
 * //   '/Users/john/monorepo/package-b/.shofer'  // Subfolder (alphabetical)
 * // ]
 * ```
 */
export async function getAllRooDirectoriesForCwd(cwd: string): Promise<string[]> {
	const directories: string[] = []

	// Org-global scope first (least specific), when one is configured
	const orgDir = getOrgShoferDirectory()
	if (orgDir) {
		directories.push(orgDir)
	}

	// User scope (`~/.shofer`) second
	directories.push(getGlobalShoferDirectory())

	// Project-local scope next
	directories.push(getProjectShoferDirectoryForCwd(cwd))

	// Discover and add subfolder .shofer directories
	const subfolderDirs = await discoverSubfolderRooDirectories(cwd)
	directories.push(...subfolderDirs)

	return directories
}

/**
 * Gets the directories to check for agent-rules files (AGENTS.md / AGENT.md /
 * AGENTS.local.md), in order from root to subfolders (alphabetically).
 *
 * The root is always included. Subdirectories are discovered by the presence
 * of the rules file itself ({@link discoverAgentRulesDirectories}) — a
 * sibling `.shofer/` folder is NOT required.
 *
 * @param cwd - Current working directory (project path)
 * @returns Array of directory paths containing agent-rules files
 *
 * @example
 * ```typescript
 * const dirs = await getAgentsDirectoriesForCwd('/Users/john/monorepo')
 * // Returns: ['/Users/john/monorepo', '/Users/john/monorepo/package-a', ...]
 * ```
 */
export async function getAgentsDirectoriesForCwd(cwd: string): Promise<string[]> {
	const directories: string[] = []

	// Always include the root directory
	directories.push(cwd)

	// Subdirectories that carry an AGENTS.md / AGENT.md / AGENTS.local.md
	directories.push(...(await discoverAgentRulesDirectories(cwd)))

	return directories
}

/**
 * Loads configuration from multiple .shofer directories with project overriding global
 *
 * @param relativePath - The relative path within each .shofer directory (e.g., 'rules/rules.md')
 * @param cwd - Current working directory (project path)
 * @returns Object with global and project content, plus merged content
 *
 * @example
 * ```typescript
 * // Load rules configuration for a project
 * const config = await loadConfiguration('rules/rules.md', '/Users/john/my-project')
 *
 * // Returns:
 * // {
 * //   global: "Global rules content...",     // From ~/.shofer/rules/rules.md
 * //   project: "Project rules content...",   // From /Users/john/my-project/.shofer/rules/rules.md
 * //   merged: "Global rules content...\n\n# Project-specific rules (override global):\n\nProject rules content..."
 * // }
 * ```
 *
 * @example File paths resolved:
 * ```
 * relativePath: 'rules/rules.md'
 * cwd: '/Users/john/my-project'
 *
 * Reads from:
 * - Global: /Users/john/.shofer/rules/rules.md
 * - Project: /Users/john/my-project/.shofer/rules/rules.md
 *
 * Other common relativePath examples:
 * - 'custom-instructions.md'
 * - 'config/settings.json'
 * - 'templates/component.tsx'
 * ```
 *
 * @example Merging behavior:
 * ```
 * // If only global exists:
 * { global: "content", project: null, merged: "content" }
 *
 * // If only project exists:
 * { global: null, project: "content", merged: "content" }
 *
 * // If both exist:
 * {
 *   global: "global content",
 *   project: "project content",
 *   merged: "global content\n\n# Project-specific rules (override global):\n\nproject content"
 * }
 * ```
 */
export async function loadConfiguration(
	relativePath: string,
	cwd: string,
): Promise<{
	global: string | null
	project: string | null
	merged: string
}> {
	const globalDir = getGlobalShoferDirectory()
	const projectDir = getProjectShoferDirectoryForCwd(cwd)

	const globalFilePath = path.join(globalDir, relativePath)
	const projectFilePath = path.join(projectDir, relativePath)

	// Read global configuration
	const globalContent = await readFileIfExists(globalFilePath)

	// Read project-local configuration
	const projectContent = await readFileIfExists(projectFilePath)

	// Merge configurations - project overrides global
	let merged = ""

	if (globalContent) {
		merged += globalContent
	}

	if (projectContent) {
		if (merged) {
			merged += "\n\n# Project-specific rules (override global):\n\n"
		}
		merged += projectContent
	}

	return {
		global: globalContent,
		project: projectContent,
		merged: merged || "",
	}
}

// Export with backward compatibility alias
export const loadShoferConfiguration: typeof loadConfiguration = loadConfiguration
