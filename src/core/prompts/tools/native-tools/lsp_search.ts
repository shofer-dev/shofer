/**
 * Schema for lsp_search tool.
 *
 * Uses the LSP workspace symbol provider (vscode.executeWorkspaceSymbolProvider)
 * to find symbols (functions, classes, variables, etc.) matching a query.
 * Falls back to word-level text search when the language server is unavailable
 * or returns no results.
 *
 * Unlike rag_search (which uses vector embeddings via Qdrant), this tool
 * requires no external infrastructure — it works entirely with VS Code's
 * built-in language services.
 */
import type OpenAI from "openai"

const DESCRIPTION = `Search the codebase for symbols (functions, classes, variables, interfaces, etc.) using the Language Server Protocol workspace symbol provider. This is a structural/symbol-aware search that finds declarations and definitions matching the query.

Falls back to word-level text search across source files when no language server is available or no symbols match.

Unlike rag_search (semantic/embedding-based), this tool requires no external infrastructure and works with VS Code's built-in language services.

Parameters:
- query: (required) The symbol or text to search for. Can be a function name, class name, variable name, or a natural-language description that will be matched against file contents as a fallback.
- maxResults: (optional) Maximum number of results to return. Defaults to 20.

Example: Searching for a function
{ "query": "handleUserLogin", "maxResults": 10 }

Example: Broader search
{ "query": "database connection", "maxResults": 30 }`

export default {
	type: "function",
	function: {
		name: "lsp_search",
		description: DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: "The symbol name or text to search for in the codebase",
				},
				maxResults: {
					type: ["number", "null"],
					description: "Maximum number of results to return (default: 20)",
				},
			},
			required: ["query", "maxResults"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
