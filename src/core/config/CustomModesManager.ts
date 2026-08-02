import * as vscode from "vscode"
import { getHost } from "@shofer/types"
import * as path from "path"
import * as fs from "fs/promises"
import * as os from "os"

import * as yaml from "yaml"
import stripBom from "strip-bom"

import { type ModeConfig, type PromptComponent, customModesSettingsSchema, modeConfigSchema } from "@shofer/types"

import { fileExistsAtPath } from "../../utils/fs"
import { getWorkspacePath } from "@shofer/core"
import { getGlobalShoferDirectory } from "@shofer/core"
import { configLog as logger } from "@shofer/core"
import { mergeLayeredConfig } from "@shofer/core"
import { t } from "@shofer/core"
import { configLog } from "@shofer/core"
import { effectiveModes } from "@shofer/core"

import { isPathLocked, type LockedManifest } from "@shofer/core"

import { ContextProxy } from "./ContextProxy"
import { loadLockedManifest, resolveScopeRoots, type ScopeRoots } from "./layeredSettingsLoader"

/** A scope's modes file, named relative to that scope's `.shofer/` root. */
const SHOFERMODES_BASENAME = "shofermodes"

/** The project scope's modes file, relative to the workspace root. */
const SHOFERMODES_FILENAME = path.join(".shofer", SHOFERMODES_BASENAME)

// Type definitions for import/export functionality
interface RuleFile {
	relativePath: string
	content: string
}

interface ExportedModeConfig extends ModeConfig {
	rulesFiles?: RuleFile[]
}

interface ImportData {
	customModes: ExportedModeConfig[]
}

interface ExportResult {
	success: boolean
	yaml?: string
	error?: string
}

interface ImportResult {
	success: boolean
	slug?: string
	error?: string
}

export class CustomModesManager {
	private static readonly cacheTTL = 10_000

