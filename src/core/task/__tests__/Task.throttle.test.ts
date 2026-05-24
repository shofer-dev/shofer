import { ShoferEventName, ProviderSettings, TokenUsage, ToolUsage } from "@shofer/types"

import { Task } from "../Task"
import { ShoferProvider } from "../../webview/ShoferProvider"
import { hasToolUsageChanged, hasTokenUsageChanged } from "../../../shared/getApiMetrics"

// Mock dependencies
vi.mock("../../webview/ShoferProvider")
vi.mock("../../../integrations/terminal/TerminalRegistry", () => ({
	TerminalRegistry: {
		releaseTerminalsForTask: vi.fn(),
	},
}))
vi.mock("../../ignore/ShoferIgnoreController")
vi.mock("../../protect/ShoferProtectedController")
vi.mock("../../context-tracking/FileContextTracker")
vi.mock("../../../integrations/editor/DiffViewProvider")
vi.mock("../../tools/ToolRepetitionDetector")
vi.mock("../../../api", () => ({
	buildApiHandler: vi.fn(() => ({
		getModel: () => ({ info: {}, id: "test-model" }),
	})),
}))

// Mock TelemetryService
vi.mock("@shofer/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureTaskCreated: vi.fn(),
			captureTaskRestarted: vi.fn(),
		},
	},
}))

// Mock task persistence to avoid disk writes
vi.mock("../../task-persistence", () => ({
	readApiMessages: vi.fn().mockResolvedValue([]),
	saveApiMessages: vi.fn().mockResolvedValue(undefined),
	appendApiMessage: vi.fn().mockResolvedValue(undefined),
	readTaskMessages: vi.fn().mockResolvedValue([]),
	saveTaskMessages: vi.fn().mockResolvedValue(undefined),
	appendTaskMessage: vi.fn().mockResolvedValue(undefined),
	taskMetadata: vi.fn().mockResolvedValue({
		historyItem: {
			id: "test-task-id",
			number: 1,
			task: "Test task",
			ts: Date.now(),
			totalCost: 0.01,
			tokensIn: 100,
			tokensOut: 50,
		},
		tokenUsage: {
			totalTokensIn: 100,
			totalTokensOut: 50,
			totalCost: 0.01,
			contextTokens: 150,
			totalCacheWrites: 0,
			totalCacheReads: 0,
		},
	}),
}))

