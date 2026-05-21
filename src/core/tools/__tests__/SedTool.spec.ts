import * as path from "path"
import * as fs from "fs/promises"

import { fileExistsAtPath } from "../../../utils/fs"
import { isPathOutsideWorkspace } from "../../../utils/pathUtils"
import { getReadablePath } from "../../../utils/path"
import { ToolUse, ToolResponse } from "../../../shared/tools"
import { sedTool } from "../SedTool"

vi.mock("fs/promises", () => ({
	readFile: vi.fn(),
}))

vi.mock("path", async () => {
	const originalPath = await vi.importActual("path")
	return {
		...originalPath,
		resolve: vi.fn().mockImplementation((...args) => {
			const separator = process.platform === "win32" ? "\\" : "/"
			return args.join(separator)
		}),
		isAbsolute: vi.fn().mockReturnValue(false),
		relative: vi.fn().mockImplementation((_from, to) => to),
	}
})

vi.mock("delay", () => ({
	default: vi.fn(),
}))

vi.mock("../../../utils/fs", () => ({
	fileExistsAtPath: vi.fn().mockResolvedValue(true),
}))

vi.mock("../../prompts/responses", () => ({
	formatResponse: {
		toolError: vi.fn((msg) => `Error: ${msg}`),
		shoferIgnoreError: vi.fn((path) => `Access denied: ${path}`),
		createPrettyPatch: vi.fn(() => "mock-diff"),
	},
}))

vi.mock("../../../utils/pathUtils", () => ({
	isPathOutsideWorkspace: vi.fn().mockReturnValue(false),
}))

vi.mock("../../../utils/path", () => ({
	getReadablePath: vi.fn().mockReturnValue("test/path.txt"),
}))

vi.mock("../../diff/stats", () => ({
	sanitizeUnifiedDiff: vi.fn((diff) => diff),
	computeDiffStats: vi.fn(() => ({ additions: 1, deletions: 1 })),
}))

vi.mock("vscode", () => ({
	window: {
		showWarningMessage: vi.fn().mockResolvedValue(undefined),
	},
	env: {
		openExternal: vi.fn(),
	},
	Uri: {
		parse: vi.fn(),
	},
}))

const mockedFsReadFile = vi.mocked(fs.readFile)

