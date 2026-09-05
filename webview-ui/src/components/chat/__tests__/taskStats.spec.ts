// npx vitest src/components/chat/__tests__/taskStats.spec.ts
//
// The shared active-time breakdown behind the Stats views. The invariant under
// test is the painting rule: overlapping spans are attributed to the
// HIGHEST-priority covering segment (tool/mcp/waiting beat the request phases),
// and time covered by nothing is idle and dropped.

import type { ApiRequestFinishedPayload, ShoferMessage } from "@shofer/types"

import {
	CATEGORIES,
	CAT_BY_KEY,
	OVERHEAD,
	arcPath,
	breakdownFromPayloads,
	buildSlices,
	computeBreakdown,
	formatMs,
	mergeBreakdowns,
	polar,
} from "../taskStats"

const payload = (over: Partial<ApiRequestFinishedPayload> = {}): ApiRequestFinishedPayload =>
	({
		requestIndex: 0,
		taskId: "t1",
		parentTaskId: null,
		startedAtOffsetMs: 0,
		finishedAtOffsetMs: 1000,
		ttfbMs: 100,
		model: "m",
		apiProtocol: "openai",
		retryAttempt: 0,
		tokensIn: 1,
		tokensOut: 1,
		cacheWrites: 0,
		cacheReads: 0,
		cost: 0,
		status: "completed",
		toolSpans: [],
		...over,
	}) as ApiRequestFinishedPayload

const span = (over: Partial<ApiRequestFinishedPayload["toolSpans"][number]> = {}) => ({
	startedAtOffsetMs: 0,
	finishedAtOffsetMs: 100,
	toolName: "read_file",
	toolId: "id",
	resultSizeChars: null,
	isError: false,
	...over,
})

describe("formatMs", () => {
	it.each([
		[0, "0ms"],
		[999, "999ms"],
		[1500, "1.5s"],
		[59_900, "59.9s"],
		[65_000, "1m 5s"],
		[120_000, "2m"],
		[3_600_000, "1h"],
		[3_900_000, "1h 5m"],
	])("formats %ims as %s", (ms, expected) => {
		expect(formatMs(ms)).toBe(expected)
	})
})

describe("breakdownFromPayloads", () => {
	it("returns null with no requests", () => {
		expect(breakdownFromPayloads([])).toBeNull()
	})

	it("returns null when the timeline has no extent", () => {
		expect(breakdownFromPayloads([payload({ startedAtOffsetMs: 5, finishedAtOffsetMs: 5, ttfbMs: 0 })])).toBeNull()
	})

	it("splits a plain request into TTFB and streaming", () => {
		const b = breakdownFromPayloads([payload()])!
		expect(b.totals.llm).toBe(100)
		expect(b.totals.streaming).toBe(900)
		expect(b.totals.thinking).toBe(0)
		expect(b.totalMs).toBe(1000)
		expect(b.requestCount).toBe(1)
	})

	it("carves a thinking phase out between TTFB and generation start", () => {
		const b = breakdownFromPayloads([payload({ ttfbMs: 100, genStartOffsetMs: 400 })])!
		expect(b.totals.llm).toBe(100)
		expect(b.totals.thinking).toBe(300)
		expect(b.totals.streaming).toBe(600)
	})

	it("clamps a ttfb and a generation start that overrun the request", () => {
		const b = breakdownFromPayloads([payload({ ttfbMs: 5000, genStartOffsetMs: 9000 })])!
		expect(b.totals.llm).toBe(1000)
		expect(b.totals.streaming).toBe(0)
	})

	it("treats a negative ttfb as zero", () => {
		const b = breakdownFromPayloads([payload({ ttfbMs: -50 })])!
		expect(b.totals.llm).toBe(0)
		expect(b.totals.streaming).toBe(1000)
	})

	it("lets a tool span win the overlap against the streaming phase", () => {
		const b = breakdownFromPayloads([
			payload({ toolSpans: [span({ startedAtOffsetMs: 200, finishedAtOffsetMs: 500 })] }),
		])!
		expect(b.totals.tool).toBe(300)
		expect(b.totals.streaming).toBe(600)
		expect(b.toolTotals).toEqual([{ name: "read_file", ms: 300, count: 1, errors: 0 }])
	})

	it("classifies an mcp-prefixed span as an MCP call", () => {
		const b = breakdownFromPayloads([
			payload({
				toolSpans: [span({ toolName: "mcp:server/tool", startedAtOffsetMs: 200, finishedAtOffsetMs: 400 })],
			}),
		])!
		expect(b.totals.mcp).toBe(200)
		expect(b.totals.tool).toBe(0)
	})

	it("classifies `wait` and any waitsForTask span as waiting, and keeps it out of the tool table", () => {
		const b = breakdownFromPayloads([
			payload({
				toolSpans: [
					span({ toolName: "wait", startedAtOffsetMs: 200, finishedAtOffsetMs: 300 }),
					span({
						toolName: "new_task",
						waitsForTask: true,
						startedAtOffsetMs: 300,
						finishedAtOffsetMs: 400,
					}),
				],
			}),
		])!
		expect(b.totals.waiting_subtask).toBe(200)
		expect(b.toolTotals).toHaveLength(0)
	})

	it("counts errors per tool and orders the table by time spent", () => {
		const b = breakdownFromPayloads([
			payload({
				toolSpans: [
					span({ toolName: "a", startedAtOffsetMs: 100, finishedAtOffsetMs: 150, isError: true }),
					span({ toolName: "a", startedAtOffsetMs: 150, finishedAtOffsetMs: 200 }),
					span({ toolName: "b", startedAtOffsetMs: 200, finishedAtOffsetMs: 500 }),
				],
			}),
		])!
		expect(b.toolTotals).toEqual([
			{ name: "b", ms: 300, count: 1, errors: 0 },
			{ name: "a", ms: 100, count: 2, errors: 1 },
		])
	})

	it("drops the gap between two requests as idle", () => {
		const b = breakdownFromPayloads([
			payload({ startedAtOffsetMs: 0, finishedAtOffsetMs: 100, ttfbMs: 0 }),
			payload({ startedAtOffsetMs: 1000, finishedAtOffsetMs: 1100, ttfbMs: 0 }),
		])!
		expect(b.totalMs).toBe(200)
		expect(b.requestCount).toBe(2)
	})

	it("clamps a span whose end precedes its start", () => {
		const b = breakdownFromPayloads([
			payload({ toolSpans: [span({ startedAtOffsetMs: 300, finishedAtOffsetMs: 100 })] }),
		])!
		expect(b.totals.tool).toBe(0)
	})
})

