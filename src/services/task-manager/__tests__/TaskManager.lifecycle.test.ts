// npx vitest src/services/task-manager/__tests__/TaskManager.lifecycle.test.ts

/**
 * `TaskManager` owns the parallel-task set, and two AGENTS.md rules live here:
 *
 *  - **Restore-Ordering Rule.** `registerBackgroundTask` calls `assertRestored()`
 *    first, because a task registered before the persisted map is seeded would be
 *    classified by the "genuinely new" fallback and come back as `running`.
 *  - **Single-Writer Persistence Rule.** `setState` is the ONLY writer of
 *    `taskState`, and its persist is versioned latest-wins: a slow
 *    `completed`-with-rating write that lands after a synchronous `running` write
 *    must be DROPPED, or a restarted task is recorded as finished.
 *
 * The third thing pinned here is the active-time accounting, which is what the
 * Stats runtime pie reads: a task accumulates wall-clock time only while
 * `running` or `waiting`, and a plain query must never advance that clock.
 */

const hoisted = vi.hoisted(() => ({
	incTaskCreated: vi.fn(),
	incTaskCompleted: vi.fn(),
	incTaskErrored: vi.fn(),
}))

vi.mock("@shofer/core", async (importOriginal) => ({
	...(await importOriginal<typeof import("@shofer/core")>()),
	incTaskCreated: hoisted.incTaskCreated,
	incTaskCompleted: hoisted.incTaskCompleted,
	incTaskErrored: hoisted.incTaskErrored,
	taskLog: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { ShoferEventName } from "@shofer/types"
import type { HistoryItem, TaskState } from "@shofer/types"

import { TaskManager } from "../TaskManager"
import type { ShoferProvider } from "../../../core/webview/ShoferProvider"

type Store = { get: ReturnType<typeof vi.fn> }

function makeProvider(stored: Record<string, HistoryItem> = {}) {
	const updateTaskHistory = vi.fn(async (item: HistoryItem) => {
		stored[item.id] = { ...stored[item.id], ...item }
		return []
	})
	const store: Store = { get: vi.fn((id: string) => stored[id]) }
	return {
		provider: { taskHistoryStore: store, updateTaskHistory } as unknown as ShoferProvider,
		updateTaskHistory,
		stored,
		store,
	}
}

function makeTask(taskId: string, extra: Record<string, unknown> = {}) {
	const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
	return {
		taskId,
		rootTaskId: "root",
		cwd: "/w",
		taskMode: "code",
		abandoned: false,
		abort: false,
		shoferMessages: [] as Array<Record<string, unknown>>,
		abortTask: vi.fn(async () => undefined),
		cancelCurrentRequest: vi.fn(),
		on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
			listeners.set(event, [...(listeners.get(event) ?? []), cb])
		}),
		off: vi.fn(),
		removeListener: vi.fn(),
		emitEvent: (event: string, ...args: unknown[]) => {
			for (const cb of listeners.get(event) ?? []) cb(...args)
		},
		...extra,
	}
}

/** The manager only ever sees the surface above; the cast is at the call boundary. */
type TaskDouble = ReturnType<typeof makeTask>
const asTask = (t: TaskDouble) => t as unknown as Parameters<TaskManager["registerBackgroundTask"]>[0]

/** A manager that has completed the restore handshake. */
function restoredManager(stored: Record<string, HistoryItem> = {}) {
	const fixture = makeProvider(stored)
	const manager = new TaskManager(fixture.provider)
	manager.ensureRestored()
	return { manager, ...fixture }
}

beforeEach(() => vi.clearAllMocks())

describe("the Restore-Ordering Rule", () => {
	it("REFUSES to register a background task before the map is authoritative", () => {
		const { provider } = makeProvider()
		const manager = new TaskManager(provider)

		expect(() => manager.registerBackgroundTask(asTask(makeTask("t-1")))).toThrow(
			/registerBackgroundTask\(\) called before restoreManagedTasks/,
		)
	})

	it("ensureRestored unblocks registration WITHOUT seeding, so the later restore still runs", async () => {
		const { manager } = restoredManager()

		manager.registerBackgroundTask(asTask(makeTask("t-1")))
		await manager.restoreManagedTasks([{ id: "t-2", ts: 1, task: "other" } as HistoryItem])

		expect(
			manager
				.getManagedTasks()
				.map((m) => m.id)
				.sort(),
		).toEqual(["t-1", "t-2"])
	})

	it("restoreManagedTasks seeds ONCE — a second call is a no-op", async () => {
		const { manager } = restoredManager()

		await manager.restoreManagedTasks([{ id: "t-1", ts: 1, task: "first" } as HistoryItem])
		await manager.restoreManagedTasks([{ id: "t-2", ts: 2, task: "second" } as HistoryItem])

		expect(manager.getManagedTasks().map((m) => m.id)).toEqual(["t-1"])
	})

	it("never CLOBBERS a task that registered before the restore settled", async () => {
		const { manager } = restoredManager()
		manager.registerBackgroundTask(asTask(makeTask("t-1")), "Live name")

		await manager.restoreManagedTasks([
			{ id: "t-1", ts: 1, task: "persisted", name: "Persisted name" } as HistoryItem,
		])

		expect(manager.getManagedTask("t-1")!.name).toBe("Live name")
	})

	it("skips a history row with no id", async () => {
		const { manager } = restoredManager()

		await manager.restoreManagedTasks([{ ts: 1, task: "no id" } as HistoryItem])

		expect(manager.getManagedTasks()).toEqual([])
	})

	it("names a restored task from its own name, then its task text, then its number", async () => {
		const { manager } = restoredManager()

		await manager.restoreManagedTasks([
			{ id: "a", ts: 1, name: "Explicit", task: "ignored" } as HistoryItem,
			{ id: "b", ts: 1, task: "x".repeat(80) } as HistoryItem,
			{ id: "c", ts: 1, number: 7 } as HistoryItem,
		])

		expect(manager.getManagedTask("a")!.name).toBe("Explicit")
		expect(manager.getManagedTask("b")!.name).toBe("x".repeat(50) + "...")
		expect(manager.getManagedTask("c")!.name).toBe("Task 7")
	})
})

describe("sanitizeRestoredState", () => {
	async function restoredLifecycle(state: TaskState | undefined) {
		const { manager } = restoredManager()
		await manager.restoreManagedTasks([{ id: "t-1", ts: 1, task: "t", taskState: state } as HistoryItem])
		return manager.getTaskState("t-1")
	}

	it.each(["running", "waiting_input", "waiting"] as const)(
		"DOWNGRADES the transient lifecycle %s to idle — in-flight work cannot survive a restart",
		async (lifecycle) => {
			await expect(restoredLifecycle({ lifecycle })).resolves.toEqual({ lifecycle: "idle" })
		},
	)

	it("PRESERVES a completed state with its rating", async () => {
		await expect(restoredLifecycle({ lifecycle: "completed", rating: "well" })).resolves.toEqual({
			lifecycle: "completed",
			rating: "well",
		})
	})

	it.each(["error", "idle"] as const)("preserves %s", async (lifecycle) => {
		await expect(restoredLifecycle({ lifecycle })).resolves.toMatchObject({ lifecycle })
	})

	it("treats an ABSENT state as idle", async () => {
		await expect(restoredLifecycle(undefined)).resolves.toEqual({ lifecycle: "idle" })
	})
})

describe("registerBackgroundTask", () => {
	it("classifies a genuinely new task as RUNNING", () => {
		const { manager } = restoredManager()

		manager.registerBackgroundTask(asTask(makeTask("t-1")))

		expect(manager.getTaskState("t-1")).toEqual({ lifecycle: "running" })
		expect(hoisted.incTaskCreated).not.toHaveBeenCalled()
	})

	it("classifies an ABORTED or ABANDONED new task as idle, not running", () => {
		const { manager } = restoredManager()

		manager.registerBackgroundTask(asTask(makeTask("aborted", { abort: true })))
		manager.registerBackgroundTask(asTask(makeTask("abandoned", { abandoned: true })))

		expect(manager.getTaskState("aborted")).toEqual({ lifecycle: "idle" })
		expect(manager.getTaskState("abandoned")).toEqual({ lifecycle: "idle" })
	})

	it("ADOPTS the persisted state for a rehydrated task rather than re-deriving it", async () => {
		const { manager } = restoredManager()
		await manager.restoreManagedTasks([
			{ id: "t-1", ts: 1, task: "t", taskState: { lifecycle: "completed", rating: "well" } } as HistoryItem,
		])

		manager.registerBackgroundTask(asTask(makeTask("t-1")))

		expect(manager.getTaskState("t-1")).toEqual({ lifecycle: "completed", rating: "well" })
	})

	it("auto-names from the first text message, truncating with an ellipsis", () => {
		const { manager } = restoredManager()
		const task = makeTask("t-1") as unknown as { shoferMessages: Array<Record<string, unknown>> }
		task.shoferMessages = [{ type: "say", say: "text", text: "x".repeat(80) }]

		manager.registerBackgroundTask(asTask(task as unknown as TaskDouble))

		expect(manager.getManagedTask("t-1")!.name).toBe("x".repeat(50) + "...")
	})

	it("falls back to 'New Task' when there is nothing to name it after", () => {
		const { manager } = restoredManager()

		manager.registerBackgroundTask(asTask(makeTask("t-1")))

		expect(manager.getManagedTask("t-1")!.name).toBe("New Task")
	})

	it("REPLACES the instance for a task that is already registered, without duplicating it", () => {
		const { manager } = restoredManager()
		const first = makeTask("t-1")
		const second = makeTask("t-1")

		manager.registerBackgroundTask(asTask(first))
		manager.registerBackgroundTask(asTask(second))

		expect(manager.getManagedTasks()).toHaveLength(1)
		expect(manager.getManagedTaskInstance("t-1")).toBe(second)
		expect(hoisted.incTaskCreated).toHaveBeenCalled()
	})
})

describe("focus", () => {
	it("REFUSES to focus a task the manager does not know", async () => {
		const { manager } = restoredManager()

		await expect(manager.focusTask("ghost")).rejects.toThrow(/not found/)
	})

	it("focusing CLEARS that task's pending notifications", async () => {
		const { manager } = restoredManager()
		const task = makeTask("t-1")
		manager.registerBackgroundTask(asTask(task))
		;(task as unknown as { emitEvent: (e: string, ...a: unknown[]) => void }).emitEvent("taskAskResponded")

		await manager.focusTask("t-1")

		expect(manager.getNotifications()).toEqual([])
		expect(manager.getFocusedTaskId()).toBe("t-1")
		expect(manager.getFocusedTask()!.id).toBe("t-1")
	})

	it("reports NO focused task before anything is focused", () => {
		const { manager } = restoredManager()

		expect(manager.getFocusedTaskId()).toBeNull()
		expect(manager.getFocusedTask()).toBeNull()
	})

	it("clearFocusIfMatches only clears the NAMED task", async () => {
		const { manager } = restoredManager()
		manager.registerBackgroundTask(asTask(makeTask("t-1")))
		await manager.focusTask("t-1")

		manager.clearFocusIfMatches("someone-else")
		expect(manager.getFocusedTaskId()).toBe("t-1")

		manager.clearFocusIfMatches("t-1")
		expect(manager.getFocusedTaskId()).toBeNull()
	})

	it("reports null for a focused id whose task has since been deleted", async () => {
		const { manager } = restoredManager()
		manager.registerBackgroundTask(asTask(makeTask("t-1")))
		await manager.focusTask("t-1")
		await manager.deleteManagedTask("t-1")

		expect(manager.getFocusedTask()).toBeNull()
	})
})

describe("execution control", () => {
	it("start / pause / stop all REFUSE an unknown task", async () => {
		const { manager } = restoredManager()

		await expect(manager.startManagedTask("ghost")).rejects.toThrow(/not found/)
		await expect(manager.pauseManagedTask("ghost")).rejects.toThrow(/not found/)
		await expect(manager.stopManagedTask("ghost")).rejects.toThrow(/not found/)
	})

	it("startManagedTask refuses a managed row with no live instance", async () => {
		const { manager } = restoredManager()
		await manager.restoreManagedTasks([{ id: "t-1", ts: 1, task: "t" } as HistoryItem])

		await expect(manager.startManagedTask("t-1")).rejects.toThrow(/Task for managed task t-1 not found/)
	})

	it("pauseManagedTask cancels the in-flight request and aborts NON-destructively", async () => {
		const { manager } = restoredManager()
		const task = makeTask("t-1")
		manager.registerBackgroundTask(asTask(task))

		await manager.pauseManagedTask("t-1")

		expect(task.cancelCurrentRequest).toHaveBeenCalled()
		expect(task.abortTask).toHaveBeenCalledWith(false)
		expect(manager.getTaskState("t-1")).toEqual({ lifecycle: "paused" })
	})

	it("stopManagedTask aborts as ABANDONED and lands the task idle", async () => {
		const { manager } = restoredManager()
		const task = makeTask("t-1")
		manager.registerBackgroundTask(asTask(task))

		await manager.stopManagedTask("t-1")

		expect(task.abortTask).toHaveBeenCalledWith(true)
		expect(manager.getTaskState("t-1")).toEqual({ lifecycle: "idle" })
	})

	it("pause / stop survive an abort that throws", async () => {
		const { manager } = restoredManager()
		const task = makeTask("t-1", {
			abortTask: vi.fn(async () => {
				throw new Error("already gone")
			}),
		})
		manager.registerBackgroundTask(asTask(task))

		await expect(manager.pauseManagedTask("t-1")).resolves.toBeUndefined()
		await expect(manager.stopManagedTask("t-1")).resolves.toBeUndefined()
	})

	it("pause and stop work on a managed row with no live instance", async () => {
		const { manager } = restoredManager()
		await manager.restoreManagedTasks([{ id: "t-1", ts: 1, task: "t" } as HistoryItem])

		await manager.pauseManagedTask("t-1")

		expect(manager.getTaskState("t-1")).toEqual({ lifecycle: "paused" })
	})
})

describe("queries", () => {
	it("countActiveTasks counts running and waiting only", async () => {
		const { manager } = restoredManager()
		await manager.restoreManagedTasks([
			{ id: "a", ts: 1, task: "a", taskState: { lifecycle: "completed" } } as HistoryItem,
			{ id: "b", ts: 1, task: "b" } as HistoryItem,
		])
		manager.setState("b", { lifecycle: "waiting" })

		expect(manager.countActiveTasks()).toBe(1)
	})

	it("getActiveManagedTasks counts only tasks with a LIVE instance", async () => {
		const { manager } = restoredManager()
		await manager.restoreManagedTasks([{ id: "persisted-only", ts: 1, task: "t" } as HistoryItem])
		manager.registerBackgroundTask(asTask(makeTask("live")))

		expect(manager.getActiveManagedTasks().map((m) => m.id)).toEqual(["live"])
	})

	it("getBackgroundTasks EXCLUDES the focused task", async () => {
		const { manager } = restoredManager()
		manager.registerBackgroundTask(asTask(makeTask("a")))
		manager.registerBackgroundTask(asTask(makeTask("b")))
		await manager.focusTask("a")

		expect(manager.getBackgroundTasks().map((m) => m.id)).toEqual(["b"])
	})

	it("getManagedTasks sorts most-recently-active first", async () => {
		const { manager } = restoredManager()
		await manager.restoreManagedTasks([
			{ id: "old", ts: 1, lastActiveTs: 1_000, task: "t" } as HistoryItem,
			{ id: "new", ts: 1, lastActiveTs: 2_000, task: "t" } as HistoryItem,
		])

		expect(manager.getManagedTasks().map((m) => m.id)).toEqual(["new", "old"])
	})

	it("answers undefined for a task nobody registered", () => {
		const { manager } = restoredManager()

		expect(manager.getTaskState("ghost")).toBeUndefined()
		expect(manager.getManagedTask("ghost")).toBeUndefined()
		expect(manager.getManagedTaskInstance("ghost")).toBeUndefined()
	})
})

describe("active-time accounting", () => {
	it("a plain QUERY never advances the stored clock", () => {
		vi.useFakeTimers()
		const { manager } = restoredManager()
		manager.registerBackgroundTask(asTask(makeTask("t-1")))

		vi.advanceTimersByTime(5_000)
		const live = manager.getManagedTasks()[0].activeTimeMs
		const stored = manager.getManagedTask("t-1")!.activeTimeMs

		expect(live).toBeGreaterThanOrEqual(5_000)
		expect(stored).toBe(0)
		vi.useRealTimers()
	})

	it("ACCUMULATES the interval when the task leaves an active lifecycle", () => {
		vi.useFakeTimers()
		const { manager } = restoredManager()
		manager.registerBackgroundTask(asTask(makeTask("t-1")))

		vi.advanceTimersByTime(3_000)
		manager.setState("t-1", { lifecycle: "idle" })

		expect(manager.getManagedTask("t-1")!.activeTimeMs).toBeGreaterThanOrEqual(3_000)
		vi.useRealTimers()
	})

	it("does NOT accrue time while idle", () => {
		vi.useFakeTimers()
		const { manager } = restoredManager()
		manager.registerBackgroundTask(asTask(makeTask("t-1", { abort: true })))

		vi.advanceTimersByTime(5_000)

		expect(manager.getManagedTasks()[0].activeTimeMs).toBe(0)
		vi.useRealTimers()
	})
})

describe("setState — the single writer", () => {
	it("ignores a task it does not manage", () => {
		const { manager, updateTaskHistory } = restoredManager()

		manager.setState("ghost", { lifecycle: "running" })

		expect(updateTaskHistory).not.toHaveBeenCalled()
	})

	it("is a NO-OP for an unchanged state — no event, no write", async () => {
		const { manager, updateTaskHistory } = restoredManager({ "t-1": { id: "t-1" } as HistoryItem })
		manager.registerBackgroundTask(asTask(makeTask("t-1")))
		const changes: unknown[] = []
		manager.on("managedTask:state-changed", (...args) => changes.push(args))

		manager.setState("t-1", { lifecycle: "running" })
		await manager.waitForPendingPersist("t-1")

		expect(changes).toEqual([])
		expect(updateTaskHistory).not.toHaveBeenCalled()
	})

	it("PERSISTS the new state, carrying the live active time", async () => {
		const { manager, updateTaskHistory } = restoredManager({ "t-1": { id: "t-1" } as HistoryItem })
		manager.registerBackgroundTask(asTask(makeTask("t-1")))

		manager.setState("t-1", { lifecycle: "completed", rating: "well" })
		await manager.waitForPendingPersist("t-1")

		expect(updateTaskHistory).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "t-1",
				taskState: { lifecycle: "completed", rating: "well" },
				activeTimeMs: expect.any(Number),
			}),
		)
	})

	it("writes NOTHING when the store has no row for the task", async () => {
		const { manager, updateTaskHistory } = restoredManager()
		manager.registerBackgroundTask(asTask(makeTask("t-1")))

		manager.setState("t-1", { lifecycle: "idle" })
		await manager.waitForPendingPersist("t-1")

		expect(updateTaskHistory).not.toHaveBeenCalled()
	})

	it("writes NOTHING when the persisted state already matches", async () => {
		const { manager, updateTaskHistory } = restoredManager({
			"t-1": { id: "t-1", taskState: { lifecycle: "idle" } } as HistoryItem,
		})
		manager.registerBackgroundTask(asTask(makeTask("t-1")))

		manager.setState("t-1", { lifecycle: "idle" })
		await manager.waitForPendingPersist("t-1")

		expect(updateTaskHistory).not.toHaveBeenCalled()
	})

	it("DROPS a stale write — the last state set is the one that reaches disk", async () => {
		const { manager, updateTaskHistory } = restoredManager({ "t-1": { id: "t-1" } as HistoryItem })
		manager.registerBackgroundTask(asTask(makeTask("t-1")))

		manager.setState("t-1", { lifecycle: "completed", rating: "well" })
		manager.setState("t-1", { lifecycle: "running" })
		await manager.waitForPendingPersist("t-1")

		const written = updateTaskHistory.mock.calls.map(([item]) => (item as HistoryItem).taskState)
		expect(written).toEqual([{ lifecycle: "running" }])
	})

	it("SURVIVES a failing persist rather than rejecting into the caller", async () => {
		const { provider, store } = makeProvider({ "t-1": { id: "t-1" } as HistoryItem })
		;(provider as unknown as { updateTaskHistory: () => Promise<never> }).updateTaskHistory = async () => {
			throw new Error("disk full")
		}
		void store
		const manager = new TaskManager(provider)
		manager.ensureRestored()
		manager.registerBackgroundTask(asTask(makeTask("t-1")))

		manager.setState("t-1", { lifecycle: "idle" })

		await expect(manager.waitForPendingPersist("t-1")).resolves.toBeUndefined()
	})

	it("waitForPendingPersist is a no-op when nothing is in flight", async () => {
		const { manager } = restoredManager()

		await expect(manager.waitForPendingPersist("t-1")).resolves.toBeUndefined()
	})

	it("drops the rating when the lifecycle is not `completed`", () => {
		const { manager } = restoredManager()
		manager.registerBackgroundTask(asTask(makeTask("t-1")))

		manager.setState("t-1", { lifecycle: "error", rating: "poor" } as TaskState)

		expect(manager.getTaskState("t-1")).toEqual({ lifecycle: "error", rating: "poor" })
	})
})

