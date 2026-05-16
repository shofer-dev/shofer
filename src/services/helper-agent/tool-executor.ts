/**
 * HelperAgentToolExecutor — read-only tool dispatcher for the Helper Agent.
 *
 * The Helper Agent runs outside the main `Task` plumbing (no chat UI, no
 * approval flow, no file-context tracker), so it cannot reuse the
 * `BaseTool` implementations directly — those are tightly coupled to
 * `Task` (consecutiveMistakeCount, providerRef, fileContextTracker,
 * say()/ask()/pushToolResult, …). Instead this module wraps the
 * underlying utility layer (`ripgrep`, `glob/list-files`,
 * `extractTextFromFile`, `CodeIndexManager`, raw VS Code APIs) into a
 * minimal `execute(name, argsJson)` interface that returns a string for
 * the model to consume in the next turn of the agent loop.
 *
 * Only Read-category tools are exposed (TOOL_GROUPS.read in
 * packages/types/src/tool.ts), minus `ask_helper_agent` itself to prevent
 * recursion. Every implementation is read-only and side-effect-free with
 * respect to workspace files.
 */

import * as fs from "fs/promises"
import * as path from "path"
import * as vscode from "vscode"
import { Buffer } from "buffer"

import { extractTextFromFile, addLineNumbers } from "../../integrations/misc/extract-text"
import { regexGrepSearch } from "../ripgrep"
import { listFiles as globListFiles } from "../glob/list-files"
import { CodeIndexManager } from "../code-index/manager"
import { logger } from "../../utils/logging"

const LOG_PREFIX = "[HelperAgent.ToolExecutor]"

/** Maximum bytes returned for a single tool call; over this we truncate. */
const MAX_TOOL_OUTPUT_BYTES = 200_000

/** Default max files returned by list_files / find_files. */
const DEFAULT_LIST_LIMIT = 500

/** Result of a tool invocation. */
export interface ToolExecutionResult {
	/** Text content fed back to the model as the tool_result. */
	content: string
	/** True when the tool failed; the model is told so it can recover. */
	isError?: boolean
}

/** Set of tool names the helper agent is allowed to call. */
export const HELPER_AGENT_READ_TOOLS = [
	"read_file",
	"grep_search",
	"list_files",
	"rag_search",
	"find_files",
	"read_project_structure",
	"view_image",
	"list_code_usages",
	"get_errors",
	"get_project_setup_info",
	"get_changed_files",
	"lsp_search",
	"fetch_web_page",
] as const

export type HelperAgentReadTool = (typeof HELPER_AGENT_READ_TOOLS)[number]

export class HelperAgentToolExecutor {
	private readonly _cwd: string
	private readonly _context: vscode.ExtensionContext

	constructor(cwd: string, context: vscode.ExtensionContext) {
		this._cwd = cwd
		this._context = context
	}

