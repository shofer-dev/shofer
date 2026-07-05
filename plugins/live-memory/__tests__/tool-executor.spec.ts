import { describe, it, expect, vi } from "vitest"

import { LiveMemoryToolExecutor, MAX_TOOL_OUTPUT_BYTES, type GitRunResult, type ToolExecutorDeps } from "../tool-executor.js"
import type { FindFilesOptions, HostFileSystem, PluginSearch } from "@shofer/types"

const CWD = "/ws"

/** Convert a simplified glob to an anchored RegExp (supports `**`, `*`, `/`). */
function globToRegExp(pattern: string): RegExp {
	let re = ""
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i]!
		if (c === "*") {
			if (pattern[i + 1] === "*") {
				// `**/` → optional any-dirs; bare `**` → anything.
				if (pattern[i + 2] === "/") {
					re += "(?:.*/)?"
					i += 2
				} else {
					re += ".*"
					i += 1
				}
			} else {
				re += "[^/]*"
			}
		} else if ("\\^$+?.()|[]{}".includes(c)) {
			re += "\\" + c
		} else {
			re += c
		}
	}
	return new RegExp(`^${re}$`)
}

/** In-memory {@link HostFileSystem} keyed by absolute path. */
function makeFs(files: Record<string, string>): HostFileSystem {
	const map = new Map(Object.entries(files))
	return {
		async readFile(p) {
			const c = map.get(p)
			if (c === undefined) throw new Error(`ENOENT: ${p}`)
			return c
		},
		async writeFile() {},
		async exists(p) {
			return map.has(p)
		},
		async mkdir() {},
		async delete() {},
		async findFiles(pattern: string, opts: FindFilesOptions) {
			const re = globToRegExp(pattern)
			const excludes = (opts.exclude ?? []).map(globToRegExp)
			const out: string[] = []
			for (const abs of map.keys()) {
				if (!abs.startsWith(opts.cwd + "/")) continue
				const rel = abs.slice(opts.cwd.length + 1)
				if (!re.test(rel)) continue
				if (excludes.some((ex) => ex.test(rel))) continue
				out.push(abs)
				if (opts.maxResults && out.length >= opts.maxResults) break
			}
			return out
		},
	}
}

function makeSearch(): PluginSearch {
	return {
		async ragSearch() {
			return [{ filePath: "src/a.ts", startLine: 10, endLine: 12, score: 0.876, snippet: "const x = 1" }]
		},
		async gitSearch() {
			return [
				{
					commitHash: "deadbeefcafe",
					shortHash: "deadbee",
					author: "Ada",
					authorDate: "2026-01-02",
					subject: "fix bug",
					body: "details here",
					score: 0.5,
				},
			]
		},
		async codeUsages(symbol) {
			return [{ name: symbol, kind: "Function", filePath: "src/a.ts", line: 42 }]
		},
		async diagnostics() {
			return [
				{ filePath: "src/a.ts", line: 3, column: 5, severity: "error", message: "boom" },
				{ filePath: "src/a.ts", line: 9, column: 1, severity: "warning", message: "careful" },
				{ filePath: "src/a.ts", line: 1, column: 1, severity: "hint", message: "ignored" },
			]
		},
	}
}

const FILES = {
	"/ws/package.json": `{"name":"demo"}`,
	"/ws/README.md": "# Demo\nhello world",
	"/ws/src/a.ts": "line1\nline2 needle\nline3",
	"/ws/src/b.ts": "no match here",
	"/ws/node_modules/dep/index.js": "junk",
}

function makeExecutor(overrides: Partial<ToolExecutorDeps> = {}) {
	return new LiveMemoryToolExecutor({
		cwd: CWD,
		fs: makeFs(FILES),
		search: makeSearch(),
		...overrides,
	})
}

