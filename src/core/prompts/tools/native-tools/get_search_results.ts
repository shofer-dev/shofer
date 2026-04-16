import type OpenAI from "openai"

const GET_SEARCH_RESULTS_DESCRIPTION = `Request to search for text in files and open the VS Code Search view. This tool performs a text search and displays results in VS Code's Search panel.

Parameters:
- query: (required) The search query text
- isRegex: (optional) Whether the query is a regular expression. Defaults to false.
- includePattern: (optional) Glob pattern to limit which files are searched
- maxResults: (optional) Maximum number of results to return. Defaults to 100.

Example: Search for text
{ "query": "function myFunction" }

Example: Regex search in TypeScript files
{ "query": "import.*from", "isRegex": true, "includePattern": "*.ts" }`

const QUERY_PARAMETER_DESCRIPTION = `The search query text`

const IS_REGEX_PARAMETER_DESCRIPTION = `Whether the query is a regular expression (default: false)`

const INCLUDE_PATTERN_PARAMETER_DESCRIPTION = `Glob pattern to limit which files are searched`

const MAX_RESULTS_PARAMETER_DESCRIPTION = `Maximum number of results to return (default: 100)`

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
				maxResults: {
					type: ["number", "null"],
					description: MAX_RESULTS_PARAMETER_DESCRIPTION,
				},
			},
			required: ["query", "isRegex", "includePattern", "maxResults"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
