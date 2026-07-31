import * as fs from "fs/promises"
import * as path from "path"
import * as vscode from "vscode"
import matter from "gray-matter"

import type { ShoferProvider } from "../../core/webview/ShoferProvider"
import { getGlobalShoferDirectory, getGlobalAgentsDirectory, getProjectAgentsDirectoryForCwd } from "@shofer/core"
import { getOrgShoferDirectory } from "@shofer/core"
import { directoryExists, fileExists } from "@shofer/core"
import { getSharedPluginManager } from "@shofer/core"
import { isPathLocked, loadLockedManifestFromDisk } from "@shofer/core"
import { SkillMetadata, SkillContent, qualifiedSkillName } from "@shofer/types"
import { getAllModes } from "@shofer/core"
import {
	validateSkillName as validateSkillNameShared,
	SkillNameValidationError,
	SKILL_NAME_MAX_LENGTH,
} from "@shofer/types"
import { skillsLog } from "@shofer/core"
import { t } from "@shofer/core"

// Re-export for convenience
export type { SkillMetadata, SkillContent }

export class SkillsManager {
	private skills: Map<string, SkillMetadata> = new Map()
	/** Org-scope skill entries recorded during discovery (same keys as `skills`). */
	private orgSkillEntries: Map<string, SkillMetadata> = new Map()
	/** Names of org-defined skills the org `locked.json` makes final. */
	private lockedOrgSkillNames: Set<string> = new Set()
	private providerRef: WeakRef<ShoferProvider>
	private disposables: vscode.Disposable[] = []
	private isDisposed = false

	constructor(provider: ShoferProvider) {
		this.providerRef = new WeakRef(provider)
	}

	async initialize(): Promise<void> {
		await this.discoverSkills()
		await this.setupFileWatchers()
	}

	/**
	 * Discover all skills from global and project directories.
	 * Supports both generic skills (skills/) and mode-specific skills (skills-{mode}/).
	 * Also supports symlinks:
	 * - .shofer/skills can be a symlink to a directory containing skill subdirectories
	 * - .shofer/skills/[dirname] can be a symlink to a skill directory
	 */
	async discoverSkills(): Promise<void> {
		this.skills.clear()
		this.orgSkillEntries.clear()
		const skillsDirs = await this.getSkillsDirectories()

		for (const { dir, source, mode, pluginName, privateNames, org } of skillsDirs) {
			await this.scanSkillsDirectory(dir, source, mode, pluginName, privateNames, org)
		}

		await this.enforceOrgSkillLocks()
	}

	/**
	 * Enforce the org scope's skill locks: skills are a directory-merged
	 * namespace (no engine merge), so locks are applied here — a skill name the
	 * org scope defines AND `locked.json` names (`skills` / `skills/<name>`) is
	 * org-final. Every same-name entry from any other scope (user, project,
	 * `.agents`, plugins) is purged and the org entries restored, regardless of
	 * scan order. Skills are identity digest inputs (hierarchical_rbac.md §6),
	 * so a shadowed org skill would change the hands under the org's identity.
	 */
	private async enforceOrgSkillLocks(): Promise<void> {
		this.lockedOrgSkillNames = new Set()
		const orgDir = getOrgShoferDirectory()
		if (!orgDir || this.orgSkillEntries.size === 0) {
			return
		}
		const manifest = await loadLockedManifestFromDisk(orgDir)
		const allLocked = isPathLocked("skills", manifest)
		for (const meta of this.orgSkillEntries.values()) {
			if (allLocked || isPathLocked(`skills/${meta.name}`, manifest)) {
				this.lockedOrgSkillNames.add(meta.name)
			}
		}
		if (this.lockedOrgSkillNames.size === 0) {
			return
		}
		for (const [key, meta] of [...this.skills.entries()]) {
			if (this.lockedOrgSkillNames.has(meta.name) && !this.orgSkillEntries.has(key)) {
				skillsLog.warn(
					`Skill "${meta.name}" (${meta.path}) is shadowed by the org-locked skill of the same name and was ignored`,
				)
				this.skills.delete(key)
			}
		}
		for (const [key, meta] of this.orgSkillEntries.entries()) {
			if (this.lockedOrgSkillNames.has(meta.name)) {
				this.skills.set(key, meta)
			}
		}
	}

