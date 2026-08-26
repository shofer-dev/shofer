/**
 * Tests for the `api_req_started` payload's timing fields.
 *
 * `Task` is heavy to instantiate under vitest (full vscode mock, watchers,
 * controllers), so — following the precedent in `cost-limit.spec.ts` — the
 * rewrite seam itself is tested rather than the loop that drives it: the two
 * payload builders `Task.recursivelyMakeShoferRequests` calls, and the clock
 * they are measured with.
 *
 * The property under test is the one a transcript consumer depends on: the
 * OPENING payload carries no timing at all, and every STREAM-END rewrite carries
 * the elapsed span measured from a monotonic clock captured at request open,
 * plus the phase split (waiting / thinking / output) derived from the marks the
 * streaming loop already recorded. The thinking phase is a SET of intervals, not
 * one boundary — a model that interleaves reasoning with output has several, and
 * this payload is the only place they are recorded.
 */

import type { ShoferApiReqInfo } from "@shofer/types"

import {
	defaultMonotonicClock,
	endedApiReqInfo,
	openedApiReqInfo,
	startApiRequestTimer,
	streamPhaseFields,
	type MonotonicClock,
	type StreamPhaseMarks,
} from "../api-req-timing.js"

/** The marks a stream that produced no chunk at all leaves behind. */
const NO_MARKS: StreamPhaseMarks = {
	ttfbMs: null,
	genStartOffsetMs: null,
	reasoningIntervalsMs: [],
	reasoningOpenedAtMs: null,
}

/** Marks for a stream that reasoned once, then produced output. */
function marks(fields: Partial<StreamPhaseMarks>): StreamPhaseMarks {
	return { ...NO_MARKS, ...fields }
}

/** A hand-cranked monotonic clock, so no test depends on real elapsed time. */
function fakeClock(start = 1_000): { clock: MonotonicClock; advance: (ms: number) => void } {
	let nowMs = start
	return {
		clock: () => nowMs,
		advance: (ms: number) => {
			nowMs += ms
		},
	}
}

describe("openedApiReqInfo", () => {
	it("carries no durationMs — absence is what 'no end is known' means", () => {
		const info = openedApiReqInfo({ apiProtocol: "openai", model: "justceo/orchestrator", retryAttempt: 0 })

		expect(info.durationMs).toBeUndefined()
		expect("durationMs" in info).toBe(false)
		// Nor any phase: nothing has streamed yet, so there is no first byte and
		// no reasoning window to state.
		expect("firstChunkMs" in info).toBe(false)
		expect("thinkingMs" in info).toBe(false)
		expect("reasoningIntervalsMs" in info).toBe(false)
		// And it survives the JSON round-trip the message text is stored as.
		expect(JSON.parse(JSON.stringify(info))).toEqual({
			apiProtocol: "openai",
			model: "justceo/orchestrator",
			retryAttempt: 0,
		})
	})

	it("keeps the announced request's own fields", () => {
		const info = openedApiReqInfo({ apiProtocol: "anthropic", model: undefined, retryAttempt: 2 })

		expect(info.apiProtocol).toBe("anthropic")
		expect(info.retryAttempt).toBe(2)
	})
})

describe("startApiRequestTimer", () => {
	it("measures from the moment the request was opened", () => {
		const { clock, advance } = fakeClock()
		const timer = startApiRequestTimer(clock)

		advance(2_431)

		expect(timer.elapsedMs()).toBe(2_431)
	})

	it("rounds to whole milliseconds", () => {
		const { clock, advance } = fakeClock()
		const timer = startApiRequestTimer(clock)

		advance(707.93)

		expect(timer.elapsedMs()).toBe(708)
	})

	it("never reports a negative span", () => {
		const { clock, advance } = fakeClock()
		const timer = startApiRequestTimer(clock)

		advance(-5_000)

		expect(timer.elapsedMs()).toBe(0)
	})

	it("defaults to the process monotonic clock, never the wall clock", () => {
		const spy = vi.spyOn(performance, "now")
		const dateSpy = vi.spyOn(Date, "now")
		try {
			defaultMonotonicClock()
			expect(spy).toHaveBeenCalled()
			expect(dateSpy).not.toHaveBeenCalled()
		} finally {
			spy.mockRestore()
			dateSpy.mockRestore()
		}
	})
})

