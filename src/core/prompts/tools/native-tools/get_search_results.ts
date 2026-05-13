import type OpenAI from "openai"

const GET_SEARCH_RESULTS_DESCRIPTION = `Request to search for text in files across the workspace. This tool performs a text search using VS Code's indexed search engine and returns matching results programmatically — no UI is modified.

Parameters:
- query: (required) The search query text
- isRegex: (optional) Whether the query is a regular expression. Defaults to false.
- includePattern: (optional) Glob pattern to limit which files are searched
- excludePattern: (optional) Glob pattern to exclude files from search
- maxResults: (optional) Maximum number of results to return. Defaults to 100.
- caseSensitive: (optional) Whether the search should be case-sensitive. Defaults to false.
- wholeWord: (optional) Match whole words only (wraps query in \\b boundaries). Defaults to false. Cannot be combined with isRegex.

Example: Search for text
{ "query": "function myFunction" }

Example: Regex search in TypeScript files
{ "query": "import.*from", "isRegex": true, "includePattern": "*.ts" }

Example: Whole-word case-sensitive search
{ "query": "TODO", "wholeWord": true, "caseSensitive": true, "includePattern": "*.ts" }`

const QUERY_PARAMETER_DESCRIPTION = `The search query text`

const IS_REGEX_PARAMETER_DESCRIPTION = `Whether the query is a regular expression (default: false)`

const INCLUDE_PATTERN_PARAMETER_DESCRIPTION = `Glob pattern to limit which files are searched`

const EXCLUDE_PATTERN_PARAMETER_DESCRIPTION = `Glob pattern to exclude files from search`

const MAX_RESULTS_PARAMETER_DESCRIPTION = `Maximum number of results to return (default: 100)`

const CASE_SENSITIVE_PARAMETER_DESCRIPTION = `Whether the search should be case-sensitive (default: false)`

const WHOLE_WORD_PARAMETER_DESCRIPTION = `Match whole words only by wrapping the query in \\b word boundary anchors (default: false). Cannot be combined with isRegex.`

export default {
	type: "function",
	function: {
		name: "get_search_results",
		description: GET_SEARCH_RESULTS_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: QUERY_PARAMETER_DESCRIPTION,
				},
				isRegex: {
					type: ["boolean", "null"],
					description: IS_REGEX_PARAMETER_DESCRIPTION,
				},
				includePattern: {
					type: ["string", "null"],
					description: INCLUDE_PATTERN_PARAMETER_DESCRIPTION,
				},
				excludePattern: {
					type: ["string", "null"],
					description: EXCLUDE_PATTERN_PARAMETER_DESCRIPTION,
				},
				maxResults: {
					type: ["number", "null"],
					description: MAX_RESULTS_PARAMETER_DESCRIPTION,
				},
				caseSensitive: {
					type: ["boolean", "null"],
					description: CASE_SENSITIVE_PARAMETER_DESCRIPTION,
				},
				wholeWord: {
					type: ["boolean", "null"],
					description: WHOLE_WORD_PARAMETER_DESCRIPTION,
				},
			},
			required: [
				"query",
				"isRegex",
				"includePattern",
				"excludePattern",
				"maxResults",
				"caseSensitive",
				"wholeWord",
			],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
