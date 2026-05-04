import type OpenAI from "openai"

/**
 * Tool schema for updating an existing project skill.
 *
 * Skills live at `<project>/.roo/skills/<slug>/SKILL.md`. This tool lets the
 * agent modify the SKILL.md body of an existing skill in one of three modes:
 *
 *   replace — overwrite the entire file with `content`
 *   append  — append `content` to the end of the file
 *   patch   — replace `old_string` with `new_string` (must match exactly once)
 *
 * The tool only operates on already-existing skills. Skill creation is handled
 * by the authoring pipeline (e.g. browser-tools observe-mode), not here.
 */

const SKILL_UPDATE_DESCRIPTION = `Update the SKILL.md body of an existing project skill at \`.roo/skills/<slug>/SKILL.md\`.

Modes:
- replace: overwrite the entire file with \`content\`.
- append:  append \`content\` to the end of the file.
- patch:   replace \`old_string\` with \`new_string\` (must match exactly once).

This tool only updates skills that already exist; it does not create new ones.`

export default {
	type: "function",
	function: {
		name: "skill_update",
		description: SKILL_UPDATE_DESCRIPTION,
		strict: false,
		parameters: {
			type: "object",
			properties: {
				skill: {
					type: "string",
					description: "Slug of the skill to update (parent directory name under .roo/skills/).",
				},
				mode: {
					type: "string",
					enum: ["replace", "append", "patch"],
					description: "Update mode: replace, append, or patch.",
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
