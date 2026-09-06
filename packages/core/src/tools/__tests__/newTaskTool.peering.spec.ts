import { DEFAULT_MAX_PARALLEL_TASKS, createInMemoryHost, setHost } from "@shofer/types"

import { BUILTIN_MODES } from "../../__fixtures__/builtin-config.js"
import { NewTaskTool } from "../NewTaskTool.js"

vi.mock("@shofer/telemetry", () => ({
	TelemetryService: { hasInstance: () => true, instance: { captureSubtaskSpawned: vi.fn() } },
}))

/**
 * `new_task`'s SPAWN — the gates it passes on the way, and the peer graph it
 * leaves behind.
 *
 * Peering is the part with a subtle asymmetry. A grant can only name tasks that
 * ALREADY EXIST, so it is necessarily written one-directionally
 * (`peer_task_ids` on the spawn), but a conversation needs both directions:
 * without the mirror the child can reach the peer and the peer cannot answer.
 * So the tool writes the reverse edge too — into the peer's live instance AND
 * its history row, because the peer predates the child and its row is safe to
 * write. The mirror is deliberately NOT transitive: two siblings that merely
 * share a parent are not connected, because being spawned by the same task says
 * nothing about whether they should talk.
 *
 * The grants are also SCOPED: a named peer must share the spawner's root, which
 * is checked BEFORE the child is created so a rejected grant does not leave an
 * orphan running.
 *
 * The advisory parameters follow the **Advisory Parameter Defaults Rule** — the
 * prompt calls them soft, so a missing or nonsensical value is silently
 * defaulted rather than erroring, and the result length is clamped to the hard
 * cap that protects the parent's context.
 */

const tool = new NewTaskTool()

type Peer = { taskId: string; rootTaskId?: string; knownPeers?: Set<string> }

function makeProvider(over: Record<string, unknown> = {}) {
	const history: Array<Record<string, unknown>> = []
	const live = new Map<string, Peer>()
	const provider = {
		history,
		live,
		getState: vi.fn().mockResolvedValue({ customModes: BUILTIN_MODES }),
		contextProxy: { getValue: vi.fn().mockReturnValue(DEFAULT_MAX_PARALLEL_TASKS) },
		taskManager: {
			countActiveTasks: vi.fn().mockReturnValue(0),
			getManagedTaskInstance: vi.fn((id: string) => live.get(id)),
			registerBackgroundTask: vi.fn(),
		},
		createTask: vi.fn(async (..._args: unknown[]) => ({ taskId: "child-1" })),
		getTaskWithId: vi.fn(async (id: string) => ({ historyItem: { id } })),
		updateTaskHistory: vi.fn(async (item: Record<string, unknown>) => {
			history.push(item)
			return []
		}),
		log: vi.fn(),
		...over,
	}
	return provider
}

function makeTask(over: Record<string, unknown> = {}, provider = makeProvider()) {
	const task = {
		taskId: "parent-1",
		rootTaskId: undefined,
		parentTask: undefined,
		costLimit: undefined,
		consecutiveMistakeCount: 0,
		didToolFailInCurrentTurn: false,
		backgroundChildren: new Map(),
		knownPeers: undefined as Set<string> | undefined,
		childTaskId: undefined as string | undefined,
		agentContext: undefined,
		recordToolError: vi.fn(),
		sayAndCreateMissingParamError: vi.fn(async (_t: string, p: string) => `missing:${p}`),
		getTaskMode: vi.fn().mockResolvedValue("code"),
		ask: vi.fn().mockResolvedValue(undefined),
		providerRef: { deref: () => provider },
		...over,
	}
	return { task, provider }
}

function callbacks(over: Record<string, unknown> = {}) {
	const results: unknown[] = []
	const errors: unknown[] = []
	return {
		results,
		errors,
		pushToolResult: vi.fn((r: unknown) => results.push(r)),
		handleError: vi.fn(async (_c: string, e: unknown) => {
			errors.push(e)
		}),
		askApproval: vi.fn().mockResolvedValue(true),
		...over,
	} as never as { results: unknown[]; errors: unknown[]; askApproval: ReturnType<typeof vi.fn> }
}

const PARAMS = { mode: "code", message: "do the thing" }

beforeEach(() => {
	vi.clearAllMocks()
	setHost(createInMemoryHost())
})

