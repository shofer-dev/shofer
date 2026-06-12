// npx vitest run services/task-manager/__tests__/TaskManager.persistence.spec.ts

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import type { HistoryItem, TaskState } from "@shofer/types"
import { IDLE_TASK_STATE } from "@shofer/types"

import { TaskManager } from "../TaskManager"

/**
 * Tests for TaskManager persistence behaviour:
 *
 *  1. `setState` writes the new (lifecycle, rating) tuple through to
 *     HistoryItem so the icon survives an extension restart.
 *  2. `restoreManagedTasks` sanitizes transient lifecycles (`running`,
 *     `waiting_input`) — no live Task instance can exist after a restart.
 *  3. Terminal lifecycles (`completed`, `error`) and user-initiated `paused`
 *     survive verbatim.
 */
describe("TaskManager persistence", () => {
	function makeHistoryItem(overrides: Partial<HistoryItem>): HistoryItem {
		return {
			id: "task-1",
			number: 1,
			ts: 1_700_000_000_000,
			task: "Do the thing",
			tokensIn: 10,
			tokensOut: 20,
			totalCost: 0.001,
			...overrides,
		}
	}

	function buildManager(initial?: HistoryItem) {
		const store = new Map<string, HistoryItem>()
		if (initial) store.set(initial.id, initial)

		const updateTaskHistory = vi.fn(async (item: HistoryItem) => {
			const merged = { ...(store.get(item.id) ?? {}), ...item }
			store.set(item.id, merged)
			return [...store.values()]
		})

		const provider = {
			taskHistoryStore: { get: (id: string) => store.get(id) },
			updateTaskHistory,
		}

		const manager = new TaskManager(provider as any)
		return { manager, provider, updateTaskHistory, store }
	}

	function seedManaged(manager: TaskManager, id: string, state: TaskState) {
		;(manager as any).managedTasks.set(id, {
			id,
			name: "test",
			taskId: id,
			workspace: "",
			createdAt: 0,
			lastActiveAt: 0,
			state,
		})
	}

	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe("setState persistence", () => {
		it("writes the new state through to the HistoryItem", async () => {
			const initial = makeHistoryItem({ taskState: { lifecycle: "running" } })
			const { manager, updateTaskHistory, store } = buildManager(initial)
			await manager.restoreManagedTasks([])
			seedManaged(manager, initial.id, { lifecycle: "running" })

			manager.setState(initial.id, { lifecycle: "idle" })

			// fire-and-forget persistence promise
			await new Promise((r) => setImmediate(r))

			expect(updateTaskHistory).toHaveBeenCalledTimes(1)
			expect(updateTaskHistory.mock.calls[0][0]).toEqual(
				expect.objectContaining({ id: initial.id, taskState: { lifecycle: "idle" } }),
			)
			expect(store.get(initial.id)?.taskState).toEqual({ lifecycle: "idle" })
		})

		it("does not write when the persisted state already matches", async () => {
			const initial = makeHistoryItem({ taskState: { lifecycle: "idle" } })
			const { manager, updateTaskHistory } = buildManager(initial)
			await manager.restoreManagedTasks([])
			seedManaged(manager, initial.id, { lifecycle: "running" })

			manager.setState(initial.id, { lifecycle: "idle" })
			await new Promise((r) => setImmediate(r))

			expect(updateTaskHistory).not.toHaveBeenCalled()
		})

		it("is a no-op when the HistoryItem does not yet exist", async () => {
			const { manager, updateTaskHistory } = buildManager()
			await manager.restoreManagedTasks([])
			seedManaged(manager, "unknown", { lifecycle: "idle" })

			manager.setState("unknown", { lifecycle: "running" })
			await new Promise((r) => setImmediate(r))

			expect(updateTaskHistory).not.toHaveBeenCalled()
		})

		it("persists the rating component for completed states", async () => {
			const initial = makeHistoryItem({ taskState: { lifecycle: "running" } })
			const { manager, store } = buildManager(initial)
			await manager.restoreManagedTasks([])
			seedManaged(manager, initial.id, { lifecycle: "running" })

			manager.setState(initial.id, { lifecycle: "completed", rating: "excellent" })
			await new Promise((r) => setImmediate(r))

			expect(store.get(initial.id)?.taskState).toEqual({
				lifecycle: "completed",
				rating: "excellent",
			})
		})
	})

	describe("restoreManagedTasks sanitization", () => {
		it("downgrades stale 'running' lifecycle to idle on restore", async () => {
			const { manager } = buildManager()
			await manager.restoreManagedTasks([
				makeHistoryItem({ id: "t-running", taskState: { lifecycle: "running" } }),
			])
			expect(manager.getTaskState("t-running")).toEqual(IDLE_TASK_STATE)
		})

		it("downgrades stale 'waiting_input' lifecycle to idle on restore", async () => {
			const { manager } = buildManager()
			await manager.restoreManagedTasks([
				makeHistoryItem({ id: "t-wait", taskState: { lifecycle: "waiting_input" } }),
			])
			expect(manager.getTaskState("t-wait")).toEqual(IDLE_TASK_STATE)
		})

		it("preserves 'error' lifecycle on restore", async () => {
			const { manager } = buildManager()
			await manager.restoreManagedTasks([makeHistoryItem({ id: "t-err", taskState: { lifecycle: "error" } })])
			expect(manager.getTaskState("t-err")).toEqual({ lifecycle: "error" })
		})

		it("preserves 'paused' lifecycle on restore", async () => {
			const { manager } = buildManager()
			await manager.restoreManagedTasks([makeHistoryItem({ id: "t-pause", taskState: { lifecycle: "paused" } })])
			expect(manager.getTaskState("t-pause")).toEqual({ lifecycle: "paused" })
		})

		it("preserves 'completed' + 'poor' rating on restore", async () => {
			const { manager } = buildManager()
			await manager.restoreManagedTasks([
				makeHistoryItem({ id: "t-poor", taskState: { lifecycle: "completed", rating: "poor" } }),
			])
			expect(manager.getTaskState("t-poor")).toEqual({ lifecycle: "completed", rating: "poor" })
		})

		it("preserves 'completed' + 'well' rating on restore", async () => {
			const { manager } = buildManager()
			await manager.restoreManagedTasks([
				makeHistoryItem({ id: "t-well", taskState: { lifecycle: "completed", rating: "well" } }),
			])
			expect(manager.getTaskState("t-well")).toEqual({ lifecycle: "completed", rating: "well" })
		})

		it("preserves 'completed' + 'excellent' rating on restore", async () => {
			const { manager } = buildManager()
			await manager.restoreManagedTasks([
				makeHistoryItem({ id: "t-exc", taskState: { lifecycle: "completed", rating: "excellent" } }),
			])
			expect(manager.getTaskState("t-exc")).toEqual({ lifecycle: "completed", rating: "excellent" })
		})

		it("falls back to idle when no state was persisted", async () => {
			const { manager } = buildManager()
			await manager.restoreManagedTasks([makeHistoryItem({ id: "t-fresh" })])
			expect(manager.getTaskState("t-fresh")).toEqual(IDLE_TASK_STATE)
		})
	})

	describe("waitForPendingPersist", () => {
		it("resolves after the in-flight persist for the task has flushed to disk", async () => {
			const initial = makeHistoryItem({ taskState: { lifecycle: "completed", rating: "excellent" } })
			const { manager, store } = buildManager(initial)
			await manager.restoreManagedTasks([])
			seedManaged(manager, initial.id, { lifecycle: "completed", rating: "excellent" })

			manager.setState(initial.id, { lifecycle: "running" })
			await manager.waitForPendingPersist(initial.id)

			// After awaiting, the running state must be durably on disk — it must
			// NOT still carry the stale completed+rating.
			expect(store.get(initial.id)?.taskState).toEqual({ lifecycle: "running" })
		})

		it("is a no-op when there is no pending persist for the task", async () => {
			const { manager } = buildManager()
			await manager.restoreManagedTasks([])
			await expect(manager.waitForPendingPersist("nonexistent")).resolves.toBeUndefined()
		})
	})
	describe("live activeTimeMs (pure projection)", () => {
		const BASE = 1_700_000_000_000
		let nowSpy: ReturnType<typeof vi.spyOn>

		beforeEach(() => {
			nowSpy = vi.spyOn(Date, "now").mockReturnValue(BASE)
		})

		afterEach(() => {
			nowSpy.mockRestore()
		})

		function seedTimed(
			manager: TaskManager,
			id: string,
			state: TaskState,
			activeTimeMs: number,
			runningSince: number,
		) {
			;(manager as any).managedTasks.set(id, {
				id,
				name: "test",
				taskId: id,
				workspace: "",
				createdAt: 0,
				lastActiveAt: 0,
				state,
				activeTimeMs,
				_runningSince: runningSince,
			})
		}

		it("returns live time for a running task without mutating stored state", async () => {
			const { manager } = buildManager()
			await manager.restoreManagedTasks([])
			seedTimed(manager, "t-run", { lifecycle: "running" }, 1_000, BASE)

			nowSpy.mockReturnValue(BASE + 5_000)

			const snapshot = manager.getManagedTasks().find((t) => t.id === "t-run")!
			// Live value = stored 1000 + the 5000ms in-progress interval.
			expect(snapshot.activeTimeMs).toBe(6_000)

			// Purity: getManagedTasks is a query. The stored ManagedTask must be
			// untouched — the old implementation mutated these in place on every
			// read, turning an incidental read into a persistence-clock advance.
			const stored = (manager as any).managedTasks.get("t-run")
			expect(stored.activeTimeMs).toBe(1_000)
			expect(stored._runningSince).toBe(BASE)
		})

		it("is idempotent — repeated reads at the same instant do not compound", async () => {
			const { manager } = buildManager()
			await manager.restoreManagedTasks([])
			seedTimed(manager, "t-run", { lifecycle: "running" }, 0, BASE)

			nowSpy.mockReturnValue(BASE + 3_000)
			const first = manager.getManagedTasks().find((t) => t.id === "t-run")!.activeTimeMs
			const second = manager.getManagedTasks().find((t) => t.id === "t-run")!.activeTimeMs
			expect(first).toBe(3_000)
			expect(second).toBe(3_000)
		})

		it("returns stored time verbatim for non-running tasks", async () => {
			const { manager } = buildManager()
			await manager.restoreManagedTasks([])
			seedTimed(manager, "t-done", { lifecycle: "completed", rating: "well" }, 4_200, 0)

			nowSpy.mockReturnValue(BASE + 9_999)
			const snapshot = manager.getManagedTasks().find((t) => t.id === "t-done")!
			expect(snapshot.activeTimeMs).toBe(4_200)
		})

		it("persists the live active time when a running task transitions out", async () => {
			const initial = makeHistoryItem({ id: "t-persist", taskState: { lifecycle: "running" } })
			const { manager, store } = buildManager(initial)
			await manager.restoreManagedTasks([])
			seedTimed(manager, "t-persist", { lifecycle: "running" }, 1_000, BASE)

			nowSpy.mockReturnValue(BASE + 2_000)
			manager.setState("t-persist", { lifecycle: "completed", rating: "well" })

			// fire-and-forget persistence promise
			await new Promise((r) => setImmediate(r))

			// 1000 stored + the 2000ms in-progress interval folded in on leaving running.
			expect(store.get("t-persist")?.activeTimeMs).toBe(3_000)
		})
	})

	it("seeds managedTasks after ensureRestored (restored/seeded flag split)", async () => {
		const { manager } = buildManager()

		// Simulate the ShoferProvider constructor: ensureRestored() is called
		// synchronously so early-bird registerBackgroundTask calls don't throw.
		manager.ensureRestored()

		// Later, initializeTaskHistoryStore settles and calls
		// restoreManagedTasks with real persisted history.  This MUST
		// actually seed — the seeded flag is separate from restored.
		await manager.restoreManagedTasks([
			makeHistoryItem({ id: "t-restored", taskState: { lifecycle: "completed", rating: "excellent" } }),
		])

		expect(manager.getTaskState("t-restored")).toEqual({
			lifecycle: "completed",
			rating: "excellent",
		})
	})
})
