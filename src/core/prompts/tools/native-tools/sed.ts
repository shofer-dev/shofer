import type OpenAI from "openai"

const SED_DESCRIPTION = `Request to perform regex find-and-replace on a workspace file, similar to \`sed 's/pattern/replacement/g'\`.

Parameters:
- path: (required) The path of the file to modify, relative to the workspace
- pattern: (required) The regex pattern to search for (JavaScript RegExp syntax)
- replacement: (required) The replacement string. Supports capture group backreferences ($1, $2, etc.)
- global: (optional) Whether to replace all occurrences (default: true)

Example: Replace all occurrences of "foo" with "bar" in a file
{ "path": "src/app.ts", "pattern": "foo", "replacement": "bar" }

Example: Replace with capture groups
{ "path": "src/app.ts", "pattern": "import (.+) from '(.+)'", "replacement": "import $1 from '$2'" }

Example: Single (non-global) replacement
{ "path": "src/app.ts", "pattern": "TODO", "replacement": "DONE", "global": false }`

const PATH_PARAMETER_DESCRIPTION = `The path of the file to modify, relative to the workspace`
const PATTERN_PARAMETER_DESCRIPTION = `The regex pattern to search for (JavaScript RegExp syntax)`
const REPLACEMENT_PARAMETER_DESCRIPTION = `The replacement string. Supports capture group backreferences ($1, $2, etc.)`
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