	/**
	 * The org-locked skill names (org-defined + named by the org `locked.json`),
	 * as of the last discovery. The Settings UI marks these read-only; the
	 * lifecycle methods refuse mutations of them.
	 */
	public getLockedSkillNames(): string[] {
		return [...this.lockedOrgSkillNames].sort()
	}

	/** Refuse a mutation touching an org-locked skill name loudly. */
	private assertSkillNotLocked(name: string): void {
		if (this.lockedOrgSkillNames.has(name)) {
			throw new Error(t("skills:errors.org_locked", { name }))
		}
	}

	/**
	 * Scan a skills directory for skill subdirectories.
	 * Handles two symlink cases:
	 * 1. The skills directory itself is a symlink (resolved by directoryExists using realpath)
	 * 2. Individual skill subdirectories are symlinks
	 */
	private async scanSkillsDirectory(
		dirPath: string,
		source: "global" | "project" | "plugin",
		mode?: string,
		pluginName?: string,
		privateNames: string[] = [],
		org = false,
	): Promise<void> {
		if (!(await directoryExists(dirPath))) {
			return
		}

		try {
			// Get the real path (resolves if dirPath is a symlink)
			const realDirPath = await fs.realpath(dirPath)

			// Read directory entries
			const entries = await fs.readdir(realDirPath)

			for (const entryName of entries) {
				const entryPath = path.join(realDirPath, entryName)

				// Check if this entry is a directory (follows symlinks automatically)
				const stats = await fs.stat(entryPath).catch(() => null)
				if (!stats?.isDirectory()) continue

				// Load skill metadata - the skill name comes from the entry name (symlink name if symlinked)
				await this.loadSkillMetadata(entryPath, source, mode, entryName, pluginName, privateNames, org)
			}
		} catch {
			// Directory doesn't exist or can't be read - this is fine
		}
	}