describe("rename, delete and dispose", () => {
	it("renameManagedTask renames a known task and ignores an unknown one", () => {
		const { manager } = restoredManager()
		manager.registerBackgroundTask(asTask(makeTask("t-1")))

		manager.renameManagedTask("t-1", "New name")
		expect(manager.getManagedTask("t-1")!.name).toBe("New name")

		expect(() => manager.renameManagedTask("ghost", "x")).not.toThrow()
	})

	it("deleteManagedTask aborts the instance, forgets the row and drops its notifications", async () => {
		const { manager } = restoredManager()
		const task = makeTask("t-1")
		manager.registerBackgroundTask(asTask(task))
		;(task as unknown as { emitEvent: (e: string, ...a: unknown[]) => void }).emitEvent("taskAskResponded")

		await manager.deleteManagedTask("t-1")

		expect(task.abortTask).toHaveBeenCalledWith(true)
		expect(manager.getManagedTask("t-1")).toBeUndefined()
		expect(manager.getNotifications()).toEqual([])
	})

	it("deleteManagedTask survives an abort that throws, and a task with no instance", async () => {
		const { manager } = restoredManager()
		manager.registerBackgroundTask(
			asTask(
				makeTask("t-1", {
					abortTask: vi.fn(async () => {
						throw new Error("gone")
					}),
				}),
			),
		)

		await expect(manager.deleteManagedTask("t-1")).resolves.toBeUndefined()
		await expect(manager.deleteManagedTask("never-existed")).resolves.toBeUndefined()
	})

	it("updateTaskInstance swaps the live instance, and ignores an unmanaged id", () => {
		const { manager } = restoredManager()
		manager.registerBackgroundTask(asTask(makeTask("t-1")))
		const replacement = makeTask("t-1")

		manager.updateTaskInstance("t-1", asTask(replacement))
		expect(manager.getManagedTaskInstance("t-1")).toBe(replacement)

		manager.updateTaskInstance("ghost", asTask(makeTask("ghost")))
		expect(manager.getManagedTaskInstance("ghost")).toBeUndefined()
	})

	it("removeManagedTaskInstance drops the instance but KEEPS the managed row", () => {
		const { manager } = restoredManager()
		manager.registerBackgroundTask(asTask(makeTask("t-1")))

		manager.removeManagedTaskInstance("t-1")

		expect(manager.getManagedTaskInstance("t-1")).toBeUndefined()
		expect(manager.getManagedTask("t-1")).toBeDefined()
	})

	it("dispose aborts every instance and empties the manager", async () => {
		const { manager } = restoredManager()
		const a = makeTask("a")
		const b = makeTask("b")
		manager.registerBackgroundTask(asTask(a))
		manager.registerBackgroundTask(asTask(b))
		await manager.focusTask("a")

		await manager.dispose()

		expect(a.abortTask).toHaveBeenCalledWith(true)
		expect(b.abortTask).toHaveBeenCalledWith(true)
		expect(manager.getManagedTasks()).toEqual([])
		expect(manager.getFocusedTaskId()).toBeNull()
	})
})

