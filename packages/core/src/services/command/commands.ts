import fs from "fs/promises"
import * as path from "path"
import { Dirent } from "fs"
import matter from "gray-matter"
import { getGlobalShoferDirectory, getProjectShoferDirectoryForCwd } from "../shofer-config/index.js"
import { getOrgShoferDirectory } from "../../config/scope-roots.js"
import { getBuiltInCommands, getBuiltInCommand } from "./built-in-commands.js"
import { configLog } from "../../logging/subsystems.js"
import { getSharedPluginManager } from "../../plugins/plugin-manager.js"

/**
 * Maximum depth for resolving symlinks to prevent cyclic symlink loops
 */
const MAX_DEPTH = 5

export interface Command {
	name: string
	content: string
	source: "global" | "project" | "built-in" | "plugin"
	filePath: string
	description?: string
	argumentHint?: string
	mode?: string
	/** When source === "plugin", the contributing plugin's name (attribution). */
	pluginName?: string
	/**
	 * A **private** (internal) plugin command — invocable by its qualified name but
	 * hidden from user-facing enumerations. {@link getCommands} filters these out;
	 * {@link getCommand} still resolves them. Absent for normal/file commands.
	 */
	private?: boolean
}

/**
 * Information about a resolved command file
 */
interface CommandFileInfo {
	/** Original path (symlink path if symlinked, otherwise the file path) */
	originalPath: string
	/** Resolved path (target of symlink if symlinked, otherwise the file path) */
	resolvedPath: string
}

/**
 * Recursively resolve a symbolic link and collect command file info
 */
async function resolveCommandSymLink(symlinkPath: string, fileInfo: CommandFileInfo[], depth: number): Promise<void> {
	// Avoid cyclic symlinks
	if (depth > MAX_DEPTH) {
		return
	}
	try {
		// Get the symlink target
		const linkTarget = await fs.readlink(symlinkPath)
		// Resolve the target path (relative to the symlink location)
		const resolvedTarget = path.resolve(path.dirname(symlinkPath), linkTarget)

		// Check if the target is a file (use lstat to detect nested symlinks)
		const stats = await fs.lstat(resolvedTarget)
		if (stats.isFile()) {
			// Only include markdown files
			if (isMarkdownFile(resolvedTarget)) {
				// For symlinks to files, store the symlink path as original and target as resolved
				fileInfo.push({ originalPath: symlinkPath, resolvedPath: resolvedTarget })
			}
		} else if (stats.isDirectory()) {
			// Read the target directory and process its entries
			const entries = await fs.readdir(resolvedTarget, { withFileTypes: true })
			const directoryPromises: Promise<void>[] = []
			for (const entry of entries) {
				directoryPromises.push(resolveCommandDirectoryEntry(entry, resolvedTarget, fileInfo, depth + 1))
			}
			await Promise.all(directoryPromises)
		} else if (stats.isSymbolicLink()) {
			// Handle nested symlinks
			await resolveCommandSymLink(resolvedTarget, fileInfo, depth + 1)
		}
	} catch {
		// Skip invalid symlinks
	}
}

/**
 * Recursively resolve directory entries and collect command file paths
 */
async function resolveCommandDirectoryEntry(
	entry: Dirent,
	dirPath: string,
	fileInfo: CommandFileInfo[],
	depth: number,
): Promise<void> {
	// Avoid cyclic symlinks
	if (depth > MAX_DEPTH) {
		return
	}

	const fullPath = path.resolve(entry.parentPath || dirPath, entry.name)
	if (entry.isFile()) {
		// Only include markdown files
		if (isMarkdownFile(entry.name)) {
			// Regular file - both original and resolved paths are the same
			fileInfo.push({ originalPath: fullPath, resolvedPath: fullPath })
		}
	} else if (entry.isSymbolicLink()) {
		// Await the resolution of the symbolic link
		await resolveCommandSymLink(fullPath, fileInfo, depth + 1)
	}
}

/**
 * Try to resolve a symlinked command file
 */
