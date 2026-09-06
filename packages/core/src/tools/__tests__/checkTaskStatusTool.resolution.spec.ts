const readTaskMessages = vi.fn(async () => [] as Array<Record<string, unknown>>)
vi.mock("../../task-persistence/taskMessages.js", () => ({
	readTaskMessages: (...a: unknown[]) => readTaskMessages(...(a as [])),
}))

import { TaskStatus } from "@shofer/types"

import { CheckTaskStatusTool } from "../CheckTaskStatusTool.js"

/**
 * How `check_task_status` decides what to SAY about another task.
 *
 * Status is resolved through a ladder rather than read from one place, because
 * no single place is authoritative at every moment: the in-memory handle is
 * stale as soon as the child finishes, the live instance is gone after a
 * restart, and the persisted history lags by a write. The ladder is
 * handle-terminal → live TaskManager state → persisted history → live instance
 * → persisted lifecycle, and the LAST rung is the one that matters: a child
 * with no live instance and an idle-on-disk lifecycle reports **running**, not
 * `error`. Reporting `error` there would make a parent abandon work that is
 * merely parked, and it looks identical to a real failure.
 *
 * The access gate is the other half. A caller may inspect a DIRECT CHILD, or a
 * PEER that shares its root AND appears in its `knownPeers` — the least-
 * privilege scope, where `undefined` denies everything rather than admitting
 * everything.
 */

const buildProvider = (over: Record<string, unknown> = {}) => ({
	taskManager: {
		getManagedTaskInstance: vi.fn(),
		getTaskState: vi.fn().mockReturnValue(null),
		getManagedTask: vi.fn(),
		getManagedTasks: vi.fn().mockReturnValue([]),
	},
	taskHistoryStore: { get: vi.fn().mockReturnValue(undefined), getAll: vi.fn().mockReturnValue([]) },
	getTaskWithId: vi.fn().mockRejectedValue(new Error("no history")),
	getState: vi.fn().mockResolvedValue({ customModes: [] }),
	contextProxy: { globalStorageUri: { fsPath: "/tmp/storage" } },
	...over,
})

function buildTask(over: Record<string, unknown> = {}, provider = buildProvider()) {
	return {
		task: {
			taskId: "caller-1",
			rootTaskId: "root-1",
			backgroundChildren: new Map(),
			knownPeers: new Set<string>(),
			providerRef: { deref: () => provider },
			ask: vi.fn().mockResolvedValue(undefined),
			...over,
		} as never,
		provider,
	}
}

function buildCallbacks(over: Record<string, unknown> = {}) {
	const results: string[] = []
	return {
		results,
		askApproval: vi.fn().mockResolvedValue(true),
		pushToolResult: vi.fn((r: string) => results.push(r)),
		handleError: vi.fn(),
		...over,
	} as never as { results: string[]; askApproval: ReturnType<typeof vi.fn> } & Record<string, never>
}

const tool = new CheckTaskStatusTool()

/** A direct child whose handle is not yet terminal, so the ladder runs. */
const runningChild = () => new Map([["child-1", { taskId: "child-1", status: "running", createdAt: 1 }]])

beforeEach(() => {
	vi.clearAllMocks()
	readTaskMessages.mockResolvedValue([])
})

