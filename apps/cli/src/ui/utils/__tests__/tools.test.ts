// pnpm --filter @shofer/cli test src/ui/utils/__tests__/tools.test.ts

import {
	extractToolData,
	formatToolAskMessage,
	formatToolOutput,
	parseMarkdownChecklist,
	parseTodosFromToolInfo,
} from "../tools.js"

/**
 * The tool-rendering adapters: the CLI receives a tool's `ShoferSayTool` payload
 * as loose JSON and these four functions are what turn it into something the Ink
 * views can render. They are total by construction — every one takes an
 * unvalidated `Record<string, unknown>` and must produce output for it — so the
 * cases below cover both the shapes the agent actually emits and the degenerate
 * ones a malformed payload produces.
 */

describe("extractToolData", () => {
	it("defaults the tool name when the payload does not name one", () => {
		expect(extractToolData({}).tool).toBe("unknown")
	})

	it("carries the common file fields through", () => {
		const data = extractToolData({
			tool: "readFile",
			path: "src/a.ts",
			isOutsideWorkspace: true,
			isProtected: false,
			content: "hello",
			reason: "because",
		})

		expect(data).toMatchObject({
			tool: "readFile",
			path: "src/a.ts",
			isOutsideWorkspace: true,
			isProtected: false,
			content: "hello",
			reason: "because",
		})
	})

	it("omits the optional fields the payload did not carry", () => {
		const data = extractToolData({ tool: "readFile" })

		expect(data.diff).toBeUndefined()
		expect(data.diffStats).toBeUndefined()
		expect(data.regex).toBeUndefined()
		expect(data.batchFiles).toBeUndefined()
		expect(data.batchDiffs).toBeUndefined()
		expect(data.lineNumber).toBeUndefined()
	})

	it("takes a diff and its stats", () => {
		const data = extractToolData({ tool: "appliedDiff", diff: "@@", diffStats: { added: 3, removed: 1 } })
		expect(data.diff).toBe("@@")
		expect(data.diffStats).toEqual({ added: 3, removed: 1 })
	})

	it("drops diffStats that are not a pair of numbers", () => {
		expect(extractToolData({ tool: "appliedDiff", diffStats: { added: 3 } }).diffStats).toBeUndefined()
		expect(extractToolData({ tool: "appliedDiff", diffStats: {} }).diffStats).toBeUndefined()
		expect(
			extractToolData({ tool: "appliedDiff", diffStats: { added: "3", removed: 1 } }).diffStats,
		).toBeUndefined()
	})

	it("takes the search fields", () => {
		const data = extractToolData({ tool: "grepSearch", regex: "foo", filePattern: "*.ts", query: "bar" })
		expect(data).toMatchObject({ regex: "foo", filePattern: "*.ts", query: "bar" })
	})

	it("accepts either spelling of the mode field, with mode_slug winning", () => {
		expect(extractToolData({ tool: "switchMode", mode: "code" }).mode).toBe("code")
		expect(extractToolData({ tool: "switch_mode", mode_slug: "architect" }).mode).toBe("architect")
		expect(extractToolData({ tool: "switch_mode", mode: "code", mode_slug: "architect" }).mode).toBe("architect")
	})

	it("takes the command fields", () => {
		const data = extractToolData({ tool: "executeCommand", command: "ls", output: "a\nb" })
		expect(data).toMatchObject({ command: "ls", output: "a\nb" })
	})

	it("maps a batch file read, defaulting a missing path to the empty string", () => {
		const data = extractToolData({
			tool: "readFile",
			files: [{ path: "a.ts", lineSnippet: "1-10", isOutsideWorkspace: false, key: "k", content: "x" }, {}],
		})

		expect(data.batchFiles).toEqual([
			{ path: "a.ts", lineSnippet: "1-10", isOutsideWorkspace: false, key: "k", content: "x" },
			{ path: "", lineSnippet: undefined, isOutsideWorkspace: undefined, key: undefined, content: undefined },
		])
	})

	it("ignores a `files` field that is not an array", () => {
		expect(extractToolData({ tool: "readFile", files: "a.ts" }).batchFiles).toBeUndefined()
	})

	it("maps batch diffs", () => {
		const data = extractToolData({
			tool: "appliedDiff",
			batchDiffs: [
				{
					path: "a.ts",
					changeCount: 2,
					key: "k",
					content: "c",
					diffStats: { added: 1, removed: 0 },
					diffs: [{ content: "d", startLine: 4 }],
				},
				{},
			],
		})

		expect(data.batchDiffs?.[0]).toMatchObject({ path: "a.ts", changeCount: 2 })
		expect(data.batchDiffs?.[1]?.path).toBe("")
	})

	it("ignores a `batchDiffs` field that is not an array", () => {
		expect(extractToolData({ tool: "appliedDiff", batchDiffs: 1 }).batchDiffs).toBeUndefined()
	})

	it("takes the question, result and display hints", () => {
		const data = extractToolData({
			tool: "attemptCompletion",
			question: "q?",
			result: "done",
			lineNumber: 12,
			additionalFileCount: 3,
		})

		expect(data).toMatchObject({ question: "q?", result: "done", lineNumber: 12, additionalFileCount: 3 })
	})
})