	/**
	 * Load skill metadata from a skill directory.
	 * @param skillDir - The resolved path to the skill directory (target of symlink if symlinked)
	 * @param source - Whether this is a global or project skill
	 * @param mode - The mode this skill is specific to (undefined for generic skills)
	 * @param skillName - The skill name (from symlink name if symlinked, otherwise from directory name)
	 */
	private async loadSkillMetadata(
		skillDir: string,
		source: "global" | "project" | "plugin",
		mode?: string,
		skillName?: string,
		pluginName?: string,
		privateNames: string[] = [],
		org = false,
	): Promise<void> {
		const skillMdPath = path.join(skillDir, "SKILL.md")
		if (!(await fileExists(skillMdPath))) return

		try {
			const fileContent = await fs.readFile(skillMdPath, "utf-8")

			// Use gray-matter to parse frontmatter
			const { data: frontmatter, content: body } = matter(fileContent)

			// Validate required fields (only name and description for now)
			if (!frontmatter.name || typeof frontmatter.name !== "string") {
				skillsLog.error(`Skill at ${skillDir} is missing required 'name' field`)
				return
			}
			if (!frontmatter.description || typeof frontmatter.description !== "string") {
				skillsLog.error(`Skill at ${skillDir} is missing required 'description' field`)
				return
			}

			// Validate that frontmatter name matches the skill name (directory name or symlink name)
			// Per the Agent Skills spec: "name field must match the parent directory name"
			const effectiveSkillName = skillName || path.basename(skillDir)
			if (frontmatter.name !== effectiveSkillName) {
				skillsLog.error(`Skill name "${frontmatter.name}" doesn't match directory "${effectiveSkillName}"`)
				return
			}

			// Validate skill name per agentskills.io spec using shared validation
			const nameValidation = validateSkillNameShared(effectiveSkillName)
			if (!nameValidation.valid) {
				const errorMessage = this.getSkillNameErrorMessage(effectiveSkillName, nameValidation.error!)
				skillsLog.error(`Skill name "${effectiveSkillName}" is invalid: ${errorMessage}`)
				return
			}

			// Description constraints:
			// - 1-1024 chars
			// - non-empty (after trimming)
			const description = frontmatter.description.trim()
			if (description.length < 1 || description.length > 1024) {
				skillsLog.error(
					`Skill "${effectiveSkillName}" has an invalid description length: must be 1-1024 characters (got ${description.length})`,
				)
				return
			}

			// Parse modeSlugs from frontmatter (new format) or fall back to directory-based mode
			// Priority: frontmatter.modeSlugs > frontmatter.mode > directory mode
			let modeSlugs: string[] | undefined
			if (Array.isArray(frontmatter.modeSlugs)) {
				modeSlugs = frontmatter.modeSlugs.filter((s: unknown) => typeof s === "string" && s.length > 0)
				if (modeSlugs.length === 0) {
					modeSlugs = undefined // Empty array means "any mode"
				}
			} else if (typeof frontmatter.mode === "string" && frontmatter.mode.length > 0) {
				// Legacy single mode in frontmatter
				modeSlugs = [frontmatter.mode]
			} else if (mode) {
				// Fall back to directory-based mode (skills-{mode}/)
				modeSlugs = [mode]
			}

			// Create unique key combining name, source, and modeSlugs for override resolution
			// For backward compatibility, use first mode slug or undefined for the key
			const primaryMode = modeSlugs?.[0]
			const skillKey = this.getSkillKey(effectiveSkillName, source, primaryMode, pluginName)

			const metadata: SkillMetadata = {
				name: effectiveSkillName,
				description,
				path: skillMdPath,
				source,
				pluginName, // Set only for plugin-contributed skills (attribution)
				// Private plugin skills: invocable by qualified name, hidden from
				// user-facing enumerations (owner directive #4).
				private: source === "plugin" && privateNames.includes(effectiveSkillName) ? true : undefined,
				mode: primaryMode, // Deprecated: kept for backward compatibility
				modeSlugs, // New: array of mode slugs, undefined = any mode
			}
			this.skills.set(skillKey, metadata)
			if (org) {
				// Remembered separately so enforceOrgSkillLocks can restore the
				// org version after a later-scanned scope replaces the same key.
				this.orgSkillEntries.set(skillKey, metadata)
			}
		} catch (error) {
			skillsLog.error(`Failed to load skill at ${skillDir}:`, error)
		}
	}

	/**
	 * Get skills **advertised** for the current mode — the list shown to the model
	 * (system-prompt skills section, skill tool) and to the user (slash-command
	 * menu). Excludes {@link SkillMetadata.private} skills (owner directive #4); those
	 * remain resolvable/invocable by qualified name via {@link getSkillContent}.
	 *
	 * @param currentMode - The current mode slug (e.g., 'code', 'architect')
	 */
	getSkillsForMode(currentMode: string): SkillMetadata[] {
		return this.resolveSkillsForMode(currentMode, false)
	}

	/**
	 * Resolve the skills applicable to `currentMode`, keyed by each skill's
	 * **addressing identifier** ({@link qualifiedSkillName}): file skills by their bare
	 * name, plugin skills by `<pluginName>:<name>` (§14.7 → namespacing). This isolates
	 * plugin skills by construction — a plugin skill can never shadow a built-in/user
	 * skill or another plugin's skill. Within a single identifier, overrides resolve by
	 * {@link skillPrecedence} (project > global for files) with mode-specific > generic
	 * on a tie. `includePrivate` gates whether private skills participate: `false` for
	 * the advertised list, `true` for invocation-time resolution.
	 */
	private resolveSkillsForMode(currentMode: string, includePrivate: boolean): SkillMetadata[] {
		const resolvedSkills = new Map<string, SkillMetadata>()

		for (const skill of this.skills.values()) {
			if (skill.private && !includePrivate) continue

			// Check if skill is available in current mode:
			// - modeSlugs undefined or empty = available in all modes ("Any mode")
			// - modeSlugs array with values = available only if currentMode is in the array
			const isAvailableInMode = this.isSkillAvailableInMode(skill, currentMode)
			if (!isAvailableInMode) continue

			const key = qualifiedSkillName(skill)
			const existingSkill = resolvedSkills.get(key)

			if (!existingSkill) {
				resolvedSkills.set(key, skill)
				continue
			}

			// Apply override rules
			const shouldOverride = this.shouldOverrideSkill(existingSkill, skill)
			if (shouldOverride) {
				resolvedSkills.set(key, skill)
			}
		}

		return Array.from(resolvedSkills.values())
	}

