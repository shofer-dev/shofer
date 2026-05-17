import type OpenAI from "openai"

const GIT_SEARCH_DESCRIPTION = `Search git commit history (commit messages only — not diffs, not file contents) using semantic search. This allows discovering relevant commit context — who changed what, when, and why — by searching by meaning rather than exact keywords.

Search results include: commit hash, short hash, author, author date, commit subject (first line), and commit body.

Parameters:
- query: (required) The search query describing what you're looking for in commit history
- maxResults: (optional) Maximum number of results (default 20, max 50).

Example: Searching for commit history about a specific feature
{ "query": "Added authentication middleware to the API gateway" }

Example: Searching with result limit
{ "query": "database migration changes", "maxResults": 10 }`

export default {
	type: "function",
	function: {
		name: "git_search",
		description: GIT_SEARCH_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: "Meaning-based search query describing what you want to find in git commit history",
				},
				maxResults: {
					type: ["number", "null"],
					description:
						"Maximum number of results (default 20, silently clamped to 50). Pass null to use the default.",
				},
			},
			required: ["query", "maxResults"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
