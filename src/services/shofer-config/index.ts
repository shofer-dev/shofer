import * as path from "path"
import * as os from "os"
import fs from "fs/promises"
import * as childProcess from "child_process"
import * as readline from "readline"

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
		// Dynamic import to avoid vscode dependency at module load time
		// (file-search.ts → vscode, which is unavailable in the webview context).
		// We only need the ripgrep binary locator here, not executeRipgrep — the
		// latter caps results at 500, which is wrong for `.shofer/` discovery
		// in repos where the root .shofer/ holds large generated content
		// (e.g. agent worktree snapshots). When the cap fires, every result is
		// from the root .shofer/ (which we discard anyway via the
		// rootShoferDir filter below) and no subfolder .shofer/ ever surfaces.
		const { getBinPath } = await import("../ripgrep")
		const vscode = await import("vscode")
		const rgPath = await getBinPath(vscode.env.appRoot)
		if (!rgPath) {
			return []
		}

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

		await new Promise<void>((resolve, reject) => {
			const proc = childProcess.spawn(rgPath, args)
			const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity })

			rl.on("line", (line) => {
				// Stream-dedupe into the directory set so memory stays O(#.shofer dirs)
				// regardless of how many files live inside any one .shofer/ dir.
				const rel = path.relative(cwd, line)
				const match = rel.match(/^(.+?)[/\\]\.shofer(?:[/\\]|$)/)
				if (match) {
					shoferDirs.add(path.join(cwd, match[1], ".shofer"))
				}
			})

			let errorOutput = ""
			proc.stderr.on("data", (d) => {
				errorOutput += d.toString()
			})
			rl.on("close", () => {
				if (errorOutput && shoferDirs.size === 0) {
					reject(new Error(`ripgrep process error: ${errorOutput}`))
				} else {
					resolve()
				}
			})
			proc.on("error", (err) => reject(err))
		})

		return Array.from(shoferDirs).sort()
	} catch (error) {
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

	// Add global directory first
	directories.push(getGlobalShoferDirectory())

	// Add project-local directory second
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

	// Add global directory first
	directories.push(getGlobalShoferDirectory())

	// Add project-local directory second
	directories.push(getProjectShoferDirectoryForCwd(cwd))

	// Discover and add subfolder .shofer directories
	const subfolderDirs = await discoverSubfolderRooDirectories(cwd)
	directories.push(...subfolderDirs)

	return directories
}

/**
 * Gets parent directories containing .shofer folders, in order from root to subfolders
 *
 * @param cwd - Current working directory (project path)
 * @returns Array of parent directory paths (not .shofer paths) containing AGENTS.md or .shofer
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

	// Get all subfolder .shofer directories
	const subfolderShoferDirs = await discoverSubfolderRooDirectories(cwd)

	// Extract parent directories (remove .shofer from path)
	for (const shoferDir of subfolderShoferDirs) {
		const parentDir = path.dirname(shoferDir)
		directories.push(parentDir)
	}

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