describe("formatToolOutput", () => {
	it("renders a camelCase mode switch, with and without a reason", () => {
		expect(formatToolOutput({ tool: "switchMode", mode: "code", reason: "why" })).toBe("→ code mode\n  why")
		expect(formatToolOutput({ tool: "switchMode" })).toBe("→ unknown mode")
	})

	it("renders a snake_case mode switch, preferring mode_slug", () => {
		expect(formatToolOutput({ tool: "switch_mode", mode_slug: "architect" })).toBe("→ architect mode")
		expect(formatToolOutput({ tool: "switch_mode", mode: "code" })).toBe("→ code mode")
		expect(formatToolOutput({ tool: "switch_mode" })).toBe("→ unknown mode")
	})

	it("renders a command", () => {
		expect(formatToolOutput({ tool: "execute_command", command: "ls -la" })).toBe("$ ls -la")
		expect(formatToolOutput({ tool: "execute_command" })).toBe("$ (no command)")
	})

	it("renders a single read and a batch read", () => {
		expect(formatToolOutput({ tool: "read_file", path: "a.ts" })).toBe("📄 a.ts")
		expect(formatToolOutput({ tool: "read_file" })).toBe("📄 (no path)")
		expect(formatToolOutput({ tool: "read_file", files: [{ path: "a.ts" }, { path: "b.ts" }] })).toBe(
			"📄 a.ts\n📄 b.ts",
		)
		// An empty batch falls back to the single-path rendering.
		expect(formatToolOutput({ tool: "read_file", files: [], path: "a.ts" })).toBe("📄 a.ts")
	})

	it("renders writes and diffs", () => {
		expect(formatToolOutput({ tool: "write_to_file", path: "a.ts" })).toBe("📝 a.ts")
		expect(formatToolOutput({ tool: "write_to_file" })).toBe("📝 (no path)")
		expect(formatToolOutput({ tool: "apply_diff", path: "a.ts" })).toBe("✏️ a.ts")
		expect(formatToolOutput({ tool: "apply_diff" })).toBe("✏️ (no path)")
	})

	it("renders a search, defaulting the path to the cwd", () => {
		expect(formatToolOutput({ tool: "grep_search", regex: "foo", path: "src" })).toBe('🔍 "foo" in src')
		expect(formatToolOutput({ tool: "grep_search", regex: "foo" })).toBe('🔍 "foo" in .')
	})

	it("renders a listing, flagging recursion", () => {
		expect(formatToolOutput({ tool: "list_files", path: "src", recursive: true })).toBe("📁 src (recursive)")
		expect(formatToolOutput({ tool: "list_files" })).toBe("📁 .")
	})

	it("truncates a long completion result at 100 characters", () => {
		expect(formatToolOutput({ tool: "attempt_completion", result: "ok" })).toBe("✅ ok")
		expect(formatToolOutput({ tool: "attempt_completion" })).toBe("✅ Task completed")

		const rendered = formatToolOutput({ tool: "attempt_completion", result: "x".repeat(150) })
		expect(rendered).toBe(`✅ ${"x".repeat(100)}...`)
	})

	it("renders a followup question and a subtask", () => {
		expect(formatToolOutput({ tool: "ask_followup_question", question: "why?" })).toBe("❓ why?")
		expect(formatToolOutput({ tool: "ask_followup_question" })).toBe("❓ (no question)")
		expect(formatToolOutput({ tool: "new_task", mode: "code" })).toBe("📋 Creating subtask in code mode")
		expect(formatToolOutput({ tool: "new_task" })).toBe("📋 Creating subtask")
	})

	it("renders both spellings of the todo update as the marker TodoChangeDisplay looks for", () => {
		expect(formatToolOutput({ tool: "update_todo_list" })).toBe("☑ TODO list updated")
		expect(formatToolOutput({ tool: "updateTodoList" })).toBe("☑ TODO list updated")
	})

	it("falls back to a key: value dump for an unknown tool, JSON-encoding non-strings", () => {
		expect(formatToolOutput({ tool: "mystery", a: "one", b: { c: 2 } })).toBe('a: one\nb: {"c":2}')
	})

	it("truncates each fallback value at 100 characters", () => {
		expect(formatToolOutput({ tool: "mystery", a: "y".repeat(150) })).toBe(`a: ${"y".repeat(100)}...`)
	})

	it("says so when an unknown tool carried no parameters at all", () => {
		expect(formatToolOutput({ tool: "mystery" })).toBe("(no parameters)")
		expect(formatToolOutput({})).toBe("(no parameters)")
	})
})