describe("Task token usage throttling", () => {
	let mockProvider: any
	let mockApiConfiguration: ProviderSettings
	let task: Task

	beforeEach(() => {
		// Reset all mocks
		vi.clearAllMocks()
		vi.useFakeTimers()

		// Mock provider
		mockProvider = {
			context: {
				globalStorageUri: { fsPath: "/test/path" },
			},
			getState: vi.fn().mockResolvedValue({ mode: "code" }),
			log: vi.fn(),
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
			postStateToWebviewWithoutTaskHistory: vi.fn().mockResolvedValue(undefined),
			postStateToWebviewWithoutShoferMessages: vi.fn().mockResolvedValue(undefined),
			updateTaskHistory: vi.fn().mockResolvedValue(undefined),
			getCurrentTask: vi.fn().mockReturnValue(undefined),
			taskManager: {
				getFocusedTaskId: vi.fn().mockReturnValue(undefined),
			},
		}

		// Mock API configuration
		mockApiConfiguration = {
			apiProvider: "anthropic",
			apiKey: "test-key",
		} as ProviderSettings

		// Create task instance without starting it
		task = new Task({
			provider: mockProvider as ShoferProvider,
			apiConfiguration: mockApiConfiguration,
			startTask: false,
		})
	})

	afterEach(() => {
		vi.useRealTimers()
		if (task && !task.abort) {
			task.dispose()
		}
	})

	/**
	 * Flush the 250-ms save debounce and drain the resulting async chain.
	 * addToShoferMessages schedules a trailing-only debounce; emission only
	 * happens after that save completes. Advancing 300 ms fires the debounce,
	 * then three microtask flushes drain taskMetadata → debouncedEmitTokenUsage.
	 */
	const flushSave = async () => {
		vi.advanceTimersByTime(300)
		await Promise.resolve()
		await Promise.resolve()
		await Promise.resolve()
	}

	test("should emit TaskTokenUsageUpdated immediately on first change", async () => {
		const emitSpy = vi.spyOn(task, "emit")

		// Add a message to trigger saveShoferMessages
		await (task as any).addToShoferMessages({
			ts: Date.now(),
			type: "say",
			say: "text",
			text: "Test message",
		})
		await flushSave()

		// Should emit on first change (leading edge of emit throttle)
		expect(emitSpy).toHaveBeenCalledWith(
			ShoferEventName.TaskTokenUsageUpdated,
			task.taskId,
			expect.any(Object),
			expect.any(Object),
		)
	})

	test("should throttle subsequent emissions within 2 seconds", async () => {
		const { taskMetadata } = await import("../../task-persistence")
		let callCount = 0

		// Mock to return different token usage on each call
		vi.mocked(taskMetadata).mockImplementation(async () => {
			callCount++
			return {
				historyItem: {
					id: "test-task-id",
					number: 1,
					task: "Test task",
					ts: Date.now(),
					totalCost: 0.01 * callCount,
					tokensIn: 100 * callCount,
					tokensOut: 50 * callCount,
				},
				tokenUsage: {
					totalTokensIn: 100 * callCount,
					totalTokensOut: 50 * callCount,
					totalCost: 0.01 * callCount,
					contextTokens: 150 * callCount,
					totalCacheWrites: 0,
					totalCacheReads: 0,
				},
			}
		})

		const emitSpy = vi.spyOn(task, "emit")

		// First message - should emit on leading edge
		await (task as any).addToShoferMessages({
			ts: Date.now(),
			type: "say",
			say: "text",
			text: "Message 1",
		})
		await flushSave() // flush 250-ms save debounce → emit fires (leading)

		const firstEmitCount = emitSpy.mock.calls.filter(
			(call) => call[0] === ShoferEventName.TaskTokenUsageUpdated,
		).length

		// Second message within throttle window (800 ms since last emit) — should NOT emit
		vi.advanceTimersByTime(500)
		await (task as any).addToShoferMessages({
			ts: Date.now(),
			type: "say",
			say: "text",
			text: "Message 2",
		})
		await flushSave() // flush save → throttled

		const secondEmitCount = emitSpy.mock.calls.filter(
			(call) => call[0] === ShoferEventName.TaskTokenUsageUpdated,
		).length

		// Should still be the same count (throttled)
		expect(secondEmitCount).toBe(firstEmitCount)

		// Third message after throttle window expires (~2400 ms since first emit) — should emit
		vi.advanceTimersByTime(1600)
		await (task as any).addToShoferMessages({
			ts: Date.now(),
			type: "say",
			say: "text",
			text: "Message 3",
		})
		await flushSave() // flush save → emit fires (past 2-second throttle)

		const thirdEmitCount = emitSpy.mock.calls.filter(
			(call) => call[0] === ShoferEventName.TaskTokenUsageUpdated,
		).length

		// Should have emitted again after throttle period
		expect(thirdEmitCount).toBeGreaterThan(secondEmitCount)
	})

	test("should include toolUsage in emission payload", async () => {
		const emitSpy = vi.spyOn(task, "emit")

		// Set some tool usage
		task.toolUsage = {
			read_file: { attempts: 5, failures: 1 },
			write_to_file: { attempts: 3, failures: 0 },
		}

		// Add a message to trigger emission
		await (task as any).addToShoferMessages({
			ts: Date.now(),
			type: "say",
			say: "text",
			text: "Test message",
		})
		await flushSave()

		// Should emit with toolUsage as third parameter
		expect(emitSpy).toHaveBeenCalledWith(
			ShoferEventName.TaskTokenUsageUpdated,
			task.taskId,
			expect.any(Object), // tokenUsage
			task.toolUsage, // toolUsage
		)
	})

	test("should force final emission on task abort", async () => {
		const emitSpy = vi.spyOn(task, "emit")

		// Set some tool usage
		task.toolUsage = {
			read_file: { attempts: 5, failures: 1 },
		}

		// Add a message first
		await (task as any).addToShoferMessages({
			ts: Date.now(),
			type: "say",
			say: "text",
			text: "Message 1",
		})

		// Clear the spy to check for final emission
		emitSpy.mockClear()

		// Abort task immediately (within throttle window)
		vi.advanceTimersByTime(500)
		await task.abortTask()

		// Should have emitted TaskTokenUsageUpdated before TaskAborted
		const calls = emitSpy.mock.calls
		const tokenUsageUpdateIndex = calls.findIndex((call) => call[0] === ShoferEventName.TaskTokenUsageUpdated)
		const taskAbortedIndex = calls.findIndex((call) => call[0] === ShoferEventName.TaskAborted)

		// Should have both events
		expect(tokenUsageUpdateIndex).toBeGreaterThanOrEqual(0)
		expect(taskAbortedIndex).toBeGreaterThanOrEqual(0)

		// TaskTokenUsageUpdated should come before TaskAborted
		expect(tokenUsageUpdateIndex).toBeLessThan(taskAbortedIndex)
	})

	test("should update tokenUsageSnapshot when throttled emission occurs", async () => {
		const { taskMetadata } = await import("../../task-persistence")
		let callCount = 0

		// Mock to return different token usage on each call
		vi.mocked(taskMetadata).mockImplementation(async () => {
			callCount++
			return {
				historyItem: {
					id: "test-task-id",
					number: 1,
					task: "Test task",
					ts: Date.now(),
					totalCost: 0.01 * callCount,
					tokensIn: 100 * callCount,
					tokensOut: 50 * callCount,
				},
				tokenUsage: {
					totalTokensIn: 100 * callCount,
					totalTokensOut: 50 * callCount,
					totalCost: 0.01 * callCount,
					contextTokens: 150 * callCount,
					totalCacheWrites: 0,
					totalCacheReads: 0,
				},
			}
		})

		// Add initial message and flush so snapshot is set
		await (task as any).addToShoferMessages({
			ts: Date.now(),
			type: "say",
			say: "text",
			text: "Message 1",
		})
		await flushSave() // flush save → emit fires → tokenUsageSnapshot set

		// Get the initial snapshot (set by the first emission)
		const initialSnapshot = (task as any).tokenUsageSnapshot

		// Add another message within throttle window (800 ms since last emit)
		vi.advanceTimersByTime(500)
		await (task as any).addToShoferMessages({
			ts: Date.now(),
			type: "say",
			say: "text",
			text: "Message 2",
		})
		await flushSave() // flush save → throttled → snapshot unchanged

		// Snapshot should still be the same (throttled)
		expect((task as any).tokenUsageSnapshot).toBe(initialSnapshot)

		// Add message after throttle window (~2400 ms since first emit)
		vi.advanceTimersByTime(1600)
		await (task as any).addToShoferMessages({
			ts: Date.now(),
			type: "say",
			say: "text",
			text: "Message 3",
		})
		await flushSave() // flush save → emit fires → snapshot updated

		// Snapshot should be updated now (new object reference)
		expect((task as any).tokenUsageSnapshot).not.toBe(initialSnapshot)
		// Values should be different
		expect((task as any).tokenUsageSnapshot.totalTokensIn).toBeGreaterThan(initialSnapshot.totalTokensIn)
	})

	test("should not emit if token usage has not changed even after throttle period", async () => {
		const { taskMetadata } = await import("../../task-persistence")

		// Mock taskMetadata to return same token usage
		const constantTokenUsage: TokenUsage = {
			totalTokensIn: 100,
			totalTokensOut: 50,
			totalCost: 0.01,
			contextTokens: 150,
			totalCacheWrites: 0,
			totalCacheReads: 0,
		}

		vi.mocked(taskMetadata).mockResolvedValue({
			historyItem: {
				id: "test-task-id",
				number: 1,
				task: "Test task",
				ts: Date.now(),
				totalCost: 0.01,
				tokensIn: 100,
				tokensOut: 50,
			},
			tokenUsage: constantTokenUsage,
		})

		const emitSpy = vi.spyOn(task, "emit")

		// Add first message and flush so the first emission is recorded
		await (task as any).addToShoferMessages({
			ts: Date.now(),
			type: "say",
			say: "text",
			text: "Message 1",
		})
		await flushSave() // flush save → emit fires

		const firstEmitCount = emitSpy.mock.calls.filter(
			(call) => call[0] === ShoferEventName.TaskTokenUsageUpdated,
		).length

		// Wait past throttle period and add another message with the same token usage
		vi.advanceTimersByTime(2100)
		await (task as any).addToShoferMessages({
			ts: Date.now(),
			type: "say",
			say: "text",
			text: "Message 2",
		})
		await flushSave() // flush save → no emit (token usage unchanged)

		const secondEmitCount = emitSpy.mock.calls.filter(
			(call) => call[0] === ShoferEventName.TaskTokenUsageUpdated,
		).length

		// Should not have emitted again since token usage didn't change
		expect(secondEmitCount).toBe(firstEmitCount)
	})

	test("should emit when tool usage changes even if token usage is the same", async () => {
		const { taskMetadata } = await import("../../task-persistence")

		// Mock taskMetadata to return same token usage
		const constantTokenUsage: TokenUsage = {
			totalTokensIn: 100,
			totalTokensOut: 50,
			totalCost: 0.01,
			contextTokens: 150,
			totalCacheWrites: 0,
			totalCacheReads: 0,
		}

		vi.mocked(taskMetadata).mockResolvedValue({
			historyItem: {
				id: "test-task-id",
				number: 1,
				task: "Test task",
				ts: Date.now(),
				totalCost: 0.01,
				tokensIn: 100,
				tokensOut: 50,
			},
			tokenUsage: constantTokenUsage,
		})

		const emitSpy = vi.spyOn(task, "emit")

		// Add first message - should emit
		await (task as any).addToShoferMessages({
			ts: Date.now(),
			type: "say",
			say: "text",
			text: "Message 1",
		})

		const firstEmitCount = emitSpy.mock.calls.filter(
			(call) => call[0] === ShoferEventName.TaskTokenUsageUpdated,
		).length

		// Wait for throttle period
		vi.advanceTimersByTime(2100)

		// Change tool usage (token usage stays the same)
		task.toolUsage = {
			read_file: { attempts: 5, failures: 1 },
		}

		// Add another message
		await (task as any).addToShoferMessages({
			ts: Date.now(),
			type: "say",
			say: "text",
			text: "Message 2",
		})

		const secondEmitCount = emitSpy.mock.calls.filter(
			(call) => call[0] === ShoferEventName.TaskTokenUsageUpdated,
		).length

		// Should have emitted because tool usage changed even though token usage didn't
		expect(secondEmitCount).toBeGreaterThan(firstEmitCount)
	})

	test("should update toolUsageSnapshot when emission occurs", async () => {
		// Add initial message and flush so the first emission sets the snapshot
		await (task as any).addToShoferMessages({
			ts: Date.now(),
			type: "say",
			say: "text",
			text: "Message 1",
		})
		await flushSave() // flush save → emit fires → toolUsageSnapshot set to {}

		// toolUsageSnapshot should now be a deep copy of the empty toolUsage
		const initialSnapshot = (task as any).toolUsageSnapshot
		expect(initialSnapshot).toBeDefined()
		expect(Object.keys(initialSnapshot)).toHaveLength(0)

		// Wait past throttle period
		vi.advanceTimersByTime(2100)

		// Update tool usage
		task.toolUsage = {
			read_file: { attempts: 3, failures: 0 },
			write_to_file: { attempts: 2, failures: 1 },
		}

		// Add another message and flush so the second emission updates the snapshot
		await (task as any).addToShoferMessages({
			ts: Date.now(),
			type: "say",
			say: "text",
			text: "Message 2",
		})
		await flushSave() // flush save → emit fires → toolUsageSnapshot updated

		// Snapshot should be updated to match the new toolUsage
		const newSnapshot = (task as any).toolUsageSnapshot
		expect(newSnapshot).not.toBe(initialSnapshot)
		expect(newSnapshot.read_file).toEqual({ attempts: 3, failures: 0 })
		expect(newSnapshot.write_to_file).toEqual({ attempts: 2, failures: 1 })
	})

	test("emitFinalTokenUsageUpdate should emit on tool usage change alone", async () => {
		const emitSpy = vi.spyOn(task, "emit")

		// Set initial tool usage and simulate previous emission
		;(task as any).tokenUsageSnapshot = task.getTokenUsage()
		;(task as any).toolUsageSnapshot = {}

		// Change tool usage
		task.toolUsage = {
			execute_command: { attempts: 1, failures: 0 },
		}

		// Call emitFinalTokenUsageUpdate
		task.emitFinalTokenUsageUpdate()

		// Should emit due to tool usage change
		expect(emitSpy).toHaveBeenCalledWith(
			ShoferEventName.TaskTokenUsageUpdated,
			task.taskId,
			expect.any(Object),
			task.toolUsage,
		)
	})
})

