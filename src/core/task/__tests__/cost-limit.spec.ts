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
import type { HistoryItem, ModelInfo } from "@shofer/types"

import { aggregateTaskCostsRecursive } from "../../webview/aggregateTaskCosts"
import { calculateApiCostAnthropic, calculateApiCostOpenAI } from "../../../shared/cost"

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

/**
 * In-flight gate fallback contract.
 *
 * `Task.estimateRequestCostUsd` feeds `checkInFlightCostLimit` a local-pricing
 * estimate whenever the backend doesn't stamp `totalCost` on its usage chunk
 * (openai.ts, bedrock.ts, deepseek.ts, raw OpenAI-compatible endpoints). The
 * method is a thin protocol-aware wrapper over `calculateApiCost{Anthropic,
 * OpenAI}` — these tests lock the two properties the gate relies on:
 *
 *   1. A PRICED model yields a positive estimate, so the tight in-stream cap
 *      can fire mid-stream for backends that don't self-report cost.
 *   2. An UNPRICED model yields exactly 0, so the gate stays a no-op — by
 *      design we only ever cap real, priced spend (never block on a model we
 *      can't price).
 */
describe("in-flight gate local-pricing fallback (estimateRequestCostUsd math)", () => {
	const priced: ModelInfo = {
		maxTokens: 8192,
		contextWindow: 200_000,
		supportsPromptCache: true,
		inputPrice: 3.0, // USD / 1M
		outputPrice: 15.0,
		cacheWritesPrice: 3.75,
		cacheReadsPrice: 0.3,
	} as ModelInfo

	const unpriced: ModelInfo = {
		maxTokens: 8192,
		contextWindow: 128_000,
		supportsPromptCache: false,
	} as ModelInfo

	it("yields a positive estimate for a priced model (OpenAI protocol) so the gate can fire", () => {
		const { totalCost } = calculateApiCostOpenAI(priced, 10_000, 2_000, 0, 0)
		// 10k input @ $3/1M + 2k output @ $15/1M = 0.03 + 0.03
		expect(totalCost).toBeCloseTo(0.06, 6)
		expect(totalCost).toBeGreaterThan(0)
	})

	it("yields a positive estimate for a priced model (Anthropic protocol)", () => {
		const { totalCost } = calculateApiCostAnthropic(priced, 10_000, 2_000, 0, 0)
		expect(totalCost).toBeCloseTo(0.06, 6)
		expect(totalCost).toBeGreaterThan(0)
	})

	it("yields exactly 0 for an unpriced model so the gate stays a no-op", () => {
		expect(calculateApiCostOpenAI(unpriced, 10_000, 2_000, 0, 0).totalCost).toBe(0)
		expect(calculateApiCostAnthropic(unpriced, 10_000, 2_000, 0, 0).totalCost).toBe(0)
	})

	it("accumulates cache-read/write tokens into the estimate", () => {
		const { totalCost } = calculateApiCostOpenAI(priced, 10_000, 2_000, 1_000, 5_000)
		// non-cached input 10k-1k-5k=4k @ $3/1M, 1k cache-write @ $3.75/1M,
		// 5k cache-read @ $0.3/1M, 2k output @ $15/1M
		const expected = (4_000 * 3.0 + 1_000 * 3.75 + 5_000 * 0.3 + 2_000 * 15.0) / 1_000_000
		expect(totalCost).toBeCloseTo(expected, 9)
	})
})
