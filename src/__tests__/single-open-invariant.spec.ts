// npx vitest run __tests__/single-open-invariant.spec.ts
//
// The single-open-task invariant is about the STACK, not about killing:
// `shoferStack` models the one chat a user is looking at, so at most one task
// may be open on it and `getCurrentTask()` must be unambiguous. Every case here
// pins that property.
//
// What differs is HOW room is made, and it differs by who is asking:
//
//   - A user-initiated create (the webview's New Chat, `ShoferProvider.createTask`)
//     means "replace what I was doing", so the popped task is ABORTED. Nobody is
//     waiting on it — the person who was is the one asking for the new one.
//   - A create through `ShoferExtensionApi` is NOT that. It is the entry point
//     every non-webview caller shares (the HTTP/SSE AgentApi, the CLI, IPC, the
//     public API), and on a headless `shofer serve` node many independent
//     conversations are driven through it at once, each by its own remote
//     controller. There, the task on the stack belongs to somebody else, and
//     aborting it destroyed a live conversation mid-turn: its controller saw a
//     `taskAborted` with reason `abandoned` and then nothing, because the agent
//     composing its reply had ceased to exist. So that path BACKGROUNDS instead
//     — popped off the stack (invariant intact, one open task), still running,
//     still addressable by id through `TaskManager`.
//
// The invariant is therefore asserted as the property it protects, not as a call
// to `removeShoferFromStack`; pinning the mechanism is what made a
// multi-conversation host look like a violation.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { ShoferProvider } from "../core/webview/ShoferProvider"
import { API } from "../extension/api"
import * as ProfileValidatorMod from "../shared/ProfileValidator"

// Mock the Task class used by ShoferProvider to avoid heavy startup.
// Task moved into @shofer/core during the carve-out; ShoferProvider now imports
// it from the barrel, so we override the barrel export (partial mock keeps the
// rest of @shofer/core real).
vi.mock("@shofer/core", async (importOriginal) => {
	class TaskStub {
		public taskId: string
		public instanceId = "inst"
		public parentTask?: any
		public apiConfiguration: any
		public rootTask?: any
		constructor(opts: any) {
			this.taskId = opts.historyItem?.id ?? `task-${Math.random().toString(36).slice(2, 8)}`
			this.parentTask = opts.parentTask
			this.apiConfiguration = opts.apiConfiguration ?? { apiProvider: "anthropic" }
			opts.onCreated?.(this)
		}
		start() {}
		on() {}
		off() {}
		emit() {}
	}
	return { ...(await importOriginal<typeof import("@shofer/core")>()), Task: TaskStub }
})

