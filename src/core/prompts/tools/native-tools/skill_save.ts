import type OpenAI from "openai"

/**
 * Tool schema for saving (creating or updating) a project skill.
 *
 * Skills live at `<project>/.roo/skills/<slug>/SKILL.md`. This tool lets the
 * agent persist the SKILL.md body in one of three modes:
 *
 *   replace — overwrite the entire file with `content`. Creates the skill
 *             (and its directory) if it doesn't exist yet. This is the
 *             intended mode for authoring a new skill from scratch.
 *   append  — append `content` to the end of the file. Creates the skill
 *             with `content` as the initial body if it doesn't exist.
 *   patch   — replace `old_string` with `new_string` (must match exactly
 *             once). Requires the skill to already exist.
 */

const SKILL_SAVE_DESCRIPTION = `Create or update the SKILL.md body of a project skill at \`.roo/skills/<slug>/SKILL.md\`.

Modes:
- replace: overwrite the entire file with \`content\`. Creates the skill if it doesn't exist (use this to author a new skill).
- append:  append \`content\` to the end of the file. Creates the skill if it doesn't exist.
- patch:   replace \`old_string\` with \`new_string\` (must match exactly once). The skill must already exist.

When creating a new skill, prefer mode=replace and include YAML frontmatter (description, applyTo, …) at the top of \`content\` so the skill is discoverable by the \`skill\` tool.`

export default {
	type: "function",
	function: {
		name: "skill_save",
		description: SKILL_SAVE_DESCRIPTION,
		strict: false,
		parameters: {
			type: "object",
			properties: {
				skill: {
					type: "string",
					description: "Slug of the skill to save (parent directory name under .roo/skills/).",
				},
				mode: {
					type: "string",
					enum: ["replace", "append", "patch"],
					description: "Save mode: replace, append, or patch.",
				},
				content: {
					type: "string",
					description: "Required for mode=replace and mode=append. New file body or text to append.",
				},
				old_string: {
					type: "string",
					description: "Required for mode=patch. Exact substring to find in SKILL.md (must match once).",
				},
				new_string: {
					type: "string",
					description: "Required for mode=patch. Replacement string for old_string.",
				},
			},
			required: ["skill", "mode"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
