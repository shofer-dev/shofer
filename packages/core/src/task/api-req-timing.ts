/**
 * Timing for the `api_req_started` transcript message.
 *
 * # Why this module exists
 *
 * A model request is announced with an `api_req_started` message and — where
 * the host gets that far — closed with an `api_req_finished` span message. The
 * finished message is NOT guaranteed: the agent loop instead REWRITES the
 * started message's payload in place at stream end with the final economics
 * (model, token counts, cache reads/writes, cost). A consumer that has only the
 * transcript therefore sees, for most requests, a row that says a request was
 * opened, what it cost, and nothing at all about when it came back — which
 * renders as "started, never finished" however truthfully it is drawn.
 *
 * `durationMs` closes that: the rewritten payload states how long the request
 * took. The two halves of the rule are equally load-bearing:
 *
 * - a payload that has been rewritten at (or progressively toward) stream end
 *   CARRIES the field, and every rewrite re-measures, so the last one written
 *   is the whole open→stream-end span;
 * - a payload that was never rewritten — the request is genuinely in flight, or
 *   the host died holding it — MUST NOT carry it. Its absence is the only thing
 *   a reader has to distinguish "no end is known" from "it ended, here is how
 *   long it took", so writing a placeholder value would destroy the signal.
 *
 * That is why the two payload shapes are separate functions rather than one
 * builder with an optional argument: which one you call IS the statement.
 *
 * # Why a plain elapsed duration, and not an offset
 *
 * {@link ToolSpan} timings (`startedAtOffsetMs` / `finishedAtOffsetMs`) are
 * relative to the task's timeline ORIGIN. That shape is deliberately not reused
 * here. An origin-relative offset is only meaningful to a reader that knows the
 * origin, and the origin is pinned down by `api_req_finished`
 * (`ts - finishedAtOffsetMs`) — the very message this field exists to survive
 * the absence of. An elapsed duration needs no basis: the reader adds it to the
 * row's own timestamp.
 *
 * # Why a monotonic clock
 *
 * The measurement is taken from {@link performance.now}, captured when the
 * request is opened, and never reconstructed by subtracting message timestamps.
 * Wall-clock arithmetic across a request would report an NTP correction or a
 * clock step as a negative duration or an hour-long model call.
 */

import type { ShoferApiReqInfo } from "@shofer/types"

/** A source of monotonically non-decreasing milliseconds. */
export type MonotonicClock = () => number

/** The process monotonic clock; the only clock used in production. */
export const defaultMonotonicClock: MonotonicClock = () => performance.now()

/** Measures one model request, from the moment it was opened. */
export interface ApiRequestTimer {
	/** Whole milliseconds elapsed since the request was opened. */
	elapsedMs(): number
}

/**
 * Start measuring a model request. Call this immediately before emitting the
 * request's `api_req_started` message, so the span measures the model rather
 * than any of the host's own bookkeeping.
 *
 * @param now - Monotonic clock; injectable for tests, never overridden in
 *   production.
 */
export function startApiRequestTimer(now: MonotonicClock = defaultMonotonicClock): ApiRequestTimer {
	const openedAtMs = now()
	// Clamped at zero and rounded to whole milliseconds: a consumer places the
	// end by adding this to a millisecond-resolution timestamp, and a bar that
	// ends before it starts is worse than no bar.
	return { elapsedMs: () => Math.max(0, Math.round(now() - openedAtMs)) }
}

/**
 * The payload written when a request is OPENED — the placeholder the UI shows
 * a spinner for, and the same shape re-written once the environment details
 * have been gathered.
 *
 * It deliberately carries no timing: see the module docstring.
 */
export function openedApiReqInfo(fields: {
	apiProtocol: ShoferApiReqInfo["apiProtocol"]
	model: string | undefined
	retryAttempt: number
}): ShoferApiReqInfo {
	return {
		apiProtocol: fields.apiProtocol,
		model: fields.model,
		retryAttempt: fields.retryAttempt,
	}
}

/**
 * Stamp a stream-end payload with how long the request took.
 *
 * Call this on every rewrite that means the stream ended or is progressively
 * updating toward its end (usage drain, provider response metadata, an aborted
 * or failed stream) — never on the opening placeholder.
 */
export function endedApiReqInfo(info: ShoferApiReqInfo, timer: ApiRequestTimer): ShoferApiReqInfo {
	return { ...info, durationMs: timer.elapsedMs() }
}
