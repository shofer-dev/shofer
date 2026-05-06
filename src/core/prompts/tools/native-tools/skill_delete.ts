import type OpenAI from "openai"

const SKILL_DELETE_DESCRIPTION = `Delete an existing project skill by removing the entire \`.roo/skills/<slug>/\` directory.

This is destructive and irreversible. Use only when explicitly asked to remove a skill or when superseding it with a different one.

The \`skill\` parameter must be the slug (the directory name under \`.roo/skills/\`).`

const SKILL_PARAMETER_DESCRIPTION = `Slug of the project skill to delete (parent directory name under .roo/skills/).`

export default {
	type: "function",
	function: {
		name: "skill_delete",
		description: SKILL_DELETE_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				skill: {
					type: "string",
					description: SKILL_PARAMETER_DESCRIPTION,
				},
			},
			required: ["skill"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
