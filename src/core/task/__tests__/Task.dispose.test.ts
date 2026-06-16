import { ProviderSettings } from "@shofer/types"

import { Task } from "../Task"
import { ShoferProvider } from "../../webview/ShoferProvider"
// Prevent the transitive import graph from loading extension.ts,
// which pulls in WorkflowTask (which extends Task — circular).
vi.mock("../../../extension", () => ({}))


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
vi.mock("../../../utils/logging/subsystems", () => {
	const noop = () => {}
	return {
		taskLog: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
		webviewLog: { error: noop, info: noop, warn: noop },
		apiLog: { error: noop, info: noop, warn: noop },
		codeIndexLog: { error: noop, info: noop, warn: noop },
		configLog: { error: noop, info: noop, warn: noop },
		utilLog: { error: noop, info: noop, warn: noop },
		fsLog: { error: noop, info: noop, warn: noop },
		gitLog: { error: noop, info: noop, warn: noop },
		checkpointLog: { error: noop, info: noop, warn: noop },
		liveMemoryLog: { error: noop, info: noop, warn: noop },
		mcpLog: { error: noop, info: noop, warn: noop },
		skillsLog: { error: noop, info: noop, warn: noop },
		marketplaceLog: { error: noop, info: noop, warn: noop },
		metricsLog: { error: noop, info: noop, warn: noop },
		workflowLog: { error: noop, info: noop, warn: noop },
		i18nLog: { error: noop, info: noop, warn: noop },
		scrollLog: { error: noop, info: noop, warn: noop },
	}
})

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

describe("Task dispose method", () => {
	let mockProvider: any
	let mockApiConfiguration: ProviderSettings
	let task: Task

	beforeEach(() => {
		// Reset all mocks
		vi.clearAllMocks()

		// Mock provider
		mockProvider = {
			context: {
				globalStorageUri: { fsPath: "/test/path" },
			},
			getState: vi.fn().mockResolvedValue({ mode: "code" }),
			log: vi.fn(),
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
		// Clean up
		if (task && !task.abort) {
			task.dispose()
		}
	})

	test("should remove all event listeners when dispose is called", () => {
		// Add some event listeners using type assertion to bypass strict typing for testing
		const listener1 = vi.fn(() => {})
		const listener2 = vi.fn(() => {})
		const listener3 = vi.fn((taskId: string) => {})

		// Use type assertion to bypass strict event typing for testing
		;(task as any).on("TaskStarted", listener1)
		;(task as any).on("TaskAborted", listener2)
		;(task as any).on("TaskIdle", listener3)

		// Verify listeners are added
		expect(task.listenerCount("TaskStarted")).toBe(1)
		expect(task.listenerCount("TaskAborted")).toBe(1)
		expect(task.listenerCount("TaskIdle")).toBe(1)

		// Spy on removeAllListeners method
		const removeAllListenersSpy = vi.spyOn(task, "removeAllListeners")

		// Call dispose
		task.dispose()

		// Verify removeAllListeners was called
		expect(removeAllListenersSpy).toHaveBeenCalledOnce()

		// Verify all listeners are removed
		expect(task.listenerCount("TaskStarted")).toBe(0)
		expect(task.listenerCount("TaskAborted")).toBe(0)
		expect(task.listenerCount("TaskIdle")).toBe(0)
	})

	test("should handle errors when removing event listeners", () => {
		// Mock removeAllListeners to throw an error
		const originalRemoveAllListeners = task.removeAllListeners
		task.removeAllListeners = vi.fn(() => {
			throw new Error("Test error")
		})

		// Call dispose - should not throw
		expect(() => task.dispose()).not.toThrow()

		// Restore
		task.removeAllListeners = originalRemoveAllListeners
	})

	test("should clean up all resources in correct order", () => {
		const removeAllListenersSpy = vi.spyOn(task, "removeAllListeners")
		// Call dispose
		task.dispose()

		// Verify removeAllListeners was called first (before other cleanup)
		expect(removeAllListenersSpy).toHaveBeenCalledOnce()
	})

	test("should prevent memory leaks by removing listeners before other cleanup", () => {
		// Add multiple listeners of different types using type assertion for testing
		const listeners = {
			TaskStarted: vi.fn(() => {}),
			TaskAborted: vi.fn(() => {}),
			TaskIdle: vi.fn((taskId: string) => {}),
			TaskActive: vi.fn((taskId: string) => {}),
			TaskAskResponded: vi.fn(() => {}),
			Message: vi.fn((data: { action: "created" | "updated"; message: any }) => {}),
			TaskTokenUsageUpdated: vi.fn((taskId: string, tokenUsage: any) => {}),
			TaskToolFailed: vi.fn((taskId: string, tool: any, error: string) => {}),
			TaskUnpaused: vi.fn(() => {}),
		}

		// Add all listeners using type assertion to bypass strict typing for testing
		const taskAny = task as any
		taskAny.on("TaskStarted", listeners.TaskStarted)
		taskAny.on("TaskAborted", listeners.TaskAborted)
		taskAny.on("TaskIdle", listeners.TaskIdle)
		taskAny.on("TaskActive", listeners.TaskActive)
		taskAny.on("TaskAskResponded", listeners.TaskAskResponded)
		taskAny.on("Message", listeners.Message)
		taskAny.on("TaskTokenUsageUpdated", listeners.TaskTokenUsageUpdated)
		taskAny.on("TaskToolFailed", listeners.TaskToolFailed)
		taskAny.on("TaskUnpaused", listeners.TaskUnpaused)

		// Verify all listeners are added
		expect(task.listenerCount("TaskStarted")).toBe(1)
		expect(task.listenerCount("TaskAborted")).toBe(1)
		expect(task.listenerCount("TaskIdle")).toBe(1)
		expect(task.listenerCount("TaskActive")).toBe(1)
		expect(task.listenerCount("TaskAskResponded")).toBe(1)
		expect(task.listenerCount("Message")).toBe(1)
		expect(task.listenerCount("TaskTokenUsageUpdated")).toBe(1)
		expect(task.listenerCount("TaskToolFailed")).toBe(1)
		expect(task.listenerCount("TaskUnpaused")).toBe(1)

		// Call dispose
		task.dispose()

		// Verify all listeners are removed
		expect(task.listenerCount("TaskStarted")).toBe(0)
		expect(task.listenerCount("TaskAborted")).toBe(0)
		expect(task.listenerCount("TaskIdle")).toBe(0)
		expect(task.listenerCount("TaskActive")).toBe(0)
		expect(task.listenerCount("TaskAskResponded")).toBe(0)
		expect(task.listenerCount("Message")).toBe(0)
		expect(task.listenerCount("TaskTokenUsageUpdated")).toBe(0)
		expect(task.listenerCount("TaskToolFailed")).toBe(0)
		expect(task.listenerCount("TaskUnpaused")).toBe(0)

		// Verify total listener count is 0
		expect(task.eventNames().length).toBe(0)
	})
})