describe("the gates before a child is created", () => {
	it("falls back to the parent's own mode when none is named", async () => {
		const { task, provider } = makeTask()

		await tool.execute({ message: "m" } as never, task as never, callbacks() as never)

		expect(provider.createTask).toHaveBeenCalled()
		expect(provider.createTask.mock.calls[0]![3]).toMatchObject({ initialMode: "code" })
	})

	it("names a missing mode when the parent has none either", async () => {
		const { task } = makeTask({ getTaskMode: vi.fn().mockResolvedValue(undefined) })
		const cb = callbacks()

		await tool.execute({ message: "m" } as never, task as never, cb as never)

		expect(cb.results[0]).toBe("missing:mode")
		expect(task.didToolFailInCurrentTurn).toBe(true)
	})

	it("names a missing message", async () => {
		const { task } = makeTask()
		const cb = callbacks()

		await tool.execute({ mode: "code" } as never, task as never, cb as never)

		expect(cb.results[0]).toBe("missing:message")
	})

	it("refuses an unknown mode rather than spawning into nothing", async () => {
		const { task, provider } = makeTask()
		const cb = callbacks()

		await tool.execute({ mode: "no-such-mode", message: "m" } as never, task as never, cb as never)

		expect(String(cb.results[0])).toContain("Invalid mode: no-such-mode")
		expect(provider.createTask).not.toHaveBeenCalled()
	})

	it("refuses once the parallel-task limit is reached", async () => {
		const provider = makeProvider()
		provider.contextProxy.getValue = vi.fn().mockReturnValue(2)
		provider.taskManager.countActiveTasks = vi.fn().mockReturnValue(2)
		const { task } = makeTask({}, provider)
		const cb = callbacks()

		await tool.execute(PARAMS as never, task as never, cb as never)

		expect(String(cb.results[0])).toContain("Task limit reached: 2/2")
		expect(provider.createTask).not.toHaveBeenCalled()
	})

	it("refuses a spawn that would push the ROOT over its cost cap", async () => {
		// The cap belongs to the whole tree, so the walk goes to the true root
		// before the costs are aggregated.
		const provider = makeProvider()
		provider.getTaskWithId = vi.fn(async () => ({ historyItem: { id: "root-1", totalCost: 12 } }))
		const root = { taskId: "root-1", costLimit: { maxUsd: 5 }, parentTask: undefined }
		const { task } = makeTask({ parentTask: root }, provider)
		const cb = callbacks()

		await tool.execute(PARAMS as never, task as never, cb as never)

		expect(String(cb.results[0])).toContain("Cost limit reached")
		expect(provider.createTask).not.toHaveBeenCalled()
	})

	it("spawns anyway when the cost aggregation itself fails", async () => {
		// Preferring not to block the user: an accounting outage is not a budget.
		const provider = makeProvider()
		provider.getTaskWithId = vi.fn().mockRejectedValue(new Error("history unavailable"))
		const { task } = makeTask({ costLimit: { maxUsd: 5 } }, provider)

		await tool.execute(PARAMS as never, task as never, callbacks() as never)

		expect(provider.createTask).toHaveBeenCalled()
		expect(provider.log).toHaveBeenCalledWith(expect.stringContaining("cost-limit check failed"))
	})

	it("seeds the child's checklist from the todos it was given", async () => {
		const { task, provider } = makeTask()

		await tool.execute({ ...PARAMS, todos: "[ ] first\n[ ] second" } as never, task as never, callbacks() as never)

		const options = provider.createTask.mock.calls[0]![3] as unknown as { initialTodos: unknown[] }
		expect(options.initialTodos).toHaveLength(2)
	})

	it("requires todos when the agent's own context demands them", async () => {
		const { task } = makeTask({ agentContext: { require_todos: true } })
		const cb = callbacks()

		await tool.execute(PARAMS as never, task as never, cb as never)

		expect(cb.results[0]).toBe("missing:todos")
	})

	it("refuses when the provider has been collected", async () => {
		const task = {
			taskId: "parent-1",
			consecutiveMistakeCount: 0,
			getTaskMode: vi.fn().mockResolvedValue("code"),
			providerRef: { deref: () => undefined },
		} as never
		const cb = callbacks()

		await tool.execute(PARAMS as never, task as never, cb as never)

		expect(String(cb.results[0])).toContain("Provider reference lost")
	})

	it("stops when the approval is refused", async () => {
		const { task, provider } = makeTask()
		const cb = callbacks({ askApproval: vi.fn().mockResolvedValue(false) })

		await tool.execute(PARAMS as never, task as never, cb as never)

		expect(provider.createTask).not.toHaveBeenCalled()
		expect(cb.results).toEqual([])
	})

	it("reports a failure to create the child through handleError", async () => {
		const provider = makeProvider()
		provider.createTask = vi.fn().mockRejectedValue(new Error("no worker available"))
		const { task } = makeTask({}, provider)
		const cb = callbacks()

		await tool.execute(PARAMS as never, task as never, cb as never)

		expect(cb.errors).toHaveLength(1)
	})
})

