import type OpenAI from "openai"

const APPLY_DIFF_DESCRIPTION = `Apply precise, targeted modifications to an existing file using one or more search/replace blocks. This tool is for surgical edits only; the SEARCH content is matched via normalized Levenshtein distance (default threshold: 100%, meaning exact match). Use read_file to get the current file content before crafting SEARCH blocks — stale line numbers are the #1 cause of failures. Include all independent changes in ONE apply_diff call with multiple SEARCH/REPLACE blocks. Each block is matched independently — the engine searches around :start_line: and adjusts for prior diffs within the call. Use the ORIGINAL line numbers from before any edits.

CRITICAL: If the SEARCH or REPLACE content contains lines that look like diff markers (=======, <<<<<<<, >>>>>>>), you MUST prepend a backslash (\\) at the beginning of those lines to escape them. The parser treats unescaped markers as block delimiters. The tool will produce a clear error message if markers are not escaped, showing you exactly which markers need escaping.`

const DIFF_PARAMETER_DESCRIPTION = `A string containing one or more search/replace blocks defining the changes. Each block's ':start_line:' is a HINT (not required to match exactly — the engine searches around that line) indicating where the SEARCH content originally appeared. This is NOT the line number where replacement will be inserted. CRITICAL: Include all your changes in ONE apply_diff call with multiple blocks — each block is matched independently using its own :start_line: hint. Use the ORIGINAL line numbers from before any edits; the engine searches around each hint. You must not add a start line for the replacement content. If content lines within SEARCH or REPLACE look like diff markers (=======, <<<<<<<, >>>>>>>), prepend a backslash (e.g., \\=======). Each block must follow this format:
<<<<<<< SEARCH
:start_line:[line_number]
-------
[exact content to find]
=======
[new content to replace with]
>>>>>>> REPLACE`

export const apply_diff = {
	type: "function",
	function: {
		name: "apply_diff",
		description: APPLY_DIFF_DESCRIPTION,
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "The path of the file to modify, relative to the current workspace directory.",
				},
				diff: {
					type: "string",
					description: DIFF_PARAMETER_DESCRIPTION,
				},
			},
			required: ["path", "diff"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
