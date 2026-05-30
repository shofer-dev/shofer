/**
 * Randomized equivalence tests for incrementalMessageProcessing.
 *
 * Verifies that the incremental processor produces byte-identical output to
 * the full-pass pipeline (`combineApiRequests(combineCommandSequences(...))`
 * + `getApiMetrics`) across random message sequences under random mutation
 * sequences (append, in-place last-message update, full-array replacement).
 *
 * @see incrementalMessageProcessing.ts
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"

import type { ShoferMessage } from "@shofer/types"
import { combineApiRequests } from "@shofer/shared/combineApiRequests"
import { combineCommandSequences } from "@shofer/shared/combineCommandSequences"
import { getApiMetrics } from "@shofer/shared/getApiMetrics"
import { createIncrementalMessageProcessor } from "../incrementalMessageProcessing"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simple seeded pseudo-random number generator (mulberry32). */
function createRng(seed: number) {
	let s = seed | 0
	return {
		next(): number {
			s = (s + 0x6d2b79f5) | 0
			let t = Math.imul(s ^ (s >>> 15), 1 | s)
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296
		},
		nextInt(min: number, max: number): number {
			return Math.floor(this.next() * (max - min + 1)) + min
		},
		pick<T>(arr: T[]): T {
			return arr[this.nextInt(0, arr.length - 1)]!
		},
	}
}

type MessageKind =
	| "text"
	| "api_req_started"
	| "api_req_finished"
	| "command"
	| "command_output"
	| "use_mcp_server"
	| "mcp_server_response"
	| "condense_context"
	| "user_feedback"

let tsCounter = 1000

function makeMessage(kind: MessageKind, overrides: Partial<ShoferMessage> = {}): ShoferMessage {
	tsCounter++
	const base = { ts: tsCounter, type: "say" as const }

	switch (kind) {
		case "text":
			return {
				...base,
				...overrides,
				say: "text",
				text: `Text message ${tsCounter}`,
			} as ShoferMessage
		case "api_req_started":
			return {
				...base,
				...overrides,
				say: "api_req_started",
				text: JSON.stringify({
					tokensIn: Math.floor(Math.random() * 10000),
					tokensOut: Math.floor(Math.random() * 5000),
					cacheWrites: Math.floor(Math.random() * 1000),
					cacheReads: Math.floor(Math.random() * 2000),
					request: `GET /api/endpoint-${tsCounter}`,
				}),
			} as ShoferMessage
		case "api_req_finished":
			return {
				...base,
				...overrides,
				say: "api_req_finished",
				text: JSON.stringify({ cost: Math.random() * 0.5 }),
			} as ShoferMessage
		case "command":
			return {
				...base,
				...overrides,
				type: "ask",
				ask: "command",
				text: `ls -la /tmp/test-${tsCounter}`,
			} as ShoferMessage
		case "command_output":
			return {
				...base,
				...overrides,
				ask: "command_output",
				text: `file${tsCounter}.txt`,
			} as ShoferMessage
		case "use_mcp_server":
			return {
				...base,
				...overrides,
				type: "ask",
				ask: "use_mcp_server",
				text: JSON.stringify({ serverName: "test-server", toolName: "testTool" }),
			} as ShoferMessage
		case "mcp_server_response":
			return {
				...base,
				...overrides,
				say: "mcp_server_response",
				text: `Response ${tsCounter}`,
			} as ShoferMessage
		case "condense_context":
			return {
				...base,
				...overrides,
				say: "condense_context",
				contextCondense: {
					cost: Math.random() * 0.01,
					newContextTokens: Math.floor(Math.random() * 50000),
				},
			} as ShoferMessage
		case "user_feedback":
			return {
				...base,
				...overrides,
				say: "user_feedback",
				text: `Feedback ${tsCounter}`,
			} as ShoferMessage
	}
}

/**
 * Generate a random sequence of messages where structural pairs are balanced.
 *
 * Structural pairs:
 *  - `api_req_started` is always followed by `api_req_finished` (with some
 *    interleaving).
 *  - `command` is always closed by another `command` or EOS.
 *  - `use_mcp_server` is always closed by another `use_mcp_server` or EOS.
 */
