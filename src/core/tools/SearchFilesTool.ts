/**
 * SearchFilesTool - Consolidated search tool using VS Code's indexed workspace.findTextInFiles API.
 *
 * Replaces the old ripgrep-backed `search_files` and the separate `get_search_results` tool
 * with a single unified implementation. Supports both regex and literal text search,
 * case-sensitive/whole-word matching, file type filtering, exclusion patterns,
 * configurable context lines, and result capping.
 */

import * as vscode from "vscode"

import { type ShoferSayTool } from "@shofer/types"

import { Task } from "../task/Task"
import { getReadablePath } from "../../utils/path"
import { isPathOutsideWorkspace } from "../../utils/pathUtils"
import type { ToolUse } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface SearchFilesParams {
	path: string
	query: string
	fileTypes?: string | null
	excludePattern?: string | null
	isRegex?: boolean | null
	caseSensitive?: boolean | null
	wholeWord?: boolean | null
	maxResults?: number | null
	contextBefore?: number | null
	contextAfter?: number | null
}

interface SearchHit {
	uri: vscode.Uri
	range: vscode.Range
	preview: vscode.TextSearchResult["preview"]
}

const DEFAULT_MAX_RESULTS = 100
const DEFAULT_CONTEXT_BEFORE = 1
const DEFAULT_CONTEXT_AFTER = 1

export class SearchFilesTool extends BaseTool<"search_files"> {
	readonly name = "search_files" as const

	async execute(params: SearchFilesParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { askApproval, handleError, pushToolResult } = callbacks

		const relDirPath = params.path
		const query = params.query
		const fileTypes = params.fileTypes ?? null
		const excludePattern = params.excludePattern ?? null
		const isRegex = params.isRegex ?? true
		const caseSensitive = params.caseSensitive ?? false
		const wholeWord = params.wholeWord ?? false
		const maxResults = params.maxResults ?? DEFAULT_MAX_RESULTS
		const contextBefore = params.contextBefore ?? DEFAULT_CONTEXT_BEFORE
		const contextAfter = params.contextAfter ?? DEFAULT_CONTEXT_AFTER

		if (!relDirPath) {
			task.consecutiveMistakeCount++
			task.recordToolError("search_files")
			task.didToolFailInCurrentTurn = true
			pushToolResult(await task.sayAndCreateMissingParamError("search_files", "path"))
			return
		}

		if (!query) {
			task.consecutiveMistakeCount++
			task.recordToolError("search_files")
			task.didToolFailInCurrentTurn = true
			pushToolResult(await task.sayAndCreateMissingParamError("search_files", "query"))
			return
		}

		task.consecutiveMistakeCount = 0

		const absolutePath = vscode.Uri.joinPath(vscode.Uri.file(task.cwd), relDirPath)
		const isOutsideWorkspace = isPathOutsideWorkspace(absolutePath.fsPath)

		const sharedMessageProps: ShoferSayTool = {
			tool: "searchFiles",
			path: getReadablePath(task.cwd, relDirPath),
			regex: query,
			filePattern: fileTypes ?? undefined,
			isOutsideWorkspace,
		}

		try {
			const didApprove = await askApproval(
				"tool",
				JSON.stringify({ ...sharedMessageProps, content: `Searching for: ${query}` } satisfies ShoferSayTool),
			)
			if (!didApprove) {
				return
			}

			// Pre-process query for whole-word matching (non-regex mode only; VS Code's
			// isWordMatch handles the actual boundary matching but we also normalize the
			// pattern so the result preview makes sense).
			const effectiveQuery = wholeWord && !isRegex ? `\\b${this.escapeRegex(query)}\\b` : query
			const effectiveIsRegex = isRegex || (wholeWord && !isRegex)

			const textQuery: vscode.TextSearchQuery = {
				pattern: effectiveQuery,
				isRegExp: effectiveIsRegex,
				isCaseSensitive: caseSensitive,
				isWordMatch: wholeWord ?? false,
			}

			const searchOptions: vscode.FindTextInFilesOptions = {
				maxResults: maxResults,
				beforeContext: contextBefore,
				afterContext: contextAfter,
				include: fileTypes ? new vscode.RelativePattern(absolutePath, fileTypes) : absolutePath,
				exclude: excludePattern ?? undefined,
			}

			const hits: SearchHit[] = []
			let truncated = false

			await vscode.workspace.findTextInFiles(textQuery, searchOptions, (result) => {
				if (hits.length >= maxResults) {
					truncated = true
					return
				}
				hits.push({
					uri: result.uri,
					range: result.ranges[0],
					preview: result.preview,
				})
			})

			if (hits.length === 0) {
				pushToolResult(`No results found for: ${query}`)
				return
			}

			const output = this.formatResults(hits, query, task.cwd, maxResults, truncated)
			pushToolResult(output)
		} catch (error) {
			await handleError("searching files", error as Error)
		}
	}

