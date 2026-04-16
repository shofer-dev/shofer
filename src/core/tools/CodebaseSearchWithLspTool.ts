/**
 * CodebaseSearchWithLspTool - Searches the codebase using the LSP workspace symbol provider.
 *
 * Uses `vscode.executeWorkspaceSymbolProvider` to find symbols (functions, classes,
 * variables, interfaces, etc.) matching the query. Falls back to word-level text
 * search across source files when the language server is unavailable or returns
 * no results.
 *
 * Unlike CodebaseSearchTool (which uses vector embeddings via Qdrant), this tool
 * requires no external infrastructure and works entirely with VS Code's built-in
 * language services.
 *
 * Ported from workspace-tools `workspace_searchCodebase`.
 */

import * as vscode from "vscode"

import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import type { ToolUse } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface CodebaseSearchWithLspParams {
	query: string
	maxResults?: number | null
}

const DEFAULT_MAX_RESULTS = 20

/**
 * Source file extensions to scan during text fallback search.
 */
const SOURCE_FILE_GLOB =
	"**/*.{ts,tsx,js,jsx,go,py,rs,java,c,cpp,h,hpp,md,json,yaml,yml,toml,sql,rb,php,swift,kt,scala,sh,bash,zsh}"

export class CodebaseSearchWithLspTool extends BaseTool<"codebase_search_with_lsp"> {
	readonly name = "codebase_search_with_lsp" as const

	async execute(params: CodebaseSearchWithLspParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { askApproval, handleError, pushToolResult } = callbacks
		const { query, maxResults } = params
		const effectiveMax = maxResults ?? DEFAULT_MAX_RESULTS

		if (!query) {
			task.consecutiveMistakeCount++
			task.recordToolError("codebase_search_with_lsp")
			task.didToolFailInCurrentTurn = true
			pushToolResult(await task.sayAndCreateMissingParamError("codebase_search_with_lsp", "query"))
			return
		}

		const sharedMessageProps = {
			tool: "codebaseSearchWithLsp",
			query,
			isOutsideWorkspace: false,
		}

		const didApprove = await askApproval("tool", JSON.stringify(sharedMessageProps))
		if (!didApprove) {
			pushToolResult(formatResponse.toolDenied())
			return
		}

		task.consecutiveMistakeCount = 0

		try {
			// Primary: use the LSP workspace symbol provider
			const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
				"vscode.executeWorkspaceSymbolProvider",
				query,
			)

			if (symbols && symbols.length > 0) {
				const limited = symbols.slice(0, effectiveMax)
				const formatted = limited.map((s) => {
					const relativePath = vscode.workspace.asRelativePath(s.location.uri, false)
					const line = s.location.range.start.line + 1
					const kind = vscode.SymbolKind[s.kind] || "Unknown"
					return `${s.name} (${kind}) - ${relativePath}:${line}`
				})

				let output = `Symbol search results for "${query}" (${limited.length} of ${symbols.length}):\n\n`
				output += formatted.join("\n")
				if (symbols.length > effectiveMax) {
					output += `\n\n... ${symbols.length - effectiveMax} more symbols`
				}

				pushToolResult(output)
				return
			}

			// Fallback: word-level text search across source files
			const fallbackOutput = await this.searchTextFallback(query, effectiveMax, task.cwd)
			pushToolResult(fallbackOutput)
		} catch (error: any) {
			// If LSP fails entirely, try text fallback before giving up
			try {
				const fallbackOutput = await this.searchTextFallback(query, effectiveMax, task.cwd)
				pushToolResult(fallbackOutput)
			} catch (fallbackError: any) {
				await handleError("codebase_search_with_lsp", error)
			}
		}
	}

	/**
	 * Fallback text search when LSP symbol search is unavailable or returns no results.
	 * Splits the query into words and scores lines by how many query words they contain.
	 */
	private async searchTextFallback(query: string, maxResults: number, cwd: string): Promise<string> {
		const words = query
			.toLowerCase()
			.split(/\s+/)
			.filter((w) => w.length > 2)

		if (words.length === 0) {
			return `No results for: ${query}`
		}

		const files = await vscode.workspace.findFiles(SOURCE_FILE_GLOB, "**/node_modules/**", 500)
		const matches: Array<{ path: string; line: number; text: string; score: number }> = []

		for (const file of files) {
			if (matches.length >= maxResults * 2) break

			try {
				const content = await vscode.workspace.fs.readFile(file)
				const text = Buffer.from(content).toString("utf-8")
				const lines = text.split("\n")

				for (let i = 0; i < lines.length; i++) {
					const lineLower = lines[i].toLowerCase()
					let score = 0
					for (const word of words) {
						if (lineLower.includes(word)) {
							score++
						}
					}
					if (score > 0) {
						matches.push({
							path: file.fsPath,
							line: i + 1,
							text: lines[i].trim().slice(0, 150),
							score,
						})
					}
				}
			} catch {
				// Skip files that can't be read (binary, permissions, etc.)
			}
		}

		if (matches.length === 0) {
			return `No matches found for: ${query}`
		}

		// Sort by score descending and take top results
		matches.sort((a, b) => b.score - a.score)
		const limited = matches.slice(0, maxResults)

		let output = `Text fallback search results for "${query}" (${limited.length} matches):\n\n`
		output += limited
			.map((m) => `${vscode.workspace.asRelativePath(m.path, false)}:${m.line}: ${m.text}`)
			.join("\n")

		return output
	}

	/**
	 * Handles partial/streaming tool calls for progressive UI updates.
	 */
	override async handlePartial(task: Task, block: ToolUse<"codebase_search_with_lsp">): Promise<void> {
		const query: string | undefined = block.params.query

		const sharedMessageProps = {
			tool: "codebaseSearchWithLsp",
			query,
			isOutsideWorkspace: false,
		}

		await task.ask("tool", JSON.stringify(sharedMessageProps), block.partial).catch(() => {})
	}
}

export const codebaseSearchWithLspTool = new CodebaseSearchWithLspTool()