describe("notifications", () => {
	it("hands out a COPY so a caller cannot mutate the manager's list", () => {
		const { manager } = restoredManager()

		const notifications = manager.getNotifications()
		notifications.push({ targetTaskId: "x" } as never)

		expect(manager.getNotifications()).toEqual([])
	})

	it("clearTaskNotification removes only the named task's entries", () => {
		const { manager } = restoredManager()
		const a = makeTask("a")
		const b = makeTask("b")
		manager.registerBackgroundTask(asTask(a))
		manager.registerBackgroundTask(asTask(b))
		;(a as unknown as { emitEvent: (e: string, ...x: unknown[]) => void }).emitEvent("taskAskResponded")
		;(b as unknown as { emitEvent: (e: string, ...x: unknown[]) => void }).emitEvent("taskAskResponded")

		manager.clearTaskNotification("a")

		expect(manager.getNotifications().every((n) => n.targetTaskId !== "a")).toBe(true)
	})
})

describe("managedTaskToHistoryItem", () => {
	it("projects the managed row onto a HistoryItem, carrying the state and the name", () => {
		const { manager } = restoredManager()
		manager.registerBackgroundTask(asTask(makeTask("t-1")), "Named")
		const managed = manager.getManagedTask("t-1")!

		const item = manager.managedTaskToHistoryItem(managed, "the task", 10, 20, 0.5)

		expect(item).toMatchObject({
			id: "t-1",
			task: "the task",
			tokensIn: 10,
			tokensOut: 20,
			totalCost: 0.5,
			workspace: "/w",
			name: "Named",
			taskState: { lifecycle: "running" },
		})
	})
})