	/**
	 * Format search hits into the structured text output format:
	 *
	 *   Found N results.
	 *
	 *   ## relative/path/to/file
	 *     40 | context before
	 *   > 41 | MATCHING LINE
	 *     42 | context after
	 *   ----
	 */
	private formatResults(
		hits: SearchHit[],
		query: string,
		cwd: string,
		maxResults: number,
		truncated: boolean,
	): string {
		// Group hits by file, preserving insertion order
		const byFile = new Map<string, { lines: Map<number, string>; matchLines: Set<number> }>()

		for (const hit of hits) {
			const relPath = getReadablePath(cwd, hit.uri.fsPath)
			if (!byFile.has(relPath)) {
				byFile.set(relPath, { lines: new Map(), matchLines: new Set() })
			}
			const file = byFile.get(relPath)!

			// The match line (1-based)
			const matchLineNumber = hit.range.start.line + 1
			file.matchLines.add(matchLineNumber)

			// Extract the matching line text from the preview
			const matchText = hit.preview.text.split("\n")[0]?.trim() ?? ""
			file.lines.set(matchLineNumber, matchText)

			// Context lines from the preview
			const previewLines = hit.preview.text.split("\n")
			const matchLineIndex = 0 // The match is the first line in preview.text
			for (let i = 0; i < previewLines.length; i++) {
				const lineNum = matchLineNumber - matchLineIndex + i
				if (lineNum !== matchLineNumber) {
					file.lines.set(lineNum, previewLines[i].trim())
				}
			}
		}

		const header = truncated
			? `Found ${hits.length} results. Showing first ${maxResults} of ${hits.length} results.\n\n`
			: `Found ${hits.length} results.\n\n`

		const fileBlocks: string[] = []
		for (const [relPath, file] of byFile) {
			const sortedLines = [...file.lines.entries()].sort((a, b) => a[0] - b[0])

			// Detect non-contiguous blocks (gap > 1 line number)
			const blocks: Array<Array<[number, string]>> = []
			let currentBlock: Array<[number, string]> = []
			for (let i = 0; i < sortedLines.length; i++) {
				if (i > 0 && sortedLines[i][0] - sortedLines[i - 1][0] > 1) {
					blocks.push(currentBlock)
					currentBlock = []
				}
				currentBlock.push(sortedLines[i])
			}
			if (currentBlock.length > 0) {
				blocks.push(currentBlock)
			}

			const blockTexts = blocks.map((block) =>
				block
					.map(([lineNum, text]) => {
						const prefix = file.matchLines.has(lineNum) ? ">" : " "
						// Pad line number to 4 chars for alignment
						const paddedNum = String(lineNum).padStart(4, " ")
						return `${prefix} ${paddedNum} | ${text}`
					})
					.join("\n"),
			)

			fileBlocks.push(`## ${relPath}\n${blockTexts.join("\n----\n")}`)
		}

		return header + fileBlocks.join("\n\n")
	}

	/** Escape special regex characters for literal-to-regex whole-word wrapping. */
	private escapeRegex(str: string): string {
		return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
	}

	override async handlePartial(task: Task, block: ToolUse<"search_files">): Promise<void> {
		const relDirPath = block.params.path
		const query = block.params.query

		const absolutePath = relDirPath ? vscode.Uri.joinPath(vscode.Uri.file(task.cwd), relDirPath).fsPath : task.cwd
		const isOutsideWorkspace = isPathOutsideWorkspace(absolutePath)

		const sharedMessageProps: ShoferSayTool = {
			tool: "searchFiles",
			path: getReadablePath(task.cwd, relDirPath ?? ""),
			regex: query ?? "",
			filePattern: (block.params.fileTypes as string) ?? "",
			isOutsideWorkspace,
		}

		const partialMessage = JSON.stringify({ ...sharedMessageProps, content: "" } satisfies ShoferSayTool)
		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const searchFilesTool = new SearchFilesTool()
