/**
 * LiveMemoryToolExecutor (plugin port) — the read-only tool dispatcher the plugin's
 * future Q&A agent loop (Stage C) offers to the memory LLM.
 *
 * This is the plugin-native reimplementation of the built-in
 * `src/services/live-memory/tool-executor.ts` `LiveMemoryToolExecutor`, built ONLY on the
 * public plugin host surface — `ctx.host.fs` ({@link HostFileSystem}), `ctx.host.fetch`,
 * and the new `ctx.host.search` ({@link PluginSearch}) — with no reach into `@shofer/core`
 * internals. The tool **names** and result **shapes** match the built-in so the ported
 * agent loop can use them unchanged.
 *
 * Backing of each tool (see the two groups):
 * - `read_file` / `grep_search` / `list_files` / `find_files` / `get_project_setup_info`
 *   / `get_changed_files` — **fs-backed** (`ctx.host.fs`; `get_changed_files` shells out to
 *   `git` like the built-in).
 * - `fetch_web_page` — **fetch-backed** (`ctx.host.fetch`, scoped to `permissions.network`).
 * - `rag_search` / `git_search` / `list_code_usages` / `get_errors` — **search-backed**
 *   (`ctx.host.search`; the seam added in Piece 1).
 *
 * Every implementation is read-only. Output over {@link MAX_TOOL_OUTPUT_BYTES} is truncated,
 * mirroring the built-in's 200KB cap.
 *
 * Reduced-fidelity notes vs. the built-in (the plugin host surface is narrower than raw
 * VS Code):
 * - `grep_search` has no ripgrep; it globs candidate files via `ctx.host.fs.findFiles`
 *   and regex-scans them (bounded by {@link GREP_MAX_FILES}).
 * - `list_files` is approximated with a glob (`*` / `**\/*`) rather than a directory read.
 */

import { spawnSync } from "node:child_process"
import { resolve as resolvePath, relative as relativePath } from "node:path"

import type { HostFileSystem, PluginContext, PluginSearch } from "@shofer/types"

/** Maximum bytes returned for a single tool call; over this we truncate. */
export const MAX_TOOL_OUTPUT_BYTES = 200_000

/** Default max entries returned by list_files / find_files. */
const DEFAULT_LIST_LIMIT = 500

/** Max files grep_search will open + scan (no ripgrep on the plugin host surface). */
const GREP_MAX_FILES = 2000

/** Result of a tool invocation. */
export interface ToolExecutionResult {
	/** Text content fed back to the model as the tool_result. */
	content: string
	/** True when the tool failed; the model is told so it can recover. */
	isError?: boolean
}

/** Set of tool names the plugin's live memory agent loop is allowed to call. */
export const LIVE_MEMORY_PLUGIN_READ_TOOLS = [
	"read_file",
	"grep_search",
	"list_files",
	"find_files",
	"get_changed_files",
	"get_project_setup_info",
	"fetch_web_page",
	"rag_search",
	"git_search",
	"list_code_usages",
	"get_errors",
] as const

export type LiveMemoryPluginReadTool = (typeof LIVE_MEMORY_PLUGIN_READ_TOOLS)[number]

/** Result of a git invocation (the injectable seam {@link ToolExecutorDeps.runGit} returns). */
export interface GitRunResult {
	status: number | null
	stdout: string
	stderr: string
	/** Set when the process could not be spawned at all (e.g. git not installed). */
	error?: string
}

/** Dependencies the executor runs over — pulled from a {@link PluginContext} (see {@link fromContext}). */
export interface ToolExecutorDeps {
	/** Absolute workspace root all relative paths resolve against. */
	cwd: string
	/** Host filesystem (scoped to the plugin's `permissions.filesystem` grant). */
	fs: HostFileSystem
	/** Host fetch (scoped to `permissions.network`). Absent ⇒ `fetch_web_page` errors. */
	fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>
	/** Host search (`ctx.host.search`). Absent ⇒ the search-backed tools error. */
	search?: PluginSearch
	/** Git runner (injectable for tests). Defaults to a `spawnSync("git", …)` shell-out. */
	runGit?: (args: string[], cwd: string) => GitRunResult
}

