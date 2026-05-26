/**
 * GrepSearchTool — Performs regex/literal search across files using ripgrep.
 *
 * Backend: ripgrep (executed as a child process, discovered via @vscode/ripgrep).
 * Rationale: VS Code's `workspace.findTextInFiles` API was found to have an incomplete
 * search index in practice — certain tokens (e.g., the Go `func` keyword) were not
 * found despite being present in files that `grep` and ripgrep locate instantly.
 * Ripgrep provides a deterministic, filesystem-level search that doesn't depend on
 * VS Code's internal indexing.
 *
 * The output format is identical to the previous `findTextInFiles`-based implementation:
 *
 *   Found N results.
 *
 *   ## relative/path/to/file
 *     40 | context before
 *   > 41 | MATCHING LINE
 *     42 | context after
 *   ----
 */

import * as path from "path"
import * as childProcess from "child_process"
import * as readline from "readline"
import * as vscode from "vscode"

import { type ShoferSayTool } from "@shofer/types"

import { Task } from "../task/Task"
import { getReadablePath } from "../../utils/path"
import { isPathOutsideWorkspace } from "../../utils/pathUtils"
import { fileExistsAtPath } from "../../utils/fs"
import type { ShoferIgnoreController } from "../ignore/ShoferIgnoreController"
import type { ToolUse } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"
import { GREP_SEARCH_CAP, resolveMaxResults, formatTruncationHeader } from "./helpers/searchCap"
import { outputError } from "../../utils/outputChannelLogger"

interface GrepSearchParams {
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

interface RipgrepMatch {
	file: string
	lineNumber: number
	text: string
	isMatch: boolean
	absoluteOffset?: number
}

interface RipgrepFileResult {
	file: string
	matches: RipgrepMatch[]
}

interface SearchHit {
	relPath: string
	lines: Map<number, string>
	matchLines: Set<number>
}

const DEFAULT_CONTEXT_BEFORE = 1
const DEFAULT_CONTEXT_AFTER = 1
const MAX_LINE_LENGTH = 500

// Rough multiplier for limiting ripgrep output lines. Each match produces at most
// (beforeContext + 1 + afterContext) lines, and we add a safety margin.
const LINES_PER_RESULT_ESTIMATE = 5

const isWindows = process.platform.startsWith("win")
const binName = isWindows ? "rg.exe" : "rg"

/**
 * Locate the ripgrep binary within the VS Code installation.
 * Mirrors the logic in `src/services/ripgrep/index.ts`.
 */
async function getRipgrepBinPath(vscodeAppRoot: string): Promise<string | undefined> {
	const checkPath = async (pkgFolder: string) => {
		const fullPath = path.join(vscodeAppRoot, pkgFolder, binName)
		return (await fileExistsAtPath(fullPath)) ? fullPath : undefined
	}

	return (
		(await checkPath("node_modules/@vscode/ripgrep/bin/")) ||
		(await checkPath("node_modules/vscode-ripgrep/bin")) ||
		(await checkPath("node_modules.asar.unpacked/vscode-ripgrep/bin/")) ||
		(await checkPath("node_modules.asar.unpacked/@vscode/ripgrep/bin/"))
	)
}

/**
 * Execute ripgrep and return its stdout.
 * Limits output lines to prevent unbounded memory usage.
 */
async function execRipgrep(bin: string, args: string[], maxLines: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const rgProcess = childProcess.spawn(bin, args)
		const rl = readline.createInterface({
			input: rgProcess.stdout,
			crlfDelay: Infinity,
		})

		let output = ""
		let lineCount = 0

		rl.on("line", (line) => {
			if (lineCount < maxLines) {
				output += line + "\n"
				lineCount++
			} else {
				rl.close()
				rgProcess.kill()
			}
		})

		let errorOutput = ""
		rgProcess.stderr.on("data", (data) => {
			errorOutput += data.toString()
		})

		rl.on("close", () => {
			if (errorOutput) {
				reject(new Error(`ripgrep process error: ${errorOutput}`))
			} else {
				resolve(output)
			}
		})

		rgProcess.on("error", (error) => {
			reject(new Error(`ripgrep process error: ${error.message}`))
		})
	})
}

