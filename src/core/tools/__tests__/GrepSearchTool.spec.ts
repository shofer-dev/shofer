/**
 * Tests for GrepSearchTool — the consolidated search tool using ripgrep.
 *
 * Coverage:
 *  - Input validation: missing path / missing query
 *  - Approval flow
 *  - Ripgrep argument construction: regex, literal, case-sensitive, whole-word, globs, context
 *  - Ripgrep output parsing: JSON begin/match/context/end messages
 *  - Output formatting: header, file grouping, match/context lines, truncation
 *  - No-results case
 *  - Error handling (rg spawn failure, missing binary)
 *  - handlePartial
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// ─── Mocks (hoisted) ──────────────────────────────────────────────────────────

const { mockSpawn, mockCreateInterface, mockFileExistsAtPath } = vi.hoisted(() => ({
	mockSpawn: vi.fn(),
	mockCreateInterface: vi.fn(),
	// Hoisted so it can be re-applied in beforeEach after vi.clearAllMocks() wipes
	// the mockResolvedValue set in the vi.mock() factory.
	mockFileExistsAtPath: vi.fn(),
}))

vi.mock("child_process", async () => {
	const actual = await vi.importActual("child_process")
	return { ...actual, spawn: mockSpawn }
})

vi.mock("readline", async () => {
	const actual = await vi.importActual("readline")
	return { ...actual, createInterface: mockCreateInterface }
})

vi.mock("../../../utils/fs", () => ({
	// Synchronous factory avoids the async importActual timing issue that caused
	// the mock to be applied after GrepSearchTool's module-level import ran.
	// Path is relative to THIS test file (src/core/tools/__tests__/), so
	// ../../../utils/fs correctly resolves to src/utils/fs — the same module
	// that GrepSearchTool.ts imports via ../../utils/fs.
	fileExistsAtPath: mockFileExistsAtPath,
}))

vi.mock("vscode", async () => {
	const actual = await vi.importActual("vscode")
	return {
		...actual,
		env: { ...((actual as any)?.env ?? {}), appRoot: "/fake-vscode-app-root" },
	}
})

// ─── SUT ──────────────────────────────────────────────────────────────────────

import { GrepSearchTool } from "../GrepSearchTool"
import type { Task } from "../../task/Task"
import type { ToolUse } from "../../../shared/tools"

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createMockTask(overrides: Partial<Task> = {}): Task {
	return {
		cwd: "/workspace",
		consecutiveMistakeCount: 0,
		didToolFailInCurrentTurn: false,
		recordToolError: vi.fn(),
		sayAndCreateMissingParamError: vi.fn().mockResolvedValue("Missing required parameter"),
		ask: vi.fn().mockResolvedValue(undefined),
		providerRef: { deref: () => ({ getState: () => Promise.resolve({}) }) },
		shoferIgnoreController: undefined,
		...overrides,
	} as unknown as Task
}

interface CallbackMocks {
	askApproval: ReturnType<typeof vi.fn>
	handleError: ReturnType<typeof vi.fn>
	pushToolResult: ReturnType<typeof vi.fn>
}

function createCallbacks(): CallbackMocks {
	return {
		askApproval: vi.fn().mockResolvedValue(true),
		handleError: vi.fn(),
		pushToolResult: vi.fn(),
	}
}

/**
 * Create mock ripgrep JSON lines as would be written to stdout.
 * Each file gets a proper begin → [matches/context] → end block so that
 * parseRipgrepOutput sees one currentFile at a time without overwriting.
 */
function makeRgOutput(matches: Array<{ file: string; line: number; text: string; type: "match" | "context" }>): string {
	const lines: string[] = []

	// Group by file, preserving insertion order.
	const byFile = new Map<string, typeof matches>()
	for (const m of matches) {
		if (!byFile.has(m.file)) byFile.set(m.file, [])
		byFile.get(m.file)!.push(m)
	}

	for (const [file, fileMatches] of byFile) {
		lines.push(JSON.stringify({ type: "begin", data: { path: { text: file } } }))
		for (const m of fileMatches) {
			lines.push(
				JSON.stringify({
					type: m.type,
					data: {
						path: { text: m.file },
						line_number: m.line,
						lines: { text: m.text + "\n" },
						...(m.type === "match" ? { absolute_offset: m.line } : {}),
					},
				}),
			)
		}
		lines.push(JSON.stringify({ type: "end", data: { path: { text: file } } }))
	}

	return lines.join("\n") + "\n"
}

