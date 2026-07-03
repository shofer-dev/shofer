// npx vitest run src/task/__tests__/flushPendingToolResultsToHistory.spec.ts

import * as os from "os"
import * as path from "path"

import type { ProviderSettings } from "@shofer/types"
import { setHost, createInMemoryHost } from "@shofer/types"

import { Task } from "../Task.js"

// Mock Task's intra-core dependencies via core-RELATIVE paths so the mocks
// actually intercept (Task calls them through relative imports; a barrel mock
// of @shofer/core cannot intercept intra-package relative calls).
vi.mock("../../ignore/ShoferIgnoreController.js")
vi.mock("../../protect/ShoferProtectedController.js")
vi.mock("../../context-tracking/FileContextTracker.js")
vi.mock("../../api/index.js", () => ({
	buildApiHandler: vi.fn(() => ({
		getModel: () => ({ info: {}, id: "test-model" }),
	})),
}))
vi.mock("../../tools/ToolRepetitionDetector.js", () => ({
	ToolRepetitionDetector: class {
		check() {
			return { allowExecution: true }
		}
	},
}))

// Mock TelemetryService — @shofer/telemetry is a SEPARATE package, so the barrel
// mock intercepts Task's `import { TelemetryService } from "@shofer/telemetry"`.
vi.mock("@shofer/telemetry", () => ({
	TelemetryService: {
		hasInstance: vi.fn(() => true),
		instance: {
			captureTaskCreated: vi.fn(),
			captureTaskRestarted: vi.fn(),
		},
	},
}))

// Keep the flush path off SQLite: mock the api-message leaf module that
// `SqliteMessagePersistence.appendApiMessage` delegates to relatively.
vi.mock("../../task-persistence/apiMessages.js", () => ({
	appendApiMessage: vi.fn().mockResolvedValue(undefined),
	readApiMessages: vi.fn().mockResolvedValue([]),
	readApiMessagesTail: vi.fn().mockResolvedValue([[], false]),
	saveApiMessages: vi.fn().mockResolvedValue(undefined),
}))

const { mockPWaitFor } = vi.hoisted(() => {
	return { mockPWaitFor: vi.fn().mockImplementation(async () => Promise.resolve()) }
})

vi.mock("p-wait-for", () => ({
	default: mockPWaitFor,
}))