describe("sedTool", () => {
	const testFilePath = "test/file.txt"
	const absoluteFilePath = process.platform === "win32" ? "C:\\test\\file.txt" : "/test/file.txt"
	const testFileContent = "Line 1\nLine 2\nLine 3\nLine 4 with pattern"

	const mockTask: any = {}
	let mockAskApproval: ReturnType<typeof vi.fn>
	let mockHandleError: ReturnType<typeof vi.fn>
	let toolResult: ToolResponse | undefined
	let mockPushToolResult: ReturnType<typeof vi.fn>

	beforeEach(() => {
		vi.clearAllMocks()
		sedTool.resetPartialState()

		vi.mocked(path.resolve).mockReturnValue(absoluteFilePath)
		vi.mocked(fileExistsAtPath).mockResolvedValue(true)
		mockedFsReadFile.mockResolvedValue(testFileContent)
		vi.mocked(isPathOutsideWorkspace).mockReturnValue(false)
		vi.mocked(getReadablePath).mockReturnValue("test/path.txt")

		mockTask.cwd = "/"
		mockTask.consecutiveMistakeCount = 0
		mockTask.didEditFile = false
		mockTask.didToolFailInCurrentTurn = false
		mockTask.providerRef = {
			deref: vi.fn().mockReturnValue({
				getState: vi.fn().mockResolvedValue({
					diagnosticsEnabled: true,
					writeDelayMs: 1000,
					experiments: { preventFocusDisruption: false },
				}),
			}),
		}
		mockTask.shoferIgnoreController = {
			validateAccess: vi.fn().mockReturnValue(true),
		}
		mockTask.shoferProtectedController = {
			isWriteProtected: vi.fn().mockReturnValue(false),
		}
		mockTask.diffViewProvider = {
			editType: undefined,
			isEditing: false,
			originalContent: "",
			open: vi.fn().mockResolvedValue(undefined),
			update: vi.fn().mockResolvedValue(undefined),
			reset: vi.fn().mockResolvedValue(undefined),
			revertChanges: vi.fn().mockResolvedValue(undefined),
			saveChanges: vi.fn().mockResolvedValue({
				newProblemsMessage: "",
				userEdits: null,
				finalContent: "final content",
			}),
			saveDirectly: vi.fn().mockResolvedValue(undefined),
			scrollToFirstDiff: vi.fn(),
			pushToolWriteResult: vi.fn().mockResolvedValue("Tool result message"),
		}
		mockTask.fileContextTracker = {
			captureOriginal: vi.fn().mockResolvedValue(undefined),
			trackFileContext: vi.fn().mockResolvedValue(undefined),
		}
		mockTask.say = vi.fn().mockResolvedValue(undefined)
		mockTask.recordToolError = vi.fn()
		mockTask.recordToolUsage = vi.fn()
		mockTask.processQueuedMessages = vi.fn()
		mockTask.sayAndCreateMissingParamError = vi.fn().mockResolvedValue("Missing param error")

		mockAskApproval = vi.fn().mockResolvedValue(true)
		mockHandleError = vi.fn().mockResolvedValue(undefined)

		toolResult = undefined
		mockPushToolResult = vi.fn()
	})

	/**
	 * Execute the sed tool with given overrides. Parameters with value undefined
	 * are passed through as-is (not filtered) so parameter-validation tests work.
	 */
	async function executeSedTool(
		params: Record<string, unknown> = {},
		options: {
			fileExists?: boolean
			fileContent?: string
			accessAllowed?: boolean
		} = {},
	): Promise<ToolResponse | undefined> {
		const fileExists = options.fileExists ?? true
		const fileContent = options.fileContent ?? testFileContent
		const accessAllowed = options.accessAllowed ?? true

		vi.mocked(fileExistsAtPath).mockResolvedValue(fileExists)
		mockedFsReadFile.mockResolvedValue(fileContent)
		mockTask.shoferIgnoreController.validateAccess.mockReturnValue(accessAllowed)

		// Build nativeArgs: defaults first, then overrides (including undefined)
		const defaults: Record<string, unknown> = {
			path: testFilePath,
			pattern: "Line \\d",
			replacement: "Replaced",
			global: true,
		}
		const nativeArgs: Record<string, unknown> = { ...defaults }
		for (const key of Object.keys(params)) {
			nativeArgs[key] = params[key]
		}

		const toolUse: ToolUse = {
			type: "tool_use",
			name: "sed",
			params: { ...nativeArgs },
			nativeArgs: nativeArgs as any,
			partial: false,
		}

		mockPushToolResult = vi.fn((result: ToolResponse) => {
			toolResult = result
		})

		await sedTool.handle(mockTask, toolUse as ToolUse<"sed">, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		return toolResult
	}

	describe("parameter validation", () => {
		it("returns error when path is missing", async () => {
			const result = await executeSedTool({ path: undefined })

			expect(result).toBe("Missing param error")
			expect(mockTask.consecutiveMistakeCount).toBe(1)
			expect(mockTask.recordToolError).toHaveBeenCalledWith("sed")
			expect(mockTask.didToolFailInCurrentTurn).toBe(true)
		})

		it("returns error when pattern is missing", async () => {
			const result = await executeSedTool({ pattern: undefined })

			expect(result).toBe("Missing param error")
			expect(mockTask.consecutiveMistakeCount).toBe(1)
			expect(mockTask.recordToolError).toHaveBeenCalledWith("sed")
		})

		it("returns error when replacement is missing", async () => {
			const result = await executeSedTool({ replacement: undefined })

			expect(result).toBe("Missing param error")
			expect(mockTask.consecutiveMistakeCount).toBe(1)
			expect(mockTask.recordToolError).toHaveBeenCalledWith("sed")
		})
	})

	describe("regex matching", () => {
		it("applies regex substitution with global flag (default)", async () => {
			await executeSedTool(
				{ pattern: "Line \\d", replacement: "Replaced", global: true },
				{ fileContent: "Line 1\nLine 2\nLine 3" },
			)

			expect(mockTask.consecutiveMistakeCount).toBe(0)
			expect(mockAskApproval).toHaveBeenCalled()
			expect(mockTask.diffViewProvider.saveChanges).toHaveBeenCalled()
			expect(mockTask.didEditFile).toBe(true)
			expect(toolResult).toContain("3 replacement(s) made")
		})

		it("replaces only first match when global is false", async () => {
			await executeSedTool(
				{ pattern: "Line \\d", replacement: "Replaced", global: false },
				{ fileContent: "Line 1\nLine 2\nLine 3" },
			)

			expect(toolResult).toContain("1 replacement(s) made")
		})

		it("supports capture group backreferences", async () => {
			await executeSedTool(
				{ pattern: "Line (\\d)", replacement: "Number $1", global: true },
				{ fileContent: "Line 1\nLine 2" },
			)

			expect(toolResult).toContain("2 replacement(s) made")
		})
	})

	describe("literal fallback", () => {
		it("falls back to literal via zero-matches path when regex compiles but doesn't match", async () => {
			// "a+b" as regex means "one or more 'a' then 'b'" → matches "ab", "aab" etc.
			// In text "Math: a+b" it produces 0 matches → literal fallback.
			await executeSedTool({ pattern: "a+b", replacement: "sum", global: true }, { fileContent: "Math: a+b" })

			expect(mockAskApproval).toHaveBeenCalled()
			expect(toolResult).toContain("literal match")
		})

		it("uses regex normally when pattern with backslash matches as regex", async () => {
			// "Line \\d" is \d (digit class) — compiles fine and matches digits.
			await executeSedTool(
				{ pattern: "Line \\d", replacement: "Replaced", global: true },
				{ fileContent: "Line 1\nLine 2" },
			)

			expect(toolResult).not.toContain("literal match")
			expect(toolResult).toContain("2 replacement(s) made")
		})
	})

	describe("no match", () => {
		it("reports no matches when neither regex nor literal find anything", async () => {
			const result = await executeSedTool(
				{ pattern: "NonExistentText", replacement: "Replaced", global: true },
				{ fileContent: "Line 1\nLine 2" },
			)

			expect(result).toContain("No matches found")
		})
	})

	describe("file handling", () => {
		it("returns error when file does not exist", async () => {
			const result = await executeSedTool({}, { fileExists: false })

			expect(result).toContain("File does not exist")
			expect(mockTask.consecutiveMistakeCount).toBe(1)
		})

		it("returns access denied when shoferignore blocks file", async () => {
			const result = await executeSedTool({}, { accessAllowed: false })

			expect(result).toContain("Access denied")
		})
	})

	describe("approval workflow", () => {
		it("saves changes when user approves", async () => {
			await executeSedTool()

			expect(mockTask.diffViewProvider.saveChanges).toHaveBeenCalled()
			expect(mockTask.didEditFile).toBe(true)
			expect(mockTask.diffViewProvider.reset).toHaveBeenCalled()
		})

		it("reverts changes when user rejects", async () => {
			mockAskApproval.mockResolvedValue(false)

			const result = await executeSedTool()

			expect(mockTask.diffViewProvider.revertChanges).toHaveBeenCalled()
			expect(mockTask.diffViewProvider.saveChanges).not.toHaveBeenCalled()
			expect(result).toBeUndefined()
		})
	})

	describe("preventFocusDisruption", () => {
		it("uses saveDirectly when preventFocusDisruption is enabled", async () => {
			mockTask.providerRef.deref = vi.fn().mockReturnValue({
				getState: vi.fn().mockResolvedValue({
					diagnosticsEnabled: true,
					writeDelayMs: 1000,
					experiments: { preventFocusDisruption: true },
				}),
			})

			await executeSedTool()

			expect(mockTask.diffViewProvider.saveDirectly).toHaveBeenCalled()
			expect(mockTask.diffViewProvider.open).not.toHaveBeenCalled()
		})
	})
})
