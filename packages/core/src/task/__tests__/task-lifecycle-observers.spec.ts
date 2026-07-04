// Prevent the transitive import graph from loading extension.ts (circular via WorkflowTask).
vi.mock("../../../extension", () => ({}))

vi.mock("../../logging/subsystems.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../logging/subsystems.js")>()),
	taskLog: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
	webviewLog: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
	configLog: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock("@shofer/telemetry", () => ({
	TelemetryService: { instance: { captureMcpAsyncCallCancelled: vi.fn() } },
}))

import { Task } from "../Task.js"
import { pluginRegistry } from "../../plugins/plugin-registry.js"

/**
 * Phase 3 (design §6.9): `afterTaskComplete` is fired from `Task.abortTask()` — the
 * single task-teardown site that runs for both a normal completion and a genuine
 * abort. Fired non-blocking; here we spy on the registry to prove the site invokes it
 * with the right terminal reason.
 */
describe("Task lifecycle observers — afterTaskComplete", () => {
	const buildAbortableShell = (opts: { completed: boolean }) => {
		const task = Object.create(Task.prototype) as Task
		Object.assign(task as any, {
			taskId: "task-1",
			instanceId: "inst-1",
			_cwd: "/workspace",
			_taskMode: "code",
			abort: false,
			abandoned: false,
			_pendingApiReqNeedsEmit: false,
			mcpAsyncCalls: new Map(),
			backgroundTerminalProcesses: new Set(),
			terminalProcess: undefined,
			didExecuteAttemptCompletion: opts.completed,
			abortReason: undefined,
			consecutiveNoToolUseCount: 0,
			consecutiveNoAssistantMessagesCount: 0,
			_taskAbortController: { signal: { aborted: true }, abort: vi.fn() },
			rejectPendingParentQuestion: vi.fn(),
			abortBackgroundChildren: vi.fn(async () => {}),
			abortBackgroundTerminalProcesses: vi.fn(),
			emitFinalTokenUsageUpdate: vi.fn(),
			emit: vi.fn(),
			dispose: vi.fn(),
			_flushSaveShoferMessages: vi.fn(async () => {}),
		})
		return task
	}

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("fires afterTaskComplete with reason 'completed' on a normal completion", async () => {
		const spy = vi.spyOn(pluginRegistry, "notifyAfterTaskComplete").mockResolvedValue()
		const task = buildAbortableShell({ completed: true })

		await task.abortTask()

		expect(spy).toHaveBeenCalledTimes(1)
		expect(spy.mock.calls[0]![0]).toMatchObject({ taskId: "task-1", reason: "completed" })
	})

	it("fires afterTaskComplete with reason 'aborted' on a user abort", async () => {
		const spy = vi.spyOn(pluginRegistry, "notifyAfterTaskComplete").mockResolvedValue()
		const task = buildAbortableShell({ completed: false })

		await task.abortTask()

		expect(spy).toHaveBeenCalledTimes(1)
		expect(spy.mock.calls[0]![0]).toMatchObject({ taskId: "task-1", reason: "aborted" })
	})
})
