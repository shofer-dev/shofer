import { CheckTaskStatusTool } from "../CheckTaskStatusTool"

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
		task.backgroundChildren = new Map([
			["child-1", { taskId: "child-1", status: "completed", createdAt: 100 }],
		])
		provider.taskManager.getManagedTaskInstance.mockReturnValue({
			getTaskMode: vi.fn().mockResolvedValue("code"),
		})
		const cbs = buildCallbacks()
		await tool.execute({ task_id: "child-1" }, task, cbs)
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Status: completed"))
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
})
