import type OpenAI from "openai"
import { outputLog } from "../../../../utils/outputChannelLogger"

const SEARCH_FILES_DESCRIPTION = `Request to perform a regex search across files in a specified directory, providing context-rich results. This tool searches for patterns or specific content across multiple files, displaying each match with encapsulating context.

Craft your regex patterns carefully to balance specificity and flexibility. Use this tool to find code patterns, TODO comments, function definitions, or any text-based information across the project. The results include surrounding context, so analyze the surrounding code to better understand the matches. Leverage this tool in combination with other tools for more comprehensive analysis.

Parameters:
- path: (required) The path of the directory to search in (relative to the current workspace directory). This directory will be recursively searched.
- query: (required) The search pattern (regex or literal text)
- fileTypes: (optional) Glob pattern to filter files (e.g., '*.ts', '**/*.go'). If not provided, it will search all files.
- excludePattern: (optional) Glob pattern to exclude files from search.
- isRegex: (optional) Whether the query is a regular expression. When false, query is matched literally. Defaults to true.
- caseSensitive: (optional) Case-sensitive matching. Defaults to false.
- wholeWord: (optional) Match whole words only (wraps query in \\b boundaries). Ignored when isRegex=true. Defaults to false.
- maxResults: (optional) Maximum total results across all files. Defaults to 100; silently capped at 1000.
- contextBefore: (optional) Lines of context to show before each match. Defaults to 1.
- contextAfter: (optional) Lines of context to show after each match. Defaults to 1.

Example: Searching for all .ts files in the current directory
{ "path": ".", "query": ".*", "fileTypes": "*.ts" }

Example: Searching for function definitions in JavaScript files
{ "path": "src", "query": "function\\s+\\w+", "fileTypes": "*.js" }

Example: Literal search for TODO with whole-word matching
{ "path": "src", "query": "TODO", "fileTypes": "*.ts", "isRegex": false, "caseSensitive": true, "wholeWord": true }

Example: Literal search with excludes
{ "path": "src", "query": "outputLog", "isRegex": false, "excludePattern": "**/*.test.ts" }

Example: Minimal search (all defaults)
{ "path": "src", "query": "authService" }`

const PATH_PARAMETER_DESCRIPTION = `Directory to search recursively, relative to the workspace`

const QUERY_PARAMETER_DESCRIPTION = `The search pattern (regex or literal text)`

const FILE_TYPES_PARAMETER_DESCRIPTION = `Glob pattern to filter files (e.g., '*.ts', '**/*.go'). null = all files.`

const EXCLUDE_PATTERN_PARAMETER_DESCRIPTION = `Glob pattern to exclude files (e.g., '**/node_modules/**'). null = no exclusions.`

const IS_REGEX_PARAMETER_DESCRIPTION = `Whether query is a regular expression (default: true)`

const CASE_SENSITIVE_PARAMETER_DESCRIPTION = `Case-sensitive matching (default: false)`

const WHOLE_WORD_PARAMETER_DESCRIPTION = `Match whole words only by wrapping the query in \\b word boundary anchors (default: false). Ignored when isRegex=true.`

const MAX_RESULTS_PARAMETER_DESCRIPTION = `Maximum total results across all files (default 100, silently clamped to 1000). Raise only when you need exhaustive coverage — narrowing the query is usually cheaper.`

const CONTEXT_BEFORE_PARAMETER_DESCRIPTION = `Lines of context to show before each match (default: 1)`

const CONTEXT_AFTER_PARAMETER_DESCRIPTION = `Lines of context to show after each match (default: 1)`

export default {
	type: "function",
	function: {
		name: "grep_search",
		description: SEARCH_FILES_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: PATH_PARAMETER_DESCRIPTION,
				},
				query: {
					type: "string",
					description: QUERY_PARAMETER_DESCRIPTION,
				},
				fileTypes: {
					type: ["string", "null"],
					description: FILE_TYPES_PARAMETER_DESCRIPTION,
				},
				excludePattern: {
					type: ["string", "null"],
					description: EXCLUDE_PATTERN_PARAMETER_DESCRIPTION,
				},
				isRegex: {
					type: ["boolean", "null"],
					description: IS_REGEX_PARAMETER_DESCRIPTION,
				},
				caseSensitive: {
					type: ["boolean", "null"],
					description: CASE_SENSITIVE_PARAMETER_DESCRIPTION,
				},
				wholeWord: {
					type: ["boolean", "null"],
					description: WHOLE_WORD_PARAMETER_DESCRIPTION,
				},
				maxResults: {
					type: ["number", "null"],
					description: MAX_RESULTS_PARAMETER_DESCRIPTION,
				},
				contextBefore: {
					type: ["number", "null"],
					description: CONTEXT_BEFORE_PARAMETER_DESCRIPTION,
				},
				contextAfter: {
					type: ["number", "null"],
					description: CONTEXT_AFTER_PARAMETER_DESCRIPTION,
				},
			},
			required: [
				"path",
				"query",
				"fileTypes",
				"excludePattern",
				"isRegex",
				"caseSensitive",
				"wholeWord",
				"maxResults",
				"contextBefore",
				"contextAfter",
			],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