	private disposables: vscode.Disposable[] = []
	private isWriting = false
	private writeQueue: Array<() => Promise<void>> = []
	private cachedModes: ModeConfig[] | null = null
	/** Slugs the org scope defines AND locks — final against user/project edits. */
	private cachedLockedSlugs: string[] | null = null
	private cachedAt: number = 0

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly onUpdate: () => Promise<void>,
	) {
		this.watchCustomModesFiles().catch((error) => {
			configLog.error("[CustomModesManager] Failed to setup file watchers:", error)
		})
	}

	private async queueWrite(operation: () => Promise<void>): Promise<void> {
		this.writeQueue.push(operation)

		if (!this.isWriting) {
			await this.processWriteQueue()
		}
	}

	private async processWriteQueue(): Promise<void> {
		if (this.isWriting || this.writeQueue.length === 0) {
			return
		}

		this.isWriting = true

		try {
			while (this.writeQueue.length > 0) {
				const operation = this.writeQueue.shift()

				if (operation) {
					await operation()
				}
			}
		} finally {
			this.isWriting = false
		}
	}

	private async getWorkspaceRoomodes(): Promise<string | undefined> {
		const workspaceFolders = vscode.workspace.workspaceFolders

		if (!workspaceFolders || workspaceFolders.length === 0) {
			return undefined
		}

		const workspaceRoot = getWorkspacePath()
		const shofermodesPath = path.join(workspaceRoot, SHOFERMODES_FILENAME)
		const exists = await fileExistsAtPath(shofermodesPath)
		return exists ? shofermodesPath : undefined
	}

	/**
	 * Regex pattern for problematic characters that need to be cleaned from YAML content
	 * Includes:
	 * - \u00A0: Non-breaking space
	 * - \u200B-\u200D: Zero-width spaces and joiners
	 * - \u2010-\u2015, \u2212: Various dash characters
	 * - \u2018-\u2019: Smart single quotes
	 * - \u201C-\u201D: Smart double quotes
	 */
	private static readonly PROBLEMATIC_CHARS_REGEX =
		// eslint-disable-next-line no-misleading-character-class
		/[\u00A0\u200B\u200C\u200D\u2010\u2011\u2012\u2013\u2014\u2015\u2212\u2018\u2019\u201C\u201D]/g

	/**
	 * Clean invisible and problematic characters from YAML content
	 */
	private cleanInvisibleCharacters(content: string): string {
		// Single pass replacement for all problematic characters
		return content.replace(CustomModesManager.PROBLEMATIC_CHARS_REGEX, (match) => {
			switch (match) {
				case "\u00A0": // Non-breaking space
					return " "
				case "\u200B": // Zero-width space
				case "\u200C": // Zero-width non-joiner
				case "\u200D": // Zero-width joiner
					return ""
				case "\u2018": // Left single quotation mark
				case "\u2019": // Right single quotation mark
					return "'"
				case "\u201C": // Left double quotation mark
				case "\u201D": // Right double quotation mark
					return '"'
				default: // Dash characters (U+2010 through U+2015, U+2212)
					return "-"
			}
		})
	}

	/**
	 * Parse YAML content with enhanced error handling and preprocessing
	 */
	private parseYamlSafely(content: string, filePath: string): any {
		// Clean the content
		let cleanedContent = stripBom(content)
		cleanedContent = this.cleanInvisibleCharacters(cleanedContent)

		try {
			const parsed = yaml.parse(cleanedContent)
			// Ensure we never return null or undefined
			return parsed ?? {}
		} catch (yamlError) {
			// Try JSON as a fallback (a shofermodes file may be hand-written as JSON).
			try {
				// Parse the original content, not the cleaned content.
				return JSON.parse(content)
			} catch {
				// JSON also failed — surface the original YAML error. Silently dropping
				// to `{}` would make every custom mode disappear from the UI with no
				// in-product feedback, historically a major source of "my modes
				// vanished" reports.
				const errorMsg = yamlError instanceof Error ? yamlError.message : String(yamlError)
				configLog.error(`[CustomModesManager] Failed to parse YAML from ${filePath}:`, errorMsg)

				const lineMatch = errorMsg.match(/at line (\d+)/)
				const line = lineMatch ? lineMatch[1] : "unknown"
				getHost().notifier.error(t("common:customModes.errors.yamlParseError", { line }))

				// Return empty object to prevent duplicate error handling
				return {}
			}
		}
	}

	private async loadModesFromFile(filePath: string, source: "global" | "project"): Promise<ModeConfig[]> {
		try {
			const content = await fs.readFile(filePath, "utf-8")
			const settings = this.parseYamlSafely(content, filePath)

			// Ensure settings has customModes property
			if (!settings || typeof settings !== "object" || !settings.customModes) {
				return []
			}

			const result = customModesSettingsSchema.safeParse(settings)

			if (!result.success) {
				configLog.error(`[CustomModesManager] Schema validation failed for ${filePath}:`, result.error)

				// Surface schema-validation failures. A silent failure used to make
				// every custom mode disappear from the UI with no feedback.
				const issues = result.error.issues
					.map((issue) => `• ${issue.path.join(".")}: ${issue.message}`)
					.join("\n")

				getHost().notifier.error(t("common:customModes.errors.schemaValidationError", { issues }))

				return []
			}

			// Tag each mode with the scope it was loaded from.
			return result.data.customModes.map((mode) => ({ ...mode, source }))
		} catch (error) {
			// A missing scope file is the normal empty-layer case, not an error.
			// Only log if the error wasn't already handled in parseYamlSafely.
			if ((error as NodeJS.ErrnoException)?.code !== "ENOENT" && !(error as any).alreadyHandled) {
				const errorMsg = `Failed to load modes from ${filePath}: ${error instanceof Error ? error.message : String(error)}`
				configLog.error(`[CustomModesManager] ${errorMsg}`)
			}
			return []
		}
	}

	/**
	 * The three `.shofer/` scope roots for mode files — the same resolution the
	 * layered settings overlay uses (env `SHOFER_GLOBAL_DIR` / extension
	 * global-storage for org-global, `~/.shofer` for user, the open workspace for
	 * project), so a mode file and a settings file always agree on where each
	 * scope lives.
	 */
	private resolveModeScopeRoots(): ScopeRoots {
		let workspaceFolder: string | undefined
		try {
			workspaceFolder = getWorkspacePath() || undefined
		} catch {
			workspaceFolder = undefined
		}

		return resolveScopeRoots({
			globalStorageFsPath: this.context.globalStorageUri?.fsPath,
			homeDir: os.homedir(),
			workspaceFolder,
		})
	}

	/**
	 * Load one scope's `shofermodes` file, tagging each mode with the UI-facing
	 * source (`"project"` for the project scope, `"global"` for both the user and
	 * org-global scopes — the org layer is invisible to the UI beyond the merge
	 * outcome). A missing root or file contributes an empty layer.
	 */
	private async loadScopeModes(root: string | undefined, source: "global" | "project"): Promise<ModeConfig[]> {
		if (!root) {
			return []
		}
		return this.loadModesFromFile(path.join(root, SHOFERMODES_BASENAME), source)
	}

	/**
	 * The **user** scope's modes file (`~/.shofer/shofermodes`) — the writable
	 * home of every non-project custom mode. Created with an empty template on
	 * first access so the Settings UI can open it for editing.
	 */
	public async getCustomModesFilePath(): Promise<string> {
		const userRoot = path.join(os.homedir(), ".shofer")
		const filePath = path.join(userRoot, SHOFERMODES_BASENAME)
		const fileExists = await fileExistsAtPath(filePath)

		if (!fileExists) {
			await this.queueWrite(async () => {
				await fs.mkdir(userRoot, { recursive: true })
				await fs.writeFile(filePath, yaml.stringify({ customModes: [] }, { lineWidth: 0 }))
			})
		}

		return filePath
	}

	/**
	 * React to on-disk edits of any scope's `shofermodes` file.
	 *
	 * The three scope roots are already watched by `ContextProxy`'s `ScopeWatcher`
	 * (directory watches, so a ConfigMap symlink swap on the org-global root and an
	 * atomic temp+rename both register) — this manager subscribes to that stream
	 * rather than owning bespoke per-file watchers. Every event funnels into one
	 * handler: re-read all scopes, re-merge, refresh consumers.
	 */
	private async watchCustomModesFiles(): Promise<void> {
		// Skip if test environment is detected
		if (process.env.NODE_ENV === "test") {
			return
		}

		let proxy: ContextProxy
		try {
			proxy = ContextProxy.instance
		} catch {
			// No initialized ContextProxy (bare test harness) — no file watching.
			return
		}

		this.disposables.push(
			proxy.onDidChangeScopeFiles(({ files }) => {
				if (!files.includes(SHOFERMODES_BASENAME)) {
					return
				}
				this.refreshMergedState().catch((error) => {
					configLog.error(`[CustomModesManager] Error handling shofermodes change:`, error)
				})
			}),
		)
	}

	public async getCustomModes(): Promise<ModeConfig[]> {
		// Check if we have a valid cached result.
		const now = Date.now()

		if (this.cachedModes && now - this.cachedAt < CustomModesManager.cacheTTL) {
			return this.cachedModes
		}

		// Read every scope's `shofermodes` and merge per slug through the shared
		// layered-config engine: unlocked slugs follow project > user > org-global
		// (more-specific wins, whole-entity); a slug the org-global scope's
		// `locked.json` names (`modes/<slug>`) keeps the org version regardless.
		const roots = this.resolveModeScopeRoots()
		const [orgModes, userModes, projectModes, manifest] = await Promise.all([
			this.loadScopeModes(roots.global, "global"),
			this.loadScopeModes(roots.user, "global"),
			this.loadScopeModes(roots.project, "project"),
			loadLockedManifest(roots.global),
		])

		const mergedModes = (mergeLayeredConfig(
			{
				global: { customModes: orgModes },
				user: { customModes: userModes },
				project: { customModes: projectModes },
			},
			manifest,
		).customModes ?? []) as ModeConfig[]

		// The org-locked slug set: org-defined modes the manifest makes final.
		// Cached beside the merge so the Settings UI can mark them read-only.
		this.cachedLockedSlugs = orgModes
			.filter((m) => CustomModesManager.isModeLocked(m.slug, manifest))
			.map((m) => m.slug)

		// Fold in plugin-contributed modes (design §6.3) — including Shofer's own six,
		// which the bundled `builtin-config` plugin contributes.
		const allModes = effectiveModes(mergedModes)

		await this.context.globalState.update("customModes", allModes)

		this.cachedModes = allModes
		this.cachedAt = now

		return allModes
	}

	/** True when `locked.json` names the mode (or the whole collection). */
	private static isModeLocked(slug: string, manifest: LockedManifest): boolean {
		return (
			isPathLocked("modes", manifest) ||
			isPathLocked("customModes", manifest) ||
			isPathLocked(`modes/${slug}`, manifest) ||
			isPathLocked(`customModes/${slug}`, manifest)
		)
	}

	/**
	 * The org-locked mode slugs (org-defined + named by the org `locked.json`).
	 * Fresh as of the last merge; used by the Settings UI to mark those modes
	 * read-only and by the mutation guards below.
	 */
	public async getLockedModeSlugs(): Promise<string[]> {
		await this.getCustomModes()
		return this.cachedLockedSlugs ?? []
	}

	/** Refuse a mutation of an org-locked mode loudly instead of letting the
	 *  write land in a weaker scope where the merge silently shadows it. */
	private async assertModeNotLocked(slug: string): Promise<void> {
		const locked = await this.getLockedModeSlugs()
		if (locked.includes(slug)) {
			const message = t("common:customModes.errors.orgLocked", { slug })
			getHost().notifier.error(message)
			throw new Error(message)
		}
	}

	public async updateCustomMode(slug: string, config: ModeConfig): Promise<void> {
		await this.assertModeNotLocked(slug)
		try {
			// Validate the mode configuration before saving
			const validationResult = modeConfigSchema.safeParse(config)
			if (!validationResult.success) {
				const errorMessages = validationResult.error.errors
					.map((err) => `${err.path.join(".")}: ${err.message}`)
					.join(", ")
				const errorMessage = `Invalid mode configuration: ${errorMessages}`
				logger.error("Mode validation failed", { slug, errors: validationResult.error.errors })
				getHost().notifier.error(t("common:customModes.errors.updateFailed", { error: errorMessage }))
				throw new Error(errorMessage)
			}

			const isProjectMode = config.source === "project"
			let targetPath: string

			if (isProjectMode) {
				const workspaceFolders = vscode.workspace.workspaceFolders

				if (!workspaceFolders || workspaceFolders.length === 0) {
					logger.error("Failed to update project mode: No workspace folder found", { slug })
					throw new Error(t("common:customModes.errors.noWorkspaceForProject"))
				}

				const workspaceRoot = getWorkspacePath()
				targetPath = path.join(workspaceRoot, SHOFERMODES_FILENAME)
				const exists = await fileExistsAtPath(targetPath)

				logger.info(`${exists ? "Updating" : "Creating"} project mode in ${SHOFERMODES_FILENAME}`, {
					slug,
					workspace: workspaceRoot,
				})
			} else {
				targetPath = await this.getCustomModesFilePath()
			}

			await this.queueWrite(async () => {
				// Ensure source is set correctly based on target file.
				const modeWithSource = {
					...config,
					source: isProjectMode ? ("project" as const) : ("global" as const),
				}

				await this.updateModesInFile(targetPath, (modes) => {
					const updatedModes = modes.filter((m) => m.slug !== slug)
					updatedModes.push(modeWithSource)
					return updatedModes
				})

				this.clearCache()
				await this.refreshMergedState()
			})
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			logger.error("Failed to update custom mode", { slug, error: errorMessage })
			getHost().notifier.error(t("common:customModes.errors.updateFailed", { error: errorMessage }))
			throw error
		}
	}

	private async updateModesInFile(filePath: string, operation: (modes: ModeConfig[]) => ModeConfig[]): Promise<void> {
		let content = "{}"

		try {
			content = await fs.readFile(filePath, "utf-8")
		} catch (error) {
			// File might not exist yet.
			content = yaml.stringify({ customModes: [] }, { lineWidth: 0 })
		}

		// The scope's `.shofer/` directory may not exist yet (fresh ~/.shofer or a
		// workspace without one) — the write below must not fail on that.
		await fs.mkdir(path.dirname(filePath), { recursive: true })

		let settings

		try {
			settings = this.parseYamlSafely(content, filePath)
		} catch (error) {
			// Error already logged in parseYamlSafely
			settings = { customModes: [] }
		}

		// Ensure settings is an object and has customModes property
		if (!settings || typeof settings !== "object") {
			settings = { customModes: [] }
		}
		if (!settings.customModes) {
			settings.customModes = []
		}

		settings.customModes = operation(settings.customModes)
		await fs.writeFile(filePath, yaml.stringify(settings, { lineWidth: 0 }), "utf-8")
	}

	private async refreshMergedState(): Promise<void> {
		// getCustomModes() re-reads every scope, re-merges, and refreshes the
		// globalState cache; clearing first forces it past the TTL cache. The
		// trailing clear keeps the long-standing contract that the next external
		// getCustomModes() after an update reads from disk rather than the cache.
		this.clearCache()
		await this.getCustomModes()
		await this.onUpdate()
		this.clearCache()
	}

	public async deleteCustomMode(slug: string): Promise<void> {
		try {
			await this.assertModeNotLocked(slug)
			// Only the user and project scopes are writable — an org-global mode
			// cannot be deleted from here (and if it exists, deleting a user/project
			// override simply reverts to the org version on the next merge).
			const settingsPath = await this.getCustomModesFilePath()
			const shofermodesPath = await this.getWorkspaceRoomodes()

			const settingsModes = await this.loadModesFromFile(settingsPath, "global")
			const shofermodesModes = shofermodesPath ? await this.loadModesFromFile(shofermodesPath, "project") : []

			// Find the mode in either file
			const projectMode = shofermodesModes.find((m) => m.slug === slug)
			const globalMode = settingsModes.find((m) => m.slug === slug)

			if (!projectMode && !globalMode) {
				throw new Error(t("common:customModes.errors.modeNotFound"))
			}

			// Determine which mode to use for rules folder path calculation
			const modeToDelete = projectMode || globalMode

			await this.queueWrite(async () => {
				// Delete from project first if it exists there
				if (projectMode && shofermodesPath) {
					await this.updateModesInFile(shofermodesPath, (modes) => modes.filter((m) => m.slug !== slug))
				}

				// Delete from global settings if it exists there
				if (globalMode) {
					await this.updateModesInFile(settingsPath, (modes) => modes.filter((m) => m.slug !== slug))
				}

				// Delete associated rules folder
				if (modeToDelete) {
					await this.deleteRulesFolder(slug, modeToDelete)
				}

				// Clear cache when modes are deleted
				this.clearCache()
				await this.refreshMergedState()
			})
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			getHost().notifier.error(t("common:customModes.errors.deleteFailed", { error: errorMessage }))
		}
	}

	/**
	 * Deletes the rules folder for a specific mode
	 * @param slug - The mode slug
	 * @param mode - The mode configuration to determine the scope
	 */
	private async deleteRulesFolder(slug: string, mode: ModeConfig): Promise<void> {
		try {
			// Determine the scope based on source (project or global)
			const scope = mode.source || "global"

			// Determine the rules folder path
			let rulesFolderPath: string
			if (scope === "project") {
				const workspacePath = getWorkspacePath()
				if (workspacePath) {
					rulesFolderPath = path.join(workspacePath, ".shofer", `rules-${slug}`)
				} else {
					return // No workspace, can't delete project rules
				}
			} else {
				// Global scope - use OS home directory
				const homeDir = os.homedir()
				rulesFolderPath = path.join(homeDir, ".shofer", `rules-${slug}`)
			}

			// Check if the rules folder exists and delete it
			const rulesFolderExists = await fileExistsAtPath(rulesFolderPath)
			if (rulesFolderExists) {
				try {
					await fs.rm(rulesFolderPath, { recursive: true, force: true })
					logger.info(`Deleted rules folder for mode ${slug}: ${rulesFolderPath}`)
				} catch (error) {
					logger.error(`Failed to delete rules folder for mode ${slug}: ${error}`)
					// Notify the user about the failure
					getHost().notifier.warn(t("common:customModes.errors.rulesCleanupFailed", { rulesFolderPath }))
					// Continue even if folder deletion fails
				}
			}
		} catch (error) {
			logger.error(`Error deleting rules folder for mode ${slug}`, {
				error: error instanceof Error ? error.message : String(error),
			})
		}
	}

	public async resetCustomModes(): Promise<void> {
		try {
			const filePath = await this.getCustomModesFilePath()
			await fs.writeFile(filePath, yaml.stringify({ customModes: [] }, { lineWidth: 0 }))
			await this.context.globalState.update("customModes", [])
			this.clearCache()
			await this.onUpdate()
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			getHost().notifier.error(t("common:customModes.errors.resetFailed", { error: errorMessage }))
		}
	}

	/**
	 * Checks if a mode has associated rules files in the .shofer/rules-{slug}/ directory
	 * @param slug - The mode identifier to check
	 * @returns True if the mode has rules files with content, false otherwise
	 */
	public async checkRulesDirectoryHasContent(slug: string): Promise<boolean> {
		try {
			// First, find the mode to determine its source
			const allModes = await this.getCustomModes()
			const mode = allModes.find((m) => m.slug === slug)

			if (!mode) {
				// If not in custom modes, check if it's in .shofermodes (project-specific)
				const workspacePath = getWorkspacePath()
				if (!workspacePath) {
					return false
				}

				const shofermodesPath = path.join(workspacePath, SHOFERMODES_FILENAME)
				try {
					const roomodesExists = await fileExistsAtPath(shofermodesPath)
					if (roomodesExists) {
						const shofermodesContent = await fs.readFile(shofermodesPath, "utf-8")
						const shofermodesData = yaml.parse(shofermodesContent)
						const shofermodesModes = shofermodesData?.customModes || []

						// Check if this specific mode exists in .shofermodes
						const modeInRoomodes = shofermodesModes.find((m: any) => m.slug === slug)
						if (!modeInRoomodes) {
							return false // Mode not found anywhere
						}
					} else {
						return false // No .shofermodes file and not in custom modes
					}
				} catch (error) {
					return false // Cannot read .shofermodes and not in custom modes
				}
			}

			// Determine the correct rules directory based on mode source
			let modeRulesDir: string
			const isGlobalMode = mode?.source === "global"

			if (isGlobalMode) {
				// For global modes, check in global .shofer directory
				const globalShoferDir = getGlobalShoferDirectory()
				modeRulesDir = path.join(globalShoferDir, `rules-${slug}`)
			} else {
				// For project modes, check in workspace .shofer directory
				const workspacePath = getWorkspacePath()
				if (!workspacePath) {
					return false
				}
				modeRulesDir = path.join(workspacePath, ".shofer", `rules-${slug}`)
			}

			try {
				const stats = await fs.stat(modeRulesDir)
				if (!stats.isDirectory()) {
					return false
				}
			} catch (error) {
				return false
			}

			// Check if directory has any content files
			try {
				const entries = await fs.readdir(modeRulesDir, { withFileTypes: true })

				for (const entry of entries) {
					if (entry.isFile()) {
						// Use path.join with modeRulesDir and entry.name for compatibility
						const filePath = path.join(modeRulesDir, entry.name)
						const content = await fs.readFile(filePath, "utf-8")
						if (content.trim()) {
							return true // Found at least one file with content
						}
					}
				}

				return false // No files with content found
			} catch (error) {
				return false
			}
		} catch (error) {
			logger.error("Failed to check rules directory for mode", {
				slug,
				error: error instanceof Error ? error.message : String(error),
			})
			return false
		}
	}

	/**
	 * Exports a mode configuration with its associated rules files into a shareable YAML format
	 * @param slug - The mode identifier to export
	 * @param customPrompts - Optional custom prompts to merge into the export
	 * @returns Success status with YAML content or error message
	 */
	public async exportModeWithRules(slug: string, customPrompts?: PromptComponent): Promise<ExportResult> {
		try {
			// The effective mode list already carries plugin-contributed modes — Shofer's
			// built-ins among them — so there is no separate built-in list to consult.
			const allModes = await this.getCustomModes()
			let mode: ModeConfig | undefined = allModes.find((m) => m.slug === slug)

			// Not merged in yet: fall back to reading the project file directly, so a mode
			// added to `.shofermodes` moments ago is still exportable.
			if (!mode) {
				const workspacePath = getWorkspacePath()
				if (workspacePath) {
					const shofermodesPath = path.join(workspacePath, SHOFERMODES_FILENAME)
					try {
						const roomodesExists = await fileExistsAtPath(shofermodesPath)
						if (roomodesExists) {
							const shofermodesContent = await fs.readFile(shofermodesPath, "utf-8")
							const shofermodesData = yaml.parse(shofermodesContent)
							const shofermodesModes: ModeConfig[] = shofermodesData?.customModes || []
							mode = shofermodesModes.find((m) => m.slug === slug)
						}
					} catch (error) {
						// Unreadable/invalid project file — fall through to "Mode not found".
					}
				}

				if (!mode) {
					return { success: false, error: "Mode not found" }
				}
			}

			// Determine the base directory based on mode source
			const isGlobalMode = mode.source === "global"
			let baseDir: string
			if (isGlobalMode) {
				// For global modes, use the global .shofer directory
				baseDir = getGlobalShoferDirectory()
			} else {
				// For project modes, use the workspace directory
				const workspacePath = getWorkspacePath()
				if (!workspacePath) {
					return { success: false, error: "No workspace found" }
				}
				baseDir = workspacePath
			}

			// Check for .shofer/rules-{slug}/ directory (or rules-{slug}/ for global)
			const modeRulesDir = isGlobalMode
				? path.join(baseDir, `rules-${slug}`)
				: path.join(baseDir, ".shofer", `rules-${slug}`)

			let rulesFiles: RuleFile[] = []
			try {
				const stats = await fs.stat(modeRulesDir)
				if (stats.isDirectory()) {
					// Extract content specific to this mode by looking for the mode-specific rules
					const entries = await fs.readdir(modeRulesDir, { withFileTypes: true })

					for (const entry of entries) {
						if (entry.isFile()) {
							// Use path.join with modeRulesDir and entry.name for compatibility
							const filePath = path.join(modeRulesDir, entry.name)
							const content = await fs.readFile(filePath, "utf-8")
							if (content.trim()) {
								// Calculate relative path from within the rules directory
								// This excludes the rules-{slug} folder from the path
								const relativePath = path.relative(modeRulesDir, filePath)
								// Normalize path to use forward slashes for cross-platform compatibility
								const normalizedRelativePath = relativePath.replace(/\\/g, "/")
								rulesFiles.push({ relativePath: normalizedRelativePath, content: content.trim() })
							}
						}
					}
				}
			} catch (error) {
				// Directory doesn't exist, which is fine - mode might not have rules
			}

			// Create an export mode with rules files preserved
			const exportMode: ExportedModeConfig = {
				...mode,
				// Remove source property for export
				source: "project" as const,
			}

			// Merge custom prompts if provided
			if (customPrompts) {
				if (customPrompts.roleDefinition) exportMode.roleDefinition = customPrompts.roleDefinition
				if (customPrompts.description) exportMode.description = customPrompts.description
				if (customPrompts.whenToUse) exportMode.whenToUse = customPrompts.whenToUse
				if (customPrompts.customInstructions) exportMode.customInstructions = customPrompts.customInstructions
			}

			// Add rules files if any exist
			if (rulesFiles.length > 0) {
				exportMode.rulesFiles = rulesFiles
			}

			// Generate YAML
			const exportData = {
				customModes: [exportMode],
			}

			const yamlContent = yaml.stringify(exportData)

			return { success: true, yaml: yamlContent }
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			logger.error("Failed to export mode with rules", { slug, error: errorMessage })
			return { success: false, error: errorMessage }
		}
	}

	/**
	 * Helper method to import rules files for a mode
	 * @param importMode - The mode being imported
	 * @param rulesFiles - The rules files to import
	 * @param source - The import source ("global" or "project")
	 */
	private async importRulesFiles(
		importMode: ExportedModeConfig,
		rulesFiles: RuleFile[],
		source: "global" | "project",
	): Promise<void> {
		// Determine base directory and rules folder path based on source
		let baseDir: string
		let rulesFolderPath: string

		if (source === "global") {
			baseDir = getGlobalShoferDirectory()
			rulesFolderPath = path.join(baseDir, `rules-${importMode.slug}`)
		} else {
			const workspacePath = getWorkspacePath()
			baseDir = path.join(workspacePath, ".shofer")
			rulesFolderPath = path.join(baseDir, `rules-${importMode.slug}`)
		}

		// Always remove the existing rules folder for this mode if it exists
		// This ensures that if the imported mode has no rules, the folder is cleaned up
		try {
			await fs.rm(rulesFolderPath, { recursive: true, force: true })
			logger.info(`Removed existing ${source} rules folder for mode ${importMode.slug}`)
		} catch (error) {
			// It's okay if the folder doesn't exist
			logger.debug(`No existing ${source} rules folder to remove for mode ${importMode.slug}`)
		}

		// Only proceed with file creation if there are rules files to import
		if (!rulesFiles || !Array.isArray(rulesFiles) || rulesFiles.length === 0) {
			return
		}

		// Import the new rules files with path validation
		for (const ruleFile of rulesFiles) {
			if (ruleFile.relativePath && ruleFile.content) {
				// Validate the relative path to prevent path traversal attacks
				const normalizedRelativePath = path.normalize(ruleFile.relativePath)

				// Ensure the path doesn't contain traversal sequences
				if (normalizedRelativePath.includes("..") || path.isAbsolute(normalizedRelativePath)) {
					logger.error(`Invalid file path detected: ${ruleFile.relativePath}`)
					continue // Skip this file but continue with others
				}

				// Check if path starts with a rules-* folder (old export format)
				let cleanedRelativePath = normalizedRelativePath
				const rulesMatch = normalizedRelativePath.match(/^rules-[^\/\\]+[\/\\]/)
				if (rulesMatch) {
					// Strip the entire rules-* folder reference for backwards compatibility
					cleanedRelativePath = normalizedRelativePath.substring(rulesMatch[0].length)
					logger.info(`Detected old export format, stripping ${rulesMatch[0]} from path`)
				}

				// Use the rules folder path instead of base directory
				const targetPath = path.join(rulesFolderPath, cleanedRelativePath)
				const normalizedTargetPath = path.normalize(targetPath)
				const expectedBasePath = path.normalize(rulesFolderPath)

				// Ensure the resolved path stays within the rules folder
				if (!normalizedTargetPath.startsWith(expectedBasePath)) {
					logger.error(`Path traversal attempt detected: ${ruleFile.relativePath}`)
					continue // Skip this file but continue with others
				}

				// Ensure directory exists
				const targetDir = path.dirname(targetPath)
				await fs.mkdir(targetDir, { recursive: true })

				// Write the file
				await fs.writeFile(targetPath, ruleFile.content, "utf-8")
			}
		}
	}

	/**
	 * Imports modes from YAML content, including their associated rules files
	 * @param yamlContent - The YAML content containing mode configurations
	 * @param source - Target level for import: "global" (all projects) or "project" (current workspace only)
	 * @returns Success status with optional error message
	 */
	public async importModeWithRules(
		yamlContent: string,
		source: "global" | "project" = "project",
	): Promise<ImportResult> {
		try {
			// Parse the YAML content with proper type validation
			let importData: ImportData
			try {
				const parsed = yaml.parse(yamlContent)

				// Validate the structure
				if (!parsed?.customModes || !Array.isArray(parsed.customModes) || parsed.customModes.length === 0) {
					return { success: false, error: "Invalid import format: Expected 'customModes' array in YAML" }
				}

				importData = parsed as ImportData
			} catch (parseError) {
				return {
					success: false,
					error: `Invalid YAML format: ${parseError instanceof Error ? parseError.message : "Failed to parse YAML"}`,
				}
			}

			// Check workspace availability early if importing at project level
			if (source === "project") {
				const workspacePath = getWorkspacePath()
				if (!workspacePath) {
					return { success: false, error: "No workspace found" }
				}
			}

			// Process each mode in the import
			for (const importMode of importData.customModes) {
				const { rulesFiles, ...modeConfig } = importMode

				// Validate the mode configuration
				const validationResult = modeConfigSchema.safeParse(modeConfig)
				if (!validationResult.success) {
					logger.error(`Invalid mode configuration for ${modeConfig.slug}`, {
						errors: validationResult.error.errors,
					})
					return {
						success: false,
						error: `Invalid mode configuration for ${modeConfig.slug}: ${validationResult.error.errors.map((e) => e.message).join(", ")}`,
					}
				}

				// Check for existing mode conflicts
				const existingModes = await this.getCustomModes()
				const existingMode = existingModes.find((m) => m.slug === importMode.slug)
				if (existingMode) {
					logger.info(`Overwriting existing mode: ${importMode.slug}`)
				}

				// Import the mode configuration with the specified source
				await this.updateCustomMode(importMode.slug, {
					...modeConfig,
					source: source, // Use the provided source parameter
				})

				// Import rules files (this also handles cleanup of existing rules folders)
				await this.importRulesFiles(importMode, rulesFiles || [], source)
			}

			// Refresh the modes after import
			await this.refreshMergedState()

			// Return the imported mode's slug so the UI can activate it
			return { success: true, slug: importData.customModes[0]?.slug }
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			logger.error("Failed to import mode with rules", { error: errorMessage })
			return { success: false, error: errorMessage }
		}
	}

	private clearCache(): void {
		this.cachedModes = null
		this.cachedLockedSlugs = null
		this.cachedAt = 0
	}

	/**
	 * Invalidate the merged-modes cache so the next {@link getCustomModes} re-reads
	 * files and re-merges plugin-contributed modes. Used after a plugin is
	 * enabled/disabled so mode changes surface immediately rather than after the TTL.
	 */
	public invalidateCache(): void {
		this.clearCache()
	}

	dispose(): void {
		for (const disposable of this.disposables) {
			disposable.dispose()
		}

		this.disposables = []
	}
}