describe("hasToolUsageChanged", () => {
	test("should return true when snapshot is undefined and current has data", () => {
		const current: ToolUsage = {
			read_file: { attempts: 1, failures: 0 },
		}
		expect(hasToolUsageChanged(current, undefined)).toBe(true)
	})

	test("should return false when both are empty", () => {
		expect(hasToolUsageChanged({}, {})).toBe(false)
	})

	test("should return false when snapshot is undefined and current is empty", () => {
		expect(hasToolUsageChanged({}, undefined)).toBe(false)
	})

	test("should return true when a new tool is added", () => {
		const current: ToolUsage = {
			read_file: { attempts: 1, failures: 0 },
			write_to_file: { attempts: 1, failures: 0 },
		}
		const snapshot: ToolUsage = {
			read_file: { attempts: 1, failures: 0 },
		}
		expect(hasToolUsageChanged(current, snapshot)).toBe(true)
	})

	test("should return true when attempts change", () => {
		const current: ToolUsage = {
			read_file: { attempts: 2, failures: 0 },
		}
		const snapshot: ToolUsage = {
			read_file: { attempts: 1, failures: 0 },
		}
		expect(hasToolUsageChanged(current, snapshot)).toBe(true)
	})

	test("should return true when failures change", () => {
		const current: ToolUsage = {
			read_file: { attempts: 1, failures: 1 },
		}
		const snapshot: ToolUsage = {
			read_file: { attempts: 1, failures: 0 },
		}
		expect(hasToolUsageChanged(current, snapshot)).toBe(true)
	})

	test("should return false when nothing changed", () => {
		const current: ToolUsage = {
			read_file: { attempts: 3, failures: 1 },
			write_to_file: { attempts: 2, failures: 0 },
		}
		const snapshot: ToolUsage = {
			read_file: { attempts: 3, failures: 1 },
			write_to_file: { attempts: 2, failures: 0 },
		}
		expect(hasToolUsageChanged(current, snapshot)).toBe(false)
	})
})

