import type OpenAI from "openai"

const FETCH_WEB_PAGE_DESCRIPTION = `Request to fetch and extract content from web pages. This tool downloads web pages and extracts their text content, removing HTML markup.

Parameters:
- urls: (required) Array of URLs to fetch
- query: (optional) Query to filter the extracted content. If provided, only content matching the query terms is returned.

Example: Fetch a single page
{ "urls": ["https://example.com/docs"] }

Example: Fetch multiple pages with content filtering
{ "urls": ["https://example.com/api", "https://example.com/guide"], "query": "authentication" }`

const URLS_PARAMETER_DESCRIPTION = `Array of URLs to fetch`

const QUERY_PARAMETER_DESCRIPTION = `Query to filter the extracted content`

export default {
	type: "function",
	function: {
		name: "fetch_web_page",
		description: FETCH_WEB_PAGE_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				urls: {
					type: "array",
					items: {
						type: "string",
					},
					description: URLS_PARAMETER_DESCRIPTION,
				},
				query: {
					type: ["string", "null"],
					description: QUERY_PARAMETER_DESCRIPTION,
				},
			},
			required: ["urls", "query"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