async function tryResolveSymlinkedCommand(filePath: string): Promise<string | undefined> {
	try {
		const lstat = await fs.lstat(filePath)
		if (lstat.isSymbolicLink()) {
			// Get the symlink target
			const linkTarget = await fs.readlink(filePath)
			// Resolve the target path (relative to the symlink location)
			const resolvedTarget = path.resolve(path.dirname(filePath), linkTarget)

			// Check if the target is a file
			const stats = await fs.stat(resolvedTarget)
			if (stats.isFile()) {
				return resolvedTarget
			}
		}
	} catch {
		// Not a symlink or invalid symlink
	}
	return undefined
}

/**
 * Get all available commands from built-in, global, and project directories
 * Priority order: project > global > built-in (later sources override earlier ones)
 */
export async function getCommands(cwd: string): Promise<Command[]> {
	const commands = new Map<string, Command>()

	// Add built-in commands first (lowest priority)
	const builtInCommands = await getBuiltInCommands()
	for (const command of builtInCommands) {
		commands.set(command.name, command)
	}

	// A bundled plugin shipping the platform's own commands (`unqualifiedContributions`)
	// registers them under their authored names, HERE — at the built-in tier — so a user's
	// or project's file of the same name still wins, exactly as it did when the command
	// was compiled into core. Third-party plugin commands are namespaced further below.
	const unqualifiedPluginManager = getSharedPluginManager()
	if (unqualifiedPluginManager) {
		for (const {
			pluginName,
			dir,
			privateNames,
			unqualified,
		} of unqualifiedPluginManager.getContributedCommandDirs()) {
			if (!unqualified) continue
			await scanCommandDirectory(dir, "plugin", commands, pluginName, privateNames ?? [], true)
		}
	}

	// Scan org-global commands (override built-in; overridden by user/project)
	const orgShoferDir = getOrgShoferDirectory()
	if (orgShoferDir) {
		await scanCommandDirectory(path.join(orgShoferDir, "commands"), "global", commands)
	}

	// Scan user-scope commands (override org-global and built-in)
	const globalDir = path.join(getGlobalShoferDirectory(), "commands")
	await scanCommandDirectory(globalDir, "global", commands)

	// Scan project commands (highest priority - override both global and built-in)
	const projectDir = path.join(getProjectShoferDirectoryForCwd(cwd), "commands")
	await scanCommandDirectory(projectDir, "project", commands)

	// Scan plugin-contributed commands (design §6.5). Each is keyed under its
	// **namespaced** name `<pluginName>:<command>` (design §14.7 → namespacing), so a
	// plugin command can never collide with a built-in/user command or another
	// plugin's — no override/warning is needed. Empty when no plugin manager is wired.
	const pluginManager = getSharedPluginManager()
	if (pluginManager) {
		for (const { pluginName, dir, privateNames, unqualified } of pluginManager.getContributedCommandDirs()) {
			if (unqualified) continue
			await scanCommandDirectory(dir, "plugin", commands, pluginName, privateNames ?? [])
		}
	}

	// `getCommands` is the **enumeration** surface (command palette / slash-command
	// menu / autocomplete). Private plugin commands are registered + invocable by
	// their qualified name (via `getCommand`) but hidden here (owner directive #4).
	return Array.from(commands.values()).filter((c) => !c.private)
}

/**
 * Get a specific command by name (optimized to avoid scanning all commands)
 * Priority order: project > global > built-in
 */