const DEFAULT_RUN_GIT = (args: string[], cwd: string): GitRunResult => {
	const r = spawnSync("git", args, { cwd, encoding: "utf-8" })
	return {
		status: r.status,
		stdout: r.stdout ?? "",
		stderr: r.stderr ?? "",
		error: r.error ? r.error.message : undefined,
	}
}

export class LiveMemoryToolExecutor {
	private readonly cwd: string
	private readonly fs: HostFileSystem
	private readonly fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>
	private readonly search?: PluginSearch
	private readonly runGit: (args: string[], cwd: string) => GitRunResult

	constructor(deps: ToolExecutorDeps) {
		this.cwd = deps.cwd
		this.fs = deps.fs
		this.fetchImpl = deps.fetch
		this.search = deps.search
		this.runGit = deps.runGit ?? DEFAULT_RUN_GIT
	}

	/**
	 * Build an executor from a plugin hook context. Requires `ctx.host.fs`; when absent it
	 * throws (the agent loop should not offer read tools without a filesystem grant).
	 */
	static fromContext(ctx: PluginContext): LiveMemoryToolExecutor {
		const fs = ctx.host?.fs
		if (!fs) {
			throw new Error("LiveMemoryToolExecutor: ctx.host.fs is unavailable (grant permissions.filesystem).")
		}
		return new LiveMemoryToolExecutor({
			cwd: ctx.workspacePath ?? ctx.cwd ?? process.cwd(),
			fs,
			// `fetch` is a required method on PluginHost, so gate on the host itself.
			fetch: ctx.host ? (input, init) => ctx.host!.fetch(input, init) : undefined,
			search: ctx.host?.search,
		})
	}

	/**
	 * Dispatch a tool call. `argsJson` is the raw JSON string the model produced; on parse
	 * failure we surface a structured error so the model can self-correct. Errors during
	 * execution are caught and returned as `{ isError: true, content }` rather than thrown.
	 */
	async execute(name: string, argsJson: string, signal?: AbortSignal): Promise<ToolExecutionResult> {
		let args: Record<string, unknown>
		try {
			args = argsJson && argsJson.trim() ? (JSON.parse(argsJson) as Record<string, unknown>) : {}
		} catch (e) {
			return { isError: true, content: `Invalid JSON arguments for ${name}: ${errMsg(e)}` }
		}

		try {
			let result: ToolExecutionResult
			switch (name) {
				case "read_file":
					result = await this.readFile(args)
					break
				case "grep_search":
					result = await this.grepSearch(args)
					break
				case "list_files":
					result = await this.listFiles(args)
					break
				case "find_files":
					result = await this.findFiles(args)
					break
				case "get_changed_files":
					result = this.getChangedFiles()
					break
				case "get_project_setup_info":
					result = await this.getProjectSetupInfo()
					break
				case "fetch_web_page":
					result = await this.fetchWebPage(args, signal)
					break
				case "rag_search":
					result = await this.ragSearch(args)
					break
				case "git_search":
					result = await this.gitSearch(args)
					break
				case "list_code_usages":
					result = await this.listCodeUsages(args)
					break
				case "get_errors":
					result = await this.getErrors(args)
					break
				default:
					result = { isError: true, content: `Tool '${name}' is not available to the live memory.` }
			}
			result.content = truncateOutput(result.content)
			return result
		} catch (e) {
			return { isError: true, content: `Error executing ${name}: ${errMsg(e)}` }
		}
	}

	// ─── fs-backed ──────────────────────────────────────────────────────────

	private async readFile(args: Record<string, unknown>): Promise<ToolExecutionResult> {
		const p = asString(args.path)
		if (!p) return missing("path")
		const abs = resolvePath(this.cwd, p)
		const text = await this.fs.readFile(abs)
		const offset = Math.max(1, asNumber(args.offset) ?? 1)
		const limit = Math.max(1, asNumber(args.limit) ?? 2000)
		const lines = text.split("\n")
		const slice = lines.slice(offset - 1, offset - 1 + limit)
		const total = lines.length
		const numbered = addLineNumbers(slice, offset)
		const trailer = offset - 1 + slice.length < total ? `\n[truncated; file has ${total} lines total]` : ""
		return { content: `${p} (lines ${offset}-${offset - 1 + slice.length} of ${total}):\n${numbered}${trailer}` }
	}

