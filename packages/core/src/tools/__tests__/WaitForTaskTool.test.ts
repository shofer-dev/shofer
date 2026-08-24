import { FakeSharedTaskStore } from "../../__fixtures__/fakeSharedTaskStore.js"
import {
	TASK_STORE_ENV,
	registerTaskPersistenceBackend,
	resetTaskPersistenceBackends,
} from "../../task-persistence/backend.js"
import { WaitForTaskTool } from "../WaitForTaskTool.js"

/**
 * Tests for WaitForTaskTool covering the peer-access gate (per the
 * peer-messaging design in docs/task_messaging.md).
 *
 * The gate is relaxed: wait_for_task accepts direct children (existing
 * path) AND same-root peers present in the caller's knownPeers set.
 *
 * Peers receive synthetic TaskHandles so the event-driven wait mechanics
 * (managedTask:completed, managedTask:error, managedTask:needs-parent-input)
 * work identically for both children and peers.
 */
describe("WaitForTaskTool", () => {
	let tool: WaitForTaskTool

	beforeEach(() => {
		tool = new WaitForTaskTool()
	})

	function buildProvider(overrides: Record<string, any> = {}) {
		return {
			taskManager: {
				getManagedTaskInstance: vi.fn(),
				getTaskState: vi.fn().mockReturnValue(null),
				getManagedTask: vi.fn(),
				getManagedTasks: vi.fn().mockReturnValue([]),
				setState: vi.fn(),
				on: vi.fn(),
				off: vi.fn(),
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

	it("accepts a direct background child", async () => {
		const task = buildTask()
		task.backgroundChildren = new Map([["child-1", { taskId: "child-1", status: "completed", createdAt: 100 }]])
		const cbs = buildCallbacks()
		await tool.execute({ task_ids: ["child-1"] }, task, cbs)
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Task: child-1"))
	})

	// ─── Post-restart: persisted-child fallback ────────────────────────

	it("accepts persisted background child when in-memory handle is missing (post-restart)", async () => {
		// After a restart, backgroundChildren is empty. The tool must still
		// recognize its own persisted background child via taskHistoryStore.
		const task = buildTask({ rootTaskId: undefined, backgroundChildren: new Map() })
		const provider = task.providerRef.deref()
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
				taskState: { lifecycle: "completed" },
			},
		})
		provider.taskManager.getTaskState.mockReturnValue({ lifecycle: "completed" })

		const cbs = buildCallbacks()
		await tool.execute({ task_ids: ["child-1"] }, task, cbs)
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Task: child-1"))
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Completed: [child-1]"))
	})

	it("rejects unknown task id not in children, peers, or persisted history", async () => {
		const task = buildTask({ rootTaskId: undefined, backgroundChildren: new Map() })
		const provider = task.providerRef.deref()
		provider.taskHistoryStore.get.mockReturnValue(undefined)
		provider.getTaskWithId.mockRejectedValue(new Error("ENOENT"))
		provider.taskManager.getManagedTaskInstance.mockReturnValue(null)

		const cbs = buildCallbacks()
		await tool.execute({ task_ids: ["unknown-1"] }, task, cbs)
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("not found"))
	})

	// ─── Cancellation while blocked on a subtask ─────────────────────

	it("unwinds promptly on abort and does not resurrect the cancelled task to running", async () => {
		// Simulate the user pressing Stop: the task is aborted (abort flag + a
		// fired abortSignal) while blocked waiting on a still-running child.
		const controller = new AbortController()
		controller.abort()
		const task = buildTask({
			abortSignal: controller.signal,
			abort: true,
			abandoned: false,
			backgroundChildren: new Map([["child-1", { taskId: "child-1", status: "running", createdAt: 100 }]]),
		})
		const provider = task.providerRef.deref()
		const cbs = buildCallbacks()

		// Must resolve promptly (no hang until the 120s timeout).
		await tool.execute({ task_ids: ["child-1"] }, task, cbs)

		// It entered the waiting state...
		expect(provider.taskManager.setState).toHaveBeenCalledWith("caller-1", { lifecycle: "waiting" })
		// ...but an aborted task must NOT be flipped back to "running" — that would
		// make a cancelled task reappear as active.
		expect(provider.taskManager.setState).not.toHaveBeenCalledWith("caller-1", { lifecycle: "running" })
		// And it returns early without emitting a tool result on the dead task.
		expect(cbs.pushToolResult).not.toHaveBeenCalled()
	})

	// ─── Peer access — same rootTaskId, in knownPeers ────────────────

	it("accepts peer with same rootTaskId and knownPeers membership", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		provider.getTaskWithId.mockResolvedValue({
			historyItem: { rootTaskId: "root-1", taskState: { lifecycle: "completed" } },
		})
		provider.taskManager.getTaskState.mockReturnValue({ lifecycle: "completed" })
		const cbs = buildCallbacks()
		await tool.execute({ task_ids: ["peer-1"] }, task, cbs)
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Task: peer-1"))
	})

	it("accepts peer resolved from live instance (not history)", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		// getTaskWithId fails (no persisted history), so the gate falls back to
		// the live instance returned by getManagedTaskInstance.
		provider.getTaskWithId.mockRejectedValue(new Error("ENOENT"))
		provider.taskManager.getManagedTaskInstance.mockReturnValue({
			rootTaskId: "root-1",
			taskStatus: 6, // Running — only used for scope check in the gate
		})
		// The peer TaskHandle status defaults to "running", so the wait would
		// block. Pre-resolve the persisted status to "completed" so the initial
		// Phase 1 scan succeeds and the tool returns immediately.
		provider.taskManager.getTaskState.mockReturnValue({ lifecycle: "completed" })
		const cbs = buildCallbacks()
		await tool.execute({ task_ids: ["peer-1"] }, task, cbs)
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Status: completed"))
	})

	// ─── Peer access — denied ────────────────────────────────────────

	it("rejects peer not in knownPeers even with same rootTaskId", async () => {
		const task = buildTask({ knownPeers: new Set(["peer-2"]) })
		const provider = task.providerRef.deref()
		provider.getTaskWithId.mockResolvedValue({
			historyItem: { rootTaskId: "root-1", taskState: { lifecycle: "running" } },
		})
		const cbs = buildCallbacks()
		await tool.execute({ task_ids: ["peer-1"] }, task, cbs)
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("not found"))
	})

	it("rejects peer with undefined knownPeers (deny-all)", async () => {
		const task = buildTask({ knownPeers: undefined })
		const provider = task.providerRef.deref()
		provider.getTaskWithId.mockResolvedValue({
			historyItem: { rootTaskId: "root-1", taskState: { lifecycle: "running" } },
		})
		const cbs = buildCallbacks()
		await tool.execute({ task_ids: ["peer-1"] }, task, cbs)
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("not found"))
	})

	it("rejects peer with different rootTaskId", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		provider.getTaskWithId.mockResolvedValue({
			historyItem: { rootTaskId: "root-2", taskState: { lifecycle: "running" } },
		})
		provider.taskManager.getManagedTaskInstance.mockReturnValue({
			rootTaskId: "root-2",
		})
		const cbs = buildCallbacks()
		await tool.execute({ task_ids: ["peer-1"] }, task, cbs)
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("not found"))
	})

	it("rejects non-existent task (not child, not peer)", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		provider.getTaskWithId.mockRejectedValue(new Error("ENOENT"))
		provider.taskManager.getManagedTaskInstance.mockReturnValue(null)
		const cbs = buildCallbacks()
		await tool.execute({ task_ids: ["unknown-1"] }, task, cbs)
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("not found"))
	})

	// ─── Mixed child + peer ──────────────────────────────────────────

	it("accepts a mix of direct children and peers", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		task.backgroundChildren = new Map([["child-1", { taskId: "child-1", status: "completed", createdAt: 100 }]])
		provider.getTaskWithId.mockResolvedValue({
			historyItem: { rootTaskId: "root-1", taskState: { lifecycle: "completed" } },
		})
		provider.taskManager.getTaskState.mockReturnValue({ lifecycle: "completed" })
		const cbs = buildCallbacks()
		await tool.execute({ task_ids: ["child-1", "peer-1"] }, task, cbs)
		const result = cbs.pushToolResult.mock.calls[0][0]
		expect(result).toContain("Task: child-1")
		expect(result).toContain("Task: peer-1")
	})

	// ─── Event-driven wait — peer completion ─────────────────────────

	it("waits for peer completion via managedTask:completed event", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()

		// Peer is running — the wait will block.
		provider.getTaskWithId.mockResolvedValue({
			historyItem: { rootTaskId: "root-1", taskState: { lifecycle: "running" } },
		})
		provider.taskManager.getTaskState.mockReturnValue({ lifecycle: "running" })

		// Capture the event handler so we can fire it asynchronously.
		let capturedCompleteHandler: ((id: string) => void) | undefined
		provider.taskManager.on.mockImplementation((event: string, handler: any) => {
			if (event === "managedTask:completed") {
				capturedCompleteHandler = handler
			}
		})

		const cbs = buildCallbacks()
		const executePromise = tool.execute({ task_ids: ["peer-1"] }, task, cbs)

		// Fire the completion event after a tick to unblock the wait.
		await new Promise((r) => setTimeout(r, 10))
		expect(capturedCompleteHandler).toBeDefined()
		capturedCompleteHandler!("peer-1")

		await executePromise

		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Status: completed"))
		// Cleanup — event listeners removed.
		expect(provider.taskManager.off).toHaveBeenCalled()
	})

	// ─── Root task (no rootTaskId) cannot use peer path ──────────────

	it("root task (no rootTaskId) cannot access peer path", async () => {
		const task = buildTask({ rootTaskId: undefined })
		const provider = task.providerRef.deref()
		provider.getTaskWithId.mockRejectedValue(new Error("ENOENT"))
		provider.taskManager.getManagedTaskInstance.mockReturnValue(null)
		const cbs = buildCallbacks()
		await tool.execute({ task_ids: ["peer-1"] }, task, cbs)
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("not found"))
	})
	// ─── needs-parent-input from peer ────────────────────────────────

	it("returns immediately when peer needs parent input via managedTask:needs-parent-input", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()

		provider.getTaskWithId.mockResolvedValue({
			historyItem: { rootTaskId: "root-1", taskState: { lifecycle: "running" } },
		})
		provider.taskManager.getTaskState.mockReturnValue({ lifecycle: "running" })

		// Capture the needs-parent-input handler
		let capturedInputHandler: ((id: string) => void) | undefined
		provider.taskManager.on.mockImplementation((event: string, handler: any) => {
			if (event === "managedTask:needs-parent-input") {
				capturedInputHandler = handler
			}
		})
		// Mock the live instance for getPendingParentQuestion
		provider.taskManager.getManagedTaskInstance.mockReturnValue({
			rootTaskId: "root-1",
			getPendingParentQuestion: vi.fn().mockReturnValue({
				question: "Should I continue?",
				suggestions: [{ answer: "Yes" }],
			}),
		})

		const cbs = buildCallbacks()
		const executePromise = tool.execute({ task_ids: ["peer-1"] }, task, cbs)

		await new Promise((r) => setTimeout(r, 10))
		expect(capturedInputHandler).toBeDefined()
		capturedInputHandler!("peer-1")

		await executePromise

		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("waiting_for_parent"))
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Should I continue?"))
	})

	// ─── wait_for_task from completed peer (event-driven) ────────────

	it("waits for peer error via managedTask:error event", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()

		provider.getTaskWithId.mockResolvedValue({
			historyItem: { rootTaskId: "root-1", taskState: { lifecycle: "running" } },
		})
		provider.taskManager.getTaskState.mockReturnValue({ lifecycle: "running" })

		let capturedErrorHandler: ((id: string) => void) | undefined
		provider.taskManager.on.mockImplementation((event: string, handler: any) => {
			if (event === "managedTask:error") {
				capturedErrorHandler = handler
			}
		})

		const cbs = buildCallbacks()
		const executePromise = tool.execute({ task_ids: ["peer-1"] }, task, cbs)

		await new Promise((r) => setTimeout(r, 10))
		expect(capturedErrorHandler).toBeDefined()
		capturedErrorHandler!("peer-1")

		await executePromise

		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Status: error"))
		expect(provider.taskManager.off).toHaveBeenCalled()
	})

	// ─── Result assembly reads the SELECTED task store ───────────────
	//
	// Live regression: on the L2 worker, where tasks live in a shared Postgres
	// store, the result assembly read the local SQLite file instead and reported
	// "Status: completed" with no `Result:` line — the child's completion text
	// existed, in a store nobody asked.

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

		it("reports a completed child's result from the selected backend", async () => {
			sharedStore.setTaskMessages("child-1", [
				{ ts: 1, type: "say", say: "text", text: "working" },
				{ ts: 2, type: "say", say: "completion_result", text: "the child's answer" },
			])

			const task = buildTask()
			task.backgroundChildren = new Map([["child-1", { taskId: "child-1", status: "completed", createdAt: 100 }]])
			const cbs = buildCallbacks()
			await tool.execute({ task_ids: ["child-1"] }, task, cbs)

			expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Status: completed"))
			expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Result: the child's answer"))
		})

		it("reports a failed child's error from the selected backend", async () => {
			sharedStore.setTaskMessages("child-1", [{ ts: 1, type: "say", say: "error", text: "it blew up" }])

			const task = buildTask()
			task.backgroundChildren = new Map([["child-1", { taskId: "child-1", status: "error", createdAt: 100 }]])
			const cbs = buildCallbacks()
			await tool.execute({ task_ids: ["child-1"] }, task, cbs)

			expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Error: it blew up"))
		})
	})
})