describe("the advisory parameters", () => {
	const spawnOptions = async (params: Record<string, unknown>) => {
		const { task, provider } = makeTask()
		await tool.execute({ ...PARAMS, ...params } as never, task as never, callbacks() as never)
		return provider.createTask.mock.calls[0]![3] as unknown as Record<string, unknown>
	}

	it("defaults both when the model omits them", async () => {
		expect(await spawnOptions({})).toMatchObject({ softResultLength: 2000, softTimeoutSec: 300 })
	})

	it.each([
		["a fraction", 1.5],
		["zero", 0],
		["a negative", -1],
		["null", null],
	])("defaults the result length for %s rather than erroring", async (_case, softResultLength) => {
		expect(await spawnOptions({ softResultLength })).toMatchObject({ softResultLength: 2000 })
	})

	it("clamps a runaway result length to the hard cap", async () => {
		const options = await spawnOptions({ softResultLength: 10_000_000 })

		expect(options.softResultLength).toBeLessThan(10_000_000)
	})

	it("honours a sensible pair", async () => {
		expect(await spawnOptions({ softResultLength: 500, softTimeoutSec: 60 })).toMatchObject({
			softResultLength: 500,
			softTimeoutSec: 60,
		})
	})

	it("defaults a nonsensical timeout", async () => {
		expect(await spawnOptions({ softTimeoutSec: 0 })).toMatchObject({ softTimeoutSec: 300 })
	})

	it("locks a caller-supplied title, trimmed and bounded", async () => {
		const options = await spawnOptions({ title: `  ${"t".repeat(80)}  ` })

		expect(options.initialTitle).toHaveLength(60)
	})

	it("treats a whitespace-only title as absent, so the child may name itself", async () => {
		expect(await spawnOptions({ title: "   " })).toMatchObject({ initialTitle: undefined })
	})
})

describe("the peer graph", () => {
	it("seeds the child with its parent, and nothing else, by default", async () => {
		const { task, provider } = makeTask()

		await tool.execute(PARAMS as never, task as never, callbacks() as never)

		expect(
			(provider.createTask.mock.calls[0]![3] as unknown as { initialKnownPeers: string[] }).initialKnownPeers,
		).toEqual(["parent-1"])
	})

	it("refuses a peer that does not share the spawner's root, BEFORE creating the child", async () => {
		// Validating first is what stops a rejected grant leaving an orphan.
		const provider = makeProvider()
		provider.live.set("stranger", { taskId: "stranger", rootTaskId: "other-root" })
		const { task } = makeTask({}, provider)
		const cb = callbacks()

		await tool.execute({ ...PARAMS, peer_task_ids: ["stranger"] } as never, task as never, cb as never)

		expect(String(cb.results[0])).toContain("does not share your root task")
		expect(provider.createTask).not.toHaveBeenCalled()
	})

	it("grants a same-root peer in BOTH directions", async () => {
		const provider = makeProvider()
		const peer: Peer = { taskId: "peer-1", rootTaskId: "parent-1" }
		provider.live.set("peer-1", peer)
		const { task } = makeTask({}, provider)

		await tool.execute({ ...PARAMS, peer_task_ids: ["peer-1"] } as never, task as never, callbacks() as never)

		// Forward: the child is seeded with the peer.
		expect(
			(provider.createTask.mock.calls[0]![3] as unknown as { initialKnownPeers: string[] }).initialKnownPeers,
		).toEqual(expect.arrayContaining(["parent-1", "peer-1"]))
		// Reverse: the peer can answer, in memory now and after a restart.
		expect(peer.knownPeers?.has("child-1")).toBe(true)
		expect(provider.history).toContainEqual(expect.objectContaining({ id: "peer-1", peerIds: ["child-1"] }))
	})

	it("persists the reverse edge for a peer that is not live right now", async () => {
		const provider = makeProvider()
		provider.getTaskWithId = vi.fn(async (id: string) => ({
			historyItem: { id, rootTaskId: "parent-1", peerIds: ["someone"] },
		}))
		const { task } = makeTask({}, provider)

		await tool.execute({ ...PARAMS, peer_task_ids: ["peer-1"] } as never, task as never, callbacks() as never)

		expect(provider.history).toContainEqual(
			expect.objectContaining({ id: "peer-1", peerIds: ["someone", "child-1"] }),
		)
	})

	it("still spawns when the reverse edge cannot be persisted", async () => {
		// Only restart-survival of the edge is lost; the live mirror still works.
		const provider = makeProvider()
		const peer: Peer = { taskId: "peer-1", rootTaskId: "parent-1" }
		provider.live.set("peer-1", peer)
		provider.updateTaskHistory = vi.fn().mockRejectedValue(new Error("store down"))
		const { task } = makeTask({}, provider)
		const cb = callbacks()

		await tool.execute({ ...PARAMS, peer_task_ids: ["peer-1"] } as never, task as never, cb as never)

		expect(peer.knownPeers?.has("child-1")).toBe(true)
		expect(String(cb.results[0])).toContain("Child task started")
	})
})