/**
 * The per-task event listeners the manager installs when a task is registered.
 * They are the ONLY thing that moves a background task's lifecycle, so a missing
 * or mis-scoped listener shows up as a task stuck in the state it started in —
 * with nothing logged.
 *
 * Two rules run through them:
 *
 *  - **Every listener is scoped to ITS task.** The events carry a task id and
 *    the manager installs one listener set per task; an unscoped handler moves
 *    the wrong row when a sibling emits.
 *  - **An abort never DOWNGRADES a terminal state.** A parent completing calls
 *    `abortTask(false)` on every child, including ones that already completed;
 *    mapping that abort to `paused` would show a finished task as paused.
 */
describe("the managed-task event listeners", () => {
	/** A registered background task, plus the double that emits its events. */
	function registered(taskId = "t-1", extra: Record<string, unknown> = {}) {
		const { manager, ...fixture } = restoredManager()
		const task = makeTask(taskId, extra)
		manager.registerBackgroundTask(asTask(task))
		return { manager, task, ...fixture }
	}

	const lifecycleOf = (manager: TaskManager, id: string) => manager.getTaskState(id)?.lifecycle

	it("moves a started task to running", () => {
		const { manager, task } = registered()

		task.emitEvent(ShoferEventName.TaskStarted)

		expect(lifecycleOf(manager, "t-1")).toBe("running")
	})

	it("parks an interactive task in waiting_input and raises a notification", () => {
		const { manager, task } = registered()

		task.emitEvent(ShoferEventName.TaskInteractive, "t-1")

		expect(lifecycleOf(manager, "t-1")).toBe("waiting_input")
		expect(manager.getNotifications().map((n) => n.type)).toContain("needs_input")
	})

	it("does NOT notify for a question the child FORWARDED to its parent", () => {
		const { manager, task } = registered("child", { parentTaskId: "parent", forwardedQuestion: {} })

		task.emitEvent(ShoferEventName.TaskInteractive, "child")

		// The parent is the audience — it answers with `reply` — so interrupting
		// the human would be asking someone who is not being waited on.
		expect(lifecycleOf(manager, "child")).toBe("waiting_input")
		expect(manager.getNotifications()).toEqual([])
	})

	it("does not notify about the task the user is already looking at", async () => {
		const { manager, task } = registered()
		await manager.focusTask("t-1")

		task.emitEvent(ShoferEventName.TaskInteractive, "t-1")

		expect(manager.getNotifications()).toEqual([])
	})

	it("IGNORES an event carrying a different task's id", () => {
		const { manager, task } = registered()
		task.emitEvent(ShoferEventName.TaskStarted)

		task.emitEvent(ShoferEventName.TaskIdle, "someone-else")

		expect(lifecycleOf(manager, "t-1")).toBe("running")
	})

	it("maps active → running and idle → idle", () => {
		const { manager, task } = registered()

		task.emitEvent(ShoferEventName.TaskIdle, "t-1")
		expect(lifecycleOf(manager, "t-1")).toBe("idle")

		task.emitEvent(ShoferEventName.TaskActive, "t-1")
		expect(lifecycleOf(manager, "t-1")).toBe("running")
	})

	it("records a completion WITH its rating and announces it", () => {
		const { manager, task } = registered()
		const completed = vi.fn()
		manager.on("managedTask:completed", completed)

		task.emitEvent(ShoferEventName.TaskCompleted, "t-1", {}, {}, { rating: "completed_well" })

		expect(manager.getTaskState("t-1")).toMatchObject({ lifecycle: "completed", rating: "completed_well" })
		expect(completed).toHaveBeenCalledWith("t-1")
		expect(hoisted.incTaskCompleted).toHaveBeenCalled()
	})

	it("moves an errored task to error and counts it", () => {
		const { manager, task } = registered()

		task.emitEvent(ShoferEventName.TaskError, "t-1", "provider_error")

		expect(lifecycleOf(manager, "t-1")).toBe("error")
		expect(hoisted.incTaskErrored).toHaveBeenCalled()
	})

	it("re-announces a tool failure to the manager's own listeners", () => {
		const { manager, task } = registered()
		const seen = vi.fn()
		manager.on("managedTask:tool-error", seen)

		task.emitEvent(ShoferEventName.TaskToolFailed, "t-1", "read_file", "ENOENT")

		expect(seen).toHaveBeenCalledWith("t-1", "ENOENT")
	})

	it("PAUSES a task the user aborted", () => {
		const { manager, task } = registered()
		task.emitEvent(ShoferEventName.TaskStarted)

		task.emitEvent(ShoferEventName.TaskAborted, { reason: "user" })

		expect(lifecycleOf(manager, "t-1")).toBe("paused")
	})

	it("does NOT downgrade a COMPLETED task that its parent then aborted", () => {
		const { manager, task } = registered()
		task.emitEvent(ShoferEventName.TaskCompleted, "t-1", {}, {}, { rating: "completed_well" })

		task.emitEvent(ShoferEventName.TaskAborted, { reason: "abandoned" })

		expect(lifecycleOf(manager, "t-1")).toBe("completed")
	})

	it("leaves the state alone for an abort that merely follows a terminal event", () => {
		const { manager, task } = registered()
		task.emitEvent(ShoferEventName.TaskError, "t-1", "boom")

		task.emitEvent(ShoferEventName.TaskAborted, { reason: "error" })

		expect(lifecycleOf(manager, "t-1")).toBe("error")
	})
})