function generateBalancedSequence(rng: ReturnType<typeof createRng>, length: number): ShoferMessage[] {
	const msgs: ShoferMessage[] = []

	const openCommands: number[] = []
	const openMcps: number[] = []
	const openApi: number[] = []

	const kinds: MessageKind[] = [
		"text",
		"api_req_started",
		"command",
		"use_mcp_server",
		"condense_context",
		"user_feedback",
	]

	for (let i = 0; i < length; i++) {
		let kind: MessageKind

		if (openApi.length > 0 && rng.next() < 0.6) {
			kind = "api_req_finished"
		} else if (openCommands.length > 0 && rng.next() < 0.4) {
			kind = "command_output"
		} else if (openMcps.length > 0 && rng.next() < 0.5) {
			kind = "mcp_server_response"
		} else {
			kind = rng.pick(kinds)
		}

		const msg = makeMessage(kind)

		// Track openings/closures.
		if (kind === "api_req_started") openApi.push(i)
		else if (kind === "api_req_finished") openApi.pop()
		else if (kind === "command") openCommands.push(i)
		else if (kind === "command_output") {
			// Absorbed — don't close a command, only the next command/use_mcp_server closes it.
		} else if (kind === "use_mcp_server") openMcps.push(i)
		// mcp_server_response absorbed without closing.

		// If we just opened a new command, close the previous one.
		if (kind === "command" && openCommands.length > 1) {
			openCommands.shift()
		}
		// If we just opened a new mcp, close the previous one.
		if (kind === "use_mcp_server" && openMcps.length > 1) {
			openMcps.shift()
		}

		msgs.push(msg)
	}

	return msgs
}

/**
 * Apply a mutation to the message array (simulating streaming).
 *
 * Mutation types:
 *  - "append": add a new message.
 *  - "update-last": replace the last message (in-place update of final chunk).
 *  - "replace": full array replacement (task switch).
 */