describe("what the parent records", () => {
	it("keeps an in-memory handle for the child", async () => {
		const { task } = makeTask()

		await tool.execute(PARAMS as never, task as never, callbacks() as never)

		expect(task.backgroundChildren.get("child-1")).toMatchObject({
			taskId: "child-1",
			status: "starting",
			parentTaskId: "parent-1",
		})
		expect(task.childTaskId).toBe("child-1")
	})

	it("writes a MINIMAL delta, not a whole snapshot, so a concurrent update is not clobbered", async () => {
		const provider = makeProvider()
		provider.getTaskWithId = vi.fn(async () => ({
			historyItem: { id: "parent-1", backgroundChildIds: ["older"], childIds: ["older"] },
		}))
		const { task } = makeTask({}, provider)

		await tool.execute(PARAMS as never, task as never, callbacks() as never)

		expect(provider.history[0]).toEqual({
			id: "parent-1",
			backgroundChildIds: ["older", "child-1"],
			childIds: ["older", "child-1"],
			peerIds: ["child-1"],
		})
	})

	it("registers the child as a background task", async () => {
		const { task, provider } = makeTask()

		await tool.execute(PARAMS as never, task as never, callbacks() as never)

		expect(provider.taskManager.registerBackgroundTask).toHaveBeenCalledWith({ taskId: "child-1" })
	})

	it("survives a failure to update its own history", async () => {
		const provider = makeProvider()
		provider.updateTaskHistory = vi.fn().mockRejectedValue(new Error("store down"))
		const { task } = makeTask({}, provider)
		const cb = callbacks()

		await tool.execute(PARAMS as never, task as never, cb as never)

		expect(String(cb.results[0])).toContain("Child task started: child-1")
	})
})

describe("the streaming row", () => {
	it("renders whatever fields have arrived so far", async () => {
		const { task } = makeTask()

		await tool.handlePartial(
			task as never,
			{
				type: "tool_use",
				name: "new_task",
				params: { mode: "code", message: "do", softResultLength: "500", title: "T" },
				partial: true,
			} as never,
		)

		const [, payload, partial] = (task.ask as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
		expect(JSON.parse(payload)).toMatchObject({
			tool: "newTask",
			mode: "code",
			content: "do",
			softResultLength: 500,
			title: "T",
		})
		expect(partial).toBe(true)
	})

	it("renders empty strings for fields nothing has arrived for yet", async () => {
		const { task } = makeTask()

		await tool.handlePartial(
			task as never,
			{ type: "tool_use", name: "new_task", params: {}, partial: true } as never,
		)

		expect(JSON.parse((task.ask as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1])).toMatchObject({
			mode: "",
			content: "",
		})
	})

	it("swallows a rejected ask, which is how a cancelled stream ends", async () => {
		const { task } = makeTask({ ask: vi.fn().mockRejectedValue(new Error("aborted")) })

		await expect(
			tool.handlePartial(
				task as never,
				{ type: "tool_use", name: "new_task", params: {}, partial: true } as never,
			),
		).resolves.toBeUndefined()
	})
})
