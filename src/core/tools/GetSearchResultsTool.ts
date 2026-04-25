/**
 * GetSearchResultsTool - Searches across workspace files for text/regex matches.
 *
 * Opens the VS Code search view for visual feedback and collects results programmatically
 * using `workspace.findTextInFiles` with a fallback to manual file scanning.
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
	maxResults?: number | null
}

interface SearchMatch {
	filePath: string
	line: number
	column: number
	preview: string
}

const DEFAULT_MAX_RESULTS = 100

import { type ClineSayTool } from "@roo-code/types"

export class GetSearchResultsTool extends BaseTool<"get_search_results"> {
	readonly name = "get_search_results" as const

	async execute(params: GetSearchResultsParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { query, isRegex = false, includePattern, maxResults = DEFAULT_MAX_RESULTS } = params
		const { askApproval, handleError, pushToolResult } = callbacks

		try {
			if (!query) {
				task.consecutiveMistakeCount++
				task.recordToolError("get_search_results")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("get_search_results", "query"))
				return
			}

			task.consecutiveMistakeCount = 0

			const sharedMessageProps: ClineSayTool = {
				tool: "getSearchResults",
				regex: query,
				filePattern: includePattern ?? undefined,
			}

			const completeMessage = JSON.stringify({
				...sharedMessageProps,
				content: `Searching for: ${query}`,
			} satisfies ClineSayTool)

			const didApprove = await askApproval("tool", completeMessage)
			if (!didApprove) {
				return
			}

			const effectiveMax = maxResults ?? DEFAULT_MAX_RESULTS

			// Open VS Code search view for visual feedback (non-critical)
			try {
				await vscode.commands.executeCommand("workbench.action.findInFiles", {
					query,
					isRegex: isRegex ?? false,
					isCaseSensitive: false,
					matchWholeWord: false,
					filesToInclude: includePattern || "",
				})
			} catch {
				// Search view may not be available in headless environments
			}

			const matches: SearchMatch[] = []

			// Try VS Code's native text search API first
			try {
				const ws = vscode.workspace as any
				if (typeof ws.findTextInFiles === "function") {
					const textQuery = {
						pattern: query,
						isRegExp: isRegex ?? false,
						isCaseSensitive: false,
					}
					const searchOptions: any = { maxResults: effectiveMax }
					if (includePattern) {
						searchOptions.include = new vscode.RelativePattern(task.cwd, includePattern)
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
				const files = await vscode.workspace.findFiles(globPattern, "**/node_modules/**", 1000)

				for (const file of files) {
					if (matches.length >= effectiveMax) break

					try {
						const content = await vscode.workspace.fs.readFile(file)
						const text = Buffer.from(content).toString("utf-8")
						const lines = text.split("\n")

						for (let i = 0; i < lines.length && matches.length < effectiveMax; i++) {
							const lineText = lines[i]
							let matchIndex = -1

							if (isRegex) {
								try {
									const re = new RegExp(query, "i")
									const m = re.exec(lineText)
									if (m) matchIndex = m.index
								} catch {
									// Invalid regex — skip
								}
							} else {
								matchIndex = lineText.toLowerCase().indexOf(query.toLowerCase())
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