	private async grepSearch(args: Record<string, unknown>): Promise<ToolExecutionResult> {
		const regexSrc = asString(args.regex)
		if (!regexSrc) return missing("regex")
		let re: RegExp
		try {
			re = new RegExp(regexSrc)
		} catch (e) {
			return { isError: true, content: `Invalid regex '${regexSrc}': ${errMsg(e)}` }
		}
		const dir = asString(args.path) ? resolvePath(this.cwd, asString(args.path)!) : this.cwd
		const filePattern = asString(args.file_pattern) ?? asString(args.filePattern) ?? "**/*"
		const files = await this.fs.findFiles(filePattern, { cwd: dir, maxResults: GREP_MAX_FILES })
		const matches: string[] = []
		for (const file of files) {
			let content: string
			try {
				content = await this.fs.readFile(file)
			} catch {
				continue // Unreadable/binary — skip.
			}
			const rel = relativePath(this.cwd, file) || file
			const fileLines = content.split("\n")
			for (let i = 0; i < fileLines.length; i++) {
				if (re.test(fileLines[i]!)) matches.push(`${rel}:${i + 1}: ${fileLines[i]!.trim()}`)
			}
		}
		const scanned = files.length >= GREP_MAX_FILES ? ` [scan capped at ${GREP_MAX_FILES} files]` : ""
		return { content: matches.length === 0 ? "No matches found." : matches.join("\n") + scanned }
	}

	private async listFiles(args: Record<string, unknown>): Promise<ToolExecutionResult> {
		const dir = asString(args.path) ? resolvePath(this.cwd, asString(args.path)!) : this.cwd
		const limit = Math.max(1, asNumber(args.limit) ?? DEFAULT_LIST_LIMIT)
		const pattern = args.recursive === true ? "**/*" : "*"
		const entries = await this.fs.findFiles(pattern, { cwd: dir, maxResults: limit })
		const trailer = entries.length >= limit ? `\n[truncated at ${limit} entries]` : ""
		return { content: entries.map((p) => relativePath(this.cwd, p) || p).join("\n") + trailer }
	}

	private async findFiles(args: Record<string, unknown>): Promise<ToolExecutionResult> {
		const pattern = asString(args.pattern) ?? "**/*"
		const limit = Math.max(1, asNumber(args.limit) ?? DEFAULT_LIST_LIMIT)
		const uris = await this.fs.findFiles(pattern, { cwd: this.cwd, maxResults: limit })
		const trailer = uris.length >= limit ? `\n[truncated at ${limit} entries]` : ""
		return { content: uris.map((u) => relativePath(this.cwd, u) || u).join("\n") + trailer }
	}

	private getChangedFiles(): ToolExecutionResult {
		const r = this.runGit(["status", "--porcelain"], this.cwd)
		if (r.error) return { isError: true, content: `git status failed: ${r.error}` }
		if (r.status !== 0) return { isError: true, content: `git status exit=${r.status}: ${r.stderr}` }
		return { content: r.stdout.trim() || "(no changes)" }
	}