/**
 * Build ripgrep CLI arguments from search parameters.
 *
 * Mapping:
 *   --json              → structured output (always used)
 *   -e <query>          → regex pattern (isRegex: true) or literal (isRegex: false → -F)
 *   -i                  → case-insensitive (caseSensitive: false)
 *   -w                  → whole-word match (wholeWord: true)
 *   -g <glob>           → include files matching glob (fileTypes)
 *   -g '!<glob>'        → exclude files matching glob (excludePattern)
 *   -B <n>              → lines of context before match
 *   -A <n>              → lines of context after match
 *   --no-messages       → suppress error messages in output (essential for JSON parsing)
 *   <directoryPath>     → directory to search recursively
 */
function buildRipgrepArgs(params: {
	query: string
	isRegex: boolean
	caseSensitive: boolean
	wholeWord: boolean
	fileTypes?: string | null
	excludePattern?: string | null
	contextBefore: number
	contextAfter: number
	directoryPath: string
	/**
	 * Absolute path to a .shoferignore file. When provided, ripgrep will respect
	 * the file's patterns natively (via --ignore-file), ensuring ignored paths are
	 * excluded at the search level rather than only in the post-filter pass.
	 */
	shoferIgnoreFile?: string
}): string[] {
	const {
		query,
		isRegex,
		caseSensitive,
		wholeWord,
		fileTypes,
		excludePattern,
		contextBefore,
		contextAfter,
		directoryPath,
		shoferIgnoreFile,
	} = params

	// --no-require-git prevents ripgrep from treating submodule .git files
	// (gitdir: ../../.git/modules/...) as nested repository boundaries.
	// Without this flag, ripgrep silently skips submodule directories, causing
	// searches from the workspace root to return no results for submodule paths.
	const args: string[] = ["--json", "--no-messages", "--no-require-git"]

	if (isRegex) {
		args.push("-e", query)
	} else {
		// Fixed-string (literal) search
		args.push("-F", "-e", query)
	}

	if (!caseSensitive) {
		args.push("-i")
	}

	if (wholeWord) {
		args.push("-w")
	}

	if (fileTypes) {
		args.push("-g", fileTypes)
	}

	if (excludePattern) {
		// Ripgrep uses `-g '!pattern'` for exclusions
		args.push("-g", `!${excludePattern}`)
	}

	// Teach ripgrep about .shoferignore patterns directly so ignored files are
	// excluded at the search level, not just in the post-filter pass. This
	// prevents ignored files from consuming the maxLines budget and silently
	// crowding out legitimate results.
	if (shoferIgnoreFile) {
		args.push("--ignore-file", shoferIgnoreFile)
	}

	if (contextBefore > 0) {
		args.push("-B", String(contextBefore))
	}

	if (contextAfter > 0) {
		args.push("-A", String(contextAfter))
	}

	args.push(directoryPath)

	return args
}

/**
 * Parse ripgrep --json output into structured results grouped by file.
 * Handles `begin`, `match`, `context`, and `end` JSON message types.
 */
function parseRipgrepOutput(output: string): RipgrepFileResult[] {
	const results: RipgrepFileResult[] = []
	let currentFile: RipgrepFileResult | null = null

	output.split("\n").forEach((line) => {
		if (!line) return
		try {
			const parsed = JSON.parse(line)
			if (parsed.type === "begin") {
				currentFile = {
					file: parsed.data.path.text.toString(),
					matches: [],
				}
			} else if (parsed.type === "end") {
				if (currentFile) {
					results.push(currentFile)
				}
				currentFile = null
			} else if ((parsed.type === "match" || parsed.type === "context") && currentFile) {
				const text = parsed.data.lines.text
				const truncatedText =
					text.length > MAX_LINE_LENGTH ? text.substring(0, MAX_LINE_LENGTH) + " [truncated...]" : text

				currentFile.matches.push({
					file: currentFile.file,
					lineNumber: parsed.data.line_number,
					text: truncatedText,
					isMatch: parsed.type === "match",
					absoluteOffset: parsed.type === "match" ? parsed.data.absolute_offset : undefined,
				})
			}
		} catch {
			// Non-JSON lines (e.g., error messages suppressed by --no-messages) are ignored
		}
	})

	return results
}