describe("endedApiReqInfo", () => {
	it("stamps the elapsed span onto a stream-end rewrite", () => {
		const { clock, advance } = fakeClock()
		const timer = startApiRequestTimer(clock)
		const opened = openedApiReqInfo({ apiProtocol: "openai", model: "m", retryAttempt: 0 })

		advance(4_120)
		const ended = endedApiReqInfo(
			{ ...opened, tokensIn: 15_180, tokensOut: 80, cost: 0.00121056 } satisfies ShoferApiReqInfo,
			timer,
			marks({ ttfbMs: 380, genStartOffsetMs: 1_900, reasoningIntervalsMs: [[380, 1_900]] }),
		)

		expect(ended.durationMs).toBe(4_120)
		expect(ended.firstChunkMs).toBe(380)
		expect(ended.thinkingMs).toBe(1_520)
		expect(ended.reasoningIntervalsMs).toEqual([[380, 1_900]])
		// The economics the rewrite exists to record are untouched.
		expect(ended.tokensIn).toBe(15_180)
		expect(ended.tokensOut).toBe(80)
		expect(ended.cost).toBe(0.00121056)
		expect(ended.model).toBe("m")
	})

	it("re-measures on every rewrite, so a progressive update ends at open→stream-end", () => {
		const { clock, advance } = fakeClock()
		const timer = startApiRequestTimer(clock)
		const streamMarks = marks({ ttfbMs: 200, genStartOffsetMs: 900, reasoningIntervalsMs: [[200, 900]] })

		// The provider's end-of-stream metadata marker lands first…
		advance(3_000)
		const first = endedApiReqInfo({ tokensIn: 10 }, timer, streamMarks)
		// …then the background usage drain rewrites the same message.
		advance(900)
		const second = endedApiReqInfo({ ...first, tokensOut: 42 }, timer, streamMarks)

		expect(first.durationMs).toBe(3_000)
		expect(second.durationMs).toBe(3_900)
		// The phases are marks, not a second clock: they do not move with the
		// re-measured duration.
		expect(second.firstChunkMs).toBe(200)
		expect(second.thinkingMs).toBe(700)
		expect(second.reasoningIntervalsMs).toEqual([[200, 900]])
		expect(second.tokensIn).toBe(10)
		expect(second.tokensOut).toBe(42)
	})

	it("stamps a cancelled stream too — the stream ended, however it ended", () => {
		const { clock, advance } = fakeClock()
		const timer = startApiRequestTimer(clock)

		advance(120)
		const ended = endedApiReqInfo(
			{ cancelReason: "user_cancelled", tokensIn: 0, tokensOut: 0, cost: 0 },
			timer,
			NO_MARKS,
		)

		expect(ended.durationMs).toBe(120)
		expect(ended.cancelReason).toBe("user_cancelled")
		// Cancelled before anything arrived: a duration, and no phases to draw
		// inside it.
		expect("firstChunkMs" in ended).toBe(false)
		expect("thinkingMs" in ended).toBe(false)
		expect("reasoningIntervalsMs" in ended).toBe(false)
	})

	it("closes a still-open reasoning run at the request's own end", () => {
		const { clock, advance } = fakeClock()
		const timer = startApiRequestTimer(clock)

		// The stream died while the model was still thinking: the run has no
		// closing chunk, so the request's end is what closes it.
		advance(2_500)
		const ended = endedApiReqInfo({ cancelReason: "streaming_failed" }, timer, {
			ttfbMs: 300,
			genStartOffsetMs: null,
			reasoningIntervalsMs: [],
			reasoningOpenedAtMs: 300,
		})

		expect(ended.durationMs).toBe(2_500)
		expect(ended.reasoningIntervalsMs).toEqual([[300, 2_500]])
		expect(ended.thinkingMs).toBe(2_200)
	})

	it("never lets a phase field displace the router's own ttfbMs", () => {
		const { clock, advance } = fakeClock()
		const timer = startApiRequestTimer(clock)

		advance(2_000)
		// `ttfbMs` here is what shofer-router reported about its own request; the
		// host's measurement is a different observer and lands beside it.
		const ended = endedApiReqInfo(
			{ actualModel: "kimi-k3", ttfbMs: 91 },
			timer,
			marks({ ttfbMs: 140, genStartOffsetMs: 640, reasoningIntervalsMs: [[140, 640]] }),
		)

		expect(ended.ttfbMs).toBe(91)
		expect(ended.firstChunkMs).toBe(140)
		expect(ended.thinkingMs).toBe(500)
	})
})