export async function getCommand(cwd: string, name: string): Promise<Command | undefined> {
	// Try to find the command directly without scanning all commands
	const projectDir = path.join(getProjectShoferDirectoryForCwd(cwd), "commands")
	const globalDir = path.join(getGlobalShoferDirectory(), "commands")

	// Plugin-contributed commands are addressed by their **namespaced** name
	// `<pluginName>:<command>` (design §14.7 → namespacing). A bare name can never
	// resolve to a plugin command, so plugins can neither shadow nor be shadowed by
	// built-in/user commands. Parse the qualified form, find that specific plugin's
	// dir, and load the bare `<command>.md` from it.
	const pluginManager = getSharedPluginManager()
	if (pluginManager) {
		const sep = name.indexOf(":")
		if (sep > 0) {
			const pluginName = name.slice(0, sep)
			const bareName = name.slice(sep + 1)
			const contribution = pluginManager.getContributedCommandDirs().find((c) => c.pluginName === pluginName)
			if (contribution) {
				const pluginCommand = await tryLoadCommand(contribution.dir, bareName, "plugin")
				if (pluginCommand) {
					return { ...pluginCommand, name, source: "plugin", pluginName }
				}
			}
		}
	}

	// Check project directory next (highest priority among file sources)
	const projectCommand = await tryLoadCommand(projectDir, name, "project")
	if (projectCommand) {
		return projectCommand
	}

	// Check global directory if not found in project
	const globalCommand = await tryLoadCommand(globalDir, name, "global")
	if (globalCommand) {
		return globalCommand
	}

	// Check the org-global scope if the user scope has no override
	const orgShoferDir = getOrgShoferDirectory()
	if (orgShoferDir) {
		const orgCommand = await tryLoadCommand(path.join(orgShoferDir, "commands"), name, "global")
		if (orgCommand) {
			return orgCommand
		}
	}

	// Check built-in commands if not found anywhere else (lowest priority)
	const builtInCommand = await getBuiltInCommand(name)
	if (builtInCommand) {
		return builtInCommand
	}

	// …and, at that same tier, the authored names a bundled plugin claimed with
	// `unqualifiedContributions` — the reason `/merge-worktree` still resolves after the
	// worktree commands moved out of core into the `basics` plugin (`plugins/basics`).
	if (pluginManager) {
		for (const contribution of pluginManager.getContributedCommandDirs()) {
			if (!contribution.unqualified) continue
			const pluginCommand = await tryLoadCommand(contribution.dir, name, "plugin")
			if (pluginCommand) {
				return { ...pluginCommand, name, source: "plugin", pluginName: contribution.pluginName }
			}
		}
	}

	return undefined
}

/**
 * Try to load a specific command from a directory (supports symlinks)
 */
async function tryLoadCommand(
	dirPath: string,
	name: string,
	source: "global" | "project" | "plugin",
): Promise<Command | undefined> {
	try {
		const stats = await fs.stat(dirPath)
		if (!stats.isDirectory()) {
			return undefined
		}

		// Try to find the command file directly
		const commandFileName = `${name}.md`
		const filePath = path.join(dirPath, commandFileName)

		// Check if this is a regular file first
		let resolvedPath = filePath
		let content: string | undefined

		try {
			content = await fs.readFile(filePath, "utf-8")
		} catch {
			// File doesn't exist or can't be read - try resolving as symlink
			const symlinkedPath = await tryResolveSymlinkedCommand(filePath)
			if (symlinkedPath) {
				try {
					content = await fs.readFile(symlinkedPath, "utf-8")
					resolvedPath = symlinkedPath
				} catch {
					// Symlink target can't be read
					return undefined
				}
			} else {
				return undefined
			}
		}

		if (!content) {
			return undefined
		}

		let parsed
		let description: string | undefined
		let argumentHint: string | undefined
		let mode: string | undefined
		let commandContent: string

		try {
			// Try to parse frontmatter with gray-matter
			parsed = matter(content)
			description =
				typeof parsed.data.description === "string" && parsed.data.description.trim()
					? parsed.data.description.trim()
					: undefined
			argumentHint =
				typeof parsed.data["argument-hint"] === "string" && parsed.data["argument-hint"].trim()
					? parsed.data["argument-hint"].trim()
					: undefined
			mode = typeof parsed.data.mode === "string" && parsed.data.mode.trim() ? parsed.data.mode.trim() : undefined
			commandContent = parsed.content.trim()
		} catch {
			// If frontmatter parsing fails, treat the entire content as command content
			description = undefined
			argumentHint = undefined
			mode = undefined
			commandContent = content.trim()
		}

		return {
			name,
			content: commandContent,
			source,
			filePath: resolvedPath,
			description,
			argumentHint,
			mode,
		}
	} catch {
		// Directory doesn't exist or can't be read
		return undefined
	}
}

/**
 * Get command names for autocomplete
 */
export async function getCommandNames(cwd: string): Promise<string[]> {
	const commands = await getCommands(cwd)
	return commands.map((cmd) => cmd.name)
}