	private async getProjectSetupInfo(): Promise<ToolExecutionResult> {
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
			if (await this.fs.exists(resolvePath(this.cwd, c))) found.push(c)
		}
		return { content: `Workspace root: ${this.cwd}\nDetected manifests: ${found.join(", ") || "(none)"}` }
	}

	// ─── fetch-backed ───────────────────────────────────────────────────────

	private async fetchWebPage(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolExecutionResult> {
		const urls = Array.isArray(args.urls) ? (args.urls as unknown[]).filter((u): u is string => typeof u === "string") : []
		if (urls.length === 0) return missing("urls")
		if (!this.fetchImpl) {
			return { isError: true, content: "fetch_web_page unavailable: the plugin was not granted host network access (ctx.host.fetch)." }
		}
		const out: string[] = []
		for (const url of urls) {
			try {
				const res = await this.fetchImpl(url, { signal })
				if (!res.ok) {
					out.push(`# ${url}\nHTTP ${res.status} ${res.statusText}`)
					continue
				}
				const text = await res.text()
				const stripped = text
					.replace(/<script[\s\S]*?<\/script>/gi, "")
					.replace(/<style[\s\S]*?<\/style>/gi, "")
					.replace(/<[^>]+>/g, " ")
					.replace(/\s+/g, " ")
					.trim()
				out.push(`# ${url}\n${stripped.slice(0, 50_000)}`)
			} catch (e) {
				out.push(`# ${url}\nFETCH ERROR: ${errMsg(e)}`)
			}
		}
		return { content: out.join("\n\n---\n\n") }
	}

	// ─── search-backed (ctx.host.search) ──────────────────────────────────────

	private async ragSearch(args: Record<string, unknown>): Promise<ToolExecutionResult> {
		const query = asString(args.query)
		if (!query) return missing("query")
		if (!this.search) return noSearch("rag_search")
		const results = await this.search.ragSearch(query, { directoryPrefix: asString(args.directory_prefix) })
		if (results.length === 0) return { content: "No results found." }
		return {
			content: results
				.map(
					(r, i) =>
						`[${i + 1}] ${r.filePath}:${r.startLine}-${r.endLine} (score=${r.score.toFixed(3)})\n${r.snippet}`,
				)
				.join("\n\n"),
		}
	}

	private async gitSearch(args: Record<string, unknown>): Promise<ToolExecutionResult> {
		const query = asString(args.query)
		if (!query) return missing("query")
		if (!this.search) return noSearch("git_search")
		const results = await this.search.gitSearch(query)
		if (results.length === 0) return { content: "No results found." }
		return {
			content: results
				.map(
					(r, i) =>
						`[${i + 1}] ${r.shortHash} (${r.commitHash}) | ${r.authorDate} | ${r.author}\n${r.subject}${r.body ? "\n" + r.body.slice(0, 500) : ""} | score=${r.score.toFixed(3)}`,
				)
				.join("\n\n"),
		}
	}

	private async listCodeUsages(args: Record<string, unknown>): Promise<ToolExecutionResult> {
		const symbol = asString(args.symbol)
		if (!symbol) return missing("symbol")
		if (!this.search) return noSearch("list_code_usages")
		const symbols = await this.search.codeUsages(symbol, { filePath: asString(args.file_path) })
		if (symbols.length === 0) return { content: `No symbol matches found for '${symbol}'.` }
		return { content: symbols.map((s) => `${s.name} (${s.kind}) — ${s.filePath}:${s.line}`).join("\n") }
	}

	private async getErrors(args: Record<string, unknown>): Promise<ToolExecutionResult> {
		if (!this.search) return noSearch("get_errors")
		const diags = await this.search.diagnostics(asString(args.path))
		const lines = diags
			.filter((d) => d.severity === "error" || d.severity === "warning")
			.map((d) => {
				const sev = d.severity === "error" ? "ERROR" : "WARN"
				return `${d.filePath}:${d.line}:${d.column} ${sev} ${d.message}`
			})
		return { content: lines.length === 0 ? "No diagnostics." : lines.join("\n") }
	}
}

// ─── helpers ──────────────────────────────────────────────────────────────

function truncateOutput(text: string): string {
	const bytes = Buffer.byteLength(text, "utf-8")
	if (bytes <= MAX_TOOL_OUTPUT_BYTES) return text
	const slice = text.slice(0, MAX_TOOL_OUTPUT_BYTES)
	return `${slice}\n[truncated: ${bytes} bytes total, showing first ${MAX_TOOL_OUTPUT_BYTES}]`
}

/** Right-align line numbers over a slice starting at `startLine` (1-based). */
function addLineNumbers(lines: string[], startLine: number): string {
	const width = String(startLine + lines.length - 1).length
	return lines.map((line, i) => `${String(startLine + i).padStart(width, " ")} | ${line}`).join("\n")
}

function asString(v: unknown): string | undefined {
	return typeof v === "string" && v.trim() !== "" ? v : undefined
}

function asNumber(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined
}

function missing(param: string): ToolExecutionResult {
	return { isError: true, content: `Missing required parameter '${param}'.` }
}

function noSearch(tool: string): ToolExecutionResult {
	return {
		isError: true,
		content: `${tool} unavailable: the plugin was not granted host search access (ctx.host.search). Add "search": true to the manifest permissions.`,
	}
}

function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e)
}
