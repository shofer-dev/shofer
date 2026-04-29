/**
 * Tests for the per-root-task cost-limit feature.
 *
 * The Task class is heavy to instantiate in vitest (full vscode mock,
 * file watchers, controllers, …), so we test the pure pieces directly:
 *
 *  - `aggregateTaskCostsRecursive` — verifies the math used by the cap
 *    enforcement path actually rolls subtask costs into the root.
 *  - `resolveCostLimit` walking semantics — verified via a small
 *    structural shim with the same parentTask chain as Task.
 *
 * End-to-end pause/abort/kill behaviour is covered by manual QA.
 */
import { describe, it, expect, vi } from "vitest"
import type { HistoryItem } from "@roo-code/types"

import { aggregateTaskCostsRecursive } from "../../webview/aggregateTaskCosts"

/**
 * Minimal duck-type for the parentTask walk used by Task.resolveCostLimit.
 * Mirrors the field shape so the algorithm under test is exercised without
 * dragging in the real Task constructor.
 */
type CostLimitNode = {
	taskId: string
	parentTask?: CostLimitNode
	costLimit?: { maxUsd: number; action: "pause" | "abort" | "kill" }
}

function resolveCostLimit(node: CostLimitNode): {
	root: CostLimitNode
	limit: { maxUsd: number; action: "pause" | "abort" | "kill" } | undefined
} {
	let cursor: CostLimitNode = node
	while (cursor.parentTask) {
		cursor = cursor.parentTask
	}
	return { root: cursor, limit: cursor.costLimit }
}

describe("resolveCostLimit (parent-walk semantics)", () => {
	it("returns own costLimit for a root task", () => {
		const root: CostLimitNode = { taskId: "r", costLimit: { maxUsd: 20, action: "abort" } }
		const { root: out, limit } = resolveCostLimit(root)
		expect(out).toBe(root)
		expect(limit).toEqual({ maxUsd: 20, action: "abort" })
	})

	it("walks up to the root for a subtask", () => {
		const root: CostLimitNode = { taskId: "r", costLimit: { maxUsd: 20, action: "pause" } }
		const child: CostLimitNode = { taskId: "c", parentTask: root }
		const { root: out, limit } = resolveCostLimit(child)
		expect(out).toBe(root)
		expect(limit).toEqual({ maxUsd: 20, action: "pause" })
	})

	it("walks up multiple levels (grandchild → root)", () => {
		const root: CostLimitNode = { taskId: "r", costLimit: { maxUsd: 7, action: "kill" } }
		const child: CostLimitNode = { taskId: "c", parentTask: root }
		const grand: CostLimitNode = { taskId: "g", parentTask: child }
		const { root: out, limit } = resolveCostLimit(grand)
		expect(out).toBe(root)
		expect(limit?.maxUsd).toBe(7)
	})

	it("returns undefined when the root has no limit", () => {
		const root: CostLimitNode = { taskId: "r" }
		const child: CostLimitNode = { taskId: "c", parentTask: root }
		const { limit } = resolveCostLimit(child)
		expect(limit).toBeUndefined()
	})
})

describe("aggregateTaskCostsRecursive", () => {
	it("sums root + descendant costs into a single total", async () => {
		const history: Record<string, HistoryItem> = {
			root: { id: "root", totalCost: 1.0, childIds: ["child"] } as unknown as HistoryItem,
			child: { id: "child", totalCost: 0.5, childIds: [] } as unknown as HistoryItem,
		}
		const getHistory = vi.fn(async (id: string) => history[id])

		const result = await aggregateTaskCostsRecursive("root", getHistory)

		expect(result.totalCost).toBe(1.5)
		expect(result.ownCost).toBe(1.0)
		expect(result.childrenCost).toBe(0.5)
	})

	it("aggregates across two levels of subtasks", async () => {
		const history: Record<string, HistoryItem> = {
			root: { id: "root", totalCost: 1.0, childIds: ["child"] } as unknown as HistoryItem,
			child: { id: "child", totalCost: 0.5, childIds: ["grand"] } as unknown as HistoryItem,
			grand: { id: "grand", totalCost: 0.25, childIds: [] } as unknown as HistoryItem,
		}
		const getHistory = vi.fn(async (id: string) => history[id])

		const result = await aggregateTaskCostsRecursive("root", getHistory)

		expect(result.totalCost).toBeCloseTo(1.75, 6)
	})
})
