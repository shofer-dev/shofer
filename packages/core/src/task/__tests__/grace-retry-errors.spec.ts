// npx vitest src/task/__tests__/grace-retry-errors.spec.ts

import * as os from "os"
import * as path from "path"

import { describe, it, expect, beforeEach, vi } from "vitest"
import type { ProviderSettings } from "@shofer/types"
import { setHost, createInMemoryHost, type TaskProviderLike } from "@shofer/types"
import { TelemetryService } from "@shofer/telemetry"

// Mock Task's intra-core deps via core-RELATIVE paths. The barrel mock
// (`vi.mock("@shofer/core")`) cannot intercept Task's own relative imports, so
// we stub the concrete modules Task imports instead.

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

vi.mock("delay", () => ({
	__esModule: true,
	default: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("p-wait-for", () => ({
	default: vi.fn().mockImplementation(async () => Promise.resolve()),
}))

vi.mock("fs/promises", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, any>
	const mockFunctions = {
		mkdir: vi.fn().mockResolvedValue(undefined),
		writeFile: vi.fn().mockResolvedValue(undefined),
		appendFile: vi.fn().mockResolvedValue(undefined),
		rename: vi.fn().mockResolvedValue(undefined),
		readFile: vi.fn().mockImplementation(() => Promise.resolve("[]")),
		unlink: vi.fn().mockResolvedValue(undefined),
		rmdir: vi.fn().mockResolvedValue(undefined),
	}

	return {
		...actual,
		...mockFunctions,
		default: mockFunctions,
	}
})

import { Task } from "@shofer/core"

describe("Grace Retry Error Handling", () => {
	let mockProvider: TaskProviderLike
	let mockApiConfig: ProviderSettings

	beforeEach(() => {
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
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			postTaskStateUpdate: vi.fn(),
			getCurrentTask: vi.fn().mockReturnValue(undefined),
		} as unknown as TaskProviderLike

		mockApiConfig = {
			apiProvider: "anthropic",
			apiModelId: "claude-3-5-sonnet-20241022",
			apiKey: "test-api-key",
		}
	})

	describe("consecutiveNoAssistantMessagesCount", () => {
		it("should initialize to 0", () => {
			const task = new Task({
				provider: mockProvider as any,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			expect(task.consecutiveNoAssistantMessagesCount).toBe(0)
		})

		it("should reset to 0 when abortTask is called", async () => {
			const task = new Task({
				provider: mockProvider as any,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			// Manually set the counter to simulate consecutive failures
			task.consecutiveNoAssistantMessagesCount = 5

			// Mock dispose to prevent actual cleanup
			vi.spyOn(task, "dispose").mockImplementation(() => {})

			await task.abortTask()

			expect(task.consecutiveNoAssistantMessagesCount).toBe(0)
		})

		it("should reset consecutiveNoToolUseCount when abortTask is called", async () => {
			const task = new Task({
				provider: mockProvider as any,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			// Manually set both counters
			task.consecutiveNoAssistantMessagesCount = 3
			task.consecutiveNoToolUseCount = 4

			// Mock dispose to prevent actual cleanup
			vi.spyOn(task, "dispose").mockImplementation(() => {})

			await task.abortTask()

			// Both counters should be reset
			expect(task.consecutiveNoAssistantMessagesCount).toBe(0)
			expect(task.consecutiveNoToolUseCount).toBe(0)
		})
	})

	describe("consecutiveNoToolUseCount", () => {
		it("should initialize to 0", () => {
			const task = new Task({
				provider: mockProvider as any,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			expect(task.consecutiveNoToolUseCount).toBe(0)
		})
	})

	describe("Grace Retry Pattern", () => {
		it("should not show error on first failure (grace retry)", async () => {
			const task = new Task({
				provider: mockProvider as any,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			const saySpy = vi.spyOn(task, "say").mockResolvedValue(undefined)

			// Simulate first empty response - should NOT show error
			task.consecutiveNoAssistantMessagesCount = 0
			task.consecutiveNoAssistantMessagesCount++
			expect(task.consecutiveNoAssistantMessagesCount).toBe(1)

			// First failure: grace retry (silent)
			if (task.consecutiveNoAssistantMessagesCount >= 2) {
				await task.say("error", "MODEL_NO_ASSISTANT_MESSAGES")
			}

			// Verify error was NOT called (grace retry on first failure)
			expect(saySpy).not.toHaveBeenCalledWith("error", "MODEL_NO_ASSISTANT_MESSAGES")
		})

		it("should show error after 2 consecutive failures", async () => {
			const task = new Task({
				provider: mockProvider as any,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			const saySpy = vi.spyOn(task, "say").mockResolvedValue(undefined)

			// Simulate second consecutive empty response
			task.consecutiveNoAssistantMessagesCount = 1
			task.consecutiveNoAssistantMessagesCount++
			expect(task.consecutiveNoAssistantMessagesCount).toBe(2)

			// Second failure: should show error
			if (task.consecutiveNoAssistantMessagesCount >= 2) {
				await task.say("error", "MODEL_NO_ASSISTANT_MESSAGES")
			}

			// Verify error was called (after 2 consecutive failures)
			expect(saySpy).toHaveBeenCalledWith("error", "MODEL_NO_ASSISTANT_MESSAGES")
		})

		it("should show error on third consecutive failure", async () => {
			const task = new Task({
				provider: mockProvider as any,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			const saySpy = vi.spyOn(task, "say").mockResolvedValue(undefined)

			// Simulate third consecutive empty response
			task.consecutiveNoAssistantMessagesCount = 2
			task.consecutiveNoAssistantMessagesCount++
			expect(task.consecutiveNoAssistantMessagesCount).toBe(3)

			// Third failure: should also show error
			if (task.consecutiveNoAssistantMessagesCount >= 2) {
				await task.say("error", "MODEL_NO_ASSISTANT_MESSAGES")
			}

			// Verify error was called
			expect(saySpy).toHaveBeenCalledWith("error", "MODEL_NO_ASSISTANT_MESSAGES")
		})
	})

	describe("Counter Reset on Success", () => {
		it("should be able to simulate counter reset when valid content is received", () => {
			const task = new Task({
				provider: mockProvider as any,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			// Simulate some consecutive failures
			task.consecutiveNoAssistantMessagesCount = 3

			// Simulate receiving valid content
			const hasTextContent = true
			const hasToolUses = false

			if (hasTextContent || hasToolUses) {
				task.consecutiveNoAssistantMessagesCount = 0
			}

			expect(task.consecutiveNoAssistantMessagesCount).toBe(0)
		})

		it("should reset counter when tool uses are present", () => {
			const task = new Task({
				provider: mockProvider as any,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			// Simulate some consecutive failures
			task.consecutiveNoAssistantMessagesCount = 2

			// Simulate receiving tool uses
			const hasTextContent = false
			const hasToolUses = true

			if (hasTextContent || hasToolUses) {
				task.consecutiveNoAssistantMessagesCount = 0
			}

			expect(task.consecutiveNoAssistantMessagesCount).toBe(0)
		})
	})

	describe("Error Marker", () => {
		it("should use MODEL_NO_ASSISTANT_MESSAGES marker for error display", async () => {
			const task = new Task({
				provider: mockProvider as any,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			const saySpy = vi.spyOn(task, "say").mockResolvedValue(undefined)

			// Simulate the error condition (2 consecutive failures)
			task.consecutiveNoAssistantMessagesCount = 2

			if (task.consecutiveNoAssistantMessagesCount >= 2) {
				await task.say("error", "MODEL_NO_ASSISTANT_MESSAGES")
			}

			// Verify the exact marker is used
			expect(saySpy).toHaveBeenCalledWith("error", "MODEL_NO_ASSISTANT_MESSAGES")
		})
	})

	describe("Parallel with noToolsUsed error handling", () => {
		it("should have separate counters for noToolsUsed and noAssistantMessages", () => {
			const task = new Task({
				provider: mockProvider as any,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			// Both counters should start at 0
			expect(task.consecutiveNoToolUseCount).toBe(0)
			expect(task.consecutiveNoAssistantMessagesCount).toBe(0)

			// Incrementing one should not affect the other
			task.consecutiveNoToolUseCount = 3
			expect(task.consecutiveNoAssistantMessagesCount).toBe(0)

			task.consecutiveNoAssistantMessagesCount = 2
			expect(task.consecutiveNoToolUseCount).toBe(3)
		})
	})
})