	/**
	 * Dispatch a tool call. `argsJson` is the raw JSON string the model
	 * produced; on parse failure we surface a structured error so the model
	 * can self-correct on the next turn. Errors during execution are caught
	 * and returned as `{ isError: true, content: ... }` rather than thrown.
	 */
	public async execute(name: string, argsJson: string, signal?: AbortSignal): Promise<ToolExecutionResult> {
		const start = Date.now()
		let args: any
		try {
			args = argsJson && argsJson.trim() ? JSON.parse(argsJson) : {}
		} catch (e) {
			return {
				isError: true,
				content: `Invalid JSON arguments for ${name}: ${e instanceof Error ? e.message : String(e)}`,
			}
		}

		try {
			let result: ToolExecutionResult
			switch (name) {
				case "read_file":
					result = await this._readFile(args)
					break
				case "grep_search":
					result = await this._grepSearch(args)
					break
				case "list_files":
					result = await this._listFiles(args)
					break
				case "find_files":
					result = await this._findFiles(args)
					break
				case "rag_search":
					result = await this._ragSearch(args)
					break
				case "read_project_structure":
					result = await this._readProjectStructure(args)
					break
				case "view_image":
					result = await this._viewImage(args)
					break
				case "list_code_usages":
					result = await this._listCodeUsages(args)
					break
				case "get_errors":
					result = await this._getErrors(args)
					break
				case "get_project_setup_info":
					result = await this._getProjectSetupInfo()
					break
				case "get_changed_files":
					result = await this._getChangedFiles()
					break
				case "lsp_search":
					result = await this._lspSearch(args)
					break
				case "fetch_web_page":
					result = await this._fetchWebPage(args, signal)
					break
				default:
					result = { isError: true, content: `Tool '${name}' is not available to the helper agent.` }
			}
			result.content = truncateOutput(result.content)
			logger.info(
				`${LOG_PREFIX} ${name} done in ${Date.now() - start}ms isError=${result.isError ?? false} bytes=${result.content.length}`,
			)
			return result
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e)
			logger.error(`${LOG_PREFIX} ${name} threw after ${Date.now() - start}ms: ${message}`)
			return { isError: true, content: `Error executing ${name}: ${message}` }
		}
	}

	// ─── Tool implementations ───────────────────────────────────────────

	private async _readFile(args: { path?: string; offset?: number; limit?: number }): Promise<ToolExecutionResult> {
		if (!args.path) return { isError: true, content: "Missing required parameter 'path'." }
		const abs = path.resolve(this._cwd, args.path)
		const text = await extractTextFromFile(abs)
		const offset = Math.max(1, args.offset ?? 1)
		const limit = Math.max(1, args.limit ?? 2000)
		const lines = text.split("\n")
		const slice = lines.slice(offset - 1, offset - 1 + limit)
		const numbered = addLineNumbers(slice.join("\n"), offset)
		const total = lines.length
		const trailer = offset - 1 + slice.length < total ? `\n[truncated; file has ${total} lines total]` : ""
		return {
			content: `${args.path} (lines ${offset}-${offset - 1 + slice.length} of ${total}):\n${numbered}${trailer}`,
		}
	}

	private async _grepSearch(args: {
		path?: string
		regex?: string
		file_pattern?: string
		filePattern?: string
	}): Promise<ToolExecutionResult> {
		if (!args.regex) return { isError: true, content: "Missing required parameter 'regex'." }
		const dir = args.path ? path.resolve(this._cwd, args.path) : this._cwd
		const filePattern = args.file_pattern ?? args.filePattern
		const out = await regexGrepSearch(this._cwd, dir, args.regex, filePattern)
		return { content: out || "No matches found." }
	}

	private async _listFiles(args: {
		path?: string
		recursive?: boolean
		limit?: number
	}): Promise<ToolExecutionResult> {
		const dir = args.path ? path.resolve(this._cwd, args.path) : this._cwd
		const limit = Math.max(1, args.limit ?? DEFAULT_LIST_LIMIT)
		const [entries, hitLimit] = await globListFiles(dir, args.recursive ?? false, limit)
		const trailer = hitLimit ? `\n[truncated at ${limit} entries]` : ""
		return { content: entries.map((p) => path.relative(this._cwd, p) || p).join("\n") + trailer }
	}

	private async _findFiles(args: { pattern?: string; limit?: number }): Promise<ToolExecutionResult> {
		// Approximate find_files via VS Code's findFiles glob API (respects .gitignore).
		const pattern = args.pattern ?? "**/*"
		const limit = Math.max(1, args.limit ?? DEFAULT_LIST_LIMIT)
		const uris = await vscode.workspace.findFiles(pattern, undefined, limit)
		return {
			content:
				uris.map((u) => path.relative(this._cwd, u.fsPath)).join("\n") +
				(uris.length === limit ? `\n[truncated at ${limit} entries]` : ""),
		}
	}

	private async _ragSearch(args: { query?: string; directory_prefix?: string }): Promise<ToolExecutionResult> {
		if (!args.query) return { isError: true, content: "Missing required parameter 'query'." }
		const mgr = CodeIndexManager.getInstance(this._context, this._cwd)
		if (!mgr) return { isError: true, content: "Code index manager is not available for this workspace." }
		const results = await mgr.searchIndex(args.query, args.directory_prefix)
		if (!results || results.length === 0) return { content: "No results found." }
		return {
			content: results
				.map(
					(r: any, i: number) =>
						`[${i + 1}] ${r.payload?.filePath ?? "?"}:${r.payload?.startLine ?? "?"}-${r.payload?.endLine ?? "?"} (score=${r.score?.toFixed(3) ?? "?"})\n${(r.payload?.codeChunk ?? "").slice(0, 800)}`,
				)
				.join("\n\n"),
		}
	}

	private async _readProjectStructure(args: { max_depth?: number }): Promise<ToolExecutionResult> {
		// Cheap implementation: list top-level entries up to max_depth using fs.readdir.
		const maxDepth = Math.max(1, Math.min(5, args.max_depth ?? 2))
		const lines: string[] = []
		const walk = async (dir: string, depth: number, prefix: string): Promise<void> => {
			if (depth > maxDepth) return
			let entries: any[]
			try {
				entries = await fs.readdir(dir, { withFileTypes: true })
			} catch {
				return
			}
			entries.sort((a, b) => a.name.localeCompare(b.name))
			for (const ent of entries) {
				if (ent.name.startsWith(".")) continue
				if (ent.name === "node_modules" || ent.name === "dist" || ent.name === "build") continue
				lines.push(`${prefix}${ent.name}${ent.isDirectory() ? "/" : ""}`)
				if (ent.isDirectory()) await walk(path.join(dir, ent.name), depth + 1, prefix + "  ")
			}
		}
		await walk(this._cwd, 1, "")
		return { content: lines.join("\n") }
	}

	private async _viewImage(args: { path?: string }): Promise<ToolExecutionResult> {
		if (!args.path) return { isError: true, content: "Missing required parameter 'path'." }
		const abs = path.resolve(this._cwd, args.path)
		const stat = await fs.stat(abs)
		// Returning a base64 image as part of a tool_result string is not ideal,
		// but the helper agent currently does not surface multimodal content
		// blocks back to the model. We return metadata + a note instead.
		return {
			content: `Image file ${args.path} (${stat.size} bytes). The helper agent does not currently support inline image rendering; describe the image's role from context instead.`,
		}
	}

	private async _listCodeUsages(args: { symbol?: string; file_path?: string }): Promise<ToolExecutionResult> {
		if (!args.symbol) return { isError: true, content: "Missing required parameter 'symbol'." }
		// Best effort via workspace symbol provider.
		const symbols =
			(await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
				"vscode.executeWorkspaceSymbolProvider",
				args.symbol,
			)) ?? []
		if (symbols.length === 0) return { content: `No symbol matches found for '${args.symbol}'.` }
		const lines = symbols.slice(0, 50).map((s) => {
			const loc = s.location
			return `${s.name} (${vscode.SymbolKind[s.kind]}) — ${path.relative(this._cwd, loc.uri.fsPath)}:${loc.range.start.line + 1}`
		})
		return { content: lines.join("\n") }
	}

	private async _getErrors(args: { path?: string }): Promise<ToolExecutionResult> {
		const all = vscode.languages.getDiagnostics()
		const lines: string[] = []
		for (const [uri, diags] of all) {
			const rel = path.relative(this._cwd, uri.fsPath)
			if (args.path && !rel.startsWith(args.path) && rel !== args.path) continue
			for (const d of diags) {
				if (d.severity !== vscode.DiagnosticSeverity.Error && d.severity !== vscode.DiagnosticSeverity.Warning)
					continue
				const sev = d.severity === vscode.DiagnosticSeverity.Error ? "ERROR" : "WARN"
				lines.push(`${rel}:${d.range.start.line + 1}:${d.range.start.character + 1} ${sev} ${d.message}`)
			}
		}
		return { content: lines.length === 0 ? "No diagnostics." : lines.join("\n") }
	}

	private async _getProjectSetupInfo(): Promise<ToolExecutionResult> {
		const candidates = [
			"package.json",
			"go.mod",
			"go.work",
			"requirements.txt",
			"pyproject.toml",
			"Cargo.toml",
			"BUILD.bazel",
			"MODULE.bazel",
			"README.md",
		]
		const found: string[] = []
		for (const c of candidates) {
			try {
				await fs.access(path.join(this._cwd, c))
				found.push(c)
			} catch {
				/* not present */
			}
		}
		return { content: `Workspace root: ${this._cwd}\nDetected manifests: ${found.join(", ") || "(none)"}` }
	}

	private async _getChangedFiles(): Promise<ToolExecutionResult> {
		// Minimal git status via child_process to avoid pulling in a git lib.
		const { spawnSync } = await import("child_process")
		const r = spawnSync("git", ["status", "--porcelain"], { cwd: this._cwd, encoding: "utf-8" })
		if (r.error) return { isError: true, content: `git status failed: ${r.error.message}` }
		if (r.status !== 0) return { isError: true, content: `git status exit=${r.status}: ${r.stderr}` }
		return { content: r.stdout.trim() || "(no changes)" }
	}

	private async _lspSearch(args: { query?: string }): Promise<ToolExecutionResult> {
		if (!args.query) return { isError: true, content: "Missing required parameter 'query'." }
		return this._listCodeUsages({ symbol: args.query })
	}

	private async _fetchWebPage(
		args: { urls?: string[]; query?: string },
		signal?: AbortSignal,
	): Promise<ToolExecutionResult> {
		if (!args.urls || args.urls.length === 0)
			return { isError: true, content: "Missing required parameter 'urls'." }
		const out: string[] = []
		for (const url of args.urls) {
			try {
				const res = await fetch(url, { signal })
				if (!res.ok) {
					out.push(`# ${url}\nHTTP ${res.status} ${res.statusText}`)
					continue
				}
				const text = await res.text()
				// Strip tags very loosely; do not pull in a full HTML parser here.
				const stripped = text
					.replace(/<script[\s\S]*?<\/script>/gi, "")
					.replace(/<style[\s\S]*?<\/style>/gi, "")
					.replace(/<[^>]+>/g, " ")
					.replace(/\s+/g, " ")
					.trim()
				out.push(`# ${url}\n${stripped.slice(0, 50_000)}`)
			} catch (e) {
				out.push(`# ${url}\nFETCH ERROR: ${e instanceof Error ? e.message : String(e)}`)
			}
		}
		return { content: out.join("\n\n---\n\n") }
	}
}

function truncateOutput(text: string): string {
	const bytes = Buffer.byteLength(text, "utf-8")
	if (bytes <= MAX_TOOL_OUTPUT_BYTES) return text
	const slice = text.slice(0, MAX_TOOL_OUTPUT_BYTES)
	return `${slice}\n[truncated: ${bytes} bytes total, showing first ${MAX_TOOL_OUTPUT_BYTES}]`
}
