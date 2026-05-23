import type OpenAI from "openai"

const CODEBASE_SEARCH_DESCRIPTION = `Find files most relevant to the search query using semantic search. Searches by meaning rather than exact text matches, but in practice the embedding model heavily weights word-level token overlap — results often match on shared keywords rather than architectural or structural relevance. By default searches entire workspace. Reuse the user's exact wording unless there's a clear reason not to — their phrasing often helps semantic search. Queries MUST be in English (translate if needed).

**Use for:** Conceptual exploration where you need to discover files related to a topic, pattern, or architectural concept. Best results come from descriptive queries that describe the problem or feature (e.g., "how does task cancellation propagate through the system?").

**Do NOT use for:** Exact symbol lookups, finding specific component files by name, or locating string literals. For those, prefer:
- **\`grep_search\`** — Exact strings, symbol names, regex patterns (e.g., "HistoryPreview", "Recent Tasks")
- **\`lsp_search\`** — Structural/symbol-aware search (functions, classes, interfaces) via the language server

These two tools find the right files instantly for exact matches and should be your first choice for locating known symbols, component names, or string patterns. Use \`rag_search\` when you need to explore code by concept or behavior rather than by name.

**⚠️ Indexing latency:** This tool queries a vector index that may not reflect the very latest code changes. File changes take at minimum 500ms (debounce) + embedding time to appear in the index. During a full workspace scan, search returns partial results. If you are looking for recently-modified code and need guaranteed fresh results, use lsp_search which queries the live codebase via the language server.

Parameters:
- query: (required) The search query. Reuse the user's exact wording/question format unless there's a clear reason not to.
- path: (optional) Limit search to specific subdirectory (relative to the current workspace directory). Leave empty for entire workspace.
- maxResults: (optional) Maximum number of code snippets to return. Defaults to 10; silently capped at 50. If relevant results aren't appearing, refine the query rather than asking for more results — raising this cap won't help if the underlying embeddings didn't capture the intent.

Example: Searching for a conceptual topic
{ "query": "how does task cancellation propagate through the system?", "path": "src", "maxResults": null }

Example: Searching entire workspace
{ "query": "database connection pooling", "path": null, "maxResults": null }`

const QUERY_PARAMETER_DESCRIPTION = `Meaning-based search query describing the information you need`

const PATH_PARAMETER_DESCRIPTION = `Optional subdirectory (relative to the workspace) to limit the search scope`

const MAX_RESULTS_PARAMETER_DESCRIPTION = `Optional cap on returned snippets (default 10, silently clamped to 50). Pass null to use the default.`

export default {
	type: "function",
	function: {
		name: "rag_search",
		description: CODEBASE_SEARCH_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: QUERY_PARAMETER_DESCRIPTION,
				},
				path: {
					type: ["string", "null"],
					description: PATH_PARAMETER_DESCRIPTION,
				},
				maxResults: {
					type: ["number", "null"],
					description: MAX_RESULTS_PARAMETER_DESCRIPTION,
				},
			},
			required: ["query", "path", "maxResults"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