describe("streamPhaseFields", () => {
	it("states both phases when the model reasoned and then produced output", () => {
		expect(
			streamPhaseFields(
				marks({ ttfbMs: 412.4, genStartOffsetMs: 3_180.9, reasoningIntervalsMs: [[412.4, 3_180.9]] }),
				9_000,
			),
		).toEqual({
			firstChunkMs: 412,
			thinkingMs: 2_769,
			reasoningIntervalsMs: [[412, 3_181]],
		})
	})

	it("states EVERY reasoning window when the model interleaved thinking with output", () => {
		// think → text → think → text. A single first-boundary account would draw
		// the second reasoning window as output; this is the whole reason the
		// intervals exist.
		const fields = streamPhaseFields(
			marks({
				ttfbMs: 100,
				genStartOffsetMs: 900,
				reasoningIntervalsMs: [
					[100, 900],
					[1_400, 2_050],
				],
			}),
			3_000,
		)

		expect(fields.reasoningIntervalsMs).toEqual([
			[100, 900],
			[1_400, 2_050],
		])
		// thinkingMs is the SUM, not the span of the first window.
		expect(fields.thinkingMs).toBe(1_450)
		expect(fields.firstChunkMs).toBe(100)
	})

	it("closes an interleaved run that was still open at stream end, and never past it", () => {
		const fields = streamPhaseFields(
			marks({
				ttfbMs: 50,
				genStartOffsetMs: 400,
				reasoningIntervalsMs: [[50, 400]],
				reasoningOpenedAtMs: 1_200,
			}),
			1_750,
		)

		expect(fields.reasoningIntervalsMs).toEqual([
			[50, 400],
			[1_200, 1_750],
		])
		expect(fields.thinkingMs).toBe(900)
		// Every interval is inside the bar the consumer draws.
		for (const [, end] of fields.reasoningIntervalsMs!) {
			expect(end).toBeLessThanOrEqual(1_750)
		}
	})

	it("omits both reasoning fields entirely when no reasoning preceded the output", () => {
		// The same chunk sets both marks when the first thing to arrive is text.
		const fields = streamPhaseFields(marks({ ttfbMs: 380.2, genStartOffsetMs: 380.2 }), 2_000)

		expect(fields.firstChunkMs).toBe(380)
		expect("thinkingMs" in fields).toBe(false)
		expect("reasoningIntervalsMs" in fields).toBe(false)
	})

	it("omits a sub-millisecond reasoning window rather than writing zero or an empty array", () => {
		// Zero must never appear: absence is how a consumer reads 'no thinking
		// phase', and a zero-width segment would have to be special-cased there.
		const fields = streamPhaseFields(
			marks({ ttfbMs: 500.0, genStartOffsetMs: 500.4, reasoningIntervalsMs: [[500.0, 500.4]] }),
			1_000,
		)

		expect("thinkingMs" in fields).toBe(false)
		expect("reasoningIntervalsMs" in fields).toBe(false)
	})

	it("drops a sub-millisecond window but keeps its real neighbours", () => {
		const fields = streamPhaseFields(
			marks({
				ttfbMs: 10,
				genStartOffsetMs: 60,
				reasoningIntervalsMs: [
					[10, 60],
					[300, 300.2],
				],
			}),
			900,
		)

		expect(fields.reasoningIntervalsMs).toEqual([[10, 60]])
		expect(fields.thinkingMs).toBe(50)
	})

	it("states nothing at all when the stream produced no chunk", () => {
		expect(streamPhaseFields(NO_MARKS, 400)).toEqual({})
	})

	it("never reports a negative first chunk, whatever the clock did", () => {
		expect(streamPhaseFields(marks({ ttfbMs: -3, genStartOffsetMs: -1 }), 100)).toEqual({
			firstChunkMs: 0,
		})
	})

	it("drops a window that a clock artefact put before the request opened", () => {
		// Floored at both ends, so it collapses to nothing rather than being
		// published as a reasoning phase that preceded the request.
		const fields = streamPhaseFields(marks({ ttfbMs: 0, reasoningIntervalsMs: [[-9, -4]] }), 100)

		expect("reasoningIntervalsMs" in fields).toBe(false)
		expect("thinkingMs" in fields).toBe(false)
	})
})
