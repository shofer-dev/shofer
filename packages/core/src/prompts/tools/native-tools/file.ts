import { parametersSchema as z } from "@shofer/types"

import { defineNativeTool } from "../../../tools/defineNativeTool.js"

const FILE_TOOL_DESCRIPTION = `Filesystem operations on workspace files. Use this instead of \`execute_command\` with \`rm\`/\`mv\` so the operation is captured in the file-changes panel and is reversible.

Subcommands:
- \`rm\`: Delete a file (or directory when \`recursive=true\`).
- \`mv\`: Move/rename a file or directory. Requires \`destination\`.

Both subcommands operate relative to the workspace root and refuse paths that escape it.`

export default defineNativeTool({
	name: "file",
	description: FILE_TOOL_DESCRIPTION,
	schema: z.object({
		subcommand: z.enum(["rm", "mv"]).describe("Operation to perform: 'rm' to delete, 'mv' to move/rename."),
		path: z.string().describe("Source path relative to the workspace."),
		destination: z.string().describe("Destination path for 'mv'. Required for 'mv'; ignored for 'rm'.").optional(),
		recursive: z
			.boolean()
			.describe("For 'rm' only: when true, recursively delete a directory. Default false.")
			.optional(),
	}),
})
