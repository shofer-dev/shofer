import { ListBackgroundTasksTool } from "../ListBackgroundTasksTool"

describe("ListBackgroundTasksTool", () => {
	let tool: ListBackgroundTasksTool

	beforeEach(() => {
		tool = new ListBackgroundTasksTool()
	})

	function buildProvider(managedTasks: any[] = []) {
		return {
			taskManager: {
				getManagedTasks: () => managedTasks,
				getManagedTaskInstance: vi.fn(),
				getManagedTask: vi.fn(),
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

	it("lists background children", async () => {
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

	// ─── Peers scope ────────────────────────────────────────────────

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

	it("lists terminal (completed) peers via ManagedTask without history lookup", async () => {
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
})
