import type OpenAI from "openai"

const SED_DESCRIPTION = `Request to perform regex find-and-replace on a workspace file using JavaScript's String.replace() with a RegExp pattern. If the regex produces zero matches and the pattern contains regex metacharacters (* . + ? etc.), the tool automatically retries with all metacharacters escaped as a literal string — so you can write patterns like "**Bold text**" without escaping. IMPORTANT: The '.' character in regex matches ANY character (letter, slash, punctuation, etc.), not just a literal period. To match a literal dot/period, use \\. or [.]. This is the most common source of unexpected matches.

CRITICAL: Characters with special regex meaning — | . * + ? ( ) [ ] { } ^ $ \\ — MUST be escaped with a backslash when you intend to match them literally. The | character is the alternation (OR) operator: a pattern like "| column |" is parsed as (empty) OR " column " OR (empty), which matches every single character boundary in the file (catastrophic!). To match a literal pipe, use \\| or [|]. Likewise, to match a literal period use \\., to match literal parentheses use \\( and \\), etc. If you are searching for markdown table rows or any text containing pipes, ALWAYS escape them.

Parameters:
- path: (required) The path of the file to modify, relative to the workspace
- pattern: (required) The regex pattern to search for (JavaScript RegExp syntax). If it contains special characters and produces zero matches as a regex, the tool falls back to a literal search automatically. IMPORTANT: Characters like | . * + ? ( ) [ ] { } ^ $ \\ are regex metacharacters. Escape them with \\ to match literally: \\| for pipe, \\. for dot, \\* for asterisk, etc.
- replacement: (required) The replacement string. Supports capture group backreferences ($1, $2, etc.). For a multiline replacement, send a JSON string containing a \\n escape — it is decoded to a real newline before the substitution runs.
- global: (optional) Whether to replace all occurrences (default: true)

Example: Replace all occurrences of "foo" with "bar" in a file
{ "path": "src/app.ts", "pattern": "foo", "replacement": "bar" }

Example: Replace with capture groups
{ "path": "src/app.ts", "pattern": "import (.+) from '(.+)'", "replacement": "import $1 from '$2'" }

Example: Single (non-global) replacement
{ "path": "src/app.ts", "pattern": "TODO", "replacement": "DONE", "global": false }

Example: Escape pipes in a markdown table row (\\| escapes the literal pipe character)
{ "path": "README.md", "pattern": "\\| Resized to 128×128 \\| — consider resizing \\|", "replacement": "\\| Resized to 128×128 \\|" }`

const PATH_PARAMETER_DESCRIPTION = `The path of the file to modify, relative to the workspace`
const PATTERN_PARAMETER_DESCRIPTION = `The regex pattern to search for (JavaScript RegExp syntax). Escape regex metacharacters (| . * + ? ( ) [ ] { } ^ $ \\) with backslash to match them literally: \\| for pipe, \\. for dot, \\* for asterisk, etc. The | character is the alternation (OR) operator — "| text |" matches every character boundary! Always escape pipes in markdown table content. If the pattern contains metacharacters and produces zero matches as a regex, the tool automatically falls back to a literal search.`
const REPLACEMENT_PARAMETER_DESCRIPTION = `The replacement string. Supports capture group backreferences ($1, $2, etc.).`
const GLOBAL_PARAMETER_DESCRIPTION = `Whether to replace all occurrences (default: true)`

export default {
	type: "function",
	function: {
		name: "sed",
		description: SED_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: PATH_PARAMETER_DESCRIPTION,
				},
				pattern: {
					type: "string",
					description: PATTERN_PARAMETER_DESCRIPTION,
				},
				replacement: {
					type: "string",
					description: REPLACEMENT_PARAMETER_DESCRIPTION,
				},
				global: {
					type: ["boolean", "null"],
					description: GLOBAL_PARAMETER_DESCRIPTION,
				},
			},
			required: ["path", "pattern", "replacement", "global"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