	/**
	 * Check if a skill is available in the given mode.
	 * - modeSlugs undefined or empty = available in all modes ("Any mode")
	 * - modeSlugs with values = available only if mode is in the array
	 */
	private isSkillAvailableInMode(skill: SkillMetadata, currentMode: string): boolean {
		// No mode restrictions = available in all modes
		if (!skill.modeSlugs || skill.modeSlugs.length === 0) {
			return true
		}
		// Check if current mode is in the allowed modes
		return skill.modeSlugs.includes(currentMode)
	}

	/**
	 * Resolution precedence for a skill within a single addressing identifier. Higher
	 * wins. Because plugin skills are namespaced ({@link qualifiedSkillName}), a plugin
	 * entry is only ever compared against another entry of the *same* plugin+name, so
	 * cross-plugin/plugin-vs-file precedence is moot (they resolve under distinct
	 * keys). File skills keep the established chain: project > global.
	 */
	private skillPrecedence(skill: SkillMetadata): number {
		if (skill.source === "plugin") return 3
		if (skill.source === "project") return 2
		return 1 // global
	}

	/**
	 * Determine if newSkill should override existingSkill. Higher {@link skillPrecedence}
	 * wins (project > global for files). On a tie, mode-specific overrides generic,
	 * else the first-seen wins.
	 */
	private shouldOverrideSkill(existing: SkillMetadata, newSkill: SkillMetadata): boolean {
		const existingPriority = this.skillPrecedence(existing)
		const newPriority = this.skillPrecedence(newSkill)

		// Higher precedence always wins
		if (newPriority > existingPriority) return true
		if (newPriority < existingPriority) return false

		// Tie: mode-specific overrides generic
		// A skill with modeSlugs (restricted) is more specific than one without (any mode)
		const existingHasModes = existing.modeSlugs && existing.modeSlugs.length > 0
		const newHasModes = newSkill.modeSlugs && newSkill.modeSlugs.length > 0
		if (newHasModes && !existingHasModes) return true
		if (!newHasModes && existingHasModes) return false

		// Same precedence and same mode-specificity: keep existing (first wins)
		return false
	}

	/**
	 * Get all skills (for UI display, debugging, etc.)
	 */
	getAllSkills(): SkillMetadata[] {
		return Array.from(this.skills.values())
	}

	async getSkillContent(name: string, currentMode?: string): Promise<SkillContent | null> {
		// If mode is provided, try to find the best matching skill
		let skill: SkillMetadata | undefined

		// Skills are addressed by their qualified identifier: a bare name for file
		// skills, `<pluginName>:<name>` for plugin skills (§14.7 → namespacing).
		// Invocation resolution includes private skills (hidden from listings, but
		// still callable by qualified name — owner directive #4).
		if (currentMode) {
			const modeSkills = this.resolveSkillsForMode(currentMode, true)
			skill = modeSkills.find((s) => qualifiedSkillName(s) === name)
		} else {
			// Fall back to any skill with this addressing identifier
			skill = Array.from(this.skills.values()).find((s) => qualifiedSkillName(s) === name)
		}

		if (!skill) return null

		// Read skill content from disk. Guard the read+parse so a file that was
		// deleted/moved between discovery and now (TOCTOU) — or a SKILL.md that
		// became unparseable — yields the documented `null` instead of throwing.
		// Callers (skillInvocation, mentions) rely on the `| null` contract.
		try {
			const fileContent = await fs.readFile(skill.path, "utf-8")
			const { content: body } = matter(fileContent)

			return {
				...skill,
				instructions: body.trim(),
			}
		} catch (error) {
			skillsLog.error(`Failed to read skill content for "${name}" at ${skill.path}:`, error)
			return null
		}
	}

