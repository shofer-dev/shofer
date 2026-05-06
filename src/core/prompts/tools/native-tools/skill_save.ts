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

REQUIRED FRONTMATTER FORMAT — every SKILL.md must begin with a YAML frontmatter block (delimited by \`---\` lines) containing AT MINIMUM these two fields:
  - \`name\`: must equal the skill slug exactly (the \`skill\` argument and the parent directory name). Skills whose \`name\` does not match the slug are silently rejected by the loader and will NOT appear in the skill list.
  - \`description\`: 1–1024 character single-line summary of what the skill does and when to use it.
Optional fields (\`modeSlugs\`, \`mode\`, etc.) may follow. Any other fields are ignored.

Example of a minimal valid SKILL.md body:

---
name: my-skill
description: Short summary of what this skill does and when to invoke it.
---

# My Skill

Instructions go here.

The tool validates the resulting file (for mode=replace, mode=append when creating a new file, and mode=patch) and returns an error if the frontmatter is missing or malformed. Fix the error and retry rather than working around it.`

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