describe("the access gate", () => {
	it("refuses a task that is neither a child nor a peer", async () => {
		const { task } = buildTask()
		const cb = buildCallbacks()

		await tool.execute({ task_id: "stranger" }, task, cb as never)

		expect(cb.results[0]).toContain("not found in background children or peers")
	})

	it("admits a PEER that shares the root and is in knownPeers", async () => {
		const provider = buildProvider()
		provider.getTaskWithId = vi.fn().mockResolvedValue({ historyItem: { rootTaskId: "root-1", mode: "code" } })
		const { task } = buildTask({ knownPeers: new Set(["peer-1"]) }, provider)
		const cb = buildCallbacks()

		await tool.execute({ task_id: "peer-1" }, task, cb as never)

		expect(cb.results[0]).toContain("Task: peer-1")
	})

	it("refuses a same-root task that was never granted as a peer", async () => {
		// Least privilege: an ungranted peer is invisible even inside the family.
		const provider = buildProvider()
		provider.getTaskWithId = vi.fn().mockResolvedValue({ historyItem: { rootTaskId: "root-1" } })
		const { task } = buildTask({ knownPeers: new Set<string>() }, provider)
		const cb = buildCallbacks()

		await tool.execute({ task_id: "sibling" }, task, cb as never)

		expect(cb.results[0]).toContain("not found")
	})

	it("refuses a task belonging to a DIFFERENT root", async () => {
		const provider = buildProvider()
		provider.getTaskWithId = vi.fn().mockResolvedValue({ historyItem: { rootTaskId: "other-root" } })
		const { task } = buildTask({ knownPeers: new Set(["outsider"]) }, provider)
		const cb = buildCallbacks()

		await tool.execute({ task_id: "outsider" }, task, cb as never)

		expect(cb.results[0]).toContain("not found")
	})

	it("recognises a persisted background child after a restart", async () => {
		// `backgroundChildren` is never serialized, so the in-memory map is empty
		// on the other side of a restart; the history is what remembers.
		const provider = buildProvider()
		provider.taskHistoryStore.get = vi.fn().mockReturnValue({
			isBackground: true,
			parentTaskId: "caller-1",
			createdAt: 5,
		})
		const { task } = buildTask({}, provider)
		const cb = buildCallbacks()

		await tool.execute({ task_id: "child-1" }, task, cb as never)

		expect(cb.results[0]).toContain("Task: child-1")
	})

	it("falls through to the peer check when the history store throws", async () => {
		const provider = buildProvider()
		provider.taskHistoryStore.get = vi.fn(() => {
			throw new Error("store unavailable")
		})
		const { task } = buildTask()
		const cb = buildCallbacks()

		await tool.execute({ task_id: "child-1" }, task, cb as never)

		expect(cb.results[0]).toContain("not found")
	})

	it("refuses once the provider has been collected", async () => {
		const task = {
			taskId: "caller-1",
			backgroundChildren: runningChild(),
			providerRef: { deref: () => undefined },
		} as never
		const cb = buildCallbacks()

		await tool.execute({ task_id: "child-1" }, task, cb as never)

		expect(cb.results[0]).toContain("Provider reference lost")
	})

	it("stops when the approval is refused", async () => {
		const { task } = buildTask({ backgroundChildren: runningChild() })
		const cb = buildCallbacks({ askApproval: vi.fn().mockResolvedValue(false) })

		await tool.execute({ task_id: "child-1" }, task, cb as never)

		expect(cb.results).toEqual([])
	})
})