describe("Single-open-task invariant", () => {
	beforeEach(() => {
		vi.restoreAllMocks()
	})

	it("User-initiated create: closes existing before opening new", async () => {
		// Allow profile
		vi.spyOn(ProfileValidatorMod.ProfileValidator, "isProfileAllowed").mockReturnValue(true)

		const removeShoferFromStack = vi.fn().mockResolvedValue(undefined)
		const addShoferToStack = vi.fn().mockResolvedValue(undefined)

		const provider = {
			// Simulate an existing task present in stack
			shoferStack: [{ taskId: "existing-1" }],
			setValues: vi.fn(),
			getState: vi.fn().mockResolvedValue({
				apiConfiguration: { apiProvider: "anthropic", consecutiveMistakeLimit: 0 },
				organizationAllowList: "*",
				cloudUserInfo: null,
			}),
			removeShoferFromStack,
			addShoferToStack,
			setProviderProfile: vi.fn(),
			log: vi.fn(),
			debug: vi.fn(),
			getStateToPostToWebview: vi.fn(),
			providerSettingsManager: { getModeConfigId: vi.fn(), listConfig: vi.fn() },
			customModesManager: { getCustomModes: vi.fn().mockResolvedValue([]) },
			taskCreationCallback: vi.fn(),
			contextProxy: {
				extensionUri: {},
				setValue: vi.fn(),
				getValue: vi.fn(),
				setProviderSettings: vi.fn(),
				getProviderSettings: vi.fn(() => ({})),
			},
		} as unknown as ShoferProvider

		await (ShoferProvider.prototype as any).createTask.call(provider, "New task")

		expect(removeShoferFromStack).toHaveBeenCalledTimes(1)
		expect(addShoferToStack).toHaveBeenCalledTimes(1)
	})

	it("History resume path always closes current before rehydration (non-rehydrating case)", async () => {
		const removeShoferFromStack = vi.fn().mockResolvedValue(undefined)
		const addShoferToStack = vi.fn().mockResolvedValue(undefined)
		const updateGlobalState = vi.fn().mockResolvedValue(undefined)

		const provider = {
			getCurrentTask: vi.fn(() => undefined), // ensure not rehydrating
			removeShoferFromStack,
			addShoferToStack,
			updateGlobalState,
			log: vi.fn(),
			customModesManager: { getCustomModes: vi.fn().mockResolvedValue([]) },
			providerSettingsManager: {
				getModeConfigId: vi.fn().mockResolvedValue(undefined),
				listConfig: vi.fn().mockResolvedValue([]),
			},
			getState: vi.fn().mockResolvedValue({
				apiConfiguration: { apiProvider: "anthropic", consecutiveMistakeLimit: 0 },
				experiments: {},
				cloudUserInfo: null,
				taskSyncEnabled: false,
			}),
			// Methods used by createTaskWithHistoryItem for pending edit cleanup
			getPendingEditOperation: vi.fn().mockReturnValue(undefined),
			clearPendingEditOperation: vi.fn(),
			context: { extension: { packageJSON: {} }, globalStorageUri: { fsPath: "/tmp" } },
			contextProxy: {
				extensionUri: {},
				getValue: vi.fn(),
				setValue: vi.fn(),
				setProviderSettings: vi.fn(),
				getProviderSettings: vi.fn(() => ({})),
			},
			postInitState: vi.fn().mockResolvedValue(undefined),
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			async _createTaskWithHistoryItemImpl(historyItem: any, _options?: any) {
				await removeShoferFromStack()
				const stub = { taskId: historyItem.id, instanceId: "inst" }
				await addShoferToStack(stub)
				return stub
			},
		} as unknown as ShoferProvider

		const historyItem = {
			id: "hist-1",
			number: 1,
			ts: Date.now(),
			task: "Task",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			workspace: "/tmp",
		}

		const task = await (ShoferProvider.prototype as any).createTaskWithHistoryItem.call(provider, historyItem)
		expect(task).toBeTruthy()
		expect(removeShoferFromStack).toHaveBeenCalledTimes(1)
		expect(addShoferToStack).toHaveBeenCalledTimes(1)
	})

	it("API create path clears the stack by backgrounding, never by aborting", async () => {
		const removeShoferFromStack = vi.fn().mockResolvedValue(undefined)
		const backgroundCurrentTask = vi.fn().mockReturnValue(undefined)
		const createTask = vi.fn().mockResolvedValue({ taskId: "ipc-1" })
		const provider = {
			context: {} as any,
			removeShoferFromStack,
			backgroundCurrentTask,
			postInitState: vi.fn().mockResolvedValue(undefined),
			postMessageToWebview: vi.fn(),
			createTask,
			getValues: vi.fn(() => ({})),
			providerSettingsManager: { saveConfig: vi.fn() },
			on: vi.fn((ev: any, cb: any) => {
				if (ev === "taskCreated") {
					// no-op for this test
				}
				return provider
			}),
		} as unknown as ShoferProvider

		const output = { appendLine: vi.fn() } as any
		const api = new API(output, provider, undefined, false)

		const { taskId } = await api.createTask({
			configuration: {},
			prompt: "hello",
			images: undefined,
			newTab: false,
		})

		expect(taskId).toBe("ipc-1")
		// One open task: whatever was on the stack came off before the new one
		// went on.
		expect(backgroundCurrentTask).toHaveBeenCalledTimes(1)
		// And it came off ALIVE. A caller here is one of many driving this host;
		// the task it displaces is another conversation, not a finished one.
		expect(removeShoferFromStack).not.toHaveBeenCalled()
		expect(createTask).toHaveBeenCalled()
		// The instruction travels with the create, or `createTask`'s own
		// enforcement would abort whatever the pop left behind.
		expect(createTask.mock.calls[0]![3]).toMatchObject({ keepCurrentTask: true })
	})
})