export class GrepSearchTool extends BaseTool<"grep_search"> {
	readonly name = "grep_search" as const

	async execute(params: GrepSearchParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { askApproval, handleError, pushToolResult } = callbacks

		const relDirPath = params.path
		const query = params.query
		const fileTypes = params.fileTypes ?? null
		const excludePattern = params.excludePattern ?? null
		const isRegex = params.isRegex ?? true
		const caseSensitive = params.caseSensitive ?? false
		const wholeWord = params.wholeWord ?? false
		// Resolve through the shared cap so an absurd or invalid model-supplied value
		// (NaN / 0 / negative / 10_000) is normalised to a safe integer within
		// GREP_SEARCH_CAP. Keeps the policy identical to git_search and rag_search.
		const maxResults = resolveMaxResults(params.maxResults, GREP_SEARCH_CAP)
		const contextBefore = params.contextBefore ?? DEFAULT_CONTEXT_BEFORE
		const contextAfter = params.contextAfter ?? DEFAULT_CONTEXT_AFTER

		if (!relDirPath) {
			task.consecutiveMistakeCount++
			task.recordToolError("grep_search")
			task.didToolFailInCurrentTurn = true
			pushToolResult(await task.sayAndCreateMissingParamError("grep_search", "path"))
			return
		}

		if (!query) {
			task.consecutiveMistakeCount++
			task.recordToolError("grep_search")
			task.didToolFailInCurrentTurn = true
			pushToolResult(await task.sayAndCreateMissingParamError("grep_search", "query"))
			return
		}

		task.consecutiveMistakeCount = 0

		const resolvedPath = path.resolve(task.cwd, relDirPath)
		const isOutsideWorkspace = isPathOutsideWorkspace(resolvedPath)

		const sharedMessageProps: ShoferSayTool = {
			tool: "grepSearch",
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

			// Resolve the ignoreController once so both the --ignore-file path and
			// the post-filter below share the same reference.
			const ignoreController: ShoferIgnoreController | undefined = task.shoferIgnoreController

			const vscodeAppRoot = vscode.env.appRoot
			const rgPath = await getRipgrepBinPath(vscodeAppRoot)

			if (!rgPath) {
				pushToolResult("Search failed: Could not find ripgrep binary")
				return
			}

			// If .shoferignore is loaded, pass it directly to ripgrep so ignored
			// files are excluded at the search level. The post-filter below is kept
			// as a safety net, but without this flag ripgrep would scan ignored
			// files and their output could exhaust the maxLines budget before any
			// legitimate results are captured.
			const shoferIgnoreFile =
				ignoreController?.shoferIgnoreContent !== undefined ? path.join(task.cwd, ".shoferignore") : undefined

			const rgArgs = buildRipgrepArgs({
				query,
				isRegex,
				caseSensitive,
				wholeWord,
				fileTypes,
				excludePattern,
				contextBefore,
				contextAfter,
				directoryPath: resolvedPath,
				shoferIgnoreFile,
			})

			// Fetch 2× maxResults worth of ripgrep output so the post-processing
			// hit count can exceed maxResults and the truncation flag fires.
			// Each ripgrep JSON result block is: begin(1) + contextBefore + match(1)
			// + contextAfter + end(1) lines.
			const linesPerResult = 1 + contextBefore + 1 + contextAfter + 1
			const maxRgLines = 2 * maxResults * linesPerResult

			let rawOutput: string
			try {
				rawOutput = await execRipgrep(rgPath, rgArgs, maxRgLines)
			} catch (error) {
				outputError("Error executing ripgrep:", error)
				pushToolResult(`No results found for: ${query}`)
				return
			}

			const fileResults = parseRipgrepOutput(rawOutput)

			// Post-filter: remove any results from files that .shoferignore should
			// exclude. This is a safety net for cases where ripgrep's --ignore-file
			// did not eliminate a path (e.g. controller not yet initialised when the
			// task started, or the file was created after ripgrep launched).
			const filteredResults = ignoreController
				? fileResults.filter((fr) => ignoreController.validateAccess(fr.file))
				: fileResults

			// Convert ripgrep results to SearchHit format for formatting
			const hits = this.convertToSearchHits(filteredResults, task.cwd, contextBefore, contextAfter)

			// Apply maxResults cap
			const truncated = hits.length > maxResults
			const cappedHits = truncated ? hits.slice(0, maxResults) : hits

			if (cappedHits.length === 0) {
				pushToolResult(`No results found for: ${query}`)
				return
			}

			const output = this.formatResults(cappedHits, query, maxResults, truncated, contextBefore)
			pushToolResult(output)
		} catch (error) {
			await handleError("searching files", error as Error)
		}
	}

