import { parametersSchema as z } from "@shofer/types"

import { defineNativeTool } from "@shofer/core"

const SEARCH_FILES_DESCRIPTION = `Request to perform a regex search across files in a specified directory, providing context-rich results. This tool searches for patterns or specific content across multiple files, displaying each match with encapsulating context.

Craft your regex patterns carefully to balance specificity and flexibility. Use this tool to find code patterns, TODO comments, function definitions, or any text-based information across the project. The results include surrounding context, so analyze the surrounding code to better understand the matches. Leverage this tool in combination with other tools for more comprehensive analysis.

Parameters:
- path: (required) The path of the directory to search in (relative to the current workspace directory). This directory will be recursively searched.
- query: (required) The search pattern (regex or literal text)
- fileTypes: (optional) Glob pattern to filter files (e.g., '*.ts', '**/*.go'). If not provided, it will search all files.
- excludePattern: (optional) Glob pattern to exclude files from search.
- isRegex: (optional) Whether the query is a regular expression. When false, query is matched literally. Defaults to true.
- caseSensitive: (optional) Case-sensitive matching. Defaults to false.
- wholeWord: (optional) Match whole words only (wraps query in \\b boundaries). Works with both literal and regex queries. Defaults to false.
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

const IS_REGEX_PARAMETER_DESCRIPTION = `Whether query is a regular expression (default: true). When false, query is matched as a literal string.`

const CASE_SENSITIVE_PARAMETER_DESCRIPTION = `Case-sensitive matching (default: false)`

const WHOLE_WORD_PARAMETER_DESCRIPTION = `Match whole words only by wrapping the query in \\b word boundary anchors (default: false). Works with both literal and regex queries.`

const MAX_RESULTS_PARAMETER_DESCRIPTION = `Maximum total results across all files (default 100, silently clamped to 1000). Raise only when you need exhaustive coverage — narrowing the query is usually cheaper.`

const CONTEXT_BEFORE_PARAMETER_DESCRIPTION = `Lines of context to show before each match (default: 1)`

const CONTEXT_AFTER_PARAMETER_DESCRIPTION = `Lines of context to show after each match (default: 1)`

export default defineNativeTool({
	name: "grep_search",
	description: SEARCH_FILES_DESCRIPTION,
	schema: z.object({
		path: z.string().describe(PATH_PARAMETER_DESCRIPTION),
		query: z.string().describe(QUERY_PARAMETER_DESCRIPTION),
		fileTypes: z.string().describe(FILE_TYPES_PARAMETER_DESCRIPTION).optional(),
		excludePattern: z.string().describe(EXCLUDE_PATTERN_PARAMETER_DESCRIPTION).optional(),
		isRegex: z.boolean().describe(IS_REGEX_PARAMETER_DESCRIPTION).optional(),
		caseSensitive: z.boolean().describe(CASE_SENSITIVE_PARAMETER_DESCRIPTION).optional(),
		wholeWord: z.boolean().describe(WHOLE_WORD_PARAMETER_DESCRIPTION).optional(),
		maxResults: z.number().describe(MAX_RESULTS_PARAMETER_DESCRIPTION).optional(),
		contextBefore: z.number().describe(CONTEXT_BEFORE_PARAMETER_DESCRIPTION).optional(),
		contextAfter: z.number().describe(CONTEXT_AFTER_PARAMETER_DESCRIPTION).optional(),
	}),
})
