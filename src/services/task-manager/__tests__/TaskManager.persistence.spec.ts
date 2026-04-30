// npx vitest run services/task-manager/__tests__/TaskManager.persistence.spec.ts

import { describe, it, expect, vi, beforeEach } from "vitest"

import type { HistoryItem } from "@roo-code/types"

import { TaskManager } from "../TaskManager"

/**
 * Tests for the persistence behaviour added in the task-state-restart fix:
 *
 *   1. `updateTaskExecutionState` writes the new state through to HistoryItem
 *      so the icon survives a code-server / extension restart.
 *   2. `restoreManagedTasks` sanitizes stale "running" / "waiting_input" states
 *      (no live Task instance can exist after a restart).
 *   3. A successfully completed task (status === "completed") is restored as
 *      `"idle"` so the green check from `item.status` wins in the UI's state
 *      resolution chain.
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

	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe("updateTaskExecutionState persistence", () => {
		it("writes the new execution state through to the HistoryItem", async () => {
			const initial = makeHistoryItem({ taskExecutionState: "running" })
			const { manager, updateTaskHistory, store } = buildManager(initial)

			// Seed an in-memory managed task whose initial state matches history
			;(manager as any).managedTasks.set(initial.id, {
				id: initial.id,
				name: "test",
				taskId: initial.id,
				workspace: "",
				createdAt: initial.ts,
				lastActiveAt: initial.ts,
				state: "running",
			})

			manager.updateTaskExecutionState(initial.id, "idle")

			// Allow the fire-and-forget persistence promise to resolve
			await new Promise((r) => setImmediate(r))

			expect(updateTaskHistory).toHaveBeenCalledTimes(1)
			expect(updateTaskHistory.mock.calls[0][0]).toEqual(
				expect.objectContaining({ id: initial.id, taskExecutionState: "idle" }),
			)
			expect(store.get(initial.id)?.taskExecutionState).toBe("idle")
		})

		it("does not write when the persisted state already matches", async () => {
			const initial = makeHistoryItem({ taskExecutionState: "idle" })
			const { manager, updateTaskHistory } = buildManager(initial)
			;(manager as any).managedTasks.set(initial.id, {
				id: initial.id,
				name: "test",
				taskId: initial.id,
				workspace: "",
				createdAt: initial.ts,
				lastActiveAt: initial.ts,
				state: "running", // in-memory differs but persisted matches the new state
			})

			manager.updateTaskExecutionState(initial.id, "idle")
			await new Promise((r) => setImmediate(r))

			expect(updateTaskHistory).not.toHaveBeenCalled()
		})

		it("is a no-op when the HistoryItem does not yet exist", async () => {
			const { manager, updateTaskHistory } = buildManager()
			;(manager as any).managedTasks.set("unknown", {
				id: "unknown",
				name: "x",
				taskId: "unknown",
				workspace: "",
				createdAt: 0,
				lastActiveAt: 0,
				state: "idle",
			})

			manager.updateTaskExecutionState("unknown", "running")
			await new Promise((r) => setImmediate(r))

			expect(updateTaskHistory).not.toHaveBeenCalled()
		})
	})

	describe("restoreManagedTasks sanitization", () => {
		it("downgrades stale 'running' state to 'idle' on restore", async () => {
			const { manager } = buildManager()
			await manager.restoreManagedTasks([makeHistoryItem({ id: "t-running", taskExecutionState: "running" })])
			expect(manager.getTaskExecutionState("t-running")).toBe("idle")
		})

		it("downgrades stale 'waiting_input' state to 'idle' on restore", async () => {
			const { manager } = buildManager()
			await manager.restoreManagedTasks([makeHistoryItem({ id: "t-wait", taskExecutionState: "waiting_input" })])
			expect(manager.getTaskExecutionState("t-wait")).toBe("idle")
		})

		it("preserves 'error' state on restore", async () => {
			const { manager } = buildManager()
			await manager.restoreManagedTasks([makeHistoryItem({ id: "t-err", taskExecutionState: "error" })])
			expect(manager.getTaskExecutionState("t-err")).toBe("error")
		})

		it("preserves 'paused' state on restore", async () => {
			const { manager } = buildManager()
			await manager.restoreManagedTasks([makeHistoryItem({ id: "t-pause", taskExecutionState: "paused" })])
			expect(manager.getTaskExecutionState("t-pause")).toBe("paused")
		})

		it("forces 'idle' for tasks marked status='completed' so the green check wins", async () => {
			const { manager } = buildManager()
			await manager.restoreManagedTasks([
				makeHistoryItem({
					id: "t-done",
					status: "completed",
					taskExecutionState: "running", // stale, plus status takes precedence
				}),
			])
			expect(manager.getTaskExecutionState("t-done")).toBe("idle")
		})

		it("falls back to 'idle' when no execution state was persisted", async () => {
			const { manager } = buildManager()
			await manager.restoreManagedTasks([makeHistoryItem({ id: "t-fresh" })])
			expect(manager.getTaskExecutionState("t-fresh")).toBe("idle")
		})
	})
})
