import type OpenAI from "openai"

const GIT_SEARCH_DESCRIPTION = `Search git commit history (commit messages only — not diffs, not file contents) using semantic search. This allows discovering relevant commit context — who changed what, when, and why — by searching by meaning rather than exact keywords.

Search results include: commit hash, short hash, author, author date, commit subject (first line), and commit body.

Parameters:
- query: (required) The search query describing what you're looking for in commit history
- maxResults: (optional) Maximum number of results (default 20, max 50).
- since: (optional) ISO 8601 date string (e.g., "2024-01-01T00:00:00Z"). Only include commits with author_date >= since.
- until: (optional) ISO 8601 date string (e.g., "2024-12-31T23:59:59Z"). Only include commits with author_date <= until.

Example: Searching for commit history about a specific feature
{ "query": "Added authentication middleware to the API gateway" }

Example: Searching with result limit
{ "query": "database migration changes", "maxResults": 10 }

Example: Searching with time range
{ "query": "refactoring", "since": "2025-01-01T00:00:00Z", "until": "2025-06-01T00:00:00Z" }`

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
				since: {
					type: ["string", "null"],
					description:
						"Optional ISO 8601 date string (e.g., '2024-01-01T00:00:00Z'). Only include commits where author_date >= since. Pass null to skip.",
				},
				until: {
					type: ["string", "null"],
					description:
						"Optional ISO 8601 date string (e.g., '2024-12-31T23:59:59Z'). Only include commits where author_date <= until. Pass null to skip.",
				},
			},
			required: ["query", "maxResults", "since", "until"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
