import { describe, it, expect, vi, beforeEach } from "vitest"
import type { ProviderSettings } from "@shofer/types"
import { setHost, createInMemoryHost } from "@shofer/types"

// All vi.mock() calls are hoisted to the top of the file by Vitest
// and are applied before any imports are resolved.

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
			captureConversationMessage: vi.fn(),
			captureLlmCompletion: vi.fn(),
			captureConsecutiveMistakeError: vi.fn(),
		},
	},
}))

// Keep the persist path off disk: mock the SQLite storage engine the default
// backend drives, rather than the facade — backend selection stays real.
vi.mock("../../task-persistence/message-store.js", () => ({
	storeAppend: vi.fn().mockResolvedValue(undefined),
	storeReadAll: vi.fn().mockResolvedValue([]),
	storeReadTail: vi.fn().mockResolvedValue([[], false]),
	storeSaveAll: vi.fn().mockResolvedValue(undefined),
}))

// Import Task AFTER all vi.mock() calls - Vitest hoists mocks so this works
import { Task } from "../Task.js"

describe("Task grounding sources handling", () => {
	let mockProvider: any
	let mockApiConfiguration: ProviderSettings

	beforeEach(() => {
		vi.clearAllMocks()

		// In-memory host supplies createDiffView (NoopDiffView) + config/fs.
		setHost(createInMemoryHost())

		// Minimal provider stub (TaskProviderLike shape). `contextProxy.getValue`
		// returning 0 sets the blob cap to 0, making externalizeMessageContent a
		// no-op so the test stays off disk.
		mockProvider = {
			postInitState: vi.fn().mockResolvedValue(undefined),
			postConfigUpdate: vi.fn(),
			postTaskStateUpdate: vi.fn(),
			getState: vi.fn().mockResolvedValue({
				mode: "code",
				experiments: {},
			}),
			context: {
				globalStorageUri: { fsPath: "/test/storage" },
				extensionPath: "/test/extension",
			} as any,
			log: vi.fn(),
			updateTaskHistory: vi.fn().mockResolvedValue(undefined),
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			getCurrentTask: vi.fn().mockReturnValue(undefined),
			taskManager: { getFocusedTaskId: vi.fn().mockReturnValue(undefined) },
			contextProxy: { getValue: vi.fn().mockReturnValue(0) },
		}

		mockApiConfiguration = {
			apiProvider: "gemini",
			geminiApiKey: "test-key",
		} as ProviderSettings
	})

	it("should strip grounding sources from assistant message before persisting to API history", async () => {
		// Create a task instance
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfiguration,
			task: "Test task",
			startTask: false,
		})

		// Mock the API conversation history
		task.apiConversationHistory = []

		// Simulate an assistant message with grounding sources
		const assistantMessageWithSources = `
This is the main response content.

[1] Example Source: https://example.com
[2] Another Source: https://another.com

Sources: [1](https://example.com), [2](https://another.com)
		`.trim()

		// Mock grounding sources
		const mockGroundingSources = [
			{ title: "Example Source", url: "https://example.com" },
			{ title: "Another Source", url: "https://another.com" },
		]

		// Spy on addToApiConversationHistory to check what gets persisted
		const addToApiHistorySpy = vi.spyOn(task as any, "addToApiConversationHistory")

		// Simulate the logic from Task.ts that strips grounding sources
		let cleanAssistantMessage = assistantMessageWithSources
		if (mockGroundingSources.length > 0) {
			cleanAssistantMessage = assistantMessageWithSources
				.replace(/\[\d+\]\s+[^:\n]+:\s+https?:\/\/[^\s\n]+/g, "") // e.g., "[1] Example Source: https://example.com"
				.replace(/Sources?:\s*[\s\S]*?(?=\n\n|\n$|$)/g, "") // e.g., "Sources: [1](url1), [2](url2)"
				.trim()
		}

		// Add the cleaned message to API history
		await (task as any).addToApiConversationHistory({
			role: "assistant",
			content: [{ type: "text", text: cleanAssistantMessage }],
		})

		// Verify that the cleaned message was added without grounding sources
		expect(addToApiHistorySpy).toHaveBeenCalledWith({
			role: "assistant",
			content: [{ type: "text", text: "This is the main response content." }],
		})

		// Verify the API conversation history contains the cleaned message
		expect(task.apiConversationHistory).toHaveLength(1)
		expect(task.apiConversationHistory[0]!.content).toEqual([
			{ type: "text", text: "This is the main response content." },
		])
	})

	it("should not modify assistant message when no grounding sources are present", async () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfiguration,
			task: "Test task",
			startTask: false,
		})

		task.apiConversationHistory = []

		const assistantMessage = "This is a regular response without any sources."
		const mockGroundingSources: any[] = [] // No grounding sources

		// Apply the same logic
		let cleanAssistantMessage = assistantMessage
		if (mockGroundingSources.length > 0) {
			cleanAssistantMessage = assistantMessage
				.replace(/\[\d+\]\s+[^:\n]+:\s+https?:\/\/[^\s\n]+/g, "")
				.replace(/Sources?:\s*[\s\S]*?(?=\n\n|\n$|$)/g, "")
				.trim()
		}

		await (task as any).addToApiConversationHistory({
			role: "assistant",
			content: [{ type: "text", text: cleanAssistantMessage }],
		})

		// Message should remain unchanged
		expect(task.apiConversationHistory[0]!.content).toEqual([
			{ type: "text", text: "This is a regular response without any sources." },
		])
	})

	it("should handle various grounding source formats", () => {
		const testCases = [
			{
				input: "[1] Source Title: https://example.com\n[2] Another: https://test.com\nMain content here",
				expected: "Main content here",
			},
			{
				input: "Content first\n\nSources: [1](https://example.com), [2](https://test.com)",
				expected: "Content first",
			},
			{
				input: "Mixed content\n[1] Inline Source: https://inline.com\nMore content\nSource: [1](https://inline.com)",
				expected: "Mixed content\n\nMore content",
			},
		]

		testCases.forEach(({ input, expected }) => {
			const cleaned = input
				.replace(/\[\d+\]\s+[^:\n]+:\s+https?:\/\/[^\s\n]+/g, "")
				.replace(/Sources?:\s*[\s\S]*?(?=\n\n|\n$|$)/g, "")
				.trim()
			expect(cleaned).toBe(expected)
		})
	})
})
