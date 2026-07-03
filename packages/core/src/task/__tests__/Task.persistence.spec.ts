// npx vitest run src/task/__tests__/Task.persistence.spec.ts

import * as os from "os"
import * as path from "path"

import { describe, it, expect, beforeEach, vi } from "vitest"
import type { ProviderSettings, TaskProviderLike } from "@shofer/types"
import { setHost, createInMemoryHost } from "@shofer/types"
import { TelemetryService } from "@shofer/telemetry"

// Task and its persistence deps live in @shofer/core and are imported via
// intra-package RELATIVE sub-paths (…/task-persistence/PersistencePort.js, etc.),
// so a barrel `vi.mock("@shofer/core")` cannot intercept them. We stub the
// concrete relative modules Task imports instead.

// ─── Hoisted mocks ───────────────────────────────────────────────────────────

const {
	mockSaveApiMessages,
	mockSaveTaskMessages,
	mockAppendApiMessage,
	mockAppendTaskMessage,
	mockReadApiMessages,
	mockReadTaskMessages,
	mockTaskMetadata,
	mockPWaitFor,
} = vi.hoisted(() => ({
	mockSaveApiMessages: vi.fn().mockResolvedValue(undefined),
	mockSaveTaskMessages: vi.fn().mockResolvedValue(undefined),
	mockAppendApiMessage: vi.fn().mockResolvedValue(undefined),
	mockAppendTaskMessage: vi.fn().mockResolvedValue(undefined),
	mockReadApiMessages: vi.fn().mockResolvedValue([]),
	mockReadTaskMessages: vi.fn().mockResolvedValue([]),
	mockTaskMetadata: vi.fn().mockResolvedValue({
		historyItem: { id: "test-id", ts: Date.now(), task: "test" },
		tokenUsage: {
			totalTokensIn: 0,
			totalTokensOut: 0,
			totalCacheWrites: 0,
			totalCacheReads: 0,
			totalCost: 0,
			contextTokens: 0,
		},
	}),
	mockPWaitFor: vi.fn().mockResolvedValue(undefined),
}))

// ─── Module mocks ────────────────────────────────────────────────────────────