describe("flushPendingToolResultsToHistory", () => {
	let mockProvider: any
	let mockApiConfig: ProviderSettings

	beforeEach(() => {
		vi.clearAllMocks()

		// In-memory host supplies createDiffView (NoopDiffView) + config/fs.
		setHost(createInMemoryHost())

		// Minimal provider stub (TaskProviderLike shape): the flush path only
		// touches the provider for globalStoragePath and the blob cap. Returning
		// a blob cap of 0 makes externalizeMessageContent a no-op, keeping the
		// test off disk entirely.
		mockProvider = {
			context: {
				globalStorageUri: { fsPath: path.join(os.tmpdir(), "test-storage") },
			},
			getState: vi.fn().mockResolvedValue({ mode: "code", currentApiConfigName: "default" }),
			log: vi.fn(),
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			updateTaskHistory: vi.fn().mockResolvedValue(undefined),
			getCurrentTask: vi.fn().mockReturnValue(undefined),
			taskManager: { getFocusedTaskId: vi.fn().mockReturnValue(undefined) },
			contextProxy: { getValue: vi.fn().mockReturnValue(0) },
		}

		mockApiConfig = {
			apiProvider: "anthropic",
			apiModelId: "claude-3-5-sonnet-20241022",
			apiKey: "test-api-key",
		}
	})

	it("should not save anything when userMessageContent is empty", async () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
		})

		// Ensure userMessageContent is empty
		task.userMessageContent = []
		const initialHistoryLength = task.apiConversationHistory.length

		// Call flush
		await task.flushPendingToolResultsToHistory()

		// History should not have changed since userMessageContent was empty
		expect(task.apiConversationHistory.length).toBe(initialHistoryLength)
	})

	it("should save user message when userMessageContent has pending tool results", async () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
		})

		// Set up pending tool result in userMessageContent
		task.userMessageContent = [
			{
				type: "tool_result",
				tool_use_id: "tool-123",
				content: "File written successfully",
			},
		]

		await task.flushPendingToolResultsToHistory()

		// Should have saved 1 user message
		expect(task.apiConversationHistory.length).toBe(1)

		// Check user message with tool result
		const userMessage = task.apiConversationHistory[0]!
		expect(userMessage.role).toBe("user")
		expect(Array.isArray(userMessage.content)).toBe(true)
		expect((userMessage.content as any[])[0].type).toBe("tool_result")
		expect((userMessage.content as any[])[0].tool_use_id).toBe("tool-123")
	})

	it("should clear userMessageContent after flushing", async () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
		})

		// Set up pending tool result
		task.userMessageContent = [
			{
				type: "tool_result",
				tool_use_id: "tool-456",
				content: "Command executed",
			},
		]

		await task.flushPendingToolResultsToHistory()

		// userMessageContent should be cleared
		expect(task.userMessageContent.length).toBe(0)
	})

	it("should handle multiple tool results in a single flush", async () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
		})

		// Set up multiple pending tool results
		task.userMessageContent = [
			{
				type: "tool_result",
				tool_use_id: "tool-1",
				content: "First result",
			},
			{
				type: "tool_result",
				tool_use_id: "tool-2",
				content: "Second result",
			},
		]

		await task.flushPendingToolResultsToHistory()

		// Check user message has both tool results
		const userMessage = task.apiConversationHistory[0]!
		expect(Array.isArray(userMessage.content)).toBe(true)
		expect((userMessage.content as any[]).length).toBe(2)
		expect((userMessage.content as any[])[0].tool_use_id).toBe("tool-1")
		expect((userMessage.content as any[])[1].tool_use_id).toBe("tool-2")
	})

	it("should add timestamp to saved messages", async () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
		})

		const beforeTs = Date.now()

		task.userMessageContent = [
			{
				type: "tool_result",
				tool_use_id: "tool-ts",
				content: "Result",
			},
		]

		await task.flushPendingToolResultsToHistory()

		const afterTs = Date.now()

		// Message should have timestamp
		expect((task.apiConversationHistory[0] as any).ts).toBeGreaterThanOrEqual(beforeTs)
		expect((task.apiConversationHistory[0] as any).ts).toBeLessThanOrEqual(afterTs)
	})

	it("should skip waiting for assistantMessageSavedToHistory when flag is already true", async () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
		})

		// Set flag to true (assistant message already saved)
		task.assistantMessageSavedToHistory = true

		// Set up pending tool result
		task.userMessageContent = [
			{
				type: "tool_result",
				tool_use_id: "tool-skip-wait",
				content: "Result when flag is true",
			},
		]

		// Clear mock call history
		mockPWaitFor.mockClear()

		await task.flushPendingToolResultsToHistory()

		// Should not have called pWaitFor since flag was already true
		expect(mockPWaitFor).not.toHaveBeenCalled()

		// Should still save the message
		expect(task.apiConversationHistory.length).toBe(1)
		expect((task.apiConversationHistory[0]!.content as any[])[0].tool_use_id).toBe("tool-skip-wait")
	})

	it("should wait for assistantMessageSavedToHistory when flag is false", async () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
		})

		// Flag is false by default - assistant message not yet saved
		expect(task.assistantMessageSavedToHistory).toBe(false)

		// Set up pending tool result
		task.userMessageContent = [
			{
				type: "tool_result",
				tool_use_id: "tool-wait",
				content: "Result when flag is false",
			},
		]

		// Clear mock call history
		mockPWaitFor.mockClear()

		await task.flushPendingToolResultsToHistory()

		// Should have called pWaitFor since flag was false
		expect(mockPWaitFor).toHaveBeenCalled()

		// Should still save the message (mock resolves immediately)
		expect(task.apiConversationHistory.length).toBe(1)
	})

	it("should not flush when task is aborted during wait", async () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
		})

		// Flag is false - will need to wait
		task.assistantMessageSavedToHistory = false

		// Set up pending tool result
		task.userMessageContent = [
			{
				type: "tool_result",
				tool_use_id: "tool-aborted",
				content: "Should not be saved",
			},
		]

		// Set abort flag - this will cause the condition in pWaitFor to return true
		// AND will cause early return after the wait
		task.abort = true

		await task.flushPendingToolResultsToHistory()

		// Should not have saved anything since task was aborted
		expect(task.apiConversationHistory.length).toBe(0)
	})
})