	/**
	 * Get all skills metadata (for UI display). Returns skills from all sources
	 * without content, **excluding** private plugin skills — this is a user-facing
	 * enumeration (the skills UI list), so private skills stay hidden here (they
	 * remain invocable by qualified name via {@link getSkillContent}).
	 */
	getSkillsMetadata(): SkillMetadata[] {
		return this.getAllSkills().filter((s) => !s.private)
	}

	/**
	 * Get a skill by name, source, and optionally mode
	 */
	getSkill(name: string, source: "global" | "project", mode?: string): SkillMetadata | undefined {
		const skillKey = this.getSkillKey(name, source, mode)
		return this.skills.get(skillKey)
	}

	/**
	 * Find a skill by name and source (regardless of mode).
	 * Useful for opening/editing skills where the exact mode key may vary.
	 */
	findSkillByNameAndSource(name: string, source: "global" | "project"): SkillMetadata | undefined {
		for (const skill of this.skills.values()) {
			if (skill.name === name && skill.source === source) {
				return skill
			}
		}
		return undefined
	}

	/**
	 * Validate skill name per agentskills.io spec using shared validation.
	 * Converts error codes to user-friendly error messages.
	 */
	private validateSkillName(name: string): { valid: boolean; error?: string } {
		const result = validateSkillNameShared(name)
		if (!result.valid) {
			return { valid: false, error: this.getSkillNameErrorMessage(name, result.error!) }
		}
		return { valid: true }
	}

	/**
	 * Convert skill name validation error code to a user-friendly error message.
	 */
	private getSkillNameErrorMessage(name: string, error: SkillNameValidationError): string {
		switch (error) {
			case SkillNameValidationError.Empty:
				return t("skills:errors.name_length", { maxLength: SKILL_NAME_MAX_LENGTH, length: name.length })
			case SkillNameValidationError.TooLong:
				return t("skills:errors.name_length", { maxLength: SKILL_NAME_MAX_LENGTH, length: name.length })
			case SkillNameValidationError.InvalidFormat:
				return t("skills:errors.name_format")
		}
	}

	/**
	 * Create a new skill
	 * @param name - Skill name (must be valid per agentskills.io spec)
	 * @param source - "global" or "project"
	 * @param description - Skill description
	 * @param modeSlugs - Optional mode restrictions (undefined/empty = any mode)
	 * @returns Path to created SKILL.md file
	 */
	async createSkill(
		name: string,
		source: "global" | "project",
		description: string,
		modeSlugs?: string[],
	): Promise<string> {
		// Validate skill name
		const validation = this.validateSkillName(name)
		if (!validation.valid) {
			throw new Error(validation.error)
		}

		// A locked org skill cannot be shadowed by creating a same-name skill in
		// a writable scope — the org version would win anyway; refuse loudly.
		this.assertSkillNotLocked(name)

		// Validate description
		const trimmedDescription = description.trim()
		if (trimmedDescription.length < 1 || trimmedDescription.length > 1024) {
			throw new Error(t("skills:errors.description_length", { length: trimmedDescription.length }))
		}

		// Determine base directory
		let baseDir: string
		if (source === "global") {
			baseDir = getGlobalShoferDirectory()
		} else {
			const provider = this.providerRef.deref()
			if (!provider?.cwd) {
				throw new Error(t("skills:errors.no_workspace"))
			}
			baseDir = path.join(provider.cwd, ".shofer")
		}

		// Always use the generic skills directory (mode info stored in frontmatter now)
		const skillsDir = path.join(baseDir, "skills")
		const skillDir = path.join(skillsDir, name)
		const skillMdPath = path.join(skillDir, "SKILL.md")

		// Check if skill already exists
		if (await fileExists(skillMdPath)) {
			throw new Error(t("skills:errors.already_exists", { name, path: skillMdPath }))
		}

		// Create the skill directory
		await fs.mkdir(skillDir, { recursive: true })

		// Generate SKILL.md content with frontmatter
		const titleName = name
			.split("-")
			.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
			.join(" ")

		// Build frontmatter with optional modeSlugs
		const frontmatterLines = [`name: ${name}`, `description: ${trimmedDescription}`]
		if (modeSlugs && modeSlugs.length > 0) {
			frontmatterLines.push(`modeSlugs:`)
			for (const slug of modeSlugs) {
				frontmatterLines.push(`  - ${slug}`)
			}
		}

		const skillContent = `---
${frontmatterLines.join("\n")}
---

# ${titleName}

## Instructions

Add your skill instructions here.
`

		// Write the SKILL.md file
		await fs.writeFile(skillMdPath, skillContent, "utf-8")

		// Refresh skills list
		await this.discoverSkills()

		return skillMdPath
	}