vi.mock("delay", () => ({
	__esModule: true,
	default: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("execa", () => ({
	execa: vi.fn(),
}))

vi.mock("fs/promises", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, any>
	return {
		...actual,
		mkdir: vi.fn().mockResolvedValue(undefined),
		writeFile: vi.fn().mockResolvedValue(undefined),
		readFile: vi.fn().mockResolvedValue("[]"),
		unlink: vi.fn().mockResolvedValue(undefined),
		rmdir: vi.fn().mockResolvedValue(undefined),
		default: {
			mkdir: vi.fn().mockResolvedValue(undefined),
			writeFile: vi.fn().mockResolvedValue(undefined),
			readFile: vi.fn().mockResolvedValue("[]"),
			unlink: vi.fn().mockResolvedValue(undefined),
			rmdir: vi.fn().mockResolvedValue(undefined),
		},
	}
})

vi.mock("p-wait-for", () => ({
	default: mockPWaitFor,
}))

// §5: Task reads/writes through the SQLite-backed MessagePersistencePort, which
// it instantiates via `new SqliteMessagePersistence(...)` imported from
// `../task-persistence/PersistencePort.js`. This mock backend delegates to the
// hoisted mock fns (with the original arg shape) so the call assertions hold.
vi.mock("../../task-persistence/PersistencePort.js", () => {
	class MockBackend {
		appendApiMessage(taskId: string, message: unknown) {
			return mockAppendApiMessage({ message, taskId, globalStoragePath: "" })
		}
		readApiMessages(taskId: string) {
			return mockReadApiMessages({ taskId, globalStoragePath: "" })
		}
		readApiMessagesTail() {
			return Promise.resolve([[], false])
		}
		saveApiMessages(taskId: string, messages: unknown, serialized?: string) {
			return mockSaveApiMessages({ messages, taskId, globalStoragePath: "", serialized })
		}
		appendTaskMessage(taskId: string, message: unknown) {
			return mockAppendTaskMessage({ message, taskId, globalStoragePath: "" })
		}
		readTaskMessages(taskId: string) {
			return mockReadTaskMessages({ taskId, globalStoragePath: "" })
		}
		readTaskMessagesTail() {
			return Promise.resolve([[], false])
		}
		saveTaskMessages(taskId: string, messages: unknown, serialized?: string) {
			return mockSaveTaskMessages({ messages, taskId, globalStoragePath: "", serialized })
		}
		disposeAppendHandleForTask() {
			return Promise.resolve()
		}
	}
	return { SqliteMessagePersistence: MockBackend }
})

vi.mock("../../task-persistence/taskMetadata.js", () => ({
	taskMetadata: mockTaskMetadata,
}))

vi.mock("../../condense/index.js", async (importOriginal) => ({
	...((await importOriginal()) as Record<string, unknown>),
	summarizeConversation: vi.fn().mockResolvedValue({
		messages: [{ role: "user", content: [{ type: "text", text: "continued" }], ts: Date.now() }],
		summary: "summary",
		cost: 0,
		newContextTokens: 1,
	}),
}))

// Noop ignore controller so constructing a Task doesn't spin up the real file watcher.
vi.mock("../../ignore/ShoferIgnoreController.js", () => ({
	ShoferIgnoreController: class {
		validateAccess() {
			return true
		}
		validateCommand() {
			return undefined
		}
		filterPaths(paths: string[]) {
			return paths
		}
		getInstructions() {
			return undefined
		}
		async initialize() {}
		dispose() {}
	},
}))

vi.mock("../../utils/storage.js", async (importOriginal) => ({
	...((await importOriginal()) as Record<string, unknown>),
	getTaskDirectoryPath: vi
		.fn()
		.mockImplementation((globalStoragePath, taskId) => Promise.resolve(`${globalStoragePath}/tasks/${taskId}`)),
	getSettingsDirectoryPath: vi
		.fn()
		.mockImplementation((globalStoragePath) => Promise.resolve(`${globalStoragePath}/settings`)),
}))

// Import Task AFTER all vi.mock() calls - Vitest hoists mocks so this works.
import { Task } from "@shofer/core"

// ─── Test suite ──────────────────────────────────────────────────────────────

describe("Task persistence", () => {
	let mockProvider: TaskProviderLike & Record<string, any>
	let mockApiConfig: ProviderSettings

	beforeEach(() => {
		vi.clearAllMocks()

		setHost(createInMemoryHost())
		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		const storageUri = { fsPath: path.join(os.tmpdir(), "test-storage") }

		// Plain provider stub typed as TaskProviderLike — never import concrete
		// src classes (ShoferProvider/ContextProxy) into a core test.
		mockProvider = {
			context: { globalStorageUri: storageUri },
			getState: vi.fn().mockResolvedValue({}),
			log: vi.fn(),
			on: vi.fn(),
			off: vi.fn(),
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			postTaskStateUpdate: vi.fn(),
			updateTaskHistory: vi.fn().mockResolvedValue(undefined),
			getCurrentTask: vi.fn().mockReturnValue(undefined),
		} as unknown as TaskProviderLike & Record<string, any>

		mockApiConfig = {
			apiProvider: "anthropic",
			apiModelId: "claude-3-5-sonnet-20241022",
			apiKey: "test-api-key",
		}
	})

	// ── saveApiConversationHistory (via retrySaveApiConversationHistory) ──

	describe("saveApiConversationHistory", () => {
		it("returns true on success", async () => {
			mockSaveApiMessages.mockResolvedValueOnce(undefined)

			const task = new Task({
				provider: mockProvider as any,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			task.apiConversationHistory.push({
				role: "user",
				content: [{ type: "text", text: "hello" }],
			})

			const result = await task.retrySaveApiConversationHistory()
			expect(result).toBe(true)
		})

		it("returns false on failure", async () => {
			vi.useFakeTimers()

			// All 3 retry attempts must fail for retrySaveApiConversationHistory to return false
			mockSaveApiMessages
				.mockRejectedValueOnce(new Error("fail 1"))
				.mockRejectedValueOnce(new Error("fail 2"))
				.mockRejectedValueOnce(new Error("fail 3"))

			const task = new Task({
				provider: mockProvider as any,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			const promise = task.retrySaveApiConversationHistory()
			await vi.runAllTimersAsync()
			const result = await promise

			expect(result).toBe(false)
			expect(mockSaveApiMessages).toHaveBeenCalledTimes(3)

			vi.useRealTimers()
		})

		it("succeeds on 2nd retry attempt", async () => {
			vi.useFakeTimers()

			mockSaveApiMessages.mockRejectedValueOnce(new Error("fail 1")).mockResolvedValueOnce(undefined) // succeeds on 2nd try

			const task = new Task({
				provider: mockProvider as any,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			const promise = task.retrySaveApiConversationHistory()
			await vi.runAllTimersAsync()
			const result = await promise

			expect(result).toBe(true)
			expect(mockSaveApiMessages).toHaveBeenCalledTimes(2)

			vi.useRealTimers()
		})

		it("persists the full conversation history to saveApiMessages", async () => {
			mockSaveApiMessages.mockResolvedValueOnce(undefined)

			const task = new Task({
				provider: mockProvider as any,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			const originalMsg = {
				role: "user" as const,
				content: [{ type: "text" as const, text: "snapshot test" }],
			}
			task.apiConversationHistory.push(originalMsg)

			await task.retrySaveApiConversationHistory()

			expect(mockSaveApiMessages).toHaveBeenCalledTimes(1)
			// §5: SQLite write — the live message array is passed (no JSONL snapshot).
			const callArgs = mockSaveApiMessages.mock.calls[0][0]
			expect(callArgs.messages).toEqual(task.apiConversationHistory)
		})
	})

	// ── saveShoferMessages ────────────────────────────────────────────────

	describe("saveShoferMessages", () => {
		// §5: messages persist incrementally via appendTaskMessage (SQLite), so
		// saveShoferMessages no longer compacts — it just refreshes task metadata.
		it("returns true on success", async () => {
			const task = new Task({
				provider: mockProvider as any,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})
			const result = await (task as Record<string, any>).saveShoferMessages()
			expect(result).toBe(true)
		})

		it("returns false when the metadata refresh fails", async () => {
			mockTaskMetadata.mockRejectedValueOnce(new Error("metadata error"))

			const task = new Task({
				provider: mockProvider as any,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})
			const result = await (task as Record<string, any>).saveShoferMessages()
			expect(result).toBe(false)
		})
	})

	// ── flushPendingToolResultsToHistory — save failure/success ───────────

	describe("flushPendingToolResultsToHistory persistence", () => {
		it("retains userMessageContent on save failure", async () => {
			mockAppendApiMessage.mockRejectedValueOnce(new Error("disk full"))

			const task = new Task({
				provider: mockProvider as any,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			// Skip waiting for assistant message
			task.assistantMessageSavedToHistory = true

			task.userMessageContent = [
				{
					type: "tool_result",
					tool_use_id: "tool-fail",
					content: "Result that should be retained",
				},
			]

			const saved = await task.flushPendingToolResultsToHistory()

			expect(saved).toBe(false)
			// userMessageContent should NOT be cleared on failure
			expect(task.userMessageContent.length).toBeGreaterThan(0)
			expect(task.userMessageContent[0]).toMatchObject({
				type: "tool_result",
				tool_use_id: "tool-fail",
			})
		})

		it("clears userMessageContent on save success", async () => {
			mockAppendApiMessage.mockResolvedValueOnce(undefined)

			const task = new Task({
				provider: mockProvider as any,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			// Skip waiting for assistant message
			task.assistantMessageSavedToHistory = true

			task.userMessageContent = [
				{
					type: "tool_result",
					tool_use_id: "tool-ok",
					content: "Result that should be cleared",
				},
			]

			const saved = await task.flushPendingToolResultsToHistory()

			expect(saved).toBe(true)
			// userMessageContent should be cleared on success
			expect(task.userMessageContent).toEqual([])
		})
	})
})
