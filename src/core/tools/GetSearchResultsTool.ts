/**
 * GetSearchResultsTool - Searches across workspace files for text/regex matches.
 *
 * Uses VS Code's indexed workspace.findTextInFiles API for fast searches with a
 * fallback to manual file scanning when the API is unavailable. No UI is modified.
 * Ported from workspace-tools `workspace_getSearchResults`.
 */

import * as vscode from "vscode"

import { Task } from "../task/Task"
import { getReadablePath } from "../../utils/path"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface GetSearchResultsParams {
	query: string
	isRegex?: boolean | null
	includePattern?: string | null
	excludePattern?: string | null
	maxResults?: number | null
	caseSensitive?: boolean | null
	wholeWord?: boolean | null
}

interface SearchMatch {
	filePath: string
	line: number
	column: number
	preview: string
}

const DEFAULT_MAX_RESULTS = 100

export class GetSearchResultsTool extends BaseTool<"get_search_results"> {
	readonly name = "get_search_results" as const

	async execute(params: GetSearchResultsParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const {
			query,
			isRegex = false,
			includePattern,
			excludePattern,
			maxResults = DEFAULT_MAX_RESULTS,
			caseSensitive = false,
			wholeWord = false,
		} = params
		const { handleError, pushToolResult } = callbacks

		try {
			if (!query) {
				task.consecutiveMistakeCount++
				task.recordToolError("get_search_results")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("get_search_results", "query"))
				return
			}

			task.consecutiveMistakeCount = 0

			const didApprove = await this.askToolApproval(callbacks, {
				tool: "getSearchResults",
				regex: query,
				filePattern: includePattern ?? undefined,
				content: `Searching for: ${query}`,
			})
			if (!didApprove) {
				return
			}

			const effectiveMax = maxResults ?? DEFAULT_MAX_RESULTS

			const matches: SearchMatch[] = []

			// Pre-process query for whole-word matching (non-regex mode)
			const effectiveQuery =
				wholeWord && !isRegex ? `\\b${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b` : query
			const effectiveIsRegex = isRegex || (wholeWord && !isRegex)

			// Try VS Code's native text search API first
			try {
				const ws = vscode.workspace as any
				if (typeof ws.findTextInFiles === "function") {
					const textQuery = {
						pattern: effectiveQuery,
						isRegExp: effectiveIsRegex,
						isCaseSensitive: caseSensitive ?? false,
						isWordMatch: wholeWord ?? false,
					}
					const searchOptions: any = { maxResults: effectiveMax }
					if (includePattern) {
						searchOptions.include = new vscode.RelativePattern(task.cwd, includePattern)
					}
					if (excludePattern) {
						searchOptions.exclude = excludePattern
					}

					await ws.findTextInFiles(textQuery, searchOptions, (result: any) => {
						matches.push({
							filePath: result.uri.fsPath,
							line: result.ranges[0].start.line + 1,
							column: result.ranges[0].start.character + 1,
							preview: result.preview.text.trim().slice(0, 200),
						})
					})
				} else {
					throw new Error("findTextInFiles not available")
				}
			} catch {
				// Fallback: manual file scan
				const globPattern = includePattern ?? "**/*"
				const excludeGlob = excludePattern || "**/node_modules/**"
				const files = await vscode.workspace.findFiles(globPattern, excludeGlob, 1000)

				const regexFlags = caseSensitive ? "g" : "gi"

				for (const file of files) {
					if (matches.length >= effectiveMax) break

					try {
						const content = await vscode.workspace.fs.readFile(file)
						const text = Buffer.from(content).toString("utf-8")
						const lines = text.split("\n")

						for (let i = 0; i < lines.length && matches.length < effectiveMax; i++) {
							const lineText = lines[i]
							let matchIndex = -1

							if (effectiveIsRegex) {
								try {
									const re = new RegExp(effectiveQuery, regexFlags)
									const m = re.exec(lineText)
									if (m) matchIndex = m.index
								} catch {
									// Invalid regex — skip
								}
							} else {
								if (caseSensitive) {
									matchIndex = lineText.indexOf(query)
								} else {
									matchIndex = lineText.toLowerCase().indexOf(query.toLowerCase())
								}
							}

							if (matchIndex >= 0) {
								matches.push({
									filePath: file.fsPath,
									line: i + 1,
									column: matchIndex + 1,
									preview: lineText.trim().slice(0, 200),
								})
							}
						}
					} catch {
						// Skip unreadable files
					}
				}
			}

			if (matches.length === 0) {
				pushToolResult(`No results found for: ${query}`)
				return
			}

			const formatted = matches
				.slice(0, effectiveMax)
				.map((m) => `${getReadablePath(task.cwd, m.filePath)}:${m.line}:${m.column}: ${m.preview}`)

			let output = `Search results for "${query}" (${matches.length} match${matches.length === 1 ? "" : "es"}):\n\n`
			output += formatted.join("\n")
			if (matches.length > effectiveMax) {
				output += `\n\n... (limited to ${effectiveMax} results)`
			}

			pushToolResult(output)
		} catch (error) {
			await handleError("getting search results", error instanceof Error ? error : new Error(String(error)))
		}
	}
}

export const getSearchResultsTool = new GetSearchResultsTool()
