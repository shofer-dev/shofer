import type { HistoryItem } from "@shofer/types"
import { webviewLog } from "../../utils/logging/subsystems"

export interface AggregatedCosts {
	ownCost: number // This task's own API costs
	childrenCost: number // Sum of all direct children costs (recursive)
	totalCost: number // ownCost + childrenCost
	// Token totals across the whole subtree (own + all descendants). The
	// WorkflowTask root makes no LLM calls of its own, so its header relies on
	// these to show the tree's real token usage.
	tokensIn: number
	tokensOut: number
	childBreakdown?: {
		// Optional detailed breakdown
		[childId: string]: AggregatedCosts
	}
}

/**
 * Recursively aggregate costs for a task and all its subtasks.
 *
 * @param taskId - The task ID to aggregate costs for
 * @param getTaskHistory - Function to load HistoryItem by task ID
 * @param visited - Set to prevent circular references
 * @returns Aggregated cost information
 */
export async function aggregateTaskCostsRecursive(
	taskId: string,
	getTaskHistory: (id: string) => Promise<HistoryItem | undefined>,
	visited: Set<string> = new Set(),
): Promise<AggregatedCosts> {
	// Prevent infinite loops
	if (visited.has(taskId)) {
		webviewLog.warn(`[aggregateTaskCostsRecursive] Circular reference detected: ${taskId}`)
		return { ownCost: 0, childrenCost: 0, totalCost: 0, tokensIn: 0, tokensOut: 0 }
	}
	visited.add(taskId)

	// Load this task's history
	const history = await getTaskHistory(taskId)
	if (!history) {
		webviewLog.warn(`[aggregateTaskCostsRecursive] Task ${taskId} not found`)
		return { ownCost: 0, childrenCost: 0, totalCost: 0, tokensIn: 0, tokensOut: 0 }
	}

	const ownCost = history.totalCost || 0
	let childrenCost = 0
	// Token totals start with this task's own usage, then accumulate descendants.
	let tokensIn = history.tokensIn || 0
	let tokensOut = history.tokensOut || 0
	const childBreakdown: { [childId: string]: AggregatedCosts } = {}

	// Recursively aggregate child costs + tokens
	if (history.childIds && history.childIds.length > 0) {
		for (const childId of history.childIds) {
			const childAggregated = await aggregateTaskCostsRecursive(
				childId,
				getTaskHistory,
				new Set(visited), // Create new Set to allow sibling traversal
			)
			childrenCost += childAggregated.totalCost
			tokensIn += childAggregated.tokensIn
			tokensOut += childAggregated.tokensOut
			childBreakdown[childId] = childAggregated
		}
	}

	const result: AggregatedCosts = {
		ownCost,
		childrenCost,
		totalCost: ownCost + childrenCost,
		tokensIn,
		tokensOut,
		childBreakdown,
	}

	return result
}
