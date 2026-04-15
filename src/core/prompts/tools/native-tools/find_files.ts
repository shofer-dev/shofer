import type OpenAI from "openai"

const FIND_FILES_DESCRIPTION = `Request to find files matching a glob pattern. This tool searches for files by name pattern across the workspace, useful for locating specific file types or files in specific directories.

Parameters:
- pattern: (required) The glob pattern to match files (e.g., '*.ts', '**/*.json', 'src/**/*.test.js')
- maxResults: (optional) Maximum number of results to return. Defaults to 100.

Example: Find all TypeScript files
{ "pattern": "**/*.ts" }

Example: Find all JSON files in config directory
{ "pattern": "config/**/*.json" }

Example: Find test files with limit
{ "pattern": "**/*.test.ts", "maxResults": 50 }`

const PATTERN_PARAMETER_DESCRIPTION = `Glob pattern to match files (e.g., '*.ts', '**/*.json')`

const MAX_RESULTS_PARAMETER_DESCRIPTION = `Maximum number of results to return (default: 100)`

export default {
	type: "function",
	function: {
		name: "find_files",
		description: FIND_FILES_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				pattern: {
					type: "string",
					description: PATTERN_PARAMETER_DESCRIPTION,
				},
				maxResults: {
					type: ["number", "null"],
					description: MAX_RESULTS_PARAMETER_DESCRIPTION,
				},
			},
			required: ["pattern", "maxResults"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
