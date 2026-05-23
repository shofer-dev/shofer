import * as vscode from "vscode"
import path from "path"

import { Task } from "../task/Task"
import { CodeIndexManager } from "../../services/code-index/manager"
import { getWorkspacePath } from "../../utils/path"
import { formatResponse } from "../prompts/responses"
import { VectorStoreSearchResult } from "../../services/code-index/interfaces"
import type { ToolUse } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"
import { RAG_SEARCH_CAP, resolveMaxResults, formatTruncationHeader } from "./helpers/searchCap"

interface RagSearchParams {
	query: string
	path?: string
	maxResults?: number | null
}

export class RagSearchTool extends BaseTool<"rag_search"> {
	readonly name = "rag_search" as const

	async execute(params: RagSearchParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { askApproval, handleError, pushToolResult } = callbacks
		const { query, path: directoryPrefix } = params
		// Resolve through the shared cap (default 10, hard ceiling 50). Note that
		// the embedding model is lexically biased (word-level token overlap), so
		// raising this cap is rarely helpful — if the right files aren't in the top
		// results, the embeddings likely didn't capture the intent.
		const maxResults = resolveMaxResults(params.maxResults, RAG_SEARCH_CAP)

		const workspacePath = task.cwd && task.cwd.trim() !== "" ? task.cwd : getWorkspacePath()

		if (!workspacePath) {
			await handleError("rag_search", new Error("Could not determine workspace path."))
			return
		}

		if (!query) {
			task.consecutiveMistakeCount++
			task.didToolFailInCurrentTurn = true
			pushToolResult(await task.sayAndCreateMissingParamError("rag_search", "query"))
			return
		}

		const sharedMessageProps = {
			tool: "ragSearch",
			query: query,
			path: directoryPrefix,
			isOutsideWorkspace: false,
		}

		const didApprove = await askApproval("tool", JSON.stringify(sharedMessageProps))
		if (!didApprove) {
			pushToolResult(formatResponse.toolDenied())
			return
		}

		task.consecutiveMistakeCount = 0

		try {
			const context = task.providerRef.deref()?.context
			if (!context) {
				throw new Error("Extension context is not available.")
			}

			const manager = CodeIndexManager.getInstance(context)

			if (!manager) {
				throw new Error("CodeIndexManager is not available.")
			}

			if (!manager.isFeatureEnabled) {
				throw new Error("Code Indexing is disabled in the settings.")
			}
			if (!manager.isFeatureConfigured) {
				throw new Error("Code Indexing is not configured (Missing OpenAI Key or Qdrant URL).")
			}

			// Over-fetch by 1 so we can detect truncation reliably and surface the
			// "Showing first N of more results." hint to the LLM.
			const searchResults: VectorStoreSearchResult[] = await manager.searchIndex(
				query,
				directoryPrefix,
				maxResults + 1,
			)

			if (!searchResults || searchResults.length === 0) {
				pushToolResult(`No relevant code snippets found for the query: "${query}"`)
				return
			}

			const truncated = searchResults.length > maxResults
			const cappedResults = truncated ? searchResults.slice(0, maxResults) : searchResults

			const jsonResult = {
				query,
				truncated,
				results: [],
			} as {
				query: string
				truncated: boolean
				results: Array<{
					filePath: string
					score: number
					startLine: number
					endLine: number
					codeChunk: string
				}>
			}

			cappedResults.forEach((result) => {
				if (!result.payload) return
				if (!("filePath" in result.payload)) return

				const relativePath = vscode.workspace.asRelativePath(result.payload.filePath, false)

				jsonResult.results.push({
					filePath: relativePath,
					score: result.score,
					startLine: result.payload.startLine,
					endLine: result.payload.endLine,
					codeChunk: result.payload.codeChunk.trim(),
				})
			})

			const payload = { tool: "ragSearch", content: jsonResult }
			await task.say("rag_search_result", JSON.stringify(payload))

			const header = formatTruncationHeader({
				totalShown: jsonResult.results.length,
				maxResults,
				truncated,
				noun: "code snippets",
			})

			const output = `${header}
Query: ${query}
Results:

${jsonResult.results
	.map(
		(result) => `File path: ${result.filePath}
Score: ${result.score}
Lines: ${result.startLine}-${result.endLine}
Code Chunk: ${result.codeChunk}
`,
	)
	.join("\n")}`

			pushToolResult(output)
		} catch (error: any) {
			await handleError("rag_search", error)
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"rag_search">): Promise<void> {
		const query: string | undefined = block.params.query
		const directoryPrefix: string | undefined = block.params.path

		const sharedMessageProps = {
			tool: "ragSearch",
			query: query,
			path: directoryPrefix,
			isOutsideWorkspace: false,
		}

		await task.ask("tool", JSON.stringify(sharedMessageProps), block.partial).catch(() => {})
	}
}

export const ragSearchTool = new RagSearchTool()