/**
 * Configure the mocks so that spawning ripgrep returns the given matches.
 */
function setupRgReturn(matches: Array<{ file: string; line: number; text: string; type: "match" | "context" }>) {
	const output = makeRgOutput(matches)
	const lines = output.split("\n").filter(Boolean)

	mockSpawn.mockReturnValue({
		stdout: { on: vi.fn() },
		stderr: { on: vi.fn(), once: vi.fn() },
		on: vi.fn(),
		kill: vi.fn(),
	})

	// readline.createInterface → emit each JSON line then close
	mockCreateInterface.mockReturnValue({
		on: vi.fn((event: string, cb: (...args: any[]) => void) => {
			if (event === "line") {
				lines.forEach((line) => cb(line))
			}
			if (event === "close") {
				// Schedule close after all lines are emitted
				Promise.resolve().then(() => cb())
			}
		}),
		close: vi.fn(),
	})
}

/** Configure mocks so that rg spawn fails. */
function setupRgSpawnError() {
	mockSpawn.mockReturnValue({
		stdout: { on: vi.fn() },
		stderr: { on: vi.fn(), once: vi.fn() },
		on: vi.fn((event: string, cb: (...args: any[]) => void) => {
			if (event === "error") {
				Promise.resolve().then(() => cb(new Error("Spawn failed")))
			}
		}),
		kill: vi.fn(),
	})
	mockCreateInterface.mockReturnValue({
		on: vi.fn(),
		close: vi.fn(),
	})
}