function applyMutation(msgs: ShoferMessage[], rng: ReturnType<typeof createRng>): ShoferMessage[] {
	const mutationType = rng.pick(["append", "append", "append", "update-last", "replace"])

	switch (mutationType) {
		case "append": {
			const kind = rng.pick([
				"text",
				"api_req_started",
				"api_req_finished",
				"command",
				"command_output",
				"use_mcp_server",
				"mcp_server_response",
				"condense_context",
				"user_feedback",
			] as MessageKind[])
			return [...msgs, makeMessage(kind)]
		}
		case "update-last": {
			if (msgs.length === 0) return msgs
			const last = msgs[msgs.length - 1]!
			// Simulate partial → final update.
			return [...msgs.slice(0, -1), { ...last, partial: false, text: (last.text ?? "") + " [updated]" }]
		}
		case "replace": {
			const len = rng.nextInt(1, 20)
			return generateBalancedSequence(rng, len)
		}
		default:
			return msgs
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("incrementalMessageProcessing", () => {
	// Silence JSON parse errors from random data.
	beforeEach(() => {
		vi.spyOn(console, "error").mockImplementation(() => {})
	})
	afterEach(() => {
		vi.restoreAllMocks()
	})

	// ---- Reference (oracle) functions ----

	function fullPass(msgs: ShoferMessage[]) {
		const sliced = msgs.slice(1)
		const modified = combineApiRequests(combineCommandSequences(sliced))
		const metrics = getApiMetrics(modified)
		return { modifiedMessages: modified, apiMetrics: metrics }
	}

	// ---- Targeted cases ----

	it("handles empty message array (only task header)", () => {
		const processor = createIncrementalMessageProcessor()
		const msgs: ShoferMessage[] = [{ type: "say", say: "text", text: "task", ts: 0 } as ShoferMessage]

		const result = processor.process(msgs)
		const expected = fullPass(msgs)

		expect(result.modifiedMessages).toEqual(expected.modifiedMessages)
		expect(result.apiMetrics).toEqual(expected.apiMetrics)
	})

	it("handles single message", () => {
		const processor = createIncrementalMessageProcessor()
		const header = { type: "say", say: "text", text: "task", ts: 0 } as ShoferMessage
		const msg = makeMessage("text")
		const msgs = [header, msg]

		const result = processor.process(msgs)
		const expected = fullPass(msgs)

		expect(result.modifiedMessages).toEqual(expected.modifiedMessages)
		expect(result.apiMetrics).toEqual(expected.apiMetrics)
	})

	it("handles api_req_started / api_req_finished pairs", () => {
		const processor = createIncrementalMessageProcessor()
		const header = { type: "say", say: "text", text: "task", ts: 0 } as ShoferMessage

		tsCounter = 2000
		const started = makeMessage("api_req_started")
		const finished = makeMessage("api_req_finished")

		const msgs = [header, started, finished]
		const result = processor.process(msgs)
		const expected = fullPass(msgs)

		expect(result.modifiedMessages).toEqual(expected.modifiedMessages)
		expect(result.apiMetrics).toEqual(expected.apiMetrics)
	})

	it("handles command / command_output sequences", () => {
		const processor = createIncrementalMessageProcessor()
		const header = { type: "say", say: "text", text: "task", ts: 0 } as ShoferMessage

		tsCounter = 3000
		const cmd = makeMessage("command")
		const out1 = makeMessage("command_output")
		const out2 = makeMessage("command_output")
		const nextCmd = makeMessage("command")

		const msgs = [header, cmd, out1, out2, nextCmd]
		const result = processor.process(msgs)
		const expected = fullPass(msgs)

		expect(result.modifiedMessages).toEqual(expected.modifiedMessages)
	})

	it("handles use_mcp_server / mcp_server_response sequences", () => {
		const processor = createIncrementalMessageProcessor()
		const header = { type: "say", say: "text", text: "task", ts: 0 } as ShoferMessage

		tsCounter = 4000
		const mcp = makeMessage("use_mcp_server")
		const resp1 = makeMessage("mcp_server_response")
		const resp2 = makeMessage("mcp_server_response")
		const nextMcp = makeMessage("use_mcp_server")

		const msgs = [header, mcp, resp1, resp2, nextMcp]
		const result = processor.process(msgs)
		const expected = fullPass(msgs)

		expect(result.modifiedMessages).toEqual(expected.modifiedMessages)
	})

	it("handles trailing open command group", () => {
		const processor = createIncrementalMessageProcessor()
		const header = { type: "say", say: "text", text: "task", ts: 0 } as ShoferMessage

		tsCounter = 5000
		const text1 = makeMessage("text")
		const cmd = makeMessage("command")
		const out1 = makeMessage("command_output")

		// Trailing open group: command absorbs command_output, but no closing
		// command follows.
		const msgs = [header, text1, cmd, out1]
		const result = processor.process(msgs)
		const expected = fullPass(msgs)

		expect(result.modifiedMessages).toEqual(expected.modifiedMessages)
		expect(result.apiMetrics).toEqual(expected.apiMetrics)
	})

	it("handles unmatched api_req_started", () => {
		const processor = createIncrementalMessageProcessor()
		const header = { type: "say", say: "text", text: "task", ts: 0 } as ShoferMessage

		tsCounter = 6000
		const started = makeMessage("api_req_started")
		// No matching finished — orphan.
		const msgs = [header, started]
		const result = processor.process(msgs)
		const expected = fullPass(msgs)

		expect(result.modifiedMessages).toEqual(expected.modifiedMessages)
	})

	it("handles orphan api_req_finished and command_output", () => {
		const processor = createIncrementalMessageProcessor()
		const header = { type: "say", say: "text", text: "task", ts: 0 } as ShoferMessage

		tsCounter = 7000
		// Orphan: finished without a preceding started.
		const finished = makeMessage("api_req_finished")
		// Orphan: command_output without a preceding command.
		const out = makeMessage("command_output")
		const msgs = [header, finished, out]
		const result = processor.process(msgs)
		const expected = fullPass(msgs)

		expect(result.modifiedMessages).toEqual(expected.modifiedMessages)
	})

	it("handles full-replacement reset", () => {
		const processor = createIncrementalMessageProcessor()
		const header = { type: "say", say: "text", text: "task", ts: 0 } as ShoferMessage

		tsCounter = 8000
		// First call.
		const msgs1 = [header, makeMessage("text"), makeMessage("text")]
		const result1 = processor.process(msgs1)
		expect(result1.modifiedMessages).toEqual(fullPass(msgs1).modifiedMessages)

		// Second call with completely different array (task switch).
		tsCounter = 9000
		const msgs2 = [header, makeMessage("api_req_started"), makeMessage("api_req_finished")]
		const result2 = processor.process(msgs2)
		expect(result2.modifiedMessages).toEqual(fullPass(msgs2).modifiedMessages)
		expect(result2.apiMetrics).toEqual(fullPass(msgs2).apiMetrics)
	})

	it("handles append then update-last (streaming simulation)", () => {
		const processor = createIncrementalMessageProcessor()
		const header = { type: "say", say: "text", text: "task", ts: 0 } as ShoferMessage

		tsCounter = 10000
		const msgs1 = [header, makeMessage("text")]
		const result1 = processor.process(msgs1)
		expect(result1.modifiedMessages).toEqual(fullPass(msgs1).modifiedMessages)

		// Append.
		const msgs2 = [...msgs1, makeMessage("api_req_started")]
		const result2 = processor.process(msgs2)
		expect(result2.modifiedMessages).toEqual(fullPass(msgs2).modifiedMessages)

		// Update-last.
		const last = msgs2[msgs2.length - 1]!
		const msgs3 = [...msgs2.slice(0, -1), { ...last, text: last.text + " extra" }]
		const result3 = processor.process(msgs3)
		expect(result3.modifiedMessages).toEqual(fullPass(msgs3).modifiedMessages)

		// Append the matching finished.
		const msgs4 = [...msgs3, makeMessage("api_req_finished")]
		const result4 = processor.process(msgs4)
		expect(result4.modifiedMessages).toEqual(fullPass(msgs4).modifiedMessages)
		expect(result4.apiMetrics).toEqual(fullPass(msgs4).apiMetrics)
	})

	it("handles condense_context messages", () => {
		const processor = createIncrementalMessageProcessor()
		const header = { type: "say", say: "text", text: "task", ts: 0 } as ShoferMessage

		tsCounter = 11000
		const condense = makeMessage("condense_context")
		const msgs = [header, condense]
		const result = processor.process(msgs)
		const expected = fullPass(msgs)

		expect(result.apiMetrics.totalCost).toBe(expected.apiMetrics.totalCost)
		expect(result.apiMetrics.contextTokens).toBe(expected.apiMetrics.contextTokens)
	})

	it("handles interleaved api_req_started/finished pairs (LIFO)", () => {
		// LIFO: started1, started2, finished2, finished1.
		const processor = createIncrementalMessageProcessor()
		const header = { type: "say", say: "text", text: "task", ts: 0 } as ShoferMessage

		tsCounter = 12000
		const s1 = makeMessage("api_req_started")
		const s2 = makeMessage("api_req_started")
		const f2 = makeMessage("api_req_finished")
		const f1 = makeMessage("api_req_finished")
		const msgs = [header, s1, s2, f2, f1]

		const result = processor.process(msgs)
		const expected = fullPass(msgs)

		expect(result.modifiedMessages).toEqual(expected.modifiedMessages)
		expect(result.apiMetrics).toEqual(expected.apiMetrics)
	})

	/**
	 * Compare two TokenUsage objects with tolerance for totalCost to handle
	 * floating-point differences from different addition orders.
	 */
	function expectMetricsEqual(actual: TokenUsage, expected: TokenUsage, context?: string) {
		const prefix = context ? `${context}: ` : ""
		expect(actual.totalTokensIn, `${prefix}totalTokensIn`).toBe(expected.totalTokensIn)
		expect(actual.totalTokensOut, `${prefix}totalTokensOut`).toBe(expected.totalTokensOut)
		expect(actual.totalCacheWrites, `${prefix}totalCacheWrites`).toBe(expected.totalCacheWrites)
		expect(actual.totalCacheReads, `${prefix}totalCacheReads`).toBe(expected.totalCacheReads)
		expect(actual.contextTokens, `${prefix}contextTokens`).toBe(expected.contextTokens)
		// totalCost may differ in the last few bits due to floating-point
		// addition order in incremental processing.
		expect(actual.totalCost, `${prefix}totalCost`).toBeCloseTo(expected.totalCost, 12)
	}

	// ---- Randomized property tests ----

	it("produces byte-identical output through multi-step streaming (single seed)", () => {
		const rng = createRng(42)
		const processor = createIncrementalMessageProcessor()
		const header = { type: "say", say: "text", text: "task", ts: 0 } as ShoferMessage

		tsCounter = 0

		// Start with a balanced sequence.
		let msgs = [header, ...generateBalancedSequence(rng, 15)]

		// Run 50 mutation steps.
		for (let step = 0; step < 50; step++) {
			msgs = applyMutation(msgs, rng)
			// Always wrap in a fresh array — the mutation already creates new
			// arrays, but we ensure header at [0].
			if (msgs[0]?.ts !== 0) {
				msgs = [header, ...msgs]
			}

			const result = processor.process(msgs)
			const expected = fullPass(msgs)

			expect(result.modifiedMessages, `step ${step}: modifiedMessages mismatch`).toEqual(
				expected.modifiedMessages,
			)

			expectMetricsEqual(result.apiMetrics, expected.apiMetrics, `step ${step}`)
		}
	})

	it("produces byte-identical output across 5 random seeds", () => {
		for (let seed = 100; seed < 105; seed++) {
			const rng = createRng(seed)
			const processor = createIncrementalMessageProcessor()
			const header = { type: "say", say: "text", text: "task", ts: 0 } as ShoferMessage

			tsCounter = 0
			let msgs = [header, ...generateBalancedSequence(rng, 10)]

			for (let step = 0; step < 30; step++) {
				msgs = applyMutation(msgs, rng)
				if (msgs[0]?.ts !== 0) {
					msgs = [header, ...msgs]
				}

				const result = processor.process(msgs)
				const expected = fullPass(msgs)

				expect(result.modifiedMessages).toEqual(expected.modifiedMessages)
				expectMetricsEqual(result.apiMetrics, expected.apiMetrics, `seed=${seed} step=${step}`)
			}
		}
	})

	// ---- Reset behavior ----

	it("reset clears all cached state", () => {
		const processor = createIncrementalMessageProcessor()
		const header = { type: "say", say: "text", text: "task", ts: 0 } as ShoferMessage

		tsCounter = 13000
		const msgs1 = [header, makeMessage("text"), makeMessage("text")]

		const result1 = processor.process(msgs1)
		expect(result1.modifiedMessages).toEqual(fullPass(msgs1).modifiedMessages)

		// Reset and process again — should still work.
		processor.reset()

		const result2 = processor.process(msgs1)
		expect(result2.modifiedMessages).toEqual(fullPass(msgs1).modifiedMessages)
	})

	// ---- Edge: large command sequence ----

	it("handles a command with many command_output messages", () => {
		const processor = createIncrementalMessageProcessor()
		const header = { type: "say", say: "text", text: "task", ts: 0 } as ShoferMessage

		tsCounter = 14000
		const cmd = makeMessage("command")
		const outputs = Array.from({ length: 20 }, () => makeMessage("command_output"))
		const nextCmd = makeMessage("command")
		const msgs = [header, cmd, ...outputs, nextCmd]

		const result = processor.process(msgs)
		const expected = fullPass(msgs)

		expect(result.modifiedMessages).toEqual(expected.modifiedMessages)
	})

	// ---- Edge: deep LIFO stack ----

	it("handles deep LIFO api_req_started nesting", () => {
		const processor = createIncrementalMessageProcessor()
		const header = { type: "say", say: "text", text: "task", ts: 0 } as ShoferMessage

		tsCounter = 15000
		const msgs: ShoferMessage[] = [header]
		// Nest 10 deep.
		const starts: ShoferMessage[] = []
		for (let i = 0; i < 10; i++) {
			const s = makeMessage("api_req_started")
			starts.push(s)
			msgs.push(s)
		}
		for (let i = 9; i >= 0; i--) {
			msgs.push(makeMessage("api_req_finished"))
		}

		const result = processor.process(msgs)
		const expected = fullPass(msgs)

		expect(result.modifiedMessages).toEqual(expected.modifiedMessages)
		expect(result.apiMetrics).toEqual(expected.apiMetrics)
	})

	// ---- Edge: split exactly on a boundary ----

	it("handles split exactly on a safe boundary after commands stabilize", () => {
		const processor = createIncrementalMessageProcessor()
		const header = { type: "say", say: "text", text: "task", ts: 0 } as ShoferMessage

		tsCounter = 16000
		const text1 = makeMessage("text")
		const text2 = makeMessage("text")

		// Process initial messages to build up a cached prefix.
		const msgs1 = [header, text1, text2]
		const result1 = processor.process(msgs1)
		expect(result1.modifiedMessages).toEqual(fullPass(msgs1).modifiedMessages)

		// Now append more messages — the prefix [text1, text2] should remain
		// reference-stable and serve as the cached split point.
		const text3 = makeMessage("text")
		const msgs2 = [header, text1, text2, text3]
		const result2 = processor.process(msgs2)
		expect(result2.modifiedMessages).toEqual(fullPass(msgs2).modifiedMessages)
	})
})