	/**
	 * Delete a skill
	 * @param name - Skill name to delete
	 * @param source - Where the skill is located
	 * @param mode - Optional mode (to locate in skills-{mode}/ directory)
	 */
	async deleteSkill(name: string, source: "global" | "project", mode?: string): Promise<void> {
		this.assertSkillNotLocked(name)
		// Find the skill
		const skill = this.getSkill(name, source, mode)
		if (!skill) {
			const modeInfo = mode ? ` (mode: ${mode})` : ""
			throw new Error(t("skills:errors.not_found", { name, source, modeInfo }))
		}

		// Get the skill directory (parent of SKILL.md)
		const skillDir = path.dirname(skill.path)

		// Delete the entire skill directory
		await fs.rm(skillDir, { recursive: true, force: true })

		// Refresh skills list
		await this.discoverSkills()
	}

	/**
	 * Move a skill to a different mode
	 * @param name - Skill name to move
	 * @param source - Where the skill is located ("global" or "project")
	 * @param currentMode - Current mode (undefined for generic skills)
	 * @param newMode - Target mode (undefined for generic skills)
	 */
	async moveSkill(
		name: string,
		source: "global" | "project",
		currentMode: string | undefined,
		newMode: string | undefined,
	): Promise<void> {
		this.assertSkillNotLocked(name)
		// Don't move if source and destination are the same
		if (currentMode === newMode) {
			return
		}

		// Find the skill at its current location
		const skill = this.getSkill(name, source, currentMode)
		if (!skill) {
			const modeInfo = currentMode ? ` (mode: ${currentMode})` : ""
			throw new Error(t("skills:errors.not_found", { name, source, modeInfo }))
		}

		// Determine base directory
		let baseDir: string
		if (source === "global") {
			baseDir = getGlobalShoferDirectory()
		} else {
			const provider = this.providerRef.deref()
			if (!provider?.cwd) {
				throw new Error(t("skills:errors.no_workspace"))
			}
			baseDir = path.join(provider.cwd, ".shofer")
		}

		// Determine source and destination directories
		const sourceDirName = currentMode ? `skills-${currentMode}` : "skills"
		const destDirName = newMode ? `skills-${newMode}` : "skills"
		const sourceDir = path.join(baseDir, sourceDirName, name)
		const destSkillsDir = path.join(baseDir, destDirName)
		const destDir = path.join(destSkillsDir, name)
		const destSkillMdPath = path.join(destDir, "SKILL.md")

		// Check if skill already exists at destination
		if (await fileExists(destSkillMdPath)) {
			throw new Error(t("skills:errors.already_exists", { name, path: destSkillMdPath }))
		}

		// Ensure destination skills directory exists
		await fs.mkdir(destSkillsDir, { recursive: true })

		// Move the skill directory
		await fs.rename(sourceDir, destDir)

		// Clean up empty source skills directory
		const sourceSkillsDir = path.join(baseDir, sourceDirName)
		try {
			const entries = await fs.readdir(sourceSkillsDir)
			if (entries.length === 0) {
				await fs.rmdir(sourceSkillsDir)
			}
		} catch {
			// Ignore errors - directory might not exist or have permission issues
		}

		// Refresh skills list
		await this.discoverSkills()
	}

