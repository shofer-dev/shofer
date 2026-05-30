/**
 * Incremental Message Processing
 *
 * Eliminates the O(n²) per-task slowdown that makes a single long task get
 * progressively slower as it grows. The webview re-computes
 * `combineApiRequests(combineCommandSequences(messages))` and
 * `getApiMetrics(modifiedMessages)` over the entire message array on every
 * streamed chunk. This module makes those updates incremental:
 *
 * - Track a cached, reference-stable prefix of already-consolidated messages.
 * - Only re-consolidate the bounded tail (messages since the last safe split
 *   point).
 * - Produce byte-identical output to the existing full-pass pipeline (modulo
 *   floating-point addition order for totalCost).
 *
 * @module incrementalMessageProcessing
 */

import type { ShoferMessage, TokenUsage } from "@shofer/types"
import { combineApiRequests } from "@shofer/shared/combineApiRequests"
import { combineCommandSequences } from "@shofer/shared/combineCommandSequences"
import { getApiMetrics } from "@shofer/shared/getApiMetrics"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProcessedMessages {
	modifiedMessages: ShoferMessage[]
	apiMetrics: TokenUsage
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns the number of leading elements that are reference-identical (`===`)
 * between two arrays.
 */
function commonReferencePrefixLength<T>(a: T[], b: T[]): number {
	let i = 0
	const minLen = Math.min(a.length, b.length)
	while (i < minLen && a[i] === b[i]) {
		i++
	}
	return i
}

/**
 * Open-head sentinel — a reach value that means "this head has no upper bound
 * yet" (command / use_mcp_server not closed by the end of the array, or
 * unmatched api_req_started).  Must never collide with a valid array index.
 */
const OPEN_REACH = Infinity

/**
 * Compute the "reach" of every consolidation head in the messages array.
 *
 * reach[i] is the **last index** that the head at position i absorbs or
 * resolves at:
 *  - For `command` asks: the last `command_output` before the next `command`.
 *  - For `use_mcp_server` asks: the last `mcp_server_response` before the
 *    next `use_mcp_server`.
 *  - For `api_req_started` says: the index of the matching `api_req_finished`
 *    (LIFO pairing).
 *  - For all other messages: i (they only affect themselves).
 *
 * Open heads get `OPEN_REACH` (Infinity), meaning "no split after this head
 * is ever safe."
 *
 * @param msgs - The sliced messages array (without the task header).
 * @returns An array of the same length where reach[i] is the last index
 *          affected by the consolidation head at i.
 */
function computeReach(msgs: ShoferMessage[]): number[] {
	const n = msgs.length
	const reach = new Array<number>(n)

	// Initialize: each message reaches at least itself.
	for (let i = 0; i < n; i++) {
		reach[i] = i
	}

	// --- Command reaches (forward scan) ---
	for (let i = 0; i < n; i++) {
		const msg = msgs[i]
		if (!msg) continue

		if (msg.type === "ask" && msg.ask === "command") {
			let lastAbsorbed = i
			let closed = false

			for (let j = i + 1; j < n; j++) {
				const next = msgs[j]
				if (!next) continue
				if (next.type === "ask" && next.ask === "command") {
					closed = true
					break
				}
				if (next.ask === "command_output" || next.say === "command_output") {
					lastAbsorbed = j
				}
			}

			reach[i] = closed ? lastAbsorbed : OPEN_REACH
		}
	}

	// --- MCP server reaches (forward scan) ---
	for (let i = 0; i < n; i++) {
		const msg = msgs[i]
		if (!msg) continue

		if (msg.type === "ask" && msg.ask === "use_mcp_server") {
			let lastAbsorbed = i
			let closed = false

			for (let j = i + 1; j < n; j++) {
				const next = msgs[j]
				if (!next) continue
				if (next.type === "ask" && next.ask === "use_mcp_server") {
					closed = true
					break
				}
				if (next.say === "mcp_server_response") {
					lastAbsorbed = j
				}
			}

			reach[i] = closed ? lastAbsorbed : OPEN_REACH
		}
	}

	// --- API reaches (LIFO stack) ---
	const startedIndices: number[] = []
	for (let i = 0; i < n; i++) {
		const msg = msgs[i]
		if (!msg) continue

		if (msg.type === "say" && msg.say === "api_req_started") {
			startedIndices.push(i)
		} else if (msg.type === "say" && msg.say === "api_req_finished") {
			const startIdx = startedIndices.pop()
			if (startIdx !== undefined) {
				reach[startIdx] = i
			}
		}
	}

	// Remaining unmatched api_req_started are open.
	for (const idx of startedIndices) {
		reach[idx] = OPEN_REACH
	}

	return reach
}

/**
 * Find the largest safe split index B ≥ startFrom.
 *
 * A split at B is safe iff every consolidation head at index < B resolves
 * strictly before B (`reach[i] < B`).  This guarantees
 * `consolidate(msgs) === consolidate(msgs[0:B]) ++ consolidate(msgs[B:])`.
 *
 * Open heads carry `reach = OPEN_REACH` (Infinity): their group can still grow
 * as new messages append, so no split past an open head is ever safe and such
 * a head must never be frozen into the prefix.  Scanning therefore stops at the
 * first open head, leaving it (and everything after it) in the re-consolidated
 * suffix.
 *
 * Single forward pass, O(n): `runningMax` is maintained as `max(reach[0..B-1])`
 * so each boundary check is O(1).
 *
 * @param reach - Pre-computed reach array from {@link computeReach}.
 * @param startFrom - A boundary the caller already knows to be safe (the
 *                    current cached split, or 0).  The result is ≥ startFrom.
 * @param n - The length of msgs.
 * @returns The largest safe split index in [startFrom, n].
 */
function findSafeSplitIndex(reach: number[], startFrom: number, n: number): number {
	// runningMax = max(reach[0..B-1]); seed it with the heads before startFrom.
	let runningMax = -1
	for (let i = 0; i < startFrom; i++) {
		runningMax = Math.max(runningMax, reach[i]!)
	}

	let best = startFrom // caller guarantees startFrom is safe
	for (let B = startFrom; B < n; B++) {
		// Fold in the head at B, so runningMax now covers reach[0..B].
		runningMax = Math.max(runningMax, reach[B]!)

		// An open head bounds the prefix: no larger boundary can be safe.
		if (runningMax === OPEN_REACH) {
			break
		}

		// Boundary B+1 is safe iff every head in [0..B] resolves before it.
		if (runningMax < B + 1) {
			best = B + 1
		}
	}

	return best
}

/**
 * Combine prefix and suffix metrics.
 *
 * All numeric fields except `contextTokens` are additive.
 * `contextTokens` uses the suffix value if non-zero, otherwise falls back
 * to the prefix value.
 */
function foldMetrics(prefix: TokenUsage, suffix: TokenUsage): TokenUsage {
	return {
		totalTokensIn: prefix.totalTokensIn + suffix.totalTokensIn,
		totalTokensOut: prefix.totalTokensOut + suffix.totalTokensOut,
		totalCacheWrites:
			prefix.totalCacheWrites === undefined && suffix.totalCacheWrites === undefined
				? undefined
				: (prefix.totalCacheWrites ?? 0) + (suffix.totalCacheWrites ?? 0),
		totalCacheReads:
			prefix.totalCacheReads === undefined && suffix.totalCacheReads === undefined
				? undefined
				: (prefix.totalCacheReads ?? 0) + (suffix.totalCacheReads ?? 0),
		totalCost: prefix.totalCost + suffix.totalCost,
		contextTokens: suffix.contextTokens !== 0 ? suffix.contextTokens : prefix.contextTokens,
	}
}

/**
 * Run the full consolidation pipeline on a slice and return both
 * modified-messages and metrics.
 */
function consolidateSlice(sliced: ShoferMessage[]): {
	modified: ShoferMessage[]
	metrics: TokenUsage
} {
	const modified = combineApiRequests(combineCommandSequences(sliced))
	return { modified, metrics: getApiMetrics(modified) }
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Create an incremental message processor.
 *
 * The returned object's `process()` method takes the full `messages` array
 * (including the task header at index 0) and returns `modifiedMessages` and
 * `apiMetrics` that match the full-pass pipeline output (modulo floating-
 * point addition order for `totalCost`).
 *
 * @returns An object with a `process` method and a `reset` method.
 */
export function createIncrementalMessageProcessor() {
	// ---- Cached state ----
	/** Previous `messages.slice(1)` — used to detect reference-stability. */
	let prevInput: ShoferMessage[] = []

	/** Safe split boundary in sliced-index space (always a safe boundary). */
	let splitIndex = 0

	/** Cached `consolidate(msgs[0:splitIndex])`. */
	let prefixModified: ShoferMessage[] = []

	/** Cached metrics for the prefix. */
	let prefixMetrics: TokenUsage = {
		totalTokensIn: 0,
		totalTokensOut: 0,
		totalCacheWrites: undefined,
		totalCacheReads: undefined,
		totalCost: 0,
		contextTokens: 0,
	}

	// ---- The processor ----

	return {
		/**
		 * Process the messages array incrementally.
		 *
		 * @param messages - The full `shoferMessages` array, including the task
		 *                  header at index 0.
		 * @returns `modifiedMessages` and `apiMetrics`, matching the
		 *          full-pass pipeline output.
		 */
		process(messages: ShoferMessage[]): ProcessedMessages {
			// Strip the task header (index 0), matching the existing pipeline.
			const sliced = messages.slice(1)

			// --- Step 1: Find the common reference-stable prefix ---
			const P = commonReferencePrefixLength(prevInput, sliced)

			// --- Step 2: Detect prefix invalidation ---
			if (P < splitIndex) {
				// Prefix changed (task switch, edit, delete, checkpoint restore).
				// Recompute everything and re-establish a safe split boundary.
				const reach = computeReach(sliced)
				const newSplit = findSafeSplitIndex(reach, 0, sliced.length)

				const prefixRaw = sliced.slice(0, newSplit)
				const suffixRaw = sliced.slice(newSplit)

				const prefixConsolidated = consolidateSlice(prefixRaw)
				const suffixConsolidated = consolidateSlice(suffixRaw)

				// Update cache with safe boundary.
				prevInput = sliced
				splitIndex = newSplit
				prefixModified = prefixConsolidated.modified
				prefixMetrics = prefixConsolidated.metrics

				return {
					modifiedMessages: [...prefixConsolidated.modified, ...suffixConsolidated.modified],
					apiMetrics: foldMetrics(prefixConsolidated.metrics, suffixConsolidated.metrics),
				}
			}

			// --- Step 3: Advance the safe split boundary ---
			if (splitIndex < P) {
				// Messages in [splitIndex, P) are now stabilized. Scan for a
				// new safe boundary using the current full reach.
				const reach = computeReach(sliced)
				const newSplit = findSafeSplitIndex(reach, splitIndex, sliced.length)

				if (newSplit > splitIndex) {
					// Consolidate the newly-stabilized region and fold into the
					// cached prefix.
					const stabilizedSlice = sliced.slice(splitIndex, newSplit)
					const stabilized = consolidateSlice(stabilizedSlice)

					prefixModified = [...prefixModified, ...stabilized.modified]
					prefixMetrics = foldMetrics(prefixMetrics, stabilized.metrics)
					splitIndex = newSplit
				}
			}

			// --- Step 4: Consolidate the suffix (bounded tail) ---
			const suffixRaw = sliced.slice(splitIndex)
			const suffixConsolidated = consolidateSlice(suffixRaw)

			// --- Step 5: Combine ---
			const modifiedMessages = [...prefixModified, ...suffixConsolidated.modified]
			const apiMetrics = foldMetrics(prefixMetrics, suffixConsolidated.metrics)

			// --- Step 6: Update prevInput for the next call ---
			prevInput = sliced

			return { modifiedMessages, apiMetrics }
		},

		/**
		 * Reset all cached state. Call when switching tasks or when the
		 * message array is fully replaced.
		 */
		reset() {
			prevInput = []
			splitIndex = 0
			prefixModified = []
			prefixMetrics = {
				totalTokensIn: 0,
				totalTokensOut: 0,
				totalCacheWrites: undefined,
				totalCacheReads: undefined,
				totalCost: 0,
				contextTokens: 0,
			}
		},
	}
}
