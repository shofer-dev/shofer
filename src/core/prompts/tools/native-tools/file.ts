import type OpenAI from "openai"

const FILE_TOOL_DESCRIPTION = `Filesystem operations on workspace files. Use this instead of \`execute_command\` with \`rm\`/\`mv\` so the operation is captured in the file-changes panel and is reversible.

Subcommands:
- \`rm\`: Delete a file (or directory when \`recursive=true\`).
- \`mv\`: Move/rename a file or directory. Requires \`destination\`.

Both subcommands operate relative to the workspace root and refuse paths that escape it.`

export default {
	type: "function",
	function: {
		name: "file",
		description: FILE_TOOL_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				subcommand: {
					type: "string",
					enum: ["rm", "mv"],
					description: "Operation to perform: 'rm' to delete, 'mv' to move/rename.",
				},
				path: {
					type: "string",
					description: "Source path relative to the workspace.",
				},
				destination: {
					type: ["string", "null"],
					description: "Destination path for 'mv'. Required for 'mv'; ignored for 'rm'.",
				},
				recursive: {
					type: ["boolean", "null"],
					description: "For 'rm' only: when true, recursively delete a directory. Default false.",
				},
			},
			required: ["subcommand", "path", "destination", "recursive"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
