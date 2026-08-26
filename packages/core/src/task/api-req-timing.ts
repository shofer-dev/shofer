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
 * the model spent ten of them reasoning. `firstChunkMs`, `thinkingMs` and
 * `reasoningIntervalsMs` split the same span into the phases a reader can act
 * on — waiting for the provider, reasoning, producing output. They are NOT
 * measured again here: {@link endedApiReqInfo} takes the marks the streaming
 * loop already recorded, so the paired and unpaired accounts of one request can
 * never disagree.
 *
 * Their presence rules are as deliberate as `durationMs`'s:
 *
 * - `firstChunkMs` is present once ANY chunk has arrived, and absent when the
 *   stream produced nothing at all (an immediate provider failure) — there is
 *   no first byte to time in that case, and zero would claim there was one.
 * - `reasoningIntervalsMs` is present when at least one reasoning interval was
 *   observed, and absent when none was. An EMPTY ARRAY is never written: a
 *   consumer must be able to read "no thinking phase" off the field's absence
 *   rather than off a length it would have to special-case.
 * - `thinkingMs` is the SUM of those intervals, and its presence rule is
 *   therefore the same one: both fields are written together or neither is.
 *
 * # Why the INTERVALS, and not one boundary
 *
 * A model that reasons, answers, reasons again and answers again is entirely
 * ordinary, and a single `first chunk → first non-reasoning chunk` boundary
 * collapses all of it into the first thinking pause — every later one is drawn
 * as output. That boundary is what `api_req_finished` carries as `ttfbMs` /
 * `genStartOffsetMs`, and it KEEPS carrying exactly that: the intervals' one
 * home is this payload, deliberately, because this is the record that survives
 * every path. The finished span is not guaranteed to exist; the rewritten
 * started message always is. Adding the intervals in two places would create
 * two accounts of one stream that can drift, for a reader that already has to
 * handle the started payload alone.
 *
 * An interval still OPEN when the stream ends is closed at the request's own
 * end (the same instant `durationMs` states), because that time genuinely was
 * spent reasoning — a stream that died mid-thought has a reasoning window, it
 * simply has no output after it.
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
 * A reasoning interval as the streaming loop holds it: offsets in fractional
 * milliseconds from the request's open.
 */
export type ReasoningInterval = readonly [start: number, end: number]

/**
 * The stream milestones the agent loop records while chunks arrive, in the form
 * it holds them: offsets in fractional milliseconds from the request's open, and
 * `null` for "not seen yet".
 *
 * `ttfbMs` / `genStartOffsetMs` are deliberately the SAME pair `api_req_finished`
 * publishes — the caller passes its own live marks, so nothing here starts a
 * second clock.
 */
export interface StreamPhaseMarks {
	/** Offset of the first chunk of ANY kind; `null` until one arrives. */
	ttfbMs: number | null
	/**
	 * Offset of the first NON-reasoning chunk (text or tool call) — where output
	 * generation began. `null` until one arrives, which is also the state a
	 * stream that ended mid-reasoning leaves behind.
	 *
	 * Retained because it is what the `api_req_finished` span publishes; the
	 * phase split below is derived from the intervals, not from this boundary.
	 */
	genStartOffsetMs: number | null
	/**
	 * Reasoning intervals the stream has already CLOSED — each one a reasoning
	 * run terminated by a non-reasoning chunk, in arrival order.
	 */
	reasoningIntervalsMs: ReadonlyArray<ReasoningInterval>
	/**
	 * Offset at which a still-OPEN reasoning run began, or `null` when the
	 * stream is not currently reasoning. Closed at the payload's own end by
	 * {@link streamPhaseFields}.
	 */
	reasoningOpenedAtMs: number | null
}

/**
 * The phase fields a stream-end payload carries, given what the stream showed.
 *
 * Exported so the presence rules stated in the module docstring can be asserted
 * directly: a field this returns is a measurement, and a field it OMITS is the
 * statement that there is nothing to draw.
 *
 * @param endedAtMs - The request's own end, in whole milliseconds from its open
 *   — the value the same payload states as `durationMs`. A reasoning run still
 *   open at that point is closed there, which is what keeps every interval
 *   inside the bar the consumer draws.
 */
export function streamPhaseFields(
	marks: StreamPhaseMarks,
	endedAtMs: number,
): Pick<ShoferApiReqInfo, "firstChunkMs" | "thinkingMs" | "reasoningIntervalsMs"> {
	const fields: Pick<ShoferApiReqInfo, "firstChunkMs" | "thinkingMs" | "reasoningIntervalsMs"> = {}
	if (marks.ttfbMs === null) {
		// Nothing ever arrived: there is no first byte, and no window between a
		// first byte and anything else.
		return fields
	}
	fields.firstChunkMs = Math.max(0, Math.round(marks.ttfbMs))

	const open: ReasoningInterval[] = marks.reasoningOpenedAtMs === null ? [] : [[marks.reasoningOpenedAtMs, endedAtMs]]
	const intervals: Array<[number, number]> = []
	let thinking = 0
	for (const [start, end] of [...marks.reasoningIntervalsMs, ...open]) {
		// Both ends are floored at zero: an offset before the request opened is a
		// clock artefact, not a window to publish.
		const from = Math.max(0, Math.round(start))
		const to = Math.max(0, Math.round(end))
		// Sub-millisecond (or, from a clock hiccup, inverted) is dropped rather
		// than drawn as a zero-width band — see the module docstring.
		if (to - from < 1) {
			continue
		}
		intervals.push([from, to])
		thinking += to - from
	}
	if (intervals.length > 0) {
		fields.reasoningIntervalsMs = intervals
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
	const durationMs = timer.elapsedMs()
	return { ...info, durationMs, ...streamPhaseFields(marks, durationMs) }
}
