import { SendMessageToTaskTool } from "../SendMessageToTaskTool"

/**
 * These tests assert the delivery *contract* of send_message_to_task against the
 * canonical task-input primitives, NOT against an incidental shim. The regression
 * fixed here (commit following 897a1cf8a) was that the tool stopped waking a
 * recipient whose agent loop had already terminated. Delivery to a non-running
 * recipient MUST go through the same well-tested path the webview queueMessage
 * handler uses:
 *
 *     messageQueueService.addMessage(text, images)
 *     if (recipient.abort) recipient.cancelAndProcessQueuedMessages()  // wake/resume
 *
 * Only a `running` recipient (live loop) receives an async message passively via
 * peerNotificationQueue (Form A). The tests below verify that wiring directly.
 */
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

	/**
	 * Build a faithful target-task-instance mock with the message-queue and wake
	 * primitives the tool actually calls. `abort` reflects loop liveness: a
	 * completed/paused recipient has abort===true (loop dead → needs waking); a
	 * running/idle-at-ask recipient has abort===false.
	 */
	function buildTargetInstance(overrides: Record<string, any> = {}) {
		return {
			isBackgroundTask: true,
			rootTaskId: "root-1",
			taskStatus: "idle",
			abort: false,
			peerNotificationQueue: [] as any[],
			messageQueueService: {
				addMessage: vi.fn().mockReturnValue({ id: "queued-msg-1" }),
				removeMessage: vi.fn().mockReturnValue(true),
			},
			cancelAndProcessQueuedMessages: vi.fn().mockResolvedValue(undefined),
			...overrides,
		}
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
		const target = buildTargetInstance({ rootTaskId: task.taskId })
		provider.taskManager.getManagedTaskInstance.mockReturnValue(target)
		provider.taskManager.getManagedTask.mockReturnValue({ state: { lifecycle: "idle" } })
		provider.registerPendingSyncResolver.mockReturnValue(Promise.resolve("root result"))

		const cbs = buildCallbacks()
		await tool.execute({ task_id: "peer-1", message: "hi", wait: true, timeout_sec: 1 }, task, cbs)

		expect(target.messageQueueService.addMessage).toHaveBeenCalledWith(expect.stringContaining("PEER PROMPT"), [])
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
		provider.taskManager.getManagedTaskInstance.mockReturnValue(buildTargetInstance())
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

	// ─── Cross-root rejection ───────────────────────────────────────

	it("rejects target with different rootTaskId (live instance)", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		provider.taskManager.getManagedTaskInstance.mockReturnValue({
			isBackgroundTask: true,
			rootTaskId: "root-2",
		})
		const cbs = buildCallbacks()
		await tool.execute({ task_id: "peer-1", message: "hi" }, task, cbs)
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("does not share your root task"))
	})

	it("rejects target with different rootTaskId (no live instance, persisted)", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		provider.taskManager.getManagedTaskInstance.mockReturnValue(null)
		provider.getTaskWithId.mockResolvedValue({
			historyItem: { rootTaskId: "root-2", taskState: { lifecycle: "idle" } },
		})
		provider.taskManager.getManagedTask.mockReturnValue({ state: { lifecycle: "idle" } })
		const cbs = buildCallbacks()
		await tool.execute({ task_id: "peer-1", message: "hi" }, task, cbs)
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("does not share your root task"))
	})

	it("rejects target with empty rootTaskId in persisted history", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		provider.taskManager.getManagedTaskInstance.mockReturnValue(null)
		provider.taskManager.getManagedTask.mockReturnValue(null)
		provider.getTaskWithId.mockResolvedValue({
			historyItem: { rootTaskId: undefined, taskState: { lifecycle: "idle" } },
		})
		const cbs = buildCallbacks()
		await tool.execute({ task_id: "peer-1", message: "hi" }, task, cbs)
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("does not share your root task"))
	})

	// ─── Busy checks ────────────────────────────────────────────────

	it("sync: rejects running recipient", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		provider.taskManager.getManagedTaskInstance.mockReturnValue(buildTargetInstance({ taskStatus: "running" }))
		provider.taskManager.getManagedTask.mockReturnValue({ state: { lifecycle: "running" } })
		const cbs = buildCallbacks()
		await tool.execute({ task_id: "peer-1", message: "urgent", wait: true }, task, cbs)
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("busy"))
	})

	it("sync: rejects waiting_input recipient", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		provider.taskManager.getManagedTaskInstance.mockReturnValue(buildTargetInstance({ taskStatus: "running" }))
		provider.taskManager.getManagedTask.mockReturnValue({ state: { lifecycle: "waiting_input" } })
		const cbs = buildCallbacks()
		await tool.execute({ task_id: "peer-1", message: "urgent", wait: true }, task, cbs)
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("busy"))
	})

	it("sync: rejects waiting recipient", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		provider.taskManager.getManagedTaskInstance.mockReturnValue(buildTargetInstance({ taskStatus: "running" }))
		provider.taskManager.getManagedTask.mockReturnValue({ state: { lifecycle: "waiting" } })
		const cbs = buildCallbacks()
		await tool.execute({ task_id: "peer-1", message: "urgent", wait: true }, task, cbs)
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("busy"))
	})

	it("async: allows running recipient — delivers via peerNotificationQueue (Form A), no wake", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		const target = buildTargetInstance({ taskStatus: "running" })
		provider.taskManager.getManagedTaskInstance.mockReturnValue(target)
		provider.taskManager.getManagedTask.mockReturnValue({ state: { lifecycle: "running" } })
		const cbs = buildCallbacks()
		await tool.execute({ task_id: "peer-1", message: "heads up", wait: false }, task, cbs)

		expect(target.peerNotificationQueue.length).toBe(1)
		expect(target.peerNotificationQueue[0].message).toBe("heads up")
		// Form A only — a running loop drains it on its next turn; no queue/wake.
		expect(target.messageQueueService.addMessage).not.toHaveBeenCalled()
		expect(target.cancelAndProcessQueuedMessages).not.toHaveBeenCalled()
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Message sent"))
	})

	it("async: rejects waiting_input recipient", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		provider.taskManager.getManagedTaskInstance.mockReturnValue(buildTargetInstance({ taskStatus: "running" }))
		provider.taskManager.getManagedTask.mockReturnValue({ state: { lifecycle: "waiting_input" } })
		const cbs = buildCallbacks()
		await tool.execute({ task_id: "peer-1", message: "heads up", wait: false }, task, cbs)
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("cannot accept"))
	})

	// ─── Async mode: Form B delivery + wake ─────────────────────────

	it("async: completed recipient — Form B enqueue AND wakes the stopped loop", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		// completed ⇒ loop terminated (abort === true) ⇒ must be woken.
		const target = buildTargetInstance({ taskStatus: "idle", abort: true })
		provider.taskManager.getManagedTaskInstance.mockReturnValue(target)
		provider.taskManager.getManagedTask.mockReturnValue({ state: { lifecycle: "completed" } })
		const cbs = buildCallbacks()
		await tool.execute({ task_id: "peer-1", message: "hello", wait: false }, task, cbs)

		expect(target.messageQueueService.addMessage).toHaveBeenCalledWith(expect.stringContaining("PEER MESSAGE"), [])
		expect(target.messageQueueService.addMessage.mock.calls[0][0]).toContain("hello")
		// The regression: a completed recipient MUST be restarted to consume the queue.
		expect(target.cancelAndProcessQueuedMessages).toHaveBeenCalledTimes(1)
		// Not delivered passively via Form A.
		expect(target.peerNotificationQueue.length).toBe(0)
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Message sent"))
	})

	it("async: idle recipient (loop alive) — Form B enqueue, no wake", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		// idle-at-ask ⇒ loop alive (abort === false) ⇒ next Task.ask() drains it.
		const target = buildTargetInstance({ taskStatus: "idle", abort: false })
		provider.taskManager.getManagedTaskInstance.mockReturnValue(target)
		provider.taskManager.getManagedTask.mockReturnValue({ state: { lifecycle: "idle" } })
		const cbs = buildCallbacks()
		await tool.execute({ task_id: "peer-1", message: "hello", wait: false }, task, cbs)

		expect(target.messageQueueService.addMessage).toHaveBeenCalledTimes(1)
		expect(target.cancelAndProcessQueuedMessages).not.toHaveBeenCalled()
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Message sent"))
	})

	it("async: idle recipient with abort=true — Form B enqueue AND wakes", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		// idle-at-ask but abort=true → loop is dead → must be woken
		const target = buildTargetInstance({ taskStatus: "idle", abort: true })
		provider.taskManager.getManagedTaskInstance.mockReturnValue(target)
		provider.taskManager.getManagedTask.mockReturnValue({ state: { lifecycle: "idle" } })
		const cbs = buildCallbacks()
		await tool.execute({ task_id: "peer-1", message: "hello", wait: false }, task, cbs)

		expect(target.messageQueueService.addMessage).toHaveBeenCalledWith(expect.stringContaining("PEER MESSAGE"), [])
		expect(target.cancelAndProcessQueuedMessages).toHaveBeenCalledTimes(1)
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Message sent"))
	})

	// ─── Sync mode: Form B delivery + resolver ──────────────────────

	it("sync: idle recipient — enqueues PEER PROMPT and blocks on resolver, no wake", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		const target = buildTargetInstance({ taskStatus: "idle", abort: false })
		provider.taskManager.getManagedTaskInstance.mockReturnValue(target)
		provider.taskManager.getManagedTask.mockReturnValue({ state: { lifecycle: "idle" } })
		provider.registerPendingSyncResolver.mockReturnValue(Promise.resolve("sync result from peer"))

		const cbs = buildCallbacks()
		await tool.execute({ task_id: "peer-1", message: "urgent", wait: true, timeout_sec: 5 }, task, cbs)

		expect(target.messageQueueService.addMessage).toHaveBeenCalledWith(expect.stringContaining("PEER PROMPT"), [])
		expect(target.messageQueueService.addMessage.mock.calls[0][0]).toContain("urgent")
		expect(provider.registerPendingSyncResolver).toHaveBeenCalledWith("peer-1", "caller-1")
		expect(target.cancelAndProcessQueuedMessages).not.toHaveBeenCalled()
		expect(cbs.pushToolResult).toHaveBeenCalledWith("sync result from peer")
	})

	it("sync: completed recipient — enqueues PEER PROMPT AND wakes the stopped loop", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		const target = buildTargetInstance({ taskStatus: "idle", abort: true })
		provider.taskManager.getManagedTaskInstance.mockReturnValue(target)
		provider.taskManager.getManagedTask.mockReturnValue({ state: { lifecycle: "completed" } })
		provider.registerPendingSyncResolver.mockReturnValue(Promise.resolve("woken result"))

		const cbs = buildCallbacks()
		await tool.execute({ task_id: "peer-1", message: "answer me", wait: true, timeout_sec: 5 }, task, cbs)

		expect(target.messageQueueService.addMessage).toHaveBeenCalledWith(expect.stringContaining("PEER PROMPT"), [])
		// The regression: a completed recipient MUST be restarted so it can reach
		// attempt_completion and resolve the sender's blocking call.
		expect(target.cancelAndProcessQueuedMessages).toHaveBeenCalledTimes(1)
		expect(cbs.pushToolResult).toHaveBeenCalledWith("woken result")
	})

	it("sync: rehydrates non-live recipient and delivers via Form B", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		const target = buildTargetInstance({ taskStatus: "idle", abort: true })

		provider.taskManager.getManagedTaskInstance.mockReturnValue(null)
		provider.createTaskWithHistoryItem.mockImplementation(() => {
			provider.taskManager.getManagedTaskInstance.mockReturnValue(target)
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
		expect(target.messageQueueService.addMessage).toHaveBeenCalledWith(expect.stringContaining("PEER PROMPT"), [])
		expect(cbs.pushToolResult).toHaveBeenCalledWith("rehydrated result")
	})

	// ─── Sync: resolver conflict ────────────────────────────────────

	it("sync: rejects when recipient already has a pending sync resolver", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		provider.taskManager.getManagedTaskInstance.mockReturnValue(buildTargetInstance({ taskStatus: "idle" }))
		provider.taskManager.getManagedTask.mockReturnValue({ state: { lifecycle: "idle" } })
		provider.hasPendingSyncResolver.mockReturnValue(true)
		const cbs = buildCallbacks()
		await tool.execute({ task_id: "peer-1", message: "urgent", wait: true }, task, cbs)
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("already serving a sync request"))
	})

	// ─── Sync: abortSignal cancellation ─────────────────────────────

	it("sync: aborts when the caller's abortSignal fires", async () => {
		const task = buildTask({
			abortSignal: {
				aborted: false,
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
			},
		})
		const provider = task.providerRef.deref()
		const target = buildTargetInstance({ taskStatus: "idle", abort: false })
		provider.taskManager.getManagedTaskInstance.mockReturnValue(target)
		provider.taskManager.getManagedTask.mockReturnValue({ state: { lifecycle: "idle" } })
		// Never-resolving resolver — blocked forever until abort.
		let capturedAdd: (() => void) | undefined
		task.abortSignal.addEventListener.mockImplementation((_event: string, handler: () => void) => {
			capturedAdd = handler
		})
		provider.registerPendingSyncResolver.mockReturnValue(new Promise<string>(() => {}))

		const cbs = buildCallbacks()
		const executePromise = tool.execute(
			{ task_id: "peer-1", message: "urgent", wait: true, timeout_sec: 999 },
			task,
			cbs,
		)

		// Fire the abort signal after a tick
		await new Promise((r) => setTimeout(r, 10))
		expect(capturedAdd).toBeDefined()
		capturedAdd!()

		await executePromise

		expect(target.messageQueueService.removeMessage).toHaveBeenCalledWith("queued-msg-1")
		expect(provider.clearPendingSyncResolver).toHaveBeenCalledWith("peer-1")
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("No response"))
	})

	it("sync: on timeout, retracts the queued prompt and clears the resolver", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		const target = buildTargetInstance({ taskStatus: "idle", abort: false })
		provider.taskManager.getManagedTaskInstance.mockReturnValue(target)
		provider.taskManager.getManagedTask.mockReturnValue({ state: { lifecycle: "idle" } })
		// Resolver never resolves ⇒ the AbortSignal timeout fires.
		provider.registerPendingSyncResolver.mockReturnValue(new Promise<string>(() => {}))

		const cbs = buildCallbacks()
		await tool.execute({ task_id: "peer-1", message: "urgent", wait: true, timeout_sec: 0.01 }, task, cbs)

		expect(target.messageQueueService.removeMessage).toHaveBeenCalledWith("queued-msg-1")
		expect(provider.clearPendingSyncResolver).toHaveBeenCalledWith("peer-1")
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("No response"))
	})
})
