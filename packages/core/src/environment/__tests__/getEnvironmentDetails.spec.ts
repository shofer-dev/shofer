// npx vitest environment/__tests__/getEnvironmentDetails.spec.ts

import pWaitFor from "p-wait-for"
import delay from "delay"
import type { Mock } from "vitest"

import { setHost, createInMemoryHost } from "@shofer/types"

import { getEnvironmentDetails } from "../getEnvironmentDetails.js"
import { getFullModeDetails } from "../../modes/getFullModeDetails.js"
import { listFiles } from "../../services/glob/list-files.js"
import { TerminalRegistry } from "../../terminal/TerminalRegistry.js"
import { BaseTerminal } from "../../terminal/BaseTerminal.js"
import { arePathsEqual } from "../../path/path.js"
import { formatResponse } from "../../prompts/responses.js"
import { getGitStatus } from "../../utils/git.js"
import { getApiMetrics } from "@shofer/types"
import type { Task } from "../../task/Task.js"

vi.mock("p-wait-for", () => ({
	default: vi.fn(),
}))

vi.mock("delay", () => ({
	default: vi.fn(),
}))

vi.mock("execa", () => ({
	execa: vi.fn(),
}))

// The subject collaborates with these siblings via intra-core RELATIVE imports;
// only a relative mock (not the `@shofer/core` barrel) can intercept those calls.
vi.mock("../../modes/getFullModeDetails.js", () => ({
	getFullModeDetails: vi.fn(),
}))

vi.mock("../../services/glob/list-files.js", () => ({
	listFiles: vi.fn(),
}))

vi.mock("../../terminal/TerminalRegistry.js", () => ({
	TerminalRegistry: {
		getBackgroundTerminals: vi.fn(() => []),
		getTerminals: vi.fn(() => []),
		getUnretrievedOutput: vi.fn(() => ""),
		isProcessHot: vi.fn(() => false),
	},
}))

vi.mock("../../terminal/BaseTerminal.js", () => ({
	BaseTerminal: {
		compressTerminalOutput: vi.fn((output: string) => output),
	},
}))

// `path.js` also augments String.prototype with `toPosix`; keep the original and
// override only `arePathsEqual`.
vi.mock("../../path/path.js", async (importOriginal) => {
	const orig = await importOriginal<typeof import("../../path/path.js")>()
	return { ...orig, arePathsEqual: vi.fn() }
})

vi.mock("../../prompts/responses.js", async (importOriginal) => {
	const orig = await importOriginal<typeof import("../../prompts/responses.js")>()
	return { ...orig, formatResponse: { ...orig.formatResponse, formatFilesList: vi.fn() } }
})

vi.mock("../../utils/git.js", () => ({
	getGitStatus: vi.fn(),
}))

// `getApiMetrics` lives in `@shofer/types` (a cross-package barrel the subject
// imports by specifier), so this package-level mock DOES intercept it. Keep the
// real host registry (`setHost`/`getHost`/`createInMemoryHost`) intact.
vi.mock("@shofer/types", async (importOriginal) => {
	const orig = await importOriginal<typeof import("@shofer/types")>()
	return { ...orig, getApiMetrics: vi.fn() }
})