	/**
	 * Convert ripgrep file results into SearchHit format suitable for formatting.
	 * Groups match/context lines by file and detects non-contiguous blocks.
	 */
	private convertToSearchHits(
		fileResults: RipgrepFileResult[],
		cwd: string,
		beforeContext: number,
		afterContext: number,
	): SearchHit[] {
		const hitsByFile = new Map<string, SearchHit>()

		for (const fileResult of fileResults) {
			const relPath = getReadablePath(cwd, fileResult.file)
			if (!hitsByFile.has(relPath)) {
				hitsByFile.set(relPath, { relPath, lines: new Map(), matchLines: new Set() })
			}
			const hit = hitsByFile.get(relPath)!

			for (const match of fileResult.matches) {
				const lineNum = match.lineNumber
				hit.lines.set(lineNum, match.text.trimEnd())
				if (match.isMatch) {
					hit.matchLines.add(lineNum)
				}
			}
		}

		return Array.from(hitsByFile.values())
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
		maxResults: number,
		truncated: boolean,
		beforeContext: number,
	): string {
		const totalShown = hits.reduce((sum, h) => sum + h.matchLines.size, 0)
		const header = formatTruncationHeader({ totalShown, maxResults, truncated }) + "\n\n"

		const fileBlocks: string[] = []
		for (const hit of hits) {
			const sortedLines = [...hit.lines.entries()].sort((a, b) => a[0] - b[0])

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
						const prefix = hit.matchLines.has(lineNum) ? ">" : " "
						const paddedNum = String(lineNum).padStart(4, " ")
						return `${prefix} ${paddedNum} | ${text}`
					})
					.join("\n"),
			)

			fileBlocks.push(`## ${hit.relPath}\n${blockTexts.join("\n----\n")}`)
		}

		return header + fileBlocks.join("\n\n")
	}

	override async handlePartial(task: Task, block: ToolUse<"grep_search">): Promise<void> {
		const relDirPath = block.params.path
		const query = block.params.query

		const absolutePath = relDirPath ? path.resolve(task.cwd, relDirPath) : task.cwd
		const isOutsideWorkspace = isPathOutsideWorkspace(absolutePath)

		const sharedMessageProps: ShoferSayTool = {
			tool: "grepSearch",
			path: getReadablePath(task.cwd, relDirPath ?? ""),
			regex: query ?? "",
			filePattern: (block.nativeArgs?.fileTypes as string) ?? "",
			isOutsideWorkspace,
		}

		const partialMessage = JSON.stringify({ ...sharedMessageProps, content: "" } satisfies ShoferSayTool)
		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const grepSearchTool = new GrepSearchTool()