describe("the status ladder", () => {
	const statusOf = (cb: { results: string[] }) => /Status: (\w+)/.exec(cb.results[0]!)![1]

	it("trusts a handle that is already terminal without asking anyone", async () => {
		const provider = buildProvider()
		const { task } = buildTask(
			{ backgroundChildren: new Map([["child-1", { taskId: "child-1", status: "completed", createdAt: 1 }]]) },
			provider,
		)
		const cb = buildCallbacks()

		await tool.execute({ task_id: "child-1" }, task, cb as never)

		expect(statusOf(cb)).toBe("completed")
		expect(provider.taskManager.getTaskState).not.toHaveBeenCalled()
	})

	it("prefers the live TaskManager state", async () => {
		const provider = buildProvider()
		provider.taskManager.getTaskState = vi.fn().mockReturnValue({ lifecycle: "completed" })
		const { task } = buildTask({ backgroundChildren: runningChild() }, provider)
		const cb = buildCallbacks()

		await tool.execute({ task_id: "child-1" }, task, cb as never)

		expect(statusOf(cb)).toBe("completed")
	})

	it("falls back to the persisted lifecycle", async () => {
		const provider = buildProvider()
		provider.getTaskWithId = vi.fn().mockResolvedValue({ historyItem: { taskState: { lifecycle: "completed" } } })
		const { task } = buildTask({ backgroundChildren: runningChild() }, provider)
		const cb = buildCallbacks()

		await tool.execute({ task_id: "child-1" }, task, cb as never)

		expect(statusOf(cb)).toBe("completed")
	})

	it.each([
		[TaskStatus.Running, "running"],
		[TaskStatus.Interactive, "waiting"],
		[TaskStatus.Resumable, "waiting"],
		[TaskStatus.Idle, "waiting"],
		[TaskStatus.None, "error"],
	])("maps a live instance's %s onto %s", async (taskStatus, expected) => {
		const provider = buildProvider()
		provider.taskManager.getManagedTaskInstance = vi.fn().mockReturnValue({
			taskStatus,
			getTaskMode: vi.fn().mockResolvedValue("code"),
		})
		const { task } = buildTask({ backgroundChildren: runningChild() }, provider)
		const cb = buildCallbacks()

		await tool.execute({ task_id: "child-1" }, task, cb as never)

		expect(statusOf(cb)).toBe(expected)
	})

	it.each([
		["completed", "completed"],
		["error", "error"],
		["idle", "running"],
		["paused", "running"],
	])("reports a dead-but-persisted %s child as %s", async (lifecycle, expected) => {
		// The last rung, and the one that matters: an idle-on-disk child is
		// PARKED, not failed, and calling it an error makes the parent abandon
		// work that is still viable.
		const provider = buildProvider()
		provider.getTaskWithId = vi
			.fn()
			.mockRejectedValueOnce(new Error("not yet"))
			.mockResolvedValue({ historyItem: { taskState: { lifecycle } } })
		const { task } = buildTask({ backgroundChildren: runningChild() }, provider)
		const cb = buildCallbacks()

		await tool.execute({ task_id: "child-1" }, task, cb as never)

		expect(statusOf(cb)).toBe(expected)
	})

	it("reports an error only when NOTHING knows about the child", async () => {
		const { task } = buildTask({ backgroundChildren: runningChild() })
		const cb = buildCallbacks()

		await tool.execute({ task_id: "child-1" }, task, cb as never)

		expect(statusOf(cb)).toBe("error")
	})

	it("resolves a PEER from live state", async () => {
		const provider = buildProvider()
		provider.getTaskWithId = vi.fn().mockResolvedValue({ historyItem: { rootTaskId: "root-1" } })
		provider.taskManager.getTaskState = vi.fn().mockReturnValue({ lifecycle: "running" })
		const { task } = buildTask({ knownPeers: new Set(["peer-1"]) }, provider)
		const cb = buildCallbacks()

		await tool.execute({ task_id: "peer-1" }, task, cb as never)

		expect(statusOf(cb)).toBe("running")
	})
})