describe("getEnvironmentDetails", () => {
	const mockCwd = "/test/path"
	const mockTaskId = "test-task-id"

	type MockTerminal = {
		id: string
		getLastCommand: Mock
		getProcessesWithOutput: Mock
		cleanCompletedProcessQueue?: Mock
		getCurrentWorkingDirectory: Mock
	}

	let mockShofer: Partial<Task>
	let mockProvider: any
	let mockState: any

	beforeEach(() => {
		vi.clearAllMocks()

		setHost(createInMemoryHost())

		mockState = {
			terminalOutputLineLimit: 100,
			maxWorkspaceFiles: 50,
			maxOpenTabsContext: 10,
			mode: "code",
			customModes: [],
			experiments: {},
			customInstructions: "test instructions",
			language: "en",
			showShoferIgnoredFiles: false,
		}

		mockProvider = {
			getState: vi.fn().mockResolvedValue(mockState),
		}

		mockShofer = {
			cwd: mockCwd,
			taskId: mockTaskId,
			didEditFile: false,
			getTaskMode: vi.fn().mockResolvedValue("code"),
			fileContextTracker: {
				getAndClearRecentlyModifiedFiles: vi.fn().mockReturnValue([]),
			} as any,
			shoferIgnoreController: {
				filterPaths: vi.fn((paths: string[]) => paths.join("\n")),
				cwd: mockCwd,
				ignoreInstance: {},
				disposables: [],
				shoferIgnoreContent: "",
				isPathIgnored: vi.fn(),
				getIgnoreContent: vi.fn(),
				updateIgnoreContent: vi.fn(),
				addToIgnore: vi.fn(),
				removeFromIgnore: vi.fn(),
				dispose: vi.fn(),
			} as any,
			shoferMessages: [],
			api: {
				getModel: vi.fn().mockReturnValue({ id: "test-model", info: { contextWindow: 100000 } }),
				createMessage: vi.fn(),
				countTokens: vi.fn(),
			} as any,
			providerRef: {
				deref: vi.fn().mockReturnValue(mockProvider),
				[Symbol.toStringTag]: "WeakRef",
			} as any,
		}

		// Mock other dependencies.
		;(getApiMetrics as Mock).mockReturnValue({ contextTokens: 50000, totalCost: 0.25 })
		;(getFullModeDetails as Mock).mockResolvedValue({
			name: "💻 Code",
			roleDefinition: "You are a code assistant",
			customInstructions: "Custom instructions",
		})
		;(listFiles as Mock).mockResolvedValue([["file1.ts", "file2.ts"], false])
		;(formatResponse.formatFilesList as Mock).mockReturnValue("file1.ts\nfile2.ts")
		;(arePathsEqual as Mock).mockReturnValue(false)
		;(BaseTerminal.compressTerminalOutput as Mock).mockImplementation((output: string) => output)
		;(TerminalRegistry.getTerminals as Mock).mockReturnValue([])
		;(TerminalRegistry.getBackgroundTerminals as Mock).mockReturnValue([])
		;(TerminalRegistry.isProcessHot as Mock).mockReturnValue(false)
		;(TerminalRegistry.getUnretrievedOutput as Mock).mockReturnValue("")
		;(getGitStatus as Mock).mockResolvedValue("## main")
		vi.mocked(pWaitFor).mockResolvedValue(undefined)
		vi.mocked(delay).mockResolvedValue(undefined)
	})

	it("should return basic environment details", async () => {
		const result = await getEnvironmentDetails(mockShofer as Task)

		expect(result).toContain("<environment_details>")
		expect(result).toContain("</environment_details>")
		// Visible Files and Open Tabs headers only appear when there's content
		expect(result).toContain("# Current Time")
		expect(result).not.toContain("# Git Status") // Git status is disabled by default (maxGitStatusFiles = 0)
		expect(result).toContain("# Current Cost")
		expect(result).toContain("# Current Mode")
		expect(result).toContain("<model>test-model</model>")

		expect(mockProvider.getState).toHaveBeenCalled()

		expect(getFullModeDetails).toHaveBeenCalledWith("code", [], undefined, {
			cwd: mockCwd,
			globalCustomInstructions: "test instructions",
			language: "en",
		})

		expect(getApiMetrics).toHaveBeenCalledWith(mockShofer.shoferMessages)
	})

	it("should include file details when includeFileDetails is true", async () => {
		const result = await getEnvironmentDetails(mockShofer as Task, true)
		expect(result).toContain("# Current Workspace Directory")
		expect(result).toContain("Files")

		expect(listFiles).toHaveBeenCalledWith(mockCwd, true, 50)

		expect(formatResponse.formatFilesList).toHaveBeenCalledWith(
			mockCwd,
			["file1.ts", "file2.ts"],
			false,
			mockShofer.shoferIgnoreController,
			false,
		)
	})

	it("should not include file details when includeFileDetails is false", async () => {
		await getEnvironmentDetails(mockShofer as Task, false)
		expect(listFiles).not.toHaveBeenCalled()
		expect(formatResponse.formatFilesList).not.toHaveBeenCalled()
	})

	it("should handle desktop directory specially", async () => {
		;(arePathsEqual as Mock).mockReturnValue(true)
		const result = await getEnvironmentDetails(mockShofer as Task, true)
		expect(result).toContain("Desktop files not shown automatically")
		expect(listFiles).not.toHaveBeenCalled()
	})

	it("should skip file listing when maxWorkspaceFiles is 0", async () => {
		mockProvider.getState.mockResolvedValue({
			...mockState,
			maxWorkspaceFiles: 0,
		})

		const result = await getEnvironmentDetails(mockShofer as Task, true)

		expect(listFiles).not.toHaveBeenCalled()
		expect(result).toContain("Workspace files context disabled")
		expect(formatResponse.formatFilesList).not.toHaveBeenCalled()
	})

	it("should include recently modified files if any", async () => {
		;(mockShofer.fileContextTracker!.getAndClearRecentlyModifiedFiles as Mock).mockReturnValue([
			"modified1.ts",
			"modified2.ts",
		])

		const result = await getEnvironmentDetails(mockShofer as Task)

		expect(result).toContain("# Recently Modified Files")
		expect(result).toContain("modified1.ts")
		expect(result).toContain("modified2.ts")
	})

	it("should include active terminal information", async () => {
		const mockActiveTerminal = {
			id: "terminal-1",
			getLastCommand: vi.fn().mockReturnValue("npm test"),
			getProcessesWithOutput: vi.fn().mockReturnValue([]),
			getCurrentWorkingDirectory: vi.fn().mockReturnValue("/test/path/src"),
		} as MockTerminal

		;(TerminalRegistry.getTerminals as Mock).mockReturnValue([mockActiveTerminal])
		;(TerminalRegistry.getUnretrievedOutput as Mock).mockReturnValue("Test output")

		const result = await getEnvironmentDetails(mockShofer as Task)

		expect(result).toContain("# Actively Running Terminals")
		expect(result).toContain("## Terminal terminal-1 (Active)")
		expect(result).toContain("### Working Directory: `/test/path/src`")
		expect(result).toContain("### Original command: `npm test`")
		expect(result).toContain("Test output")

		mockShofer.didEditFile = true
		await getEnvironmentDetails(mockShofer as Task)
		expect(vi.mocked(delay)).toHaveBeenCalledWith(300)

		expect(vi.mocked(pWaitFor)).toHaveBeenCalled()
	})

	it("should include inactive terminals with output", async () => {
		const mockProcess = {
			command: "npm build",
			getUnretrievedOutput: vi.fn().mockReturnValue("Build output"),
		}

		const mockInactiveTerminal = {
			id: "terminal-2",
			getLastCommand: vi.fn().mockReturnValue("npm build"),
			getProcessesWithOutput: vi.fn().mockReturnValue([mockProcess]),
			cleanCompletedProcessQueue: vi.fn(),
			getCurrentWorkingDirectory: vi.fn().mockReturnValue("/test/path/build"),
		} as MockTerminal

		;(TerminalRegistry.getTerminals as Mock).mockImplementation((active: boolean) =>
			active ? [] : [mockInactiveTerminal],
		)

		const result = await getEnvironmentDetails(mockShofer as Task)

		expect(result).toContain("# Inactive Terminals with Completed Process Output")
		expect(result).toContain("## Terminal terminal-2 (Inactive)")
		expect(result).toContain("### Working Directory: `/test/path/build`")
		expect(result).toContain("Command: `npm build`")
		expect(result).toContain("Build output")

		expect(mockInactiveTerminal.cleanCompletedProcessQueue).toHaveBeenCalled()
	})

	it("should include working directory for terminals", async () => {
		const mockActiveTerminal = {
			id: "terminal-1",
			getLastCommand: vi.fn().mockReturnValue("cd /some/path && npm start"),
			getProcessesWithOutput: vi.fn().mockReturnValue([]),
			getCurrentWorkingDirectory: vi.fn().mockReturnValue("/some/path"),
		} as MockTerminal

		const mockProcess = {
			command: "npm test",
			getUnretrievedOutput: vi.fn().mockReturnValue("Test completed"),
		}

		const mockInactiveTerminal = {
			id: "terminal-2",
			getLastCommand: vi.fn().mockReturnValue("npm test"),
			getProcessesWithOutput: vi.fn().mockReturnValue([mockProcess]),
			cleanCompletedProcessQueue: vi.fn(),
			getCurrentWorkingDirectory: vi.fn().mockReturnValue("/another/path"),
		} as MockTerminal

		;(TerminalRegistry.getTerminals as Mock).mockImplementation((active: boolean) =>
			active ? [mockActiveTerminal] : [mockInactiveTerminal],
		)
		;(TerminalRegistry.getUnretrievedOutput as Mock).mockReturnValue("Server started")

		const result = await getEnvironmentDetails(mockShofer as Task)

		// Check active terminal working directory
		expect(result).toContain("## Terminal terminal-1 (Active)")
		expect(result).toContain("### Working Directory: `/some/path`")
		expect(result).toContain("### Original command: `cd /some/path && npm start`")

		// Check inactive terminal working directory
		expect(result).toContain("## Terminal terminal-2 (Inactive)")
		expect(result).toContain("### Working Directory: `/another/path`")

		// Verify the methods were called
		expect(mockActiveTerminal.getCurrentWorkingDirectory).toHaveBeenCalled()
		expect(mockInactiveTerminal.getCurrentWorkingDirectory).toHaveBeenCalled()
	})

	it("should handle missing provider or state", async () => {
		// Mock provider to return null.
		mockShofer.providerRef!.deref = vi.fn().mockReturnValue(null)

		const result = await getEnvironmentDetails(mockShofer as Task)

		// Verify the function still returns a result.
		expect(result).toContain("<environment_details>")
		expect(result).toContain("</environment_details>")

		// Mock provider to return null state.
		mockShofer.providerRef!.deref = vi.fn().mockReturnValue({
			getState: vi.fn().mockResolvedValue(null),
		})

		const result2 = await getEnvironmentDetails(mockShofer as Task)

		// Verify the function still returns a result.
		expect(result2).toContain("<environment_details>")
		expect(result2).toContain("</environment_details>")
	})

	it("should handle errors gracefully", async () => {
		vi.mocked(pWaitFor).mockRejectedValue(new Error("Test error"))

		const mockErrorTerminal = {
			id: "terminal-1",
			getLastCommand: vi.fn().mockReturnValue("npm test"),
			getProcessesWithOutput: vi.fn().mockReturnValue([]),
			getCurrentWorkingDirectory: vi.fn().mockReturnValue("/test/path"),
		} as MockTerminal

		;(TerminalRegistry.getTerminals as Mock).mockReturnValue([mockErrorTerminal])
		;(TerminalRegistry.getBackgroundTerminals as Mock).mockReturnValue([])
		;(mockShofer.fileContextTracker!.getAndClearRecentlyModifiedFiles as Mock).mockReturnValue([])

		await expect(getEnvironmentDetails(mockShofer as Task)).resolves.not.toThrow()
	})
	it("should include REMINDERS section when todoListEnabled is true", async () => {
		mockProvider.getState.mockResolvedValue({
			...mockState,
			apiConfiguration: { todoListEnabled: true },
		})
		const shofer = { ...mockShofer, todoList: [{ content: "test", status: "pending" }] }
		const result = await getEnvironmentDetails(shofer as Task)
		expect(result).toContain("REMINDERS")
	})

	it("should NOT include REMINDERS section when todoListEnabled is false", async () => {
		mockProvider.getState.mockResolvedValue({
			...mockState,
			apiConfiguration: { todoListEnabled: false },
		})
		const shofer = { ...mockShofer, todoList: [{ content: "test", status: "pending" }] }
		const result = await getEnvironmentDetails(shofer as Task)
		expect(result).not.toContain("REMINDERS")
	})

	it("should include REMINDERS section when todoListEnabled is undefined", async () => {
		mockProvider.getState.mockResolvedValue({
			...mockState,
			apiConfiguration: {},
		})
		const shofer = { ...mockShofer, todoList: [{ content: "test", status: "pending" }] }
		const result = await getEnvironmentDetails(shofer as Task)
		expect(result).toContain("REMINDERS")
	})
	it("should include git status when maxGitStatusFiles > 0", async () => {
		;(getGitStatus as Mock).mockResolvedValue("## main\nM  file1.ts")
		mockProvider.getState.mockResolvedValue({
			...mockState,
			maxGitStatusFiles: 10,
		})

		const result = await getEnvironmentDetails(mockShofer as Task)

		expect(result).toContain("# Git Status")
		expect(result).toContain("## main")
		expect(getGitStatus).toHaveBeenCalledWith(mockCwd, 10)
	})

	it("should NOT include git status when maxGitStatusFiles is 0", async () => {
		mockProvider.getState.mockResolvedValue({
			...mockState,
			maxGitStatusFiles: 0,
		})

		const result = await getEnvironmentDetails(mockShofer as Task)

		expect(result).not.toContain("# Git Status")
		expect(getGitStatus).not.toHaveBeenCalled()
	})

	it("should NOT include git status when maxGitStatusFiles is undefined (defaults to 0)", async () => {
		mockProvider.getState.mockResolvedValue({
			...mockState,
			maxGitStatusFiles: undefined,
		})

		const result = await getEnvironmentDetails(mockShofer as Task)

		expect(result).not.toContain("# Git Status")
		expect(getGitStatus).not.toHaveBeenCalled()
	})

	it("should handle git status returning null gracefully when enabled", async () => {
		;(getGitStatus as Mock).mockResolvedValue(null)
		mockProvider.getState.mockResolvedValue({
			...mockState,
			maxGitStatusFiles: 10,
		})

		const result = await getEnvironmentDetails(mockShofer as Task)

		expect(result).not.toContain("# Git Status")
		expect(getGitStatus).toHaveBeenCalledWith(mockCwd, 10)
	})

	it("should pass maxFiles parameter to getGitStatus", async () => {
		;(getGitStatus as Mock).mockResolvedValue("## main")
		mockProvider.getState.mockResolvedValue({
			...mockState,
			maxGitStatusFiles: 5,
		})

		await getEnvironmentDetails(mockShofer as Task)

		expect(getGitStatus).toHaveBeenCalledWith(mockCwd, 5)
	})
})