describe("LiveMemoryToolExecutor (plugin port)", () => {
	it("read_file returns a numbered slice with a header and honors offset/limit", async () => {
		const exec = makeExecutor()
		const r = await exec.execute("read_file", JSON.stringify({ path: "src/a.ts", offset: 2, limit: 1 }))
		expect(r.isError).toBeFalsy()
		expect(r.content).toContain("src/a.ts (lines 2-2 of 3):")
		expect(r.content).toContain("2 | line2 needle")
		expect(r.content).toContain("[truncated; file has 3 lines total]")
	})

	it("read_file errors on a missing path param", async () => {
		const r = await makeExecutor().execute("read_file", "{}")
		expect(r.isError).toBe(true)
		expect(r.content).toMatch(/Missing required parameter 'path'/)
	})

	it("grep_search finds regex matches across globbed files (excluding unreadable)", async () => {
		const r = await makeExecutor().execute("grep_search", JSON.stringify({ regex: "needle" }))
		expect(r.content).toContain("src/a.ts:2: line2 needle")
		expect(r.content).not.toContain("b.ts")
	})

	it("grep_search reports no matches cleanly", async () => {
		const r = await makeExecutor().execute("grep_search", JSON.stringify({ regex: "zzz-none" }))
		expect(r.content).toBe("No matches found.")
	})

	it("list_files non-recursive lists only immediate children", async () => {
		const r = await makeExecutor().execute("list_files", JSON.stringify({}))
		expect(r.content).toContain("package.json")
		expect(r.content).toContain("README.md")
		expect(r.content).not.toContain("src/a.ts")
	})

	it("find_files matches a glob pattern relative to the workspace", async () => {
		const r = await makeExecutor().execute("find_files", JSON.stringify({ pattern: "**/*.ts" }))
		expect(r.content).toContain("src/a.ts")
		expect(r.content).toContain("src/b.ts")
		expect(r.content).not.toContain("package.json")
	})

	it("get_project_setup_info detects present manifests", async () => {
		const r = await makeExecutor().execute("get_project_setup_info", "{}")
		expect(r.content).toContain("Workspace root: /ws")
		expect(r.content).toContain("package.json")
		expect(r.content).toContain("README.md")
	})

	it("get_changed_files shells out through the injected git runner", async () => {
		const runGit = vi.fn(
			(): GitRunResult => ({ status: 0, stdout: " M src/a.ts\n?? new.ts\n", stderr: "" }),
		)
		const exec = makeExecutor({ runGit })
		const r = await exec.execute("get_changed_files", "{}")
		expect(runGit).toHaveBeenCalledWith(["status", "--porcelain"], "/ws")
		expect(r.content).toContain("M src/a.ts")
		expect(r.content).toContain("?? new.ts")
	})

	it("get_changed_files surfaces a git failure as an error", async () => {
		const exec = makeExecutor({ runGit: () => ({ status: null, stdout: "", stderr: "", error: "git not found" }) })
		const r = await exec.execute("get_changed_files", "{}")
		expect(r.isError).toBe(true)
		expect(r.content).toMatch(/git status failed: git not found/)
	})

	it("fetch_web_page strips HTML from a fetched page", async () => {
		const fetchImpl = vi.fn(async () =>
			new Response("<html><body><script>x()</script><h1>Title</h1><p>Body text</p></body></html>", {
				status: 200,
			}),
		)
		const exec = makeExecutor({ fetch: fetchImpl })
		const r = await exec.execute("fetch_web_page", JSON.stringify({ urls: ["https://example.com"] }))
		expect(r.content).toContain("# https://example.com")
		expect(r.content).toContain("Title Body text")
		expect(r.content).not.toContain("x()")
	})

	it("fetch_web_page errors when no host fetch was granted", async () => {
		const exec = makeExecutor({ fetch: undefined })
		const r = await exec.execute("fetch_web_page", JSON.stringify({ urls: ["https://example.com"] }))
		expect(r.isError).toBe(true)
		expect(r.content).toMatch(/network access/)
	})

	it("rag_search formats scored code-index hits from ctx.host.search", async () => {
		const r = await makeExecutor().execute("rag_search", JSON.stringify({ query: "where" }))
		expect(r.content).toContain("[1] src/a.ts:10-12 (score=0.876)")
		expect(r.content).toContain("const x = 1")
	})

	it("git_search formats commit hits from ctx.host.search", async () => {
		const r = await makeExecutor().execute("git_search", JSON.stringify({ query: "bug" }))
		expect(r.content).toContain("[1] deadbee (deadbeefcafe) | 2026-01-02 | Ada")
		expect(r.content).toContain("fix bug")
		expect(r.content).toContain("details here")
	})

	it("list_code_usages formats workspace symbols from ctx.host.search", async () => {
		const r = await makeExecutor().execute("list_code_usages", JSON.stringify({ symbol: "doThing" }))
		expect(r.content).toBe("doThing (Function) — src/a.ts:42")
	})

	it("get_errors renders only error/warning diagnostics (hints filtered)", async () => {
		const r = await makeExecutor().execute("get_errors", "{}")
		expect(r.content).toContain("src/a.ts:3:5 ERROR boom")
		expect(r.content).toContain("src/a.ts:9:1 WARN careful")
		expect(r.content).not.toContain("ignored")
	})

	it("search-backed tools error clearly when ctx.host.search is absent", async () => {
		const exec = makeExecutor({ search: undefined })
		for (const tool of ["rag_search", "git_search", "list_code_usages", "get_errors"]) {
			const r = await exec.execute(tool, JSON.stringify({ query: "x", symbol: "x" }))
			expect(r.isError).toBe(true)
			expect(r.content).toMatch(/host search access/)
		}
	})

	it("surfaces invalid JSON args as a structured error", async () => {
		const r = await makeExecutor().execute("read_file", "{not json")
		expect(r.isError).toBe(true)
		expect(r.content).toMatch(/Invalid JSON arguments for read_file/)
	})

	it("rejects an unknown tool", async () => {
		const r = await makeExecutor().execute("delete_everything", "{}")
		expect(r.isError).toBe(true)
		expect(r.content).toMatch(/not available/)
	})

	it("truncates output over the 200KB cap", async () => {
		const big = "x".repeat(MAX_TOOL_OUTPUT_BYTES + 5_000)
		const fs = makeFs({ "/ws/big.txt": big })
		const exec = new LiveMemoryToolExecutor({ cwd: CWD, fs })
		const r = await exec.execute("read_file", JSON.stringify({ path: "big.txt", limit: 1 }))
		expect(Buffer.byteLength(r.content, "utf-8")).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_BYTES + 100)
		expect(r.content).toMatch(/\[truncated: \d+ bytes total/)
	})
})
