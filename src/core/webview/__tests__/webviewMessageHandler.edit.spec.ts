import type { Mock } from "vitest"
import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock dependencies first
vi.mock("vscode", async (importOriginal) => {
	const actual: any = await importOriginal()
	const showWarningMessage = vi.fn()
	const showErrorMessage = vi.fn()
	const getConfigurationMock = vi.fn().mockReturnValue({
		get: vi.fn(),
		update: vi.fn(),
	})
	const uriFile = vi.fn((p: string) => ({ fsPath: p }))

	return {
		...actual,
		window: {
			...actual.window,
			showWarningMessage,
			showErrorMessage,
		},
		workspace: {
			...actual.workspace,
			workspaceFolders: [{ uri: { fsPath: "/mock/workspace" } }],
			getConfiguration: getConfigurationMock,
		},
		Uri: {
			...actual.Uri,
			file: uriFile,
		},
		env: {
			...actual.env,
			uriScheme: "vscode",
		},
	}
})

vi.mock("../../task-persistence", () => ({
	saveTaskMessages: vi.fn(),
}))

vi.mock("../../../api/providers/fetchers/modelCache", () => ({
	getModels: vi.fn(),
	flushModels: vi.fn(),
	getModelsFromCache: vi.fn().mockReturnValue(undefined),
}))

vi.mock("../checkpointRestoreHandler", () => ({
	handleCheckpointRestoreOperation: vi.fn(),
}))

// Import after mocks
import { webviewMessageHandler } from "../webviewMessageHandler"
import type { ShoferProvider } from "../ShoferProvider"
import type { ShoferMessage } from "@shofer/types"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import { MessageManager } from "../../message-manager"

