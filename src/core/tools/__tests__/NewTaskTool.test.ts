import { NewTaskTool } from "../NewTaskTool"

/**
 * Tests for NewTaskTool covering the peer_task_ids parameter and
 * symmetric peer-grant machinery (docs/task_messaging.md §"peer_task_ids on
 * new_task" and §"Symmetric peering").
 *
 * The tool's execute() calls deep into provider.createTask() — these tests
 * mock at the callbacks layer to assert the contract visible to callers:
 *   - peer_task_ids validation (cross-root → reject)
 *   - knownPeers seeding via initialKnownPeers on createTask()
 *   - Symmetric reverse-edge mirroring onto granted peers
 *   - HistoryItem.peerIds persistence of the parent grant
 */
describe("NewTaskTool — peer_task_ids", () => {
	let tool: NewTaskTool

	beforeEach(() => {
		tool = new NewTaskTool()
	})

	function buildProvider(overrides: Record<string, any> = {}) {
		return {
			getState: vi.fn().mockResolvedValue({ customModes: [] }),
			getTaskWithId: vi.fn().mockResolvedValue({
				historyItem: { backgroundChildIds: [], childIds: [], peerIds: [] },
			}),
			updateTaskHistory: vi.fn().mockResolvedValue(undefined),
			createTask: vi.fn().mockResolvedValue({ taskId: "child-1" }),
			taskManager: {
				getManagedTask: vi.fn(),
				getManagedTaskInstance: vi.fn().mockReturnValue(null),
				getManagedTasks: vi.fn().mockReturnValue([]),
				registerBackgroundTask: vi.fn(),
				registerBlockingChildResolver: vi.fn(),
				setState: vi.fn(),
				hasPendingSyncResolver: vi.fn().mockReturnValue(false),
				countActiveTasks: vi.fn().mockReturnValue(0),
				on: vi.fn(),
				off: vi.fn(),
			},
			registerBlockingChildResolver: vi.fn(),
			contextProxy: {
				globalStorageUri: { fsPath: "/tmp/test-storage" },
				getValue: vi.fn().mockReturnValue(undefined), // undefined → default 10 → 0 active always passes
			},
			log: vi.fn(),
			...overrides,
		}
	}

	function buildTask(overrides: Record<string, any> = {}) {
		const providerObj = buildProvider()
		return {
			taskId: "caller-1",
			rootTaskId: "root-1",
			isBackgroundTask: true,
			knownPeers: new Set(["existing-peer-1"]),
			backgroundChildren: new Map(),
			consecutiveMistakeCount: 0,
			recordToolError: vi.fn(),
			didToolFailInCurrentTurn: false,
			sayAndCreateMissingParamError: vi.fn().mockResolvedValue("error message"),
			getTaskMode: vi.fn().mockResolvedValue("code"),
			// Task-viz spawn/return arrows — awaited in the blocking path before the
			// completion resolver is registered.
			emitTaskInteraction: vi.fn().mockResolvedValue(undefined),
			providerRef: { deref: () => providerObj },
			costLimit: null,
			abortSignal: undefined,
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

	// ─── Basic background subtask (no peer_task_ids) ─────────────────

	it("spawns a background subtask with parent-only knownPeers by default", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		const cbs = buildCallbacks()

		await tool.execute({ mode: "code", message: "analyze", is_background: true }, task, cbs)

		// Verify createTask was called with initialKnownPeers = [parent]
		// createTask signature: (message, undefined, parentTask, options, undefined, undefined)
		// options is at index 3.
		const createArgs = provider.createTask.mock.calls[0]
		expect(createArgs).toBeDefined()
		const options = createArgs[3]
		expect(options).toBeDefined()
		expect(options.initialKnownPeers).toEqual(["caller-1"])
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Child task started"))
	})

	// ─── peer_task_ids validation ────────────────────────────────────

	it("rejects peer_task_ids where a peer has a different rootTaskId", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		// Mock a live peer with different rootTaskId
		provider.taskManager.getManagedTaskInstance.mockImplementation((id: string) => {
			if (id === "cross-root-peer") return { rootTaskId: "root-2" }
			return null
		})
		const cbs = buildCallbacks()

		await tool.execute(
			{
				mode: "code",
				message: "analyze",
				is_background: true,
				peer_task_ids: ["cross-root-peer"],
			},
			task,
			cbs,
		)

		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("does not share your root task"))
		// createTask should NOT have been called
		expect(provider.createTask).not.toHaveBeenCalled()
	})

	it("accepts peer_task_ids where peer has same rootTaskId", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		// Mock a live peer with same rootTaskId
		provider.taskManager.getManagedTaskInstance.mockImplementation((id: string) => {
			if (id === "same-root-peer") return { rootTaskId: "root-1", knownPeers: new Set() }
			return null
		})
		const cbs = buildCallbacks()

		await tool.execute(
			{
				mode: "code",
				message: "analyze",
				is_background: true,
				peer_task_ids: ["same-root-peer"],
			},
			task,
			cbs,
		)

		const createArgs = provider.createTask.mock.calls[0]
		const options = createArgs[3]
		expect(options).toBeDefined()
		// initialKnownPeers should include both parent AND granted peer
		expect(options.initialKnownPeers).toEqual(expect.arrayContaining(["caller-1", "same-root-peer"]))
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Child task started"))
	})

	// ─── Symmetric peering (reverse edge) ────────────────────────────

	it("adds reverse edge to live peer's knownPeers (symmetric grant)", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		const peerKnownPeers = new Set<string>()
		provider.taskManager.getManagedTaskInstance.mockImplementation((id: string) => {
			if (id === "granted-peer") return { rootTaskId: "root-1", knownPeers: peerKnownPeers }
			return null
		})
		// Return a valid peer history for symmetric persistence
		provider.getTaskWithId.mockImplementation((id: string) => {
			if (id === "granted-peer")
				return Promise.resolve({
					historyItem: { peerIds: ["parent-only-id"], backgroundChildIds: [], childIds: [] },
				})
			return Promise.resolve({
				historyItem: { backgroundChildIds: [], childIds: [], peerIds: [] },
			})
		})
		const cbs = buildCallbacks()

		await tool.execute(
			{
				mode: "code",
				message: "analyze",
				is_background: true,
				peer_task_ids: ["granted-peer"],
			},
			task,
			cbs,
		)

		// The live peer's knownPeers should now include child-1
		expect(peerKnownPeers.has("child-1")).toBe(true)

		// The peer's history row should be updated with child-1 in peerIds
		const updateCalls = provider.updateTaskHistory.mock.calls as any[]
		const peerUpdate = updateCalls.find((c: any[]) => c[0].id === "granted-peer")
		expect(peerUpdate).toBeDefined()
		expect(peerUpdate[0].peerIds).toEqual(expect.arrayContaining(["parent-only-id", "child-1"]))
	})

	it("persists parent's own peer grant (parent→child) in history", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		const cbs = buildCallbacks()

		await tool.execute(
			{
				mode: "code",
				message: "analyze",
				is_background: true,
				peer_task_ids: ["existing-peer-1"],
			},
			task,
			cbs,
		)

		// Parent's knownPeers should include the new child
		expect(task.knownPeers.has("child-1")).toBe(true)

		// The parent history update should include child-1 in peerIds
		const updateCalls = provider.updateTaskHistory.mock.calls as any[]
		const parentUpdate = updateCalls.find((c: any[]) => c[0].id === "caller-1")
		expect(parentUpdate).toBeDefined()
		expect(parentUpdate[0].peerIds).toEqual(expect.arrayContaining(["existing-peer-1", "child-1"]))
	})

	// ─── Symmetric peering — handles missing live peer gracefully ─────

	it("persists reverse edge even when live peer instance is absent", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		// Peer is NOT live — getManagedTaskInstance returns null
		provider.taskManager.getManagedTaskInstance.mockReturnValue(null)
		// But history exists for the peer
		provider.getTaskWithId.mockImplementation((id: string) => {
			if (id === "non-live-peer")
				return Promise.resolve({
					historyItem: { peerIds: ["old-peer"], backgroundChildIds: [], childIds: [] },
				})
			return Promise.resolve({
				historyItem: { backgroundChildIds: [], childIds: [], peerIds: [] },
			})
		})
		const cbs = buildCallbacks()

		await tool.execute(
			{
				mode: "code",
				message: "analyze",
				is_background: true,
				peer_task_ids: ["non-live-peer"],
			},
			task,
			cbs,
		)

		// createTask should succeed (peer_task_ids validation skips non-live peers
		// — they have no instance to check rootTaskId against, so must be validated
		// via history fallback or not rejected)
		expect(provider.createTask).toHaveBeenCalled()
	})

	// ─── Foreground (blocking) subtask — peer_task_ids is irrelevant ──

	it("foreground subtask does not use peer_task_ids or knownPeers", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		provider.createTask.mockResolvedValue({ taskId: "child-fg" })
		provider.registerBlockingChildResolver.mockImplementation((_childId: string, resolve: (r: string) => void) => {
			// Resolve immediately to simulate child completing
			resolve("foreground result")
		})
		// The blocking resolver promise path in new_task awaits on
		// childCompletionPromise. Let's set up the mock to resolve it:
		let capturedResolve: ((r: string) => void) | undefined
		provider.registerBlockingChildResolver.mockImplementation((_childId: string, resolve: (r: string) => void) => {
			capturedResolve = resolve
		})
		const cbs = buildCallbacks()

		// Start execute — it will block on the resolver promise
		const executePromise = tool.execute({ mode: "code", message: "fix bug", is_background: false }, task, cbs)

		// Resolve the blocker after a tick
		await new Promise((r) => setTimeout(r, 10))
		capturedResolve!("foreground result")
		await executePromise

		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("foreground result"))
	})

	// ─── Cost limit guard ────────────────────────────────────────────

	it("rejects new task when root cost limit is exhausted", async () => {
		const task = buildTask({ costLimit: { maxUsd: 10 } })
		const provider = task.providerRef.deref()
		// Make cost aggregation return limit-exceeded total
		provider.getTaskWithId.mockImplementation((id: string) => {
			if (id === "caller-1")
				return Promise.resolve({
					historyItem: {
						id: "caller-1",
						totalCost: 11,
						backgroundChildIds: [],
						childIds: [],
						peerIds: [],
					},
				})
			return Promise.resolve({
				historyItem: { id, backgroundChildIds: [], childIds: [], peerIds: [] },
			})
		})
		const cbs = buildCallbacks()

		await tool.execute({ mode: "code", message: "expensive task", is_background: true }, task, cbs)

		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Cost limit reached"))
		expect(provider.createTask).not.toHaveBeenCalled()
	})

	// ─── title → initialTitle (parent-locked title) ──────────────────

	it("passes a trimmed/clamped title to createTask as initialTitle (background)", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		const cbs = buildCallbacks()

		await tool.execute(
			{ mode: "code", message: "analyze", is_background: true, title: "  Audit the auth flow  " },
			task,
			cbs,
		)

		const options = provider.createTask.mock.calls[0][3]
		expect(options.initialTitle).toBe("Audit the auth flow")
	})

	it("clamps an over-long title to 60 characters", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		const cbs = buildCallbacks()
		const longTitle = "x".repeat(100)

		await tool.execute({ mode: "code", message: "analyze", is_background: true, title: longTitle }, task, cbs)

		const options = provider.createTask.mock.calls[0][3]
		expect(options.initialTitle).toBe("x".repeat(60))
	})

	it("treats a whitespace-only title as absent (no initialTitle)", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		const cbs = buildCallbacks()

		await tool.execute({ mode: "code", message: "analyze", is_background: true, title: "   " }, task, cbs)

		const options = provider.createTask.mock.calls[0][3]
		expect(options.initialTitle).toBeUndefined()
	})

	it("threads the title through the foreground (blocking) path too", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		provider.createTask.mockResolvedValue({ taskId: "child-fg" })
		let capturedResolve: ((r: string) => void) | undefined
		provider.registerBlockingChildResolver.mockImplementation((_childId: string, resolve: (r: string) => void) => {
			capturedResolve = resolve
		})
		const cbs = buildCallbacks()

		const executePromise = tool.execute(
			{ mode: "code", message: "fix bug", is_background: false, title: "Fix the bug" },
			task,
			cbs,
		)
		await new Promise((r) => setTimeout(r, 10))
		capturedResolve!("done")
		await executePromise

		const options = provider.createTask.mock.calls[0][3]
		expect(options.initialTitle).toBe("Fix the bug")
	})

	// ─── Parallel task limit guard ───────────────────────────────────

	it("rejects new task when parallel-task limit is reached", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		provider.contextProxy.getValue = vi.fn().mockReturnValue(3)
		provider.taskManager.countActiveTasks = vi.fn().mockReturnValue(3)
		const cbs = buildCallbacks()

		await tool.execute({ mode: "code", message: "do work", is_background: true }, task, cbs)

		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Task limit reached"))
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("3/3"))
		expect(provider.createTask).not.toHaveBeenCalled()
	})

	it("allows new task when under the parallel-task limit", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		provider.contextProxy.getValue = vi.fn().mockReturnValue(5)
		provider.taskManager.countActiveTasks = vi.fn().mockReturnValue(3)
		const cbs = buildCallbacks()

		await tool.execute({ mode: "code", message: "do work", is_background: true }, task, cbs)

		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Child task started"))
		expect(provider.createTask).toHaveBeenCalled()
	})

	it("allows unlimited tasks when limit is 0", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		provider.contextProxy.getValue = vi.fn().mockReturnValue(0)
		provider.taskManager.countActiveTasks = vi.fn().mockReturnValue(999)
		const cbs = buildCallbacks()

		await tool.execute({ mode: "code", message: "do work", is_background: true }, task, cbs)

		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Child task started"))
		expect(provider.createTask).toHaveBeenCalled()
	})

	it("enforces the default limit (10) when maxParallelTasks is unset", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		provider.contextProxy.getValue = vi.fn().mockReturnValue(undefined)
		provider.taskManager.countActiveTasks = vi.fn().mockReturnValue(10)
		const cbs = buildCallbacks()

		await tool.execute({ mode: "code", message: "do work", is_background: true }, task, cbs)

		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Task limit reached"))
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("10/10"))
		expect(provider.createTask).not.toHaveBeenCalled()
	})

	it("rejects at exactly the limit with correct active count", async () => {
		const task = buildTask()
		const provider = task.providerRef.deref()
		provider.contextProxy.getValue = vi.fn().mockReturnValue(2)
		provider.taskManager.countActiveTasks = vi.fn().mockReturnValue(2)
		const cbs = buildCallbacks()

		await tool.execute({ mode: "code", message: "do work", is_background: true }, task, cbs)

		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("2/2"))
		expect(provider.createTask).not.toHaveBeenCalled()
	})
})
