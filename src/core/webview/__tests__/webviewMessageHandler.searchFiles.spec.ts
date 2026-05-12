// npx vitest core/webview/__tests__/webviewMessageHandler.searchFiles.spec.ts

import type { Mock } from "vitest"

// Mock dependencies - must come before imports
vi.mock("../../../services/search/file-search")
vi.mock("../../ignore/ShoferIgnoreController")

import { webviewMessageHandler } from "../webviewMessageHandler"
import type { ShoferProvider } from "../ShoferProvider"
import { searchWorkspaceFiles } from "../../../services/search/file-search"
import { ShoferIgnoreController } from "../../ignore/ShoferIgnoreController"

const mockSearchWorkspaceFiles = searchWorkspaceFiles as Mock<typeof searchWorkspaceFiles>

vi.mock("vscode", () => ({
	window: {
		showInformationMessage: vi.fn(),
		showErrorMessage: vi.fn(),
	},
	workspace: {
		workspaceFolders: [{ uri: { fsPath: "/mock/workspace" } }],
	},
}))

describe("webviewMessageHandler - searchFiles with ShoferIgnore filtering", () => {
	let mockShoferProvider: ShoferProvider
	let mockFilterPaths: Mock
	let mockDispose: Mock

	beforeEach(() => {
		vi.clearAllMocks()

		// Spy on the mock ShoferIgnoreController prototype methods
		mockFilterPaths = vi.fn()
		mockDispose = vi.fn()

		// Override the filterPaths method on the prototype
		;(ShoferIgnoreController.prototype as any).filterPaths = mockFilterPaths
		;(ShoferIgnoreController.prototype as any).initialize = vi.fn().mockResolvedValue(undefined)
		;(ShoferIgnoreController.prototype as any).dispose = mockDispose

		// Create mock ShoferProvider
		mockShoferProvider = {
			getState: vi.fn(),
			postMessageToWebview: vi.fn(),
			getCurrentTask: vi.fn(),
			cwd: "/mock/workspace",
		} as unknown as ShoferProvider
	})

	it("should filter results using ShoferIgnoreController when showShoferIgnoredFiles is false", async () => {
		// Setup mock results from file search
		const mockResults = [
			{ path: "src/index.ts", type: "file" as const, label: "index.ts" },
			{ path: "secrets/config.json", type: "file" as const, label: "config.json" },
			{ path: "src/utils.ts", type: "file" as const, label: "utils.ts" },
		]
		mockSearchWorkspaceFiles.mockResolvedValue(mockResults)

		// Setup state with showShoferIgnoredFiles = false
		;(mockShoferProvider.getState as Mock).mockResolvedValue({
			showShoferIgnoredFiles: false,
		})

		// Setup filter to exclude secrets folder
		mockFilterPaths.mockReturnValue(["src/index.ts", "src/utils.ts"])

		// No current task, so temporary controller will be created
		;(mockShoferProvider.getCurrentTask as Mock).mockReturnValue(null)

		await webviewMessageHandler(mockShoferProvider, {
			type: "searchFiles",
			query: "index",
			requestId: "test-request-123",
		})

		// Verify filterPaths was called with all result paths
		expect(mockFilterPaths).toHaveBeenCalledWith(["src/index.ts", "secrets/config.json", "src/utils.ts"])

		// Verify filtered results were sent to webview
		expect(mockShoferProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "fileSearchResults",
			results: [
				{ path: "src/index.ts", type: "file", label: "index.ts" },
				{ path: "src/utils.ts", type: "file", label: "utils.ts" },
			],
			requestId: "test-request-123",
		})
	})

	it("should not filter results when showShoferIgnoredFiles is true", async () => {
		// Setup mock results from file search
		const mockResults = [
			{ path: "src/index.ts", type: "file" as const, label: "index.ts" },
			{ path: "secrets/config.json", type: "file" as const, label: "config.json" },
		]
		mockSearchWorkspaceFiles.mockResolvedValue(mockResults)

		// Setup state with showShoferIgnoredFiles = true
		;(mockShoferProvider.getState as Mock).mockResolvedValue({
			showShoferIgnoredFiles: true,
		})

		// No current task
		;(mockShoferProvider.getCurrentTask as Mock).mockReturnValue(null)

		await webviewMessageHandler(mockShoferProvider, {
			type: "searchFiles",
			query: "index",
			requestId: "test-request-456",
		})

		// Verify filterPaths was NOT called
		expect(mockFilterPaths).not.toHaveBeenCalled()

		// Verify all results were sent to webview (unfiltered)
		expect(mockShoferProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "fileSearchResults",
			results: mockResults,
			requestId: "test-request-456",
		})
	})

	it("should use existing ShoferIgnoreController from current task", async () => {
		// Setup mock results from file search
		const mockResults = [
			{ path: "src/index.ts", type: "file" as const, label: "index.ts" },
			{ path: "private/secret.ts", type: "file" as const, label: "secret.ts" },
		]
		mockSearchWorkspaceFiles.mockResolvedValue(mockResults)

		// Setup state with showShoferIgnoredFiles = false
		;(mockShoferProvider.getState as Mock).mockResolvedValue({
			showShoferIgnoredFiles: false,
		})

		// Create a mock task with its own ShoferIgnoreController
		const taskFilterPaths = vi.fn().mockReturnValue(["src/index.ts"])
		const taskShoferIgnoreController = {
			filterPaths: taskFilterPaths,
			initialize: vi.fn(),
		}
		;(mockShoferProvider.getCurrentTask as Mock).mockReturnValue({
			taskId: "test-task-id",
			shoferIgnoreController: taskShoferIgnoreController,
		})

		await webviewMessageHandler(mockShoferProvider, {
			type: "searchFiles",
			query: "index",
			requestId: "test-request-789",
		})

		// Verify the task's controller was used (not the prototype)
		expect(taskFilterPaths).toHaveBeenCalledWith(["src/index.ts", "private/secret.ts"])

		// Verify filtered results were sent to webview
		expect(mockShoferProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "fileSearchResults",
			results: [{ path: "src/index.ts", type: "file", label: "index.ts" }],
			requestId: "test-request-789",
		})
	})

	it("should handle error when no workspace path is available", async () => {
		// Create provider without cwd
		mockShoferProvider = {
			...mockShoferProvider,
			cwd: undefined,
			getCurrentTask: vi.fn().mockReturnValue(null),
		} as unknown as ShoferProvider

		await webviewMessageHandler(mockShoferProvider, {
			type: "searchFiles",
			query: "test",
			requestId: "test-request-error",
		})

		// Verify error response was sent
		expect(mockShoferProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "fileSearchResults",
			results: [],
			requestId: "test-request-error",
			error: "No workspace path available",
		})
	})

	it("should handle errors from searchWorkspaceFiles", async () => {
		mockSearchWorkspaceFiles.mockRejectedValue(new Error("File search failed"))

		// Setup state
		;(mockShoferProvider.getState as Mock).mockResolvedValue({
			showShoferIgnoredFiles: false,
		})
		;(mockShoferProvider.getCurrentTask as Mock).mockReturnValue(null)

		await webviewMessageHandler(mockShoferProvider, {
			type: "searchFiles",
			query: "test",
			requestId: "test-request-fail",
		})

		// Verify error response was sent
		expect(mockShoferProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "fileSearchResults",
			results: [],
			error: "File search failed",
			requestId: "test-request-fail",
		})
	})

	it("should default showShoferIgnoredFiles to false when state is null", async () => {
		// Setup mock results from file search
		const mockResults = [{ path: "src/index.ts", type: "file" as const, label: "index.ts" }]
		mockSearchWorkspaceFiles.mockResolvedValue(mockResults)

		// Setup state to return null
		;(mockShoferProvider.getState as Mock).mockResolvedValue(null)

		// Setup filter to return all paths (no filtering)
		mockFilterPaths.mockReturnValue(["src/index.ts"])

		// No current task
		;(mockShoferProvider.getCurrentTask as Mock).mockReturnValue(null)

		await webviewMessageHandler(mockShoferProvider, {
			type: "searchFiles",
			query: "index",
			requestId: "test-request-default",
		})

		// Verify filterPaths was called (showShoferIgnoredFiles defaults to false)
		expect(mockFilterPaths).toHaveBeenCalled()
	})

	it("should dispose temporary ShoferIgnoreController after use", async () => {
		// Setup mock results from file search
		const mockResults = [{ path: "src/index.ts", type: "file" as const, label: "index.ts" }]
		mockSearchWorkspaceFiles.mockResolvedValue(mockResults)

		// Setup state
		;(mockShoferProvider.getState as Mock).mockResolvedValue({
			showShoferIgnoredFiles: false,
		})

		// Setup filter
		mockFilterPaths.mockReturnValue(["src/index.ts"])

		// No current task, so temporary controller will be created and should be disposed
		;(mockShoferProvider.getCurrentTask as Mock).mockReturnValue(null)

		await webviewMessageHandler(mockShoferProvider, {
			type: "searchFiles",
			query: "index",
			requestId: "test-request-dispose",
		})

		// Verify dispose was called on the temporary controller
		expect(mockDispose).toHaveBeenCalled()
	})

	it("should not dispose controller from current task", async () => {
		// Setup mock results from file search
		const mockResults = [{ path: "src/index.ts", type: "file" as const, label: "index.ts" }]
		mockSearchWorkspaceFiles.mockResolvedValue(mockResults)

		// Setup state
		;(mockShoferProvider.getState as Mock).mockResolvedValue({
			showShoferIgnoredFiles: false,
		})

		// Create a mock task with its own ShoferIgnoreController
		const taskFilterPaths = vi.fn().mockReturnValue(["src/index.ts"])
		const taskDispose = vi.fn()
		const taskShoferIgnoreController = {
			filterPaths: taskFilterPaths,
			initialize: vi.fn(),
			dispose: taskDispose,
		}
		;(mockShoferProvider.getCurrentTask as Mock).mockReturnValue({
			taskId: "test-task-id",
			shoferIgnoreController: taskShoferIgnoreController,
		})

		await webviewMessageHandler(mockShoferProvider, {
			type: "searchFiles",
			query: "index",
			requestId: "test-request-no-dispose",
		})

		// Verify dispose was NOT called on the task's controller
		expect(taskDispose).not.toHaveBeenCalled()
		// Verify the prototype dispose was also not called
		expect(mockDispose).not.toHaveBeenCalled()
	})
})