	/**
	 * Update the mode associations for a skill by modifying its SKILL.md frontmatter.
	 * @param name - Skill name
	 * @param source - Where the skill is located ("global" or "project")
	 * @param newModeSlugs - New mode slugs (undefined/empty = any mode)
	 */
	async updateSkillModes(name: string, source: "global" | "project", newModeSlugs?: string[]): Promise<void> {
		// Find any skill with this name and source (regardless of current mode)
		let skill: SkillMetadata | undefined
		for (const s of this.skills.values()) {
			if (s.name === name && s.source === source) {
				skill = s
				break
			}
		}

		if (!skill) {
			throw new Error(t("skills:errors.not_found", { name, source, modeInfo: "" }))
		}

		// Read the current SKILL.md file
		const fileContent = await fs.readFile(skill.path, "utf-8")
		const { data: frontmatter, content: body } = matter(fileContent)

		// Update the frontmatter with new modeSlugs
		if (newModeSlugs && newModeSlugs.length > 0) {
			frontmatter.modeSlugs = newModeSlugs
			// Remove legacy mode field if present
			delete frontmatter.mode
		} else {
			// Empty/undefined = any mode, remove mode restrictions
			delete frontmatter.modeSlugs
			delete frontmatter.mode
		}

		// Serialize back to SKILL.md format
		const newContent = matter.stringify(body, frontmatter)
		await fs.writeFile(skill.path, newContent, "utf-8")

		// Refresh skills list
		await this.discoverSkills()
	}

	/**
	 * Get all skills directories to scan, including mode-specific directories.
	 */
	private async getSkillsDirectories(): Promise<
		Array<{
			dir: string
			source: "global" | "project" | "plugin"
			mode?: string
			pluginName?: string
			privateNames?: string[]
			org?: boolean
		}>
	> {
		const dirs: Array<{
			dir: string
			source: "global" | "project" | "plugin"
			mode?: string
			pluginName?: string
			privateNames?: string[]
			/** True for the org-global scope's dirs (the lock authority). */
			org?: boolean
		}> = []
		const globalShoferDir = getGlobalShoferDirectory()
		const globalAgentsDir = getGlobalAgentsDirectory()
		const provider = this.providerRef.deref()
		const projectRooDir = provider?.cwd ? path.join(provider.cwd, ".shofer") : null
		const projectAgentsDir = provider?.cwd ? getProjectAgentsDirectoryForCwd(provider.cwd) : null

		// Get list of modes to check for mode-specific skills
		const modesList = await this.getAvailableModes()

		// Priority rules for skills with the same name:
		// 1. Source level: project > global (handled by shouldOverrideSkill in getSkillsForMode)
		// 2. Within the same source level: later-processed directories override earlier ones
		//    (via Map.set replacement during discovery - same source+mode+name key gets replaced)
		//
		// Processing order (later directories override earlier ones at the same source level):
		// - Global: .agents/skills first, then .shofer/skills (so .shofer wins)
		// - Project: .agents/skills first, then .shofer/skills (so .shofer wins)

		// Global .agents directories (lowest priority - shared across agents)
		dirs.push({ dir: path.join(globalAgentsDir, "skills"), source: "global" })
		for (const mode of modesList) {
			dirs.push({ dir: path.join(globalAgentsDir, `skills-${mode}`), source: "global", mode })
		}

		// Project .agents directories
		if (projectAgentsDir) {
			dirs.push({ dir: path.join(projectAgentsDir, "skills"), source: "project" })
			for (const mode of modesList) {
				dirs.push({ dir: path.join(projectAgentsDir, `skills-${mode}`), source: "project", mode })
			}
		}

		// Org-global .shofer directories (below the user scope: later dirs override)
		const orgShoferDir = getOrgShoferDirectory()
		if (orgShoferDir) {
			dirs.push({ dir: path.join(orgShoferDir, "skills"), source: "global", org: true })
			for (const mode of modesList) {
				dirs.push({ dir: path.join(orgShoferDir, `skills-${mode}`), source: "global", mode, org: true })
			}
		}

		// User-scope .shofer directories (Shofer-specific, higher priority than .agents)
		dirs.push({ dir: path.join(globalShoferDir, "skills"), source: "global" })
		for (const mode of modesList) {
			dirs.push({ dir: path.join(globalShoferDir, `skills-${mode}`), source: "global", mode })
		}

		// Project .shofer directories (highest priority among file sources)
		if (projectRooDir) {
			dirs.push({ dir: path.join(projectRooDir, "skills"), source: "project" })
			for (const mode of modesList) {
				dirs.push({ dir: path.join(projectRooDir, `skills-${mode}`), source: "project", mode })
			}
		}

		// Plugin-contributed skills (design §6.4 — highest precedence). Each enabled
		// plugin ships a `<root>/skills/` directory scanned like any other; mode
		// scoping comes from each SKILL.md's frontmatter. Empty when no plugin
		// manager is wired or no plugins are enabled ⇒ behavior unchanged.
		const pluginManager = getSharedPluginManager()
		if (pluginManager) {
			for (const { pluginName, dir, privateNames } of pluginManager.getContributedSkillDirs()) {
				dirs.push({ dir, source: "plugin", pluginName, privateNames: privateNames ?? [] })
			}
		}

		return dirs
	}