/** Configure mocks so that rg stderr has content (parse failure). */
function setupRgStderrError() {
	mockSpawn.mockReturnValue({
		stdout: { on: vi.fn() },
		stderr: {
			on: vi.fn((event: string, cb: (...args: any[]) => void) => {
				if (event === "data") cb("No such file or directory")
			}),
			once: vi.fn(),
		},
		on: vi.fn(),
		kill: vi.fn(),
	})
	mockCreateInterface.mockReturnValue({
		on: vi.fn((event: string, cb: (...args: any[]) => void) => {
			if (event === "close") Promise.resolve().then(() => cb())
		}),
		close: vi.fn(),
	})
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GrepSearchTool", () => {
	let tool: GrepSearchTool

	beforeEach(() => {
		tool = new GrepSearchTool()
		vi.clearAllMocks()
		// Re-apply default after clearAllMocks, which resets implementations set
		// via mockReturnValue/mockResolvedValue on hoisted vi.fn() instances.
		mockFileExistsAtPath.mockResolvedValue(true)
	})

	// ── name ───────────────────────────────────────────────────────────────

	it("has the correct tool name", () => {
		expect(tool.name).toBe("grep_search")
	})

	// ── Input validation ───────────────────────────────────────────────────

	describe("input validation", () => {
		it("reports missing path parameter", async () => {
			const task = createMockTask()
			const callbacks = createCallbacks()

			await tool.execute({ path: "", query: "something" }, task, callbacks)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith("Missing required parameter")
			expect(mockSpawn).not.toHaveBeenCalled()
		})

		it("reports missing query parameter", async () => {
			const task = createMockTask()
			const callbacks = createCallbacks()

			await tool.execute({ path: "src", query: "" }, task, callbacks)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith("Missing required parameter")
			expect(mockSpawn).not.toHaveBeenCalled()
		})
	})

	// ── Approval flow ──────────────────────────────────────────────────────

	describe("approval flow", () => {
		it("aborts when user denies approval", async () => {
			const task = createMockTask()
			const callbacks = createCallbacks()
			callbacks.askApproval.mockResolvedValue(false)

			await tool.execute({ path: "src", query: "test" }, task, callbacks)

			expect(mockSpawn).not.toHaveBeenCalled()
		})
	})

	// ── Ripgrep argument construction ──────────────────────────────────────

	describe("ripgrep argument construction", () => {
		it("uses -F for literal (non-regex) search", async () => {
			const task = createMockTask()
			const callbacks = createCallbacks()
			setupRgReturn([])

			await tool.execute({ path: "src", query: "console.log", isRegex: false }, task, callbacks)

			const args = mockSpawn.mock.calls[0][1] as string[]
			expect(args).toContain("-F")
		})

		it("does NOT use -F for regex search", async () => {
			const task = createMockTask()
			const callbacks = createCallbacks()
			setupRgReturn([])

			await tool.execute({ path: "src", query: "function\\s+\\w+" }, task, callbacks)

			const args = mockSpawn.mock.calls[0][1] as string[]
			expect(args).not.toContain("-F")
		})

		it("adds -i for case-insensitive search (default)", async () => {
			const task = createMockTask()
			const callbacks = createCallbacks()
			setupRgReturn([])

			await tool.execute({ path: "src", query: "test" }, task, callbacks)

			const args = mockSpawn.mock.calls[0][1] as string[]
			expect(args).toContain("-i")
		})

		it("omits -i for case-sensitive search", async () => {
			const task = createMockTask()
			const callbacks = createCallbacks()
			setupRgReturn([])

			await tool.execute({ path: "src", query: "test", caseSensitive: true }, task, callbacks)

			const args = mockSpawn.mock.calls[0][1] as string[]
			expect(args).not.toContain("-i")
		})

		it("adds -w for whole-word search", async () => {
			const task = createMockTask()
			const callbacks = createCallbacks()
			setupRgReturn([])

			await tool.execute({ path: "src", query: "TODO", isRegex: false, wholeWord: true }, task, callbacks)

			const args = mockSpawn.mock.calls[0][1] as string[]
			expect(args).toContain("-w")
		})

		it("adds -g for file type glob", async () => {
			const task = createMockTask()
			const callbacks = createCallbacks()
			setupRgReturn([])

			await tool.execute({ path: "src", query: "test", fileTypes: "*.ts" }, task, callbacks)

			const args = mockSpawn.mock.calls[0][1] as string[]
			expect(args).toContain("-g")
			expect(args).toContain("*.ts")
		})

		it("adds negated -g for exclude pattern", async () => {
			const task = createMockTask()
			const callbacks = createCallbacks()
			setupRgReturn([])

			await tool.execute({ path: "src", query: "test", excludePattern: "**/node_modules/**" }, task, callbacks)

			const args = mockSpawn.mock.calls[0][1] as string[]
			expect(args).toContain("!**/node_modules/**")
		})

		it("adds -B and -A for context lines", async () => {
			const task = createMockTask()
			const callbacks = createCallbacks()
			setupRgReturn([])

			await tool.execute({ path: "src", query: "test", contextBefore: 3, contextAfter: 2 }, task, callbacks)

			const args = mockSpawn.mock.calls[0][1] as string[]
			expect(args).toContain("-B")
			expect(args).toContain("3")
			expect(args).toContain("-A")
			expect(args).toContain("2")
		})

		it("resolves the directory path against task.cwd", async () => {
			const task = createMockTask({ cwd: "/home/user/project" })
			const callbacks = createCallbacks()
			setupRgReturn([])

			await tool.execute({ path: "src/app", query: "hello" }, task, callbacks)

			const args = mockSpawn.mock.calls[0][1] as string[]
			expect(args[args.length - 1]).toBe("/home/user/project/src/app")
		})
	})

	// ── Result formatting ──────────────────────────────────────────────────

	describe("result formatting", () => {
		it("returns 'No results found' when search yields nothing", async () => {
			const task = createMockTask()
			const callbacks = createCallbacks()
			setupRgReturn([])

			await tool.execute({ path: "src", query: "nonexistent" }, task, callbacks)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith("No results found for: nonexistent")
		})

		it("formats a single match with header and '>' marker", async () => {
			const task = createMockTask()
			const callbacks = createCallbacks()
			setupRgReturn([{ file: "/workspace/src/index.ts", line: 10, text: "matched line", type: "match" }])

			await tool.execute({ path: "src", query: "matched" }, task, callbacks)

			const result = callbacks.pushToolResult.mock.calls[0][0] as string
			expect(result).toContain("Found 1 results")
			expect(result).toContain("## src/index.ts")
			expect(result).toContain(">   10 | matched line")
		})

		it("formats results grouped by file", async () => {
			const task = createMockTask()
			const callbacks = createCallbacks()
			setupRgReturn([
				{ file: "/workspace/src/a.ts", line: 5, text: "match a", type: "match" },
				{ file: "/workspace/src/b.ts", line: 20, text: "match b", type: "match" },
			])

			await tool.execute({ path: "src", query: "match" }, task, callbacks)

			const result = callbacks.pushToolResult.mock.calls[0][0] as string
			expect(result).toContain("Found 2 results")
			expect(result).toContain("## src/a.ts")
			expect(result).toContain("## src/b.ts")
		})

		it("marks match lines with '>' and context lines with spaces", async () => {
			const task = createMockTask()
			const callbacks = createCallbacks()
			setupRgReturn([
				{ file: "/workspace/src/main.ts", line: 41, text: "context before", type: "context" },
				{ file: "/workspace/src/main.ts", line: 42, text: "matched line", type: "match" },
				{ file: "/workspace/src/main.ts", line: 43, text: "context after", type: "context" },
			])

			await tool.execute({ path: "src", query: "matched" }, task, callbacks)

			const result = callbacks.pushToolResult.mock.calls[0][0] as string
			expect(result).toContain(">   42 | matched line")
			expect(result).toContain("    41 | context before")
			expect(result).toContain("    43 | context after")
		})

		it("separates non-contiguous blocks with ----", async () => {
			const task = createMockTask()
			const callbacks = createCallbacks()
			setupRgReturn([
				{ file: "/workspace/src/x.ts", line: 5, text: "first match", type: "match" },
				{ file: "/workspace/src/x.ts", line: 50, text: "second match", type: "match" },
			])

			await tool.execute({ path: "src", query: "match" }, task, callbacks)

			const result = callbacks.pushToolResult.mock.calls[0][0] as string
			const fileHeaderCount = (result.match(/## src\/x\.ts/g) || []).length
			expect(fileHeaderCount).toBe(1)
			expect(result).toContain("----")
		})

		it("shows truncation message when results exceed maxResults", async () => {
			const task = createMockTask()
			const callbacks = createCallbacks()
			const matches = Array.from({ length: 5 }, (_, i) => ({
				file: `/workspace/src/file${i}.ts`,
				line: i + 1,
				text: `match ${i}`,
				type: "match" as const,
			}))
			setupRgReturn(matches)

			await tool.execute({ path: "src", query: "match", maxResults: 2 }, task, callbacks)

			const result = callbacks.pushToolResult.mock.calls[0][0] as string
			expect(result).toContain("Showing first 2 of more results")
		})

		it("pads line numbers to 4 characters", async () => {
			const task = createMockTask()
			const callbacks = createCallbacks()
			setupRgReturn([
				{ file: "/workspace/src/app.ts", line: 5, text: "line five", type: "match" },
				{ file: "/workspace/src/app.ts", line: 999, text: "line 999", type: "match" },
			])

			await tool.execute({ path: "src", query: "line" }, task, callbacks)

			const result = callbacks.pushToolResult.mock.calls[0][0] as string
			expect(result).toContain(">    5 | line five")
			expect(result).toContain(">  999 | line 999")
		})
	})

	// ── Error handling ─────────────────────────────────────────────────────

	describe("error handling", () => {
		it("returns 'No results found' when ripgrep spawn fails", async () => {
			const task = createMockTask()
			const callbacks = createCallbacks()
			setupRgSpawnError()

			await tool.execute({ path: "src", query: "test" }, task, callbacks)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith("No results found for: test")
		})

		it("returns 'No results found' on ripgrep stderr output", async () => {
			const task = createMockTask()
			const callbacks = createCallbacks()
			setupRgStderrError()

			await tool.execute({ path: "src", query: "test" }, task, callbacks)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith("No results found for: test")
		})
	})

	// ── .shoferignore filtering ────────────────────────────────────────────

	describe(".shoferignore filtering", () => {
		it("passes --ignore-file to ripgrep when the ignore controller has content", async () => {
			const ignoreController = {
				shoferIgnoreContent: "secret/\n",
				validateAccess: vi.fn().mockReturnValue(true),
			}
			const task = createMockTask({ cwd: "/workspace", shoferIgnoreController: ignoreController as any })
			const callbacks = createCallbacks()
			setupRgReturn([])

			await tool.execute({ path: "src", query: "test" }, task, callbacks)

			const args = mockSpawn.mock.calls[0][1] as string[]
			const ignoreFileIdx = args.indexOf("--ignore-file")
			expect(ignoreFileIdx).toBeGreaterThan(-1)
			expect(args[ignoreFileIdx + 1]).toBe("/workspace/.shofer/shoferignore")
		})

		it("does NOT pass --ignore-file when the ignore controller has no content (file absent)", async () => {
			const ignoreController = {
				shoferIgnoreContent: undefined,
				validateAccess: vi.fn().mockReturnValue(true),
			}
			const task = createMockTask({ shoferIgnoreController: ignoreController as any })
			const callbacks = createCallbacks()
			setupRgReturn([])

			await tool.execute({ path: "src", query: "test" }, task, callbacks)

			const args = mockSpawn.mock.calls[0][1] as string[]
			expect(args).not.toContain("--ignore-file")
		})

		it("does NOT pass --ignore-file when shoferIgnoreController is absent", async () => {
			const task = createMockTask({ shoferIgnoreController: undefined })
			const callbacks = createCallbacks()
			setupRgReturn([])

			await tool.execute({ path: "src", query: "test" }, task, callbacks)

			const args = mockSpawn.mock.calls[0][1] as string[]
			expect(args).not.toContain("--ignore-file")
		})

		it("post-filters out files where validateAccess returns false (safety net)", async () => {
			const ignoredFile = "/workspace/secret/config.ts"
			const allowedFile = "/workspace/src/index.ts"
			const ignoreController = {
				shoferIgnoreContent: "secret/\n",
				validateAccess: vi.fn((filePath: string) => !filePath.includes("secret")),
			}
			const task = createMockTask({ shoferIgnoreController: ignoreController as any })
			const callbacks = createCallbacks()
			setupRgReturn([
				{ file: ignoredFile, line: 1, text: "ignored match", type: "match" },
				{ file: allowedFile, line: 5, text: "allowed match", type: "match" },
			])

			await tool.execute({ path: ".", query: "match" }, task, callbacks)

			const result = callbacks.pushToolResult.mock.calls[0][0] as string
			expect(result).not.toContain("secret/config.ts")
			expect(result).toContain("src/index.ts")
		})

		it("returns no results when all ripgrep hits are in ignored files", async () => {
			const ignoreController = {
				shoferIgnoreContent: "secret/\n",
				validateAccess: vi.fn().mockReturnValue(false),
			}
			const task = createMockTask({ shoferIgnoreController: ignoreController as any })
			const callbacks = createCallbacks()
			setupRgReturn([{ file: "/workspace/secret/data.ts", line: 1, text: "sensitive", type: "match" }])

			await tool.execute({ path: ".", query: "sensitive" }, task, callbacks)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith("No results found for: sensitive")
		})
	})

	// ── handlePartial ──────────────────────────────────────────────────────

	describe("handlePartial", () => {
		it("sends shofer say tool message with resolved path", async () => {
			const task = createMockTask({ cwd: "/home/project" })
			const block = {
				name: "grep_search" as const,
				params: { path: "src/app", query: "" },
				nativeArgs: { fileTypes: "*.ts" },
				partial: true,
			} as unknown as ToolUse<"grep_search">

			await tool.handlePartial(task, block)

			expect(task.ask).toHaveBeenCalledWith("tool", expect.stringContaining("grepSearch"), true)
		})
	})
})
