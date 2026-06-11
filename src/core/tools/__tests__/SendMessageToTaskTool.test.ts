import { SendMessageToTaskTool } from "../SendMessageToTaskTool"

describe("SendMessageToTaskTool", () => {
	let tool: SendMessageToTaskTool

	beforeEach(() => {
		tool = new SendMessageToTaskTool()
	})

	function buildTask(overrides: Record<string, any> = {}) {
		return {
			taskId: "caller-1",
			rootTaskId: "root-1",
			isBackgroundTask: true,
			knownPeers: new Set(["peer-1"]),
			providerRef: {
				deref: () => ({
					taskManager: {
						getManagedTaskInstance: vi.fn(),
						getManagedTask: vi.fn(),
						getManagedTasks: vi.fn().mockReturnValue([]),
					},
					getTaskWithId: vi.fn(),
					createTaskWithHistoryItem: vi.fn(),
					hasPendingSyncResolver: vi.fn().mockReturnValue(false),
					registerPendingSyncResolver: vi.fn(),
					clearPendingSyncResolver: vi.fn(),
				}),
			},
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

	// ─── Scope validation ───────────────────────────────────────────

	it("rejects tasks without rootTaskId", async () => {
		const task = buildTask({ rootTaskId: undefined })
		const cbs = buildCallbacks()
		await tool.execute({ task_id: "peer-1", message: "hi" }, task, cbs)
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("rootTaskId required"))
	})

	it("rejects self-messaging", async () => {
		const task = buildTask()
		const cbs = buildCallbacks()
		await tool.execute({ task_id: "caller-1", message: "hi" }, task, cbs)
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("yourself"))
	})

	it("rejects non-background caller", async () => {
		const task = buildTask({ isBackgroundTask: false })
		const cbs = buildCallbacks()
		await tool.execute({ task_id: "peer-1", message: "hi" }, task, cbs)
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("background task"))
	})

	it("rejects target not in knownPeers", async () => {
		const task = buildTask({ knownPeers: new Set(["peer-2"]) })
		const provider = task.providerRef.deref()
		provider.taskManager.getManagedTaskInstance.mockReturnValue({
			isBackgroundTask: true,
			rootTaskId: "root-1",
		})
		const cbs = buildCallbacks()
		await tool.execute({ task_id: "peer-1", message: "hi" }, task, cbs)
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("allowed peer set"))
	})

	// ─── Deliverability checks ──────────────────────────────────────

	it("rejects errored target (live instance)", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		provider.taskManager.getManagedTaskInstance.mockReturnValue({
			isBackgroundTask: true,
			rootTaskId: "root-1",
			taskStatus: "idle",
		})
		provider.taskManager.getManagedTask.mockReturnValue({
			state: { lifecycle: "error" },
		})
		const cbs = buildCallbacks()
		await tool.execute({ task_id: "peer-1", message: "hi" }, task, cbs)
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("errored"))
	})

	it("rejects errored target (no live instance, persisted)", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		provider.taskManager.getManagedTaskInstance.mockReturnValue(null)
		provider.taskManager.getManagedTask.mockReturnValue(null)
		provider.getTaskWithId.mockResolvedValue({
			historyItem: { rootTaskId: "root-1", taskState: { lifecycle: "error" } },
		})
		const cbs = buildCallbacks()
		await tool.execute({ task_id: "peer-1", message: "hi" }, task, cbs)
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("errored"))
	})

	it("rejects unreachable target (no history)", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		provider.taskManager.getManagedTaskInstance.mockReturnValue(null)
		provider.taskManager.getManagedTask.mockReturnValue(null)
		provider.getTaskWithId.mockRejectedValue(new Error("ENOENT"))
		const cbs = buildCallbacks()
		await tool.execute({ task_id: "peer-1", message: "hi" }, task, cbs)
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("not reachable"))
	})

	// ─── Async mode, non-busy recipient (Form B) ────────────────────

	it("async: delivers via MessageQueueService for non-busy (idle) recipient and restarts", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		const addMessage = vi.fn().mockReturnValue({ id: "msg-1" })
		const cancelAndProcessQueuedMessages = vi.fn()
		provider.taskManager.getManagedTaskInstance.mockReturnValue({
			isBackgroundTask: true,
			rootTaskId: "root-1",
			taskStatus: "running", // default getter when aborted
			abort: true,
			messageQueueService: { addMessage },
			cancelAndProcessQueuedMessages,
		})
		provider.taskManager.getManagedTask.mockReturnValue({
			state: { lifecycle: "completed" },
		})
		const cbs = buildCallbacks()
		await tool.execute({ task_id: "peer-1", message: "hello", wait: false }, task, cbs)

		// Form B: message enqueued as user-turn
		expect(addMessage).toHaveBeenCalledWith(expect.stringContaining("PEER MESSAGE"), [])
		// Wake: recipient was aborted
		expect(cancelAndProcessQueuedMessages).toHaveBeenCalled()
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Message sent"))
	})

	// ─── Async mode, busy recipient (Form A) ────────────────────────

	it("async: delivers via peerNotificationQueue for busy recipient", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		provider.taskManager.getManagedTaskInstance.mockReturnValue({
			isBackgroundTask: true,
			rootTaskId: "root-1",
			taskStatus: "running",
			peerNotificationQueue: [],
		})
		provider.taskManager.getManagedTask.mockReturnValue({
			state: { lifecycle: "running" },
		})
		const cbs = buildCallbacks()
		await tool.execute({ task_id: "peer-1", message: "heads up", wait: false }, task, cbs)

		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("recipient's next turn"))
	})

	// ─── Sync mode, busy recipient ──────────────────────────────────

	it("sync: rejects busy (running) recipient", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		provider.taskManager.getManagedTaskInstance.mockReturnValue({
			isBackgroundTask: true,
			rootTaskId: "root-1",
			taskStatus: "running",
		})
		provider.taskManager.getManagedTask.mockReturnValue({
			state: { lifecycle: "running" },
		})
		const cbs = buildCallbacks()
		await tool.execute({ task_id: "peer-1", message: "urgent", wait: true }, task, cbs)

		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("cannot accept a sync request"))
	})

	// ─── Sync mode, non-busy recipient ──────────────────────────────

	it("sync: enqueues Form B and blocks on response", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		const addMessage = vi.fn().mockReturnValue({ id: "msg-1" })
		const responsePromise = Promise.resolve("sync result from peer")
		provider.taskManager.getManagedTaskInstance.mockReturnValue({
			isBackgroundTask: true,
			rootTaskId: "root-1",
			taskStatus: "running",
			abort: true,
			messageQueueService: { addMessage, removeMessage: vi.fn().mockReturnValue(true) },
			cancelAndProcessQueuedMessages: vi.fn(),
		})
		provider.taskManager.getManagedTask.mockReturnValue({
			state: { lifecycle: "idle" },
		})
		provider.registerPendingSyncResolver.mockReturnValue(responsePromise)

		const cbs = buildCallbacks()
		await tool.execute({ task_id: "peer-1", message: "urgent", wait: true, timeout_sec: 5 }, task, cbs)

		expect(addMessage).toHaveBeenCalledWith(expect.stringContaining("PEER PROMPT"), [])
		expect(cbs.pushToolResult).toHaveBeenCalledWith("sync result from peer")
	})

	it("sync: rehydrates non-live recipient and delivers", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()

		// First call returns null (no live instance).
		// After rehydration, returns the rehydrated instance.
		let callCount = 0
		const addMessage = vi.fn().mockReturnValue({ id: "msg-2" })
		provider.taskManager.getManagedTaskInstance.mockImplementation(() => {
			callCount++
			if (callCount === 1) return null
			return {
				isBackgroundTask: true,
				rootTaskId: "root-1",
				taskStatus: "running",
				abort: true,
				messageQueueService: { addMessage, removeMessage: vi.fn().mockReturnValue(true) },
				cancelAndProcessQueuedMessages: vi.fn(),
			}
		})
		provider.taskManager.getManagedTask.mockReturnValue(null)
		provider.getTaskWithId.mockResolvedValue({
			historyItem: {
				rootTaskId: "root-1",
				taskState: { lifecycle: "idle" },
			},
		})
		provider.createTaskWithHistoryItem.mockResolvedValue(undefined)
		provider.registerPendingSyncResolver.mockReturnValue(Promise.resolve("rehydrated result"))

		const cbs = buildCallbacks()
		await tool.execute({ task_id: "peer-1", message: "hello", wait: true, timeout_sec: 5 }, task, cbs)

		// Verify rehydration was called.
		expect(provider.createTaskWithHistoryItem).toHaveBeenCalled()
		expect(addMessage).toHaveBeenCalledWith(expect.stringContaining("PEER PROMPT"), [])
		expect(cbs.pushToolResult).toHaveBeenCalledWith("rehydrated result")
	})
})
