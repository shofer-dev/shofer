/**
 * Tests for the `api_req_started` payload's timing field.
 *
 * `Task` is heavy to instantiate under vitest (full vscode mock, watchers,
 * controllers), so — following the precedent in `cost-limit.spec.ts` — the
 * rewrite seam itself is tested rather than the loop that drives it: the two
 * payload builders `Task.recursivelyMakeShoferRequests` calls, and the clock
 * they are measured with.
 *
 * The property under test is the one a transcript consumer depends on: the
 * OPENING payload carries no duration, and every STREAM-END rewrite carries the
 * elapsed span measured from a monotonic clock captured at request open.
 */

import type { ShoferApiReqInfo } from "@shofer/types"

import {
	defaultMonotonicClock,
	endedApiReqInfo,
	openedApiReqInfo,
	startApiRequestTimer,
	type MonotonicClock,
} from "../api-req-timing.js"

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
		)

		expect(ended.durationMs).toBe(4_120)
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
		const first = endedApiReqInfo({ tokensIn: 10 }, timer)
		// …then the background usage drain rewrites the same message.
		advance(900)
		const second = endedApiReqInfo({ ...first, tokensOut: 42 }, timer)

		expect(first.durationMs).toBe(3_000)
		expect(second.durationMs).toBe(3_900)
		expect(second.tokensIn).toBe(10)
		expect(second.tokensOut).toBe(42)
	})

	it("stamps a cancelled stream too — the stream ended, however it ended", () => {
		const { clock, advance } = fakeClock()
		const timer = startApiRequestTimer(clock)

		advance(120)
		const ended = endedApiReqInfo({ cancelReason: "user_cancelled", tokensIn: 0, tokensOut: 0, cost: 0 }, timer)

		expect(ended.durationMs).toBe(120)
		expect(ended.cancelReason).toBe("user_cancelled")
	})
})