describe("webviewMessageHandler - Edit Message with Timestamp Fallback", () => {
	let mockShoferProvider: ShoferProvider
	let mockCurrentTask: any

	beforeEach(() => {
		vi.clearAllMocks()

		// Create a mock task with messages
		mockCurrentTask = {
			taskId: "test-task-id",
			shoferMessages: [] as ShoferMessage[],
			apiConversationHistory: [] as ApiMessage[],
			overwriteShoferMessages: vi.fn(),
			overwriteApiConversationHistory: vi.fn(),
			handleWebviewAskResponse: vi.fn(),
		}
		mockCurrentTask.messageManager = new MessageManager(mockCurrentTask)

		// Create mock provider
		mockShoferProvider = {
			getCurrentTask: vi.fn().mockReturnValue(mockCurrentTask),
			postMessageToWebview: vi.fn(),
			contextProxy: {
				getValue: vi.fn(),
				setValue: vi.fn(),
				globalStorageUri: { fsPath: "/mock/storage" },
			},
			log: vi.fn(),
			getState: vi.fn().mockResolvedValue({
				maxImageFileSize: 5,
				maxTotalImageSize: 20,
			}),
		} as unknown as ShoferProvider
	})

	it("should not modify API history when apiConversationHistoryIndex is -1", async () => {
		// Setup: User message followed by attempt_completion
		const userMessageTs = 1000
		const assistantMessageTs = 2000
		const completionMessageTs = 3000

		// UI messages (shoferMessages)
		mockCurrentTask.shoferMessages = [
			{
				ts: userMessageTs,
				type: "say",
				say: "user_feedback",
				text: "Hello",
			} as ShoferMessage,
			{
				ts: completionMessageTs,
				type: "say",
				say: "completion_result",
				text: "Task Completed!",
			} as ShoferMessage,
		]

		// API conversation history - note the user message is missing (common scenario after condense)
		mockCurrentTask.apiConversationHistory = [
			{
				ts: assistantMessageTs,
				role: "assistant",
				content: [
					{
						type: "text",
						text: "I'll help you with that.",
					},
				],
			},
			{
				ts: completionMessageTs,
				role: "assistant",
				content: [
					{
						type: "tool_use",
						name: "attempt_completion",
						id: "tool-1",
						input: {
							result: "Task Completed!",
						},
					},
				],
			},
		] as ApiMessage[]

		// Trigger edit confirmation
		await webviewMessageHandler(mockShoferProvider, {
			type: "editMessageConfirm",
			messageTs: userMessageTs,
			text: "Hello World", // edited content
			restoreCheckpoint: false,
		})

		// Verify that UI messages were truncated at the correct index
		expect(mockCurrentTask.overwriteShoferMessages).toHaveBeenCalledWith(
			[], // All messages before index 0 (empty array)
		)

		// API history should be truncated from first message at/after edited timestamp (fallback)
		expect(mockCurrentTask.overwriteApiConversationHistory).toHaveBeenCalledWith([])
	})

	it("should preserve messages before the edited message when message not in API history", async () => {
		const earlierMessageTs = 500
		const userMessageTs = 1000
		const assistantMessageTs = 2000

		// UI messages
		mockCurrentTask.shoferMessages = [
			{
				ts: earlierMessageTs,
				type: "say",
				say: "user_feedback",
				text: "Earlier message",
			} as ShoferMessage,
			{
				ts: userMessageTs,
				type: "say",
				say: "user_feedback",
				text: "Hello",
			} as ShoferMessage,
			{
				ts: assistantMessageTs,
				type: "say",
				say: "text",
				text: "Response",
			} as ShoferMessage,
		]

		// API history - missing the exact user message at ts=1000
		mockCurrentTask.apiConversationHistory = [
			{
				ts: earlierMessageTs,
				role: "user",
				content: [{ type: "text", text: "Earlier message" }],
			},
			{
				ts: assistantMessageTs,
				role: "assistant",
				content: [{ type: "text", text: "Response" }],
			},
		] as ApiMessage[]

		await webviewMessageHandler(mockShoferProvider, {
			type: "editMessageConfirm",
			messageTs: userMessageTs,
			text: "Hello World",
			restoreCheckpoint: false,
		})

		// Verify UI messages were truncated to preserve earlier message
		expect(mockCurrentTask.overwriteShoferMessages).toHaveBeenCalledWith([
			{
				ts: earlierMessageTs,
				type: "say",
				say: "user_feedback",
				text: "Earlier message",
			},
		])

		// API history should be truncated from the first API message at/after the edited timestamp (fallback)
		expect(mockCurrentTask.overwriteApiConversationHistory).toHaveBeenCalledWith([
			{
				ts: earlierMessageTs,
				role: "user",
				content: [{ type: "text", text: "Earlier message" }],
			},
		])
	})

	it("should not use fallback when exact apiConversationHistoryIndex is found", async () => {
		const userMessageTs = 1000
		const assistantMessageTs = 2000

		// Both UI and API have the message at the same timestamp
		mockCurrentTask.shoferMessages = [
			{
				ts: userMessageTs,
				type: "say",
				say: "user_feedback",
				text: "Hello",
			} as ShoferMessage,
			{
				ts: assistantMessageTs,
				type: "say",
				say: "text",
				text: "Response",
			} as ShoferMessage,
		]

		mockCurrentTask.apiConversationHistory = [
			{
				ts: userMessageTs,
				role: "user",
				content: [{ type: "text", text: "Hello" }],
			},
			{
				ts: assistantMessageTs,
				role: "assistant",
				content: [{ type: "text", text: "Response" }],
			},
		] as ApiMessage[]

		await webviewMessageHandler(mockShoferProvider, {
			type: "editMessageConfirm",
			messageTs: userMessageTs,
			text: "Hello World",
			restoreCheckpoint: false,
		})

		// Both should be truncated at index 0
		expect(mockCurrentTask.overwriteShoferMessages).toHaveBeenCalledWith([])
		expect(mockCurrentTask.overwriteApiConversationHistory).toHaveBeenCalledWith([])
	})

	it("should handle case where no API messages match timestamp criteria", async () => {
		const userMessageTs = 3000

		mockCurrentTask.shoferMessages = [
			{
				ts: userMessageTs,
				type: "say",
				say: "user_feedback",
				text: "Hello",
			} as ShoferMessage,
		]

		// All API messages have timestamps before the edited message
		mockCurrentTask.apiConversationHistory = [
			{
				ts: 1000,
				role: "assistant",
				content: [{ type: "text", text: "Old message 1" }],
			},
			{
				ts: 2000,
				role: "assistant",
				content: [{ type: "text", text: "Old message 2" }],
			},
		] as ApiMessage[]

		await webviewMessageHandler(mockShoferProvider, {
			type: "editMessageConfirm",
			messageTs: userMessageTs,
			text: "Hello World",
			restoreCheckpoint: false,
		})

		// UI messages truncated
		expect(mockCurrentTask.overwriteShoferMessages).toHaveBeenCalledWith([])

		// API history should not be modified when no API messages meet the timestamp criteria
		expect(mockCurrentTask.overwriteApiConversationHistory).not.toHaveBeenCalled()
	})

	it("should handle empty API conversation history gracefully", async () => {
		const userMessageTs = 1000

		mockCurrentTask.shoferMessages = [
			{
				ts: userMessageTs,
				type: "say",
				say: "user_feedback",
				text: "Hello",
			} as ShoferMessage,
		]

		mockCurrentTask.apiConversationHistory = []

		await webviewMessageHandler(mockShoferProvider, {
			type: "editMessageConfirm",
			messageTs: userMessageTs,
			text: "Hello World",
			restoreCheckpoint: false,
		})

		// UI messages should be truncated
		expect(mockCurrentTask.overwriteShoferMessages).toHaveBeenCalledWith([])

		// API history should not be modified when message not found
		expect(mockCurrentTask.overwriteApiConversationHistory).not.toHaveBeenCalled()
	})

	it("should correctly handle attempt_completion in API history", async () => {
		const userMessageTs = 1000
		const completionTs = 2000
		const feedbackTs = 3000

		mockCurrentTask.shoferMessages = [
			{
				ts: userMessageTs,
				type: "say",
				say: "user_feedback",
				text: "Do something",
			} as ShoferMessage,
			{
				ts: completionTs,
				type: "say",
				say: "completion_result",
				text: "Task Completed!",
			} as ShoferMessage,
			{
				ts: feedbackTs,
				type: "say",
				say: "user_feedback",
				text: "Thanks",
			} as ShoferMessage,
		]

		// API history with attempt_completion tool use (user message missing)
		mockCurrentTask.apiConversationHistory = [
			{
				ts: completionTs,
				role: "assistant",
				content: [
					{
						type: "tool_use",
						name: "attempt_completion",
						id: "tool-1",
						input: {
							result: "Task Completed!",
						},
					},
				],
			},
			{
				ts: feedbackTs,
				role: "user",
				content: [
					{
						type: "text",
						text: "Thanks",
					},
				],
			},
		] as ApiMessage[]

		// Edit the first user message
		await webviewMessageHandler(mockShoferProvider, {
			type: "editMessageConfirm",
			messageTs: userMessageTs,
			text: "Do something else",
			restoreCheckpoint: false,
		})

		// UI messages truncated at edited message
		expect(mockCurrentTask.overwriteShoferMessages).toHaveBeenCalledWith([])

		// API history should be truncated from first message at/after edited timestamp (fallback)
		expect(mockCurrentTask.overwriteApiConversationHistory).toHaveBeenCalledWith([])
	})
})
