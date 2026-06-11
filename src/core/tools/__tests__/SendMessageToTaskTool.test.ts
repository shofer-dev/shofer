import { SendMessageToTaskTool } from "../SendMessageToTaskTool"

describe("SendMessageToTaskTool", () => {
	let tool: SendMessageToTaskTool

	beforeEach(() => {
		tool = new SendMessageToTaskTool()
	})

	function buildTask(overrides: Record<string, any> = {}) {
		const providerObj = {
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
		}
		return {
			taskId: "caller-1",
			rootTaskId: "root-1",
			isBackgroundTask: true,
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

	// ─── Scope validation ───────────────────────────────────────────

	it("root tasks (no rootTaskId) can message peers", async () => {
		const task = buildTask({ rootTaskId: undefined })
		const provider = task.providerRef.deref()
		provider.taskManager.getManagedTaskInstance.mockReturnValue({
			isBackgroundTask: true,
			rootTaskId: task.taskId,
			taskStatus: "idle",
			submitUserMessage: vi.fn().mockResolvedValue(undefined),
		})
		provider.taskManager.getManagedTask.mockReturnValue({ state: { lifecycle: "idle" } })
		provider.registerPendingSyncResolver.mockReturnValue(Promise.resolve("root result"))

		const cbs = buildCallbacks()
		await tool.execute({ task_id: "peer-1", message: "hi", wait: true, timeout_sec: 1 }, task, cbs)
		expect(cbs.pushToolResult).toHaveBeenCalledWith("root result")
	})

	it("rejects self-messaging", async () => {
		const task = buildTask()
		const cbs = buildCallbacks()
		await tool.execute({ task_id: "caller-1", message: "hi" }, task, cbs)
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("yourself"))
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

	it("rejects non-background target (live instance)", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		provider.taskManager.getManagedTaskInstance.mockReturnValue({
			isBackgroundTask: false,
			rootTaskId: "root-1",
		})
		const cbs = buildCallbacks()
		await tool.execute({ task_id: "peer-1", message: "hi" }, task, cbs)
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("background task"))
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
		provider.taskManager.getManagedTask.mockReturnValue({ state: { lifecycle: "error" } })
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

	// ─── Busy checks ────────────────────────────────────────────────

	it("sync: rejects running recipient", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		provider.taskManager.getManagedTaskInstance.mockReturnValue({
			isBackgroundTask: true,
			rootTaskId: "root-1",
			taskStatus: "running",
		})
		provider.taskManager.getManagedTask.mockReturnValue({ state: { lifecycle: "running" } })
		const cbs = buildCallbacks()
		await tool.execute({ task_id: "peer-1", message: "urgent", wait: true }, task, cbs)
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("busy"))
	})

	it("sync: rejects waiting_input recipient", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		provider.taskManager.getManagedTaskInstance.mockReturnValue({
			isBackgroundTask: true,
			rootTaskId: "root-1",
			taskStatus: "running",
		})
		provider.taskManager.getManagedTask.mockReturnValue({ state: { lifecycle: "waiting_input" } })
		const cbs = buildCallbacks()
		await tool.execute({ task_id: "peer-1", message: "urgent", wait: true }, task, cbs)
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("busy"))
	})

	it("async: allows running recipient (system prompt injection)", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		const peerNotificationQueue: any[] = []
		provider.taskManager.getManagedTaskInstance.mockReturnValue({
			isBackgroundTask: true,
			rootTaskId: "root-1",
			taskStatus: "running",
			peerNotificationQueue,
		})
		provider.taskManager.getManagedTask.mockReturnValue({ state: { lifecycle: "running" } })
		const cbs = buildCallbacks()
		await tool.execute({ task_id: "peer-1", message: "heads up", wait: false }, task, cbs)

		expect(peerNotificationQueue.length).toBe(1)
		expect(peerNotificationQueue[0].message).toBe("heads up")
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Message sent"))
	})

	it("async: rejects waiting_input recipient", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		provider.taskManager.getManagedTaskInstance.mockReturnValue({
			isBackgroundTask: true,
			rootTaskId: "root-1",
			taskStatus: "running",
		})
		provider.taskManager.getManagedTask.mockReturnValue({ state: { lifecycle: "waiting_input" } })
		const cbs = buildCallbacks()
		await tool.execute({ task_id: "peer-1", message: "heads up", wait: false }, task, cbs)
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("cannot accept"))
	})

	// ─── Async mode: peerNotificationQueue ──────────────────────────

	it("async: delivers via peerNotificationQueue for non-busy recipient", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		const peerNotificationQueue: any[] = []
		provider.taskManager.getManagedTaskInstance.mockReturnValue({
			isBackgroundTask: true,
			rootTaskId: "root-1",
			taskStatus: "idle",
			peerNotificationQueue,
		})
		provider.taskManager.getManagedTask.mockReturnValue({ state: { lifecycle: "completed" } })
		const cbs = buildCallbacks()
		await tool.execute({ task_id: "peer-1", message: "hello", wait: false }, task, cbs)

		expect(peerNotificationQueue.length).toBe(1)
		expect(peerNotificationQueue[0].senderTaskId).toBe("caller-1")
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Message sent"))
	})

	// ─── Sync mode: submitUserMessage + resolver ────────────────────

	it("sync: submits via submitUserMessage and blocks on response", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		const submitUserMessage = vi.fn().mockResolvedValue(undefined)
		provider.taskManager.getManagedTaskInstance.mockReturnValue({
			isBackgroundTask: true,
			rootTaskId: "root-1",
			taskStatus: "idle",
			submitUserMessage,
		})
		provider.taskManager.getManagedTask.mockReturnValue({ state: { lifecycle: "idle" } })
		provider.registerPendingSyncResolver.mockReturnValue(Promise.resolve("sync result from peer"))

		const cbs = buildCallbacks()
		await tool.execute({ task_id: "peer-1", message: "urgent", wait: true, timeout_sec: 5 }, task, cbs)

		expect(submitUserMessage).toHaveBeenCalledWith(expect.stringContaining("PEER PROMPT"), [])
		expect(submitUserMessage.mock.calls[0][0]).toContain("urgent")
		expect(cbs.pushToolResult).toHaveBeenCalledWith("sync result from peer")
	})

	it("sync: rehydrates non-live recipient and delivers", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()

		const submitUserMessage = vi.fn().mockResolvedValue(undefined)
		provider.taskManager.getManagedTaskInstance.mockReturnValue(null)
		provider.createTaskWithHistoryItem.mockImplementation(() => {
			provider.taskManager.getManagedTaskInstance.mockReturnValue({
				isBackgroundTask: true,
				rootTaskId: "root-1",
				taskStatus: "idle",
				submitUserMessage,
			})
			return Promise.resolve(undefined)
		})
		provider.taskManager.getManagedTask.mockReturnValue({ state: { lifecycle: "idle" } })
		provider.getTaskWithId.mockResolvedValue({
			historyItem: { rootTaskId: "root-1", taskState: { lifecycle: "idle" } },
		})
		provider.registerPendingSyncResolver.mockReturnValue(Promise.resolve("rehydrated result"))

		const cbs = buildCallbacks()
		await tool.execute({ task_id: "peer-1", message: "hello", wait: true, timeout_sec: 5 }, task, cbs)
		expect(provider.createTaskWithHistoryItem).toHaveBeenCalled()
		expect(submitUserMessage).toHaveBeenCalled()
		expect(cbs.pushToolResult).toHaveBeenCalledWith("rehydrated result")
	})
})