describe("formatToolAskMessage", () => {
	it("asks about a mode switch under either spelling", () => {
		expect(formatToolAskMessage({ tool: "switchMode", mode: "code", reason: "why" })).toBe(
			"Switch to code mode?\nReason: why",
		)
		expect(formatToolAskMessage({ tool: "switch_mode", mode_slug: "architect" })).toBe("Switch to architect mode?")
		expect(formatToolAskMessage({ tool: "switch_mode" })).toBe("Switch to unknown mode?")
	})

	it("asks about a command", () => {
		expect(formatToolAskMessage({ tool: "execute_command", command: "rm -rf /" })).toBe("Run command?\n$ rm -rf /")
		expect(formatToolAskMessage({ tool: "execute_command" })).toBe("Run command?\n$ (no command)")
	})

	it("asks about a read, counting a batch", () => {
		expect(formatToolAskMessage({ tool: "read_file", files: [{ path: "a.ts" }, { path: "b.ts" }] })).toBe(
			"Read 2 file(s)?\n  a.ts\n  b.ts",
		)
		expect(formatToolAskMessage({ tool: "read_file", path: "a.ts" })).toBe("Read file: a.ts")
		expect(formatToolAskMessage({ tool: "read_file", files: [] })).toBe("Read file: (no path)")
	})

	it("asks about a write and a diff", () => {
		expect(formatToolAskMessage({ tool: "write_to_file", path: "a.ts" })).toBe("Write to file: a.ts")
		expect(formatToolAskMessage({ tool: "write_to_file" })).toBe("Write to file: (no path)")
		expect(formatToolAskMessage({ tool: "apply_diff", path: "a.ts" })).toBe("Apply changes to: a.ts")
		expect(formatToolAskMessage({ tool: "apply_diff" })).toBe("Apply changes to: (no path)")
	})

	it("falls back to the tool name plus its indented parameters, truncated at 80", () => {
		expect(formatToolAskMessage({ tool: "mystery", a: "one", b: [1] })).toBe("mystery\n  a: one\n  b: [1]")
		expect(formatToolAskMessage({ tool: "mystery", a: "z".repeat(120) })).toBe(`mystery\n  a: ${"z".repeat(80)}...`)
		expect(formatToolAskMessage({ tool: "mystery" })).toBe("mystery")
		expect(formatToolAskMessage({})).toBe("unknown")
	})
})

describe("parseTodosFromToolInfo", () => {
	it("returns null when there is no todos field at all", () => {
		expect(parseTodosFromToolInfo({})).toBeNull()
		expect(parseTodosFromToolInfo({ todos: 42 })).toBeNull()
	})

	it("normalizes an array of todo objects, filling in ids, content and status", () => {
		expect(
			parseTodosFromToolInfo({
				todos: [{ id: "a", content: "first", status: "completed" }, {}, "not an object", null],
			}),
		).toEqual([
			{ id: "a", content: "first", status: "completed" },
			{ id: "todo-1", content: "", status: "pending" },
		])
	})

	it("parses the markdown checklist form", () => {
		expect(parseTodosFromToolInfo({ todos: "[x] done\n[-] doing\n[ ] later" })).toEqual([
			{ id: "todo-0", content: "done", status: "completed" },
			{ id: "todo-1", content: "doing", status: "in_progress" },
			{ id: "todo-2", content: "later", status: "pending" },
		])
	})
})

describe("parseMarkdownChecklist", () => {
	it("skips blank and whitespace-only lines and anything that is not a checkbox", () => {
		expect(parseMarkdownChecklist("\n   \nnot a checkbox\n[ ] real")).toEqual([
			{ id: "todo-3", content: "real", status: "pending" },
		])
	})

	it("accepts an upper-case X as completed", () => {
		expect(parseMarkdownChecklist("[X] done")).toEqual([{ id: "todo-0", content: "done", status: "completed" }])
	})

	it("trims the content and tolerates leading indentation", () => {
		expect(parseMarkdownChecklist("   [ ]   spaced   ")).toEqual([
			{ id: "todo-0", content: "spaced", status: "pending" },
		])
	})

	it("returns an empty list for an empty string", () => {
		expect(parseMarkdownChecklist("")).toEqual([])
	})
})