describe("what the report carries", () => {
	it("names the child's mode by its display name", async () => {
		const provider = buildProvider()
		provider.getState = vi.fn().mockResolvedValue({ customModes: [{ slug: "code", name: "Code Mode" }] })
		provider.taskManager.getManagedTaskInstance = vi.fn().mockReturnValue({
			taskStatus: TaskStatus.Running,
			getTaskMode: vi.fn().mockResolvedValue("code"),
		})
		const { task } = buildTask({ backgroundChildren: runningChild() }, provider)
		const cb = buildCallbacks()

		await tool.execute({ task_id: "child-1" }, task, cb as never)

		expect(cb.results[0]).toContain("Mode: Code Mode")
	})

	it("says 'unknown' when no mode can be resolved at all", async () => {
		const { task } = buildTask({ backgroundChildren: runningChild() })
		const cb = buildCallbacks()

		await tool.execute({ task_id: "child-1" }, task, cb as never)

		expect(cb.results[0]).toContain("Mode: unknown")
	})

	it("includes a completed child's RESULT, read back from its own transcript", async () => {
		readTaskMessages.mockResolvedValue([
			{ type: "say", say: "text", text: "working" },
			{ type: "say", say: "completion_result", text: "the answer" },
		])
		const { task } = buildTask({
			backgroundChildren: new Map([["child-1", { taskId: "child-1", status: "completed", createdAt: 1 }]]),
		})
		const cb = buildCallbacks()

		await tool.execute({ task_id: "child-1" }, task, cb as never)

		expect(cb.results[0]).toContain("Result: the answer")
	})

	it("includes a failed child's error text", async () => {
		readTaskMessages.mockResolvedValue([{ type: "say", say: "error", text: "it blew up" }])
		const { task } = buildTask({
			backgroundChildren: new Map([["child-1", { taskId: "child-1", status: "error", createdAt: 1 }]]),
		})
		const cb = buildCallbacks()

		await tool.execute({ task_id: "child-1" }, task, cb as never)

		expect(cb.results[0]).toContain("Error: it blew up")
	})

	it("summarizes recent activity only when asked", async () => {
		readTaskMessages.mockResolvedValue([
			{ type: "say", say: "text", text: "first\nline" },
			{ type: "say", say: "tool", text: JSON.stringify({ tool: "readFile" }) },
			{ type: "say", say: "tool", text: "not json" },
		])
		const { task } = buildTask({ backgroundChildren: runningChild() })
		const cb = buildCallbacks()

		await tool.execute({ task_id: "child-1", include_activity: true }, task, cb as never)

		expect(cb.results[0]).toContain("Recent activity:")
		expect(cb.results[0]).toContain("[say:text] first line")
		expect(cb.results[0]).toContain("[tool] readFile")
		expect(cb.results[0]).toContain("[tool] (parsing failed)")
	})

	it("omits the activity feed when the transcript cannot be read", async () => {
		// Best-effort by design: a status readout must not fail over a nicety.
		readTaskMessages.mockRejectedValue(new Error("unreadable"))
		const provider = buildProvider()
		provider.taskManager.getManagedTaskInstance = vi.fn().mockReturnValue({
			taskStatus: TaskStatus.Running,
			getTaskMode: vi.fn().mockResolvedValue("code"),
		})
		const { task } = buildTask({ backgroundChildren: runningChild() }, provider)
		const cb = buildCallbacks()

		await tool.execute({ task_id: "child-1", include_activity: true }, task, cb as never)

		expect(cb.results[0]).not.toContain("Recent activity")
	})

	it("surfaces a question the child forwarded, and how to answer it", async () => {
		// A convenience readout: the request is ALREADY in the mailbox, and
		// `reply` is the channel — so the readout names the envelope id.
		const provider = buildProvider()
		provider.taskManager.getManagedTaskInstance = vi.fn().mockReturnValue({
			taskStatus: TaskStatus.Interactive,
			getTaskMode: vi.fn().mockResolvedValue("code"),
			forwardedQuestion: { question: "which file?", envelopeId: "env-9" },
		})
		const { task } = buildTask({ backgroundChildren: runningChild() }, provider)
		const cb = buildCallbacks()

		await tool.execute({ task_id: "child-1" }, task, cb as never)

		expect(cb.results[0]).toContain('Waiting on your answer: "which file?"')
		expect(cb.results[0]).toContain('message_id: "env-9"')
	})
})

describe("the streaming row", () => {
	it("renders the ask with whatever id has arrived so far", async () => {
		const { task } = buildTask()

		await tool.handlePartial(task, {
			type: "tool_use",
			name: "check_task_status",
			params: { task_id: "chi" },
			partial: true,
		} as never)

		expect((task as unknown as { ask: ReturnType<typeof vi.fn> }).ask).toHaveBeenCalledWith(
			"tool",
			JSON.stringify({ tool: "checkTaskStatus", task_id: "chi" }),
			true,
		)
	})

	it("swallows a rejected ask, which is how a cancelled stream ends", async () => {
		const { task } = buildTask({ ask: vi.fn().mockRejectedValue(new Error("aborted")) })

		await expect(
			tool.handlePartial(task, {
				type: "tool_use",
				name: "check_task_status",
				params: {},
				partial: true,
			} as never),
		).resolves.toBeUndefined()
	})
})
