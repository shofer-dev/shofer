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
 * # The PHASES inside that duration
 *
 * A duration alone says a request took eleven seconds; it does not say whether
 * the model spent ten of them reasoning. `firstChunkMs` and `thinkingMs` split
 * the same span into the three phases a reader can act on — waiting for the
 * provider, reasoning, producing output — and they are exactly the two facts
 * the `api_req_finished` span already carries as `ttfbMs` and
 * `genStartOffsetMs`. They are NOT measured again here: {@link endedApiReqInfo}
 * takes the marks the streaming loop already recorded, so the paired and
 * unpaired accounts of one request can never disagree.
 *
 * Their presence rules are as deliberate as `durationMs`'s:
 *
 * - `firstChunkMs` is present once ANY chunk has arrived, and absent when the
 *   stream produced nothing at all (an immediate provider failure) — there is
 *   no first byte to time in that case, and zero would claim there was one.
 * - `thinkingMs` is present ONLY when a reasoning phase was both observed and
 *   CLOSED by a non-reasoning chunk, and lasted at least one whole millisecond.
 *   **Absence means "no thinking phase"; zero is never written.** A model that
 *   emitted no reasoning, and a stream that died still reasoning, are both
 *   "there is no reasoning window to draw" — and a consumer that segments a bar
 *   on this field must be able to read that off the field's absence rather than
 *   off a zero it would have to special-case.
 *
 * # Why `firstChunkMs` is not called `ttfbMs`
 *
 * `ShoferApiReqInfo` already HAS a `ttfbMs`, and it is a different observer's
 * number: the one shofer-router reports for itself in the `response_metadata`
 * chunk, present only for router-served requests. This one is the HOST's — the
 * agent loop timing when the first chunk reached IT, over the same span
 * `durationMs` covers. Two measurements of two things need two names.
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
 * The stream milestones the agent loop records while chunks arrive, in the form
 * it holds them: offsets in fractional milliseconds from the request's open, and
 * `null` for "not seen yet".
 *
 * This is deliberately the SAME pair `api_req_finished` publishes as `ttfbMs`
 * and `genStartOffsetMs` — the caller passes its own live marks, so nothing here
 * starts a second clock.
 */
export interface StreamPhaseMarks {
	/** Offset of the first chunk of ANY kind; `null` until one arrives. */
	ttfbMs: number | null
	/**
	 * Offset of the first NON-reasoning chunk (text or tool call) — where output
	 * generation began. `null` until one arrives, which is also the state a
	 * stream that ended mid-reasoning leaves behind.
	 */
	genStartOffsetMs: number | null
}

/**
 * The phase fields a stream-end payload carries, given what the stream showed.
 *
 * Exported so the presence rules stated in the module docstring can be asserted
 * directly: a field this returns is a measurement, and a field it OMITS is the
 * statement that there is nothing to draw.
 */
export function streamPhaseFields(marks: StreamPhaseMarks): Pick<ShoferApiReqInfo, "firstChunkMs" | "thinkingMs"> {
	const fields: Pick<ShoferApiReqInfo, "firstChunkMs" | "thinkingMs"> = {}
	if (marks.ttfbMs === null) {
		// Nothing ever arrived: there is no first byte, and no window between a
		// first byte and anything else.
		return fields
	}
	fields.firstChunkMs = Math.max(0, Math.round(marks.ttfbMs))
	if (marks.genStartOffsetMs === null) {
		return fields
	}
	const thinking = Math.round(marks.genStartOffsetMs - marks.ttfbMs)
	// Sub-millisecond (or, from a clock hiccup, negative) is reported as no
	// thinking phase rather than as a zero-width one — see the module docstring.
	if (thinking >= 1) {
		fields.thinkingMs = thinking
	}
	return fields
}

/**
 * Stamp a stream-end payload with how long the request took, and how that time
 * split between waiting, reasoning and output.
 *
 * Call this on every rewrite that means the stream ended or is progressively
 * updating toward its end (usage drain, provider response metadata, an aborted
 * or failed stream) — never on the opening placeholder.
 *
 * @param marks - The caller's OWN live stream milestones. Required rather than
 *   optional so a new rewrite site cannot quietly ship a duration with no phases.
 */
export function endedApiReqInfo(
	info: ShoferApiReqInfo,
	timer: ApiRequestTimer,
	marks: StreamPhaseMarks,
): ShoferApiReqInfo {
	return { ...info, durationMs: timer.elapsedMs(), ...streamPhaseFields(marks) }
}