describe("computeBreakdown", () => {
	const say = (text: string): ShoferMessage =>
		({ ts: 1, type: "say", say: "api_req_finished", text }) as ShoferMessage

	it("ignores messages that are not finished-request spans", () => {
		expect(computeBreakdown([{ ts: 1, type: "say", say: "text", text: "hi" } as ShoferMessage])).toBeNull()
	})

	it("skips a malformed payload rather than throwing", () => {
		expect(computeBreakdown([say("{not json")])).toBeNull()
	})

	it("parses well-formed payloads", () => {
		const b = computeBreakdown([say(JSON.stringify(payload()))])!
		expect(b.requestCount).toBe(1)
	})
})

describe("mergeBreakdowns", () => {
	it("returns null when nothing has data", () => {
		expect(mergeBreakdowns([null, null])).toBeNull()
	})

	it("sums per-category totals and folds the tool tables together", () => {
		const one = breakdownFromPayloads([
			payload({ toolSpans: [span({ toolName: "a", startedAtOffsetMs: 200, finishedAtOffsetMs: 300 })] }),
		])
		const two = breakdownFromPayloads([
			payload({
				toolSpans: [span({ toolName: "a", startedAtOffsetMs: 200, finishedAtOffsetMs: 400, isError: true })],
			}),
		])
		const merged = mergeBreakdowns([one, null, two])!
		expect(merged.requestCount).toBe(2)
		expect(merged.toolTotals).toEqual([{ name: "a", ms: 300, count: 2, errors: 1 }])
		expect(merged.totalMs).toBe(one!.totalMs + two!.totalMs)
	})
})

describe("buildSlices", () => {
	it("returns nothing for an empty total", () => {
		const empty = { totals: CAT_BY_KEY && ({} as never), toolTotals: [], totalMs: 0, requestCount: 0 }
		expect(
			buildSlices({
				...empty,
				totals: { llm: 0, thinking: 0, streaming: 0, tool: 0, mcp: 0, waiting_subtask: 0 },
			}).slices,
		).toHaveLength(0)
	})

	it("subdivides the supplied active time and calls the remainder overhead", () => {
		const breakdown = breakdownFromPayloads([payload()])!
		const { slices, total } = buildSlices(breakdown, 2000)
		expect(total).toBe(2000)
		expect(slices.at(-1)!.cat).toBe(OVERHEAD)
		expect(slices.at(-1)!.ms).toBe(1000)
		// The slices tile the full circle.
		expect(slices.at(-1)!.a1 - slices[0].a0).toBeCloseTo(Math.PI * 2, 6)
	})

	it("falls back to the span sum when no active time is supplied", () => {
		const breakdown = breakdownFromPayloads([payload()])!
		const { slices, total } = buildSlices(breakdown)
		expect(total).toBe(1000)
		expect(slices.some((s) => s.cat === OVERHEAD)).toBe(false)
	})

	it("prefers the span sum when the reported active time is smaller (clock skew)", () => {
		const breakdown = breakdownFromPayloads([payload()])!
		expect(buildSlices(breakdown, 10).total).toBe(1000)
	})
})

describe("donut geometry", () => {
	it("places the twelve-o'clock point at the top of the viewbox", () => {
		const [x, y] = polar(100, -Math.PI / 2)
		expect(x).toBeCloseTo(120, 6)
		expect(y).toBeCloseTo(20, 6)
	})

	it("sets the large-arc flag only past a half turn", () => {
		expect(arcPath(0, Math.PI / 2, 104, 62)).toContain(" 0 1 ")
		expect(arcPath(0, Math.PI * 1.5, 104, 62)).toContain(" 1 1 ")
	})
})

describe("the category table", () => {
	it("indexes every category by key", () => {
		for (const cat of CATEGORIES) {
			expect(CAT_BY_KEY[cat.key]).toBe(cat)
		}
	})

	it("ranks tool, mcp and waiting spans above the request phases", () => {
		const phases = CATEGORIES.filter((c) => ["llm", "thinking", "streaming"].includes(c.key))
		const spans = CATEGORIES.filter((c) => !phases.includes(c))
		expect(Math.max(...phases.map((c) => c.prio))).toBeLessThan(Math.min(...spans.map((c) => c.prio)))
	})
})
