import { FakeSharedTaskStore } from "../../__fixtures__/fakeSharedTaskStore.js"
import {
	TASK_STORE_ENV,
	registerTaskPersistenceBackend,
	resetTaskPersistenceBackends,
} from "../../task-persistence/backend.js"
import { CheckTaskStatusTool } from "../CheckTaskStatusTool.js"

/**
 * Tests for CheckTaskStatusTool covering both direct-child and peer access
 * flows (per the peer-messaging design in docs/task_messaging.md).
 *
 * Peer access requires: same rootTaskId + presence in knownPeers.
 * Direct-child access is the existing fast path.
 */
describe("CheckTaskStatusTool", () => {
	let tool: CheckTaskStatusTool

	beforeEach(() => {
		tool = new CheckTaskStatusTool()
	})

	function buildProvider(overrides: Record<string, any> = {}) {
		return {
			taskManager: {
				getManagedTaskInstance: vi.fn(),
				getTaskState: vi.fn().mockReturnValue(null),
				getManagedTask: vi.fn(),
				getManagedTasks: vi.fn().mockReturnValue([]),
			},
			taskHistoryStore: {
				get: vi.fn().mockReturnValue(undefined),
				getAll: vi.fn().mockReturnValue([]),
			},
			getTaskWithId: vi.fn(),
			getState: vi.fn().mockResolvedValue({ customModes: [] }),
			contextProxy: { globalStorageUri: { fsPath: "/tmp/test-storage" } },
			...overrides,
		}
	}

	function buildTask(overrides: Record<string, any> = {}) {
		const providerObj = buildProvider()
		return {
			taskId: "caller-1",
			rootTaskId: "root-1",
			backgroundChildren: new Map(),
			knownPeers: new Set(["peer-1"]),
			providerRef: { deref: () => providerObj },
			...overrides,
		} as any
	}

	function buildCallbacks(overrides: Partial<Record<"askApproval" | "pushToolResult" | "handleError", any>> = {}) {
		return {
			askApproval: vi.fn().mockResolvedValue(true),
			pushToolResult: vi.fn(),
			handleError: vi.fn(),
			...overrides,
		} as any
	}

	// ─── Direct child access ─────────────────────────────────────────

	it("returns status for a direct background child (completed)", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		task.backgroundChildren = new Map([["child-1", { taskId: "child-1", status: "completed", createdAt: 100 }]])
		provider.taskManager.getManagedTaskInstance.mockReturnValue({
			getTaskMode: vi.fn().mockResolvedValue("code"),
		})
		const cbs = buildCallbacks()
		await tool.execute({ task_id: "child-1" }, task, cbs)
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Status: completed"))
	})

	// ─── Post-restart: persisted-child fallback ────────────────────────
	//
	// After a process restart, backgroundChildren is empty (it is never
	// serialized). The tool must still recognize its own persisted background
	// children via taskHistoryStore so the parent can check their status.

	it("recognizes persisted background child when in-memory handle is missing (post-restart)", async () => {
		const task = buildTask({ rootTaskId: undefined, backgroundChildren: new Map() })
		const provider = task.providerRef.deref()
		// Simulate a persisted child that survived the restart.
		provider.taskHistoryStore.get.mockReturnValue({
			id: "child-1",
			isBackground: true,
			parentTaskId: "caller-1",
			taskState: { lifecycle: "completed" },
			createdAt: 100,
		})
		provider.getTaskWithId.mockResolvedValue({
			historyItem: {
				id: "child-1",
				isBackground: true,
				parentTaskId: "caller-1",
				taskState: { lifecycle: "completed" },
				mode: "code",
			},
		})
		provider.taskManager.getTaskState.mockReturnValue({ lifecycle: "completed" })
		provider.taskManager.getManagedTaskInstance.mockReturnValue(null)

		const cbs = buildCallbacks()
		await tool.execute({ task_id: "child-1" }, task, cbs)
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Status: completed"))
		expect(cbs.pushToolResult).not.toHaveBeenCalledWith(expect.stringContaining("not found"))
	})

	it("persisted child with idle lifecycle resolves to 'running' (not error) post-restart", async () => {
		const task = buildTask({ rootTaskId: undefined, backgroundChildren: new Map() })
		const provider = task.providerRef.deref()
		provider.taskHistoryStore.get.mockReturnValue({
			id: "child-2",
			isBackground: true,
			parentTaskId: "caller-1",
			taskState: { lifecycle: "idle" },
			createdAt: 200,
		})
		provider.getTaskWithId.mockResolvedValue({
			historyItem: {
				id: "child-2",
				isBackground: true,
				parentTaskId: "caller-1",
				taskState: { lifecycle: "idle" },
				mode: "code",
			},
		})
		provider.taskManager.getTaskState.mockReturnValue(null)
		provider.taskManager.getManagedTaskInstance.mockReturnValue(null)

		const cbs = buildCallbacks()
		await tool.execute({ task_id: "child-2" }, task, cbs)
		// idle-on-disk child should be "running" (resumable), NOT "error"
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Status: running"))
	})

	it("rejects persisted task that is not a background child of this task", async () => {
		const task = buildTask({ rootTaskId: undefined, backgroundChildren: new Map() })
		const provider = task.providerRef.deref()
		// Persisted, but belongs to a different parent.
		provider.taskHistoryStore.get.mockReturnValue({
			id: "other-child",
			isBackground: true,
			parentTaskId: "different-parent",
			taskState: { lifecycle: "running" },
		})
		provider.getTaskWithId.mockRejectedValue(new Error("ENOENT"))
		provider.taskManager.getManagedTaskInstance.mockReturnValue(null)

		const cbs = buildCallbacks()
		await tool.execute({ task_id: "other-child" }, task, cbs)
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("not found"))
	})

	// ─── Peer access — not found ─────────────────────────────────────

	it("rejects task not in background children or peers", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		provider.getTaskWithId.mockRejectedValue(new Error("ENOENT"))
		provider.taskManager.getManagedTaskInstance.mockReturnValue(null)
		const cbs = buildCallbacks()
		await tool.execute({ task_id: "unknown-1" }, task, cbs)
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("not found"))
	})

	// ─── Peer access — same rootTaskId, in knownPeers ────────────────

	it("allows peer with same rootTaskId and knownPeers membership", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		provider.getTaskWithId.mockResolvedValue({
			historyItem: { rootTaskId: "root-1", taskState: { lifecycle: "completed" } },
		})
		provider.taskManager.getTaskState.mockReturnValue({ lifecycle: "completed" })
		const cbs = buildCallbacks()
		await tool.execute({ task_id: "peer-1" }, task, cbs)
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Status: completed"))
	})

	it("allows peer resolved from live instance (not history)", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		provider.getTaskWithId.mockRejectedValue(new Error("ENOENT"))
		provider.taskManager.getManagedTaskInstance.mockReturnValue({
			rootTaskId: "root-1",
			taskStatus: 6, // Running
			getTaskMode: vi.fn().mockResolvedValue("code"),
		})
		provider.taskManager.getTaskState.mockReturnValue({ lifecycle: "running" })
		const cbs = buildCallbacks()
		await tool.execute({ task_id: "peer-1" }, task, cbs)
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Status: running"))
	})

	// ─── Peer access — denied ────────────────────────────────────────

	it("rejects peer not in knownPeers even with same rootTaskId", async () => {
		const task = buildTask({ knownPeers: new Set(["peer-2"]) })
		const provider = task.providerRef.deref()
		provider.getTaskWithId.mockResolvedValue({
			historyItem: { rootTaskId: "root-1", taskState: { lifecycle: "completed" } },
		})
		const cbs = buildCallbacks()
		await tool.execute({ task_id: "peer-1" }, task, cbs)
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("not found"))
	})

	it("rejects peer with undefined knownPeers (deny-all)", async () => {
		const task = buildTask({ knownPeers: undefined })
		const provider = task.providerRef.deref()
		provider.getTaskWithId.mockResolvedValue({
			historyItem: { rootTaskId: "root-1", taskState: { lifecycle: "completed" } },
		})
		const cbs = buildCallbacks()
		await tool.execute({ task_id: "peer-1" }, task, cbs)
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("not found"))
	})

	it("rejects peer with different rootTaskId", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		provider.getTaskWithId.mockResolvedValue({
			historyItem: { rootTaskId: "root-2", taskState: { lifecycle: "completed" } },
		})
		provider.taskManager.getManagedTaskInstance.mockReturnValue({
			rootTaskId: "root-2",
		})
		const cbs = buildCallbacks()
		await tool.execute({ task_id: "peer-1" }, task, cbs)
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("not found"))
	})

	// ─── Peer status resolution ──────────────────────────────────────

	it("resolves peer error status from persisted history", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		provider.getTaskWithId.mockResolvedValue({
			historyItem: { rootTaskId: "root-1", taskState: { lifecycle: "error" } },
		})
		provider.taskManager.getTaskState.mockReturnValue(null)
		const cbs = buildCallbacks()
		await tool.execute({ task_id: "peer-1" }, task, cbs)
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Status: error"))
	})

	it("peer status falls back to 'running' when history has no lifecycle", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		provider.getTaskWithId.mockResolvedValue({
			historyItem: { rootTaskId: "root-1", taskState: {} },
		})
		provider.taskManager.getTaskState.mockReturnValue(null)
		const cbs = buildCallbacks()
		await tool.execute({ task_id: "peer-1" }, task, cbs)
		// Empty taskState → lifecycle is undefined → not error/not completed → defaults to "running"
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Status: running"))
	})

	// ─── Root task (no rootTaskId) cannot use peer path ────────────────

	it("root task (no rootTaskId) cannot access peer path — only direct children", async () => {
		const task = buildTask({ rootTaskId: undefined })
		const provider = task.providerRef.deref()
		provider.getTaskWithId.mockRejectedValue(new Error("ENOENT"))
		provider.taskManager.getManagedTaskInstance.mockReturnValue(null)
		const cbs = buildCallbacks()
		await tool.execute({ task_id: "peer-1" }, task, cbs)
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("not found"))
	})

	// ─── Peer access — pending parent question ────────────────────────

	it("peer surfaces pending parent question from live instance", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		provider.getTaskWithId.mockResolvedValue({
			historyItem: { rootTaskId: "root-1", taskState: { lifecycle: "running" }, mode: "debug" },
		})
		provider.taskManager.getTaskState.mockReturnValue({ lifecycle: "running" })
		provider.taskManager.getManagedTaskInstance.mockReturnValue({
			getTaskMode: vi.fn().mockResolvedValue("debug"),
			getPendingParentQuestion: vi.fn().mockReturnValue({
				question: "Should I refactor this module?",
				suggestions: [{ answer: "Yes, refactor" }, { answer: "No, leave it" }],
			}),
		})

		const cbs = buildCallbacks()
		await tool.execute({ task_id: "peer-1" }, task, cbs)
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Pending parent question"))
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Should I refactor this module?"))
	})

	// ─── Peer access — pending parent question with no suggestions ────

	it("peer surfaces pending parent question with 'none' for empty suggestions", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		provider.getTaskWithId.mockResolvedValue({
			historyItem: { rootTaskId: "root-1", taskState: { lifecycle: "running" }, mode: "code" },
		})
		provider.taskManager.getTaskState.mockReturnValue({ lifecycle: "running" })
		provider.taskManager.getManagedTaskInstance.mockReturnValue({
			getTaskMode: vi.fn().mockResolvedValue("code"),
			getPendingParentQuestion: vi.fn().mockReturnValue({
				question: "Proceed?",
				suggestions: [],
			}),
		})

		const cbs = buildCallbacks()
		await tool.execute({ task_id: "peer-1" }, task, cbs)
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Suggestions: none"))
	})

	// ─── Peer access — mode resolution ────────────────────────────────

	it("peer resolves mode from live instance", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		provider.getTaskWithId.mockResolvedValue({
			historyItem: { rootTaskId: "root-1", taskState: { lifecycle: "running" }, mode: "architect" },
		})
		provider.taskManager.getTaskState.mockReturnValue({ lifecycle: "running" })
		provider.taskManager.getManagedTaskInstance.mockReturnValue({
			getTaskMode: vi.fn().mockResolvedValue("architect"),
		})
		provider.getState.mockResolvedValue({
			customModes: [{ slug: "architect", name: "Architect" }],
		})
		const cbs = buildCallbacks()
		await tool.execute({ task_id: "peer-1" }, task, cbs)
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Mode: Architect"))
	})

	// ─── Peer access — mode falls back to persisted history ───────────

	it("peer resolves mode from persisted history when no live instance", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		provider.getTaskWithId.mockResolvedValue({
			historyItem: {
				rootTaskId: "root-1",
				taskState: { lifecycle: "completed" },
				mode: "architect",
			},
		})
		provider.taskManager.getTaskState.mockReturnValue({ lifecycle: "completed" })
		// No live instance
		provider.taskManager.getManagedTaskInstance.mockReturnValue(null)
		provider.getState.mockResolvedValue({
			customModes: [{ slug: "architect", name: "Architect" }],
		})
		const cbs = buildCallbacks()
		await tool.execute({ task_id: "peer-1" }, task, cbs)
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Mode: Architect"))
	})

	// ─── Result + activity read the SELECTED task store ───────────────
	//
	// Same live regression as WaitForTaskTool: reading the local SQLite file on
	// a host whose tasks live in a shared store reported the child's STATUS with
	// no `Result:` line and an empty activity feed, silently.

	describe("with a shared task store selected", () => {
		const sharedStore = new FakeSharedTaskStore()

		beforeEach(() => {
			sharedStore.clear()
			registerTaskPersistenceBackend("fake-shared", () => sharedStore)
			process.env[TASK_STORE_ENV] = "fake-shared"
		})

		afterEach(async () => {
			delete process.env[TASK_STORE_ENV]
			await resetTaskPersistenceBackends()
		})

		it("reports a completed child's result and activity from the selected backend", async () => {
			sharedStore.setTaskMessages("child-1", [
				{ ts: 1, type: "say", say: "text", text: "thinking about it" },
				{ ts: 2, type: "say", say: "completion_result", text: "the child's answer" },
			])

			const task = buildTask()
			task.backgroundChildren = new Map([["child-1", { taskId: "child-1", status: "completed", createdAt: 100 }]])
			const cbs = buildCallbacks()
			await tool.execute({ task_id: "child-1", include_activity: true }, task, cbs)

			const result = cbs.pushToolResult.mock.calls[0]![0] as string
			expect(result).toContain("Status: completed")
			expect(result).toContain("Result: the child's answer")
			expect(result).toContain("thinking about it")
		})
	})
})
