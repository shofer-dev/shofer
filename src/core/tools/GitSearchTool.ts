import { Task } from "../task/Task"
import { GitIndexManager } from "../../services/git-index/git-index-manager"
import { getWorkspacePath } from "../../utils/path"
import { formatResponse } from "../prompts/responses"
import type { GitSearchResult } from "../../services/git-index/interfaces/git"
import type { ToolUse } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"
import { GIT_SEARCH_CAP, resolveMaxResults, formatTruncationHeader } from "./helpers/searchCap"

interface GitSearchParams {
	query: string
	maxResults?: number | null
	since?: string | null
	until?: string | null
}

/**
 * Semantic search tool over git commit history.
 *
 * Embeds the user's query and performs cosine similarity search against
 * the git-specific Qdrant collection, returning matching commit messages.
 */
export class GitSearchTool extends BaseTool<"git_search"> {
	readonly name = "git_search" as const

	async execute(params: GitSearchParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { askApproval, handleError, pushToolResult } = callbacks
		const { query, since, until } = params
		// Resolve through the shared cap (default 20, hard ceiling 50) so the
		// behaviour matches grep_search / rag_search exactly. Invalid model-supplied
		// values (NaN, 0, negative, absurdly large) collapse to the safe default.
		const maxResults = resolveMaxResults(params.maxResults, GIT_SEARCH_CAP)

		try {
			const workspacePath = task.cwd && task.cwd.trim() !== "" ? task.cwd : getWorkspacePath()

			if (!workspacePath) {
				await handleError("git_search", new Error("Could not determine workspace path."))
				return
			}

			if (!query || query.trim() === "") {
				task.consecutiveMistakeCount++
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("git_search", "query"))
				return
			}

			const sharedMessageProps = {
				tool: "gitSearch",
				query: query,
			}

			const didApprove = await askApproval("tool", JSON.stringify(sharedMessageProps))
			if (!didApprove) {
				pushToolResult(formatResponse.toolDenied())
				return
			}

			task.consecutiveMistakeCount = 0

			const context = task.providerRef.deref()?.context
			if (!context) {
				throw new Error("Extension context is not available.")
			}

			const manager = GitIndexManager.getInstance(context, workspacePath)

			if (!manager) {
				throw new Error("GitIndexManager is not available for this workspace.")
			}

			if (!manager.isFeatureEnabled) {
				throw new Error("Git indexing is disabled in the settings.")
			}
			if (!manager.isFeatureConfigured) {
				throw new Error("Git indexing is not configured (Missing API Key or Qdrant URL).")
			}

			let searchResults: GitSearchResult[]

			try {
				// Over-fetch by 1 so we can reliably detect truncation: if Qdrant returns
				// maxResults+1 hits we know at least one more existed and the LLM should
				// see the "Showing first N of more results." hint.
				searchResults = await manager.searchIndex(query, maxResults + 1)
			} catch (searchError: any) {
				if (
					searchError.message?.includes("Not found") ||
					searchError.message?.includes("does not exist") ||
					searchError.message?.includes("not ready")
				) {
					pushToolResult(
						`Git commit history index is not ready yet. The index may still be building. ` +
							`Please try again shortly.`,
					)
					return
				}
				throw searchError
			}

			if (!searchResults || searchResults.length === 0) {
				pushToolResult(`No relevant commits found for the query: "${query}"`)
				return
			}

			// Post-filter by optional time range. ISO 8601 author_date strings
			// compare lexicographically, so simple string comparison works.
			const hasTimeFilter = since !== undefined || until !== undefined
			let filteredResults = searchResults
			if (hasTimeFilter) {
				filteredResults = searchResults.filter((r) => {
					const authorDate = r.payload.author_date
					if (!authorDate) return false
					if (since !== undefined && authorDate < since) return false
					if (until !== undefined && authorDate > until) return false
					return true
				})

				if (filteredResults.length === 0) {
					const rangeLabel = [since && `since=${since}`, until && `until=${until}`].filter(Boolean).join(", ")
					pushToolResult(
						`No commits found in the time range (${rangeLabel}) for the query: "${query}". ` +
							`${searchResults.length} semantic matches were filtered out by the date constraint.`,
					)
					return
				}
			}

			const truncated = filteredResults.length > maxResults
			const cappedResults = truncated ? filteredResults.slice(0, maxResults) : filteredResults

			const jsonResult = {
				query,
				truncated,
				results: cappedResults.map((result) => ({
					commit_hash: result.payload.commit_hash,
					short_hash: result.payload.short_hash,
					author: result.payload.author,
					author_date: result.payload.author_date,
					subject: result.payload.subject,
					body: result.payload.body,
					score: result.score,
				})),
			}

			const payload = { tool: "gitSearch", content: jsonResult }
			await task.say("git_search_result", JSON.stringify(payload))

			const header = formatTruncationHeader({
				totalShown: jsonResult.results.length,
				maxResults,
				truncated,
				noun: "commits",
			})

			const output = `${header}
Query: ${query}
Results:
${jsonResult.results
	.map(
		(result) => `Commit: ${result.short_hash} (${result.commit_hash})
Author: ${result.author}
Date: ${result.author_date}
Score: ${result.score.toFixed(4)}
Subject: ${result.subject}
${result.body ? `Body: ${result.body}` : ""}`,
	)
	.join("\n\n---\n\n")}`

			pushToolResult(output)
		} catch (error: any) {
			await handleError("git_search", error)
		} finally {
			// Reset partial state tracking per the Streaming Path-Stabilization Rule
			this.resetPartialState()
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"git_search">): Promise<void> {
		const query: string | undefined = block.params.query

		// Emit progressive UI updates on every partial chunk.
		// git_search does not have a file `path` parameter so hasPathStabilized
		// is not applicable; we emit on every chunk to give the user early
		// visibility of what is being searched.
		const sharedMessageProps = {
			tool: "gitSearch",
			query: query,
		}

		await task.ask("tool", JSON.stringify(sharedMessageProps), block.partial).catch(() => {})
	}
}

export const gitSearchTool = new GitSearchTool()