describe("hasTokenUsageChanged", () => {
	test("should return true when snapshot is undefined", () => {
		const current: TokenUsage = {
			totalTokensIn: 100,
			totalTokensOut: 50,
			totalCost: 0.01,
			contextTokens: 150,
		}
		expect(hasTokenUsageChanged(current, undefined)).toBe(true)
	})

	test("should return true when totalTokensIn changes", () => {
		const current: TokenUsage = {
			totalTokensIn: 200,
			totalTokensOut: 50,
			totalCost: 0.01,
			contextTokens: 150,
		}
		const snapshot: TokenUsage = {
			totalTokensIn: 100,
			totalTokensOut: 50,
			totalCost: 0.01,
			contextTokens: 150,
		}
		expect(hasTokenUsageChanged(current, snapshot)).toBe(true)
	})

	test("should return false when nothing changed", () => {
		const current: TokenUsage = {
			totalTokensIn: 100,
			totalTokensOut: 50,
			totalCost: 0.01,
			contextTokens: 150,
			totalCacheWrites: 10,
			totalCacheReads: 5,
		}
		const snapshot: TokenUsage = {
			totalTokensIn: 100,
			totalTokensOut: 50,
			totalCost: 0.01,
			contextTokens: 150,
			totalCacheWrites: 10,
			totalCacheReads: 5,
		}
		expect(hasTokenUsageChanged(current, snapshot)).toBe(false)
	})
})
