// npx vitest run services/task-manager/__tests__/TaskManager.persistence.spec.ts

import { describe, it, expect, vi, beforeEach } from "vitest"

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
})
