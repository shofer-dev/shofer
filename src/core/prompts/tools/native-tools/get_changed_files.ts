import type OpenAI from "openai"

const GET_CHANGED_FILES_DESCRIPTION = `Request the list of files that Shofer has changed during the current task, along with the number of inserted and deleted lines per file.

Source of truth is Shofer's internal tracking for the current session:
- The shadow-git checkpoint repository (when checkpoints are enabled), which provides authoritative line-level insertion/deletion counts versus the task's base commit.
- The internal file context tracker, which records every file Shofer has edited even when checkpoints are disabled.

Files known only to the tracker are reported with unknown line counts. The tool takes no parameters.

Example:
{ }`

export default {
	type: "function",
	function: {
		name: "get_changed_files",
		description: GET_CHANGED_FILES_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {},
			required: [],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
