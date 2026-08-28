import { ListBackgroundTasksTool } from "../ListBackgroundTasksTool.js"

describe("ListBackgroundTasksTool", () => {
	let tool: ListBackgroundTasksTool

	beforeEach(() => {
		tool = new ListBackgroundTasksTool()
	})

	function buildProvider(managedTasks: any[] = [], historyEntries: any[] = []) {
		return {
			taskManager: {
				getManagedTasks: () => managedTasks,
				getManagedTaskInstance: vi.fn(),
				getManagedTask: vi.fn(),
			},
			taskHistoryStore: {
				getAll: () => historyEntries,
			},
			getTaskWithId: vi.fn(),
		}
	}

	function buildTask(overrides: Record<string, any> = {}) {
		return {
			taskId: "caller-1",
			rootTaskId: "root-1",
			knownPeers: new Set(["peer-1", "peer-2"]),
			backgroundChildren: new Map(),
			providerRef: {
				deref: () => buildProvider(),
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

	// ─── Children scope ─────────────────────────────────────────────

	it("lists live background children", async () => {
		const task = buildTask()
		task.backgroundChildren = new Map([["child-1", { taskId: "child-1", status: "running", createdAt: 100 }]])
		;(task.providerRef.deref as any) = () =>
			buildProvider([{ id: "child-1", name: "Child One", state: { lifecycle: "running" }, createdAt: 100 }])

		const cbs = buildCallbacks()
		await tool.execute({ scope: "children" }, task, cbs)

		const resultStr = cbs.pushToolResult.mock.calls[0][0]
		const result = JSON.parse(resultStr)
		expect(result.tasks).toHaveLength(1)
		expect(result.tasks[0].task_id).toBe("child-1")
		expect(result.tasks[0].status).toBe("running")
	})

	it("children scope includes non-live children from persisted history", async () => {
		const task = buildTask()
		// No live children — only history
		task.backgroundChildren = new Map()
		const historyEntries = [
			{
				id: "child-2",
				name: "Stopped Child",
				task: "history task",
				rootTaskId: "root-1",
				parentTaskId: "caller-1",
				isBackground: true,
				taskState: { lifecycle: "completed" },
				createdAt: 200,
				ts: 200,
			},
		]
		;(task.providerRef.deref as any) = () => buildProvider([], historyEntries)

		const cbs = buildCallbacks()
		await tool.execute({ scope: "children" }, task, cbs)

		const resultStr = cbs.pushToolResult.mock.calls[0][0]
		const result = JSON.parse(resultStr)
		expect(result.tasks).toHaveLength(1)
		expect(result.tasks[0].task_id).toBe("child-2")
		expect(result.tasks[0].status).toBe("completed")
	})

	it("children scope includes synchronous (non-background) children from history", async () => {
		// A task the host pushed directly, rather than a `new_task` child, is never added to
		// backgroundChildren, so without the persisted-history fallback it
		// would be invisible. Matching on parentTaskId must surface it.
		const task = buildTask()
		task.backgroundChildren = new Map()
		const historyEntries = [
			{
				id: "sync-child",
				name: "Sync Child",
				task: "compute 1+1",
				rootTaskId: "root-1",
				parentTaskId: "caller-1",
				isBackground: false,
				taskState: { lifecycle: "completed" },
				createdAt: 150,
				ts: 150,
			},
		]
		;(task.providerRef.deref as any) = () => buildProvider([], historyEntries)

		const cbs = buildCallbacks()
		await tool.execute({ scope: "children" }, task, cbs)

		const resultStr = cbs.pushToolResult.mock.calls[0][0]
		const result = JSON.parse(resultStr)
		expect(result.tasks).toHaveLength(1)
		expect(result.tasks[0].task_id).toBe("sync-child")
		expect(result.tasks[0].status).toBe("completed")
	})

	it("children scope deduplicates live and history entries", async () => {
		const task = buildTask()
		task.backgroundChildren = new Map([["child-1", { taskId: "child-1", status: "running", createdAt: 100 }]])
		// History also has child-1 — live entry wins
		const historyEntries = [
			{
				id: "child-1",
				name: "Child One (history)",
				task: "history",
				rootTaskId: "root-1",
				parentTaskId: "caller-1",
				isBackground: true,
				taskState: { lifecycle: "completed" },
				createdAt: 100,
				ts: 100,
			},
		]
		;(task.providerRef.deref as any) = () => buildProvider([], historyEntries)

		const cbs = buildCallbacks()
		await tool.execute({ scope: "children" }, task, cbs)

		const resultStr = cbs.pushToolResult.mock.calls[0][0]
		const result = JSON.parse(resultStr)
		expect(result.tasks).toHaveLength(1)
	})

	// ─── Default scope (backward compat) ────────────────────────────

	it("default scope is 'children' when scope is omitted", async () => {
		const task = buildTask()
		task.backgroundChildren = new Map([["child-1", { taskId: "child-1", status: "running", createdAt: 100 }]])
		;(task.providerRef.deref as any) = () =>
			buildProvider([{ id: "child-1", name: "Child One", state: { lifecycle: "running" }, createdAt: 100 }])

		const cbs = buildCallbacks()
		await tool.execute({}, task, cbs)

		const resultStr = cbs.pushToolResult.mock.calls[0][0]
		const result = JSON.parse(resultStr)
		expect(result.tasks).toHaveLength(1)
		expect(result.tasks[0].task_id).toBe("child-1")
	})

	it("scope null defaults to 'children'", async () => {
		const task = buildTask()
		task.backgroundChildren = new Map([["child-1", { taskId: "child-1", status: "running", createdAt: 100 }]])
		;(task.providerRef.deref as any) = () =>
			buildProvider([{ id: "child-1", name: "Child One", state: { lifecycle: "running" }, createdAt: 100 }])

		const cbs = buildCallbacks()
		await tool.execute({ scope: null }, task, cbs)

		const resultStr = cbs.pushToolResult.mock.calls[0][0]
		const result = JSON.parse(resultStr)
		expect(result.tasks).toHaveLength(1)
	})

	// ─── Peers scope — ManagedTask only ─────────────────────────────

	it("lists peers with same rootTaskId, excluding self", async () => {
		const managedPeers = [
			{ id: "caller-1", name: "Self", rootTaskId: "root-1", state: { lifecycle: "running" }, createdAt: 100 },
			{ id: "peer-1", name: "Peer One", rootTaskId: "root-1", state: { lifecycle: "running" }, createdAt: 200 },
			{ id: "peer-2", name: "Peer Two", rootTaskId: "root-1", state: { lifecycle: "completed" }, createdAt: 300 },
		]
		const task = buildTask()
		;(task.providerRef.deref as any) = () => buildProvider(managedPeers)

		const cbs = buildCallbacks()
		await tool.execute({ scope: "peers" }, task, cbs)

		const resultStr = cbs.pushToolResult.mock.calls[0][0]
		const result = JSON.parse(resultStr)
		expect(result.tasks).toHaveLength(2)
		const ids = result.tasks.map((t: any) => t.task_id)
		expect(ids).toContain("peer-1")
		expect(ids).toContain("peer-2")
	})

	it("lists terminal (completed) peers via ManagedTask", async () => {
		const managedPeers = [
			{
				id: "peer-1",
				name: "Completed Peer",
				rootTaskId: "root-1",
				state: { lifecycle: "completed" },
				createdAt: 400,
			},
		]
		const task = buildTask()
		;(task.providerRef.deref as any) = () => buildProvider(managedPeers)

		const cbs = buildCallbacks()
		await tool.execute({ scope: "peers" }, task, cbs)

		const resultStr = cbs.pushToolResult.mock.calls[0][0]
		const result = JSON.parse(resultStr)
		expect(result.tasks).toHaveLength(1)
		expect(result.tasks[0].task_id).toBe("peer-1")
		expect(result.tasks[0].status).toBe("completed")
	})

	it("filters peers not in knownPeers", async () => {
		const managedPeers = [
			{ id: "peer-1", name: "Known", rootTaskId: "root-1", state: { lifecycle: "idle" }, createdAt: 100 },
			{ id: "peer-3", name: "Unknown", rootTaskId: "root-1", state: { lifecycle: "idle" }, createdAt: 200 },
		]
		const task = buildTask({ knownPeers: new Set(["peer-1"]) })
		;(task.providerRef.deref as any) = () => buildProvider(managedPeers)

		const cbs = buildCallbacks()
		await tool.execute({ scope: "peers" }, task, cbs)

		const resultStr = cbs.pushToolResult.mock.calls[0][0]
		const result = JSON.parse(resultStr)
		expect(result.tasks).toHaveLength(1)
		expect(result.tasks[0].task_id).toBe("peer-1")
	})

	it("excludes peers with different rootTaskId", async () => {
		const managedPeers = [
			{ id: "peer-1", name: "Same Root", rootTaskId: "root-1", state: { lifecycle: "idle" }, createdAt: 100 },
			{
				id: "peer-2",
				name: "Different Root",
				rootTaskId: "root-2",
				state: { lifecycle: "idle" },
				createdAt: 200,
			},
		]
		const task = buildTask()
		;(task.providerRef.deref as any) = () => buildProvider(managedPeers)

		const cbs = buildCallbacks()
		await tool.execute({ scope: "peers" }, task, cbs)

		const resultStr = cbs.pushToolResult.mock.calls[0][0]
		const result = JSON.parse(resultStr)
		expect(result.tasks).toHaveLength(1)
		expect(result.tasks[0].task_id).toBe("peer-1")
	})

	// ─── Peers scope — HistoryStore augmentation ─────────────────────

	it("peers scope includes stopped peers from TaskHistoryStore", async () => {
		// ManagedTasks has only peer-1 (live). History has peer-2 (stopped/cancelled
		// and removed from ManagedTasks).
		const managedPeers = [
			{ id: "peer-1", name: "Live Peer", rootTaskId: "root-1", state: { lifecycle: "running" }, createdAt: 400 },
		]
		const historyEntries = [
			{
				id: "peer-2",
				name: "Stopped Peer",
				task: "history",
				rootTaskId: "root-1",
				taskState: { lifecycle: "error" },
				createdAt: 200,
				ts: 200,
			},
		]
		const task = buildTask({ knownPeers: new Set(["peer-1", "peer-2"]) })
		;(task.providerRef.deref as any) = () => buildProvider(managedPeers, historyEntries)

		const cbs = buildCallbacks()
		await tool.execute({ scope: "peers" }, task, cbs)

		const resultStr = cbs.pushToolResult.mock.calls[0][0]
		const result = JSON.parse(resultStr)
		expect(result.tasks).toHaveLength(2)
		const ids = result.tasks.map((t: any) => t.task_id)
		expect(ids).toContain("peer-1")
		expect(ids).toContain("peer-2")
		// Stopped peer from history should show "error" status
		const stoppedPeer = result.tasks.find((t: any) => t.task_id === "peer-2")
		expect(stoppedPeer.status).toBe("error")
	})

	it("peers scope deduplicates ManagedTask and HistoryStore entries", async () => {
		// Same task in both sources — ManagedTask wins.
		const managedPeers = [
			{ id: "peer-1", name: "Live Peer", rootTaskId: "root-1", state: { lifecycle: "running" }, createdAt: 400 },
		]
		const historyEntries = [
			{
				id: "peer-1",
				name: "Peer One (history)",
				task: "history",
				rootTaskId: "root-1",
				taskState: { lifecycle: "paused" },
				createdAt: 400,
				ts: 400,
			},
		]
		const task = buildTask()
		;(task.providerRef.deref as any) = () => buildProvider(managedPeers, historyEntries)

		const cbs = buildCallbacks()
		await tool.execute({ scope: "peers" }, task, cbs)

		const resultStr = cbs.pushToolResult.mock.calls[0][0]
		const result = JSON.parse(resultStr)
		expect(result.tasks).toHaveLength(1)
		// Live ManagedTask lifecycle wins over history
		expect(result.tasks[0].status).toBe("running")
	})

	it("peers scope filters history entries by knownPeers and rootTaskId", async () => {
		const managedPeers: any[] = []
		const historyEntries = [
			{
				id: "peer-1",
				name: "Known Same Root",
				task: "history",
				rootTaskId: "root-1",
				taskState: { lifecycle: "idle" },
				createdAt: 100,
				ts: 100,
			},
			{
				id: "peer-3",
				name: "Not In knownPeers",
				task: "history",
				rootTaskId: "root-1",
				taskState: { lifecycle: "idle" },
				createdAt: 200,
				ts: 200,
			},
			{
				id: "peer-4",
				name: "Different Root",
				task: "history",
				rootTaskId: "root-2",
				taskState: { lifecycle: "idle" },
				createdAt: 300,
				ts: 300,
			},
		]
		const task = buildTask({ knownPeers: new Set(["peer-1"]) })
		;(task.providerRef.deref as any) = () => buildProvider(managedPeers, historyEntries)

		const cbs = buildCallbacks()
		await tool.execute({ scope: "peers" }, task, cbs)

		const resultStr = cbs.pushToolResult.mock.calls[0][0]
		const result = JSON.parse(resultStr)
		expect(result.tasks).toHaveLength(1)
		expect(result.tasks[0].task_id).toBe("peer-1")
	})

	// ─── Root-task peer scoping (issue: leaking unrelated tasks) ────

	it("root caller (no rootTaskId) excludes other root tasks from ManagedTasks", async () => {
		// The caller is a root task (rootTaskId undefined). Other root tasks
		// (also rootTaskId undefined) must NOT appear as peers — only tasks
		// whose rootTaskId === caller.taskId qualify.
		const managedPeers = [
			{
				id: "child-1",
				name: "Own Child",
				rootTaskId: "caller-1",
				state: { lifecycle: "running" },
				createdAt: 100,
			},
			{
				id: "other-root",
				name: "Unrelated Root",
				rootTaskId: undefined,
				state: { lifecycle: "idle" },
				createdAt: 200,
			},
		]
		const task = buildTask({
			rootTaskId: undefined,
			knownPeers: new Set(["child-1"]),
		})
		;(task.providerRef.deref as any) = () => buildProvider(managedPeers)

		const cbs = buildCallbacks()
		await tool.execute({ scope: "peers" }, task, cbs)

		const resultStr = cbs.pushToolResult.mock.calls[0][0]
		const result = JSON.parse(resultStr)
		expect(result.tasks).toHaveLength(1)
		expect(result.tasks[0].task_id).toBe("child-1")
	})

	it("root caller excludes other root tasks from TaskHistoryStore", async () => {
		// Persisted history contains an unrelated root task (no rootTaskId) and
		// the caller's own child. Only the child should appear.
		const historyEntries = [
			{
				id: "child-1",
				name: "Own Child",
				task: "history",
				rootTaskId: "caller-1",
				taskState: { lifecycle: "idle" },
				createdAt: 100,
				ts: 100,
			},
			{
				id: "stale-root",
				name: "Stale Unrelated Root",
				task: "old session",
				rootTaskId: undefined,
				taskState: { lifecycle: "idle" },
				createdAt: 200,
				ts: 200,
			},
		]
		const task = buildTask({
			rootTaskId: undefined,
			knownPeers: new Set(["child-1"]),
		})
		;(task.providerRef.deref as any) = () => buildProvider([], historyEntries)

		const cbs = buildCallbacks()
		await tool.execute({ scope: "peers" }, task, cbs)

		const resultStr = cbs.pushToolResult.mock.calls[0][0]
		const result = JSON.parse(resultStr)
		expect(result.tasks).toHaveLength(1)
		expect(result.tasks[0].task_id).toBe("child-1")
	})

	it("root caller discovers all same-tree descendants regardless of knownPeers", async () => {
		// A root caller has no rootTaskId and no meaningful peer-grant set, so
		// the knownPeers gate is skipped for it. ALL descendants sharing its
		// rootTaskId appear — including ones not in knownPeers (e.g. sync
		// children, ungranted grandchildren).
		const managedPeers = [
			{
				id: "child-1",
				name: "Granted Child",
				rootTaskId: "caller-1",
				state: { lifecycle: "running" },
				createdAt: 100,
			},
			{
				id: "child-2",
				name: "Ungranted Child",
				rootTaskId: "caller-1",
				state: { lifecycle: "running" },
				createdAt: 200,
			},
		]
		const task = buildTask({
			rootTaskId: undefined,
			knownPeers: new Set(["child-1"]),
		})
		;(task.providerRef.deref as any) = () => buildProvider(managedPeers)

		const cbs = buildCallbacks()
		await tool.execute({ scope: "peers" }, task, cbs)

		const resultStr = cbs.pushToolResult.mock.calls[0][0]
		const result = JSON.parse(resultStr)
		const ids = result.tasks.map((t: any) => t.task_id)
		expect(ids).toHaveLength(2)
		expect(ids).toContain("child-1")
		expect(ids).toContain("child-2")
	})
})
