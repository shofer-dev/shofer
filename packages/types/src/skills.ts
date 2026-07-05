/**
 * Skill metadata for discovery (loaded at startup)
 * Only name and description are required for now
 */
export interface SkillMetadata {
	name: string // Required: skill identifier
	description: string // Required: when to use this skill
	path: string // Absolute path to SKILL.md
	source: "global" | "project" | "plugin" // Where the skill was discovered
	/** When source === "plugin", the contributing plugin's name (attribution). */
	pluginName?: string
	/**
	 * @deprecated Use modeSlugs instead. Kept for backward compatibility.
	 * If set, skill is only available in this mode.
	 */
	mode?: string
	/**
	 * Mode slugs where this skill is available.
	 * - undefined or empty array means the skill is available in all modes ("Any mode").
	 * - An array with one or more mode slugs restricts the skill to those modes.
	 */
	modeSlugs?: string[]
}

/**
 * Full skill content (loaded on activation)
 */
export interface SkillContent extends SkillMetadata {
	instructions: string // Full markdown body
}

/**
 * The **addressing identifier** a skill resolves and is invoked under. File
 * skills (global/project) keep their bare on-disk `name`. Plugin-contributed
 * skills are **namespaced** as `<pluginName>:<name>` (design §14.7 →
 * namespacing) so a plugin skill can never shadow a built-in/user skill or
 * another plugin's skill by construction. The on-disk directory name and the
 * SKILL.md frontmatter `name` stay spec-compliant (no `:`); the qualification
 * lives purely at this resolution/addressing layer — `pluginName` already
 * carries attribution.
 */
export function qualifiedSkillName(skill: Pick<SkillMetadata, "name" | "source" | "pluginName">): string {
	return skill.source === "plugin" && skill.pluginName ? `${skill.pluginName}:${skill.name}` : skill.name
}

/**
 * Skill name validation constants per agentskills.io specification:
 * https://agentskills.io/specification
 *
 * Name constraints:
 * - 1-64 characters
 * - Lowercase letters, numbers, and hyphens only
 * - Must not start or end with a hyphen
 * - Must not contain consecutive hyphens
 */
export const SKILL_NAME_MIN_LENGTH = 1
export const SKILL_NAME_MAX_LENGTH = 64

/**
 * Regex pattern for valid skill names.
 * Matches: lowercase letters/numbers, optionally followed by groups of hyphen + lowercase letters/numbers.
 * This ensures no leading/trailing hyphens and no consecutive hyphens.
 */
export const SKILL_NAME_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Error codes for skill name validation.
 * These can be mapped to translation keys in the frontend or error messages in the backend.
 */
export enum SkillNameValidationError {
	Empty = "empty",
	TooLong = "too_long",
	InvalidFormat = "invalid_format",
}

/**
 * Result of skill name validation.
 */
export interface SkillNameValidationResult {
	valid: boolean
	error?: SkillNameValidationError
}

/**
 * Validate a skill name according to agentskills.io specification.
 *
 * @param name - The skill name to validate
 * @returns Validation result with error code if invalid
 */
export function validateSkillName(name: string): SkillNameValidationResult {
	if (!name || name.length < SKILL_NAME_MIN_LENGTH) {
		return { valid: false, error: SkillNameValidationError.Empty }
	}

	if (name.length > SKILL_NAME_MAX_LENGTH) {
		return { valid: false, error: SkillNameValidationError.TooLong }
	}

	if (!SKILL_NAME_REGEX.test(name)) {
		return { valid: false, error: SkillNameValidationError.InvalidFormat }
	}

	return { valid: true }
}