	/**
	 * Slugs of every mode available here — the user's, the project's, and the
	 * plugin-contributed ones (Shofer's own six included). Empty when there is no
	 * provider to ask: mode-specific skill directories are then simply not watched,
	 * rather than watched for a mode set that may not exist.
	 */
	private async getAvailableModes(): Promise<string[]> {
		const provider = this.providerRef.deref()
		if (!provider) {
			return []
		}

		try {
			const customModes = await provider.customModesManager.getCustomModes()
			return getAllModes(customModes).map((m) => m.slug)
		} catch {
			return []
		}
	}

	private getSkillKey(name: string, source: string, mode?: string, pluginName?: string): string {
		// Plugin skills include the plugin name so two plugins can each ship a
		// same-named skill without their discovery keys colliding.
		const scope = source === "plugin" && pluginName ? `plugin:${pluginName}` : source
		return `${scope}:${mode || "generic"}:${name}`
	}

	private async setupFileWatchers(): Promise<void> {
		// Skip if test environment is detected or VSCode APIs are not available
		if (process.env.NODE_ENV === "test" || !vscode.workspace.createFileSystemWatcher) {
			return
		}

		const provider = this.providerRef.deref()
		if (!provider?.cwd) return

		// Watch for changes in skills directories
		const globalShoferDir = getGlobalShoferDirectory()
		const globalAgentsDir = getGlobalAgentsDirectory()
		const projectRooDir = path.join(provider.cwd, ".shofer")
		const projectAgentsDir = getProjectAgentsDirectoryForCwd(provider.cwd)

		// Watch global .shofer skills directory
		this.watchDirectory(path.join(globalShoferDir, "skills"))

		// Watch global .agents skills directory
		this.watchDirectory(path.join(globalAgentsDir, "skills"))

		// Watch project .shofer skills directory
		this.watchDirectory(path.join(projectRooDir, "skills"))

		// Watch project .agents skills directory
		this.watchDirectory(path.join(projectAgentsDir, "skills"))

		// Watch mode-specific directories for all available modes
		const modesList = await this.getAvailableModes()
		for (const mode of modesList) {
			// .shofer mode-specific
			this.watchDirectory(path.join(globalShoferDir, `skills-${mode}`))
			this.watchDirectory(path.join(projectRooDir, `skills-${mode}`))
			// .agents mode-specific
			this.watchDirectory(path.join(globalAgentsDir, `skills-${mode}`))
			this.watchDirectory(path.join(projectAgentsDir, `skills-${mode}`))
		}
	}

	private watchDirectory(dirPath: string): void {
		if (process.env.NODE_ENV === "test" || !vscode.workspace.createFileSystemWatcher) {
			return
		}

		const pattern = new vscode.RelativePattern(dirPath, "**/SKILL.md")
		const watcher = vscode.workspace.createFileSystemWatcher(pattern)

		watcher.onDidChange(async (uri) => {
			if (this.isDisposed) return
			await this.discoverSkills()
		})

		watcher.onDidCreate(async (uri) => {
			if (this.isDisposed) return
			await this.discoverSkills()
		})

		watcher.onDidDelete(async (uri) => {
			if (this.isDisposed) return
			await this.discoverSkills()
		})

		this.disposables.push(watcher)
	}

	async dispose(): Promise<void> {
		this.isDisposed = true
		this.disposables.forEach((d) => d.dispose())
		this.disposables = []
		this.skills.clear()
	}
}