/**
 * Scan a specific command directory (supports symlinks)
 */
async function scanCommandDirectory(
	dirPath: string,
	source: "global" | "project" | "plugin",
	commands: Map<string, Command>,
	pluginName?: string,
	privateNames: string[] = [],
	unqualified = false,
): Promise<void> {
	try {
		const stats = await fs.stat(dirPath)
		if (!stats.isDirectory()) {
			return
		}

		const entries = await fs.readdir(dirPath, { withFileTypes: true })

		// Collect all command files, including those from symlinks
		const fileInfo: CommandFileInfo[] = []
		const initialPromises: Promise<void>[] = []

		for (const entry of entries) {
			initialPromises.push(resolveCommandDirectoryEntry(entry, dirPath, fileInfo, 0))
		}

		// Wait for all files to be resolved
		await Promise.all(initialPromises)

		// Process each collected file
		for (const { originalPath, resolvedPath } of fileInfo) {
			// Command name comes from the original path (symlink name if symlinked).
			// Plugin commands are **namespaced** as `<pluginName>:<command>` (design
			// §14.7 → namespacing) so they can never collide with built-in/user
			// commands or with another plugin's commands.
			// A bundled plugin with `unqualifiedContributions` keeps the authored name
			// (`/merge-worktree`), which is the whole point of the exemption.
			const bareName = getCommandNameFromFile(path.basename(originalPath))
			const commandName =
				source === "plugin" && pluginName && !unqualified ? `${pluginName}:${bareName}` : bareName

			try {
				const content = await fs.readFile(resolvedPath, "utf-8")

				let parsed
				let description: string | undefined
				let argumentHint: string | undefined
				let mode: string | undefined
				let commandContent: string

				try {
					// Try to parse frontmatter with gray-matter
					parsed = matter(content)
					description =
						typeof parsed.data.description === "string" && parsed.data.description.trim()
							? parsed.data.description.trim()
							: undefined
					argumentHint =
						typeof parsed.data["argument-hint"] === "string" && parsed.data["argument-hint"].trim()
							? parsed.data["argument-hint"].trim()
							: undefined
					mode =
						typeof parsed.data.mode === "string" && parsed.data.mode.trim()
							? parsed.data.mode.trim()
							: undefined
					commandContent = parsed.content.trim()
				} catch {
					// If frontmatter parsing fails, treat the entire content as command content
					description = undefined
					argumentHint = undefined
					mode = undefined
					commandContent = content.trim()
				}

				// File precedence: project overrides global overrides built-in (unchanged).
				// Plugin commands are namespaced (`<pluginName>:<command>`), so their key
				// can never collide with a built-in/user command or another plugin's
				// command — no last-installed-wins tie-break or warning is needed here
				// (design §14.7 → namespacing).
				if (source === "plugin") {
					// Unqualified plugin commands sit at the built-in tier, so a user's or
					// project's file of the same name still overrides them (they are scanned
					// before both). Namespaced ones cannot collide at all.
					commands.set(commandName, {
						name: commandName,
						content: commandContent,
						source,
						filePath: resolvedPath,
						description,
						argumentHint,
						mode,
						pluginName,
						// Hidden from enumerations, still invocable by qualified name.
						private: privateNames.includes(bareName),
					})
				} else if (source === "project" || !commands.has(commandName)) {
					commands.set(commandName, {
						name: commandName,
						content: commandContent,
						source,
						filePath: resolvedPath,
						description,
						argumentHint,
						mode,
						pluginName: undefined,
					})
				}
			} catch (error) {
				configLog.warn(`Failed to read command file ${resolvedPath}:`, error)
			}
		}
	} catch {
		// Directory doesn't exist or can't be read - this is fine
	}
}

/**
 * Extract command name from filename (strip .md extension only)
 */
export function getCommandNameFromFile(filename: string): string {
	if (filename.toLowerCase().endsWith(".md")) {
		return filename.slice(0, -3)
	}
	return filename
}

/**
 * Check if a file is a markdown file
 */
export function isMarkdownFile(filename: string): boolean {
	return filename.toLowerCase().endsWith(".md")
}
