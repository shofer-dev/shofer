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
 * streaming loop already recorded for the `api_req_finished` span.
 */

import type { ShoferApiReqInfo } from "@shofer/types"

import {
	defaultMonotonicClock,
	endedApiReqInfo,
	openedApiReqInfo,
	startApiRequestTimer,
	streamPhaseFields,
	type MonotonicClock,
} from "../api-req-timing.js"

/** The marks a stream that produced no chunk at all leaves behind. */
const NO_MARKS = { ttfbMs: null, genStartOffsetMs: null }

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
			{ ttfbMs: 380, genStartOffsetMs: 1_900 },
		)

		expect(ended.durationMs).toBe(4_120)
		expect(ended.firstChunkMs).toBe(380)
		expect(ended.thinkingMs).toBe(1_520)
		// The economics the rewrite exists to record are untouched.
		expect(ended.tokensIn).toBe(15_180)
		expect(ended.tokensOut).toBe(80)
		expect(ended.cost).toBe(0.00121056)
		expect(ended.model).toBe("m")
	})

	it("re-measures on every rewrite, so a progressive update ends at open→stream-end", () => {
		const { clock, advance } = fakeClock()
		const timer = startApiRequestTimer(clock)

		// The provider's end-of-stream metadata marker lands first…
		advance(3_000)
		const first = endedApiReqInfo({ tokensIn: 10 }, timer, { ttfbMs: 200, genStartOffsetMs: 900 })
		// …then the background usage drain rewrites the same message.
		advance(900)
		const second = endedApiReqInfo({ ...first, tokensOut: 42 }, timer, { ttfbMs: 200, genStartOffsetMs: 900 })

		expect(first.durationMs).toBe(3_000)
		expect(second.durationMs).toBe(3_900)
		// The phases are marks, not a second clock: they do not move with the
		// re-measured duration.
		expect(second.firstChunkMs).toBe(200)
		expect(second.thinkingMs).toBe(700)
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
	})

	it("never lets a phase field displace the router's own ttfbMs", () => {
		const { clock, advance } = fakeClock()
		const timer = startApiRequestTimer(clock)

		advance(2_000)
		// `ttfbMs` here is what shofer-router reported about its own request; the
		// host's measurement is a different observer and lands beside it.
		const ended = endedApiReqInfo({ actualModel: "kimi-k3", ttfbMs: 91 }, timer, {
			ttfbMs: 140,
			genStartOffsetMs: 640,
		})

		expect(ended.ttfbMs).toBe(91)
		expect(ended.firstChunkMs).toBe(140)
		expect(ended.thinkingMs).toBe(500)
	})
})

describe("streamPhaseFields", () => {
	it("states both phases when the model reasoned and then produced output", () => {
		expect(streamPhaseFields({ ttfbMs: 412.4, genStartOffsetMs: 3_180.9 })).toEqual({
			firstChunkMs: 412,
			thinkingMs: 2_769,
		})
	})

	it("omits thinkingMs entirely when no reasoning preceded the output", () => {
		// The same chunk sets both marks when the first thing to arrive is text.
		const fields = streamPhaseFields({ ttfbMs: 380.2, genStartOffsetMs: 380.2 })

		expect(fields.firstChunkMs).toBe(380)
		expect("thinkingMs" in fields).toBe(false)
	})

	it("omits a sub-millisecond reasoning window rather than writing zero", () => {
		// Zero must never appear: absence is how a consumer reads 'no thinking
		// phase', and a zero-width segment would have to be special-cased there.
		const fields = streamPhaseFields({ ttfbMs: 500.0, genStartOffsetMs: 500.4 })

		expect("thinkingMs" in fields).toBe(false)
	})

	it("omits thinkingMs when the stream ended still reasoning — the boundary was never reached", () => {
		const fields = streamPhaseFields({ ttfbMs: 610, genStartOffsetMs: null })

		expect(fields.firstChunkMs).toBe(610)
		expect("thinkingMs" in fields).toBe(false)
	})

	it("states nothing at all when the stream produced no chunk", () => {
		expect(streamPhaseFields(NO_MARKS)).toEqual({})
	})

	it("never reports a negative first chunk, whatever the clock did", () => {
		// The gap between the two marks is still the measured 2 ms; only the
		// offset itself is floored, because a first byte before the request
		// opened is a clock artefact and not a fact to publish.
		expect(streamPhaseFields({ ttfbMs: -3, genStartOffsetMs: -1 })).toEqual({
			firstChunkMs: 0,
			thinkingMs: 2,
		})
	})

	it("omits thinkingMs when the marks run backwards", () => {
		// A non-reasoning chunk cannot precede the first chunk of any kind; if
		// the marks say so, the window is nonsense, not zero-length.
		expect("thinkingMs" in streamPhaseFields({ ttfbMs: 900, genStartOffsetMs: 400 })).toBe(false)
	})
})
