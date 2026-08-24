import { z } from "zod"

/**
 * W3C Trace Context (https://www.w3.org/TR/trace-context/) as it crosses a
 * process boundary into shofer.
 *
 * This is a **transport** type, not an observability implementation: core neither
 * parses `traceparent` nor depends on OpenTelemetry. It carries the two standard
 * header values from whoever started the work — a controller driving the AgentApi,
 * a job runner handing a dispatch to `ctx.agent.spawn` — to the observer that
 * knows what to do with them (a tracing plugin). A host with no such plugin
 * carries the strings and ignores them, which costs nothing and keeps the
 * causal chain recoverable if one is added later.
 *
 * Why the full header rather than a bare trace id: the sampling flags live only
 * in `traceparent`, so an id alone can be joined after the fact but never
 * RESUMED — a span opened under it would start a new sampling decision and
 * detach from the caller's trace.
 */
export const traceContextSchema = z.object({
	/** The `traceparent` header value, verbatim (`00-<trace-id>-<span-id>-<flags>`). */
	traceparent: z.string(),
	/** The `tracestate` header value, verbatim, when the caller sent one. */
	tracestate: z.string().optional(),
})

export type TraceContext = z.infer<typeof traceContextSchema>

/** The two W3C header names, spelled once so no call site re-types them. */
export const TRACEPARENT_HEADER = "traceparent"
export const TRACESTATE_HEADER = "tracestate"

/**
 * Read a {@link TraceContext} out of a bag of (already lower-cased) HTTP headers.
 *
 * `undefined` when there is no `traceparent` — an absent context is a fact
 * ("this work was started outside a trace"), never an error, so a caller that
 * propagates nothing is served exactly as before.
 */
export function traceContextFromHeaders(
	headers: Record<string, string | string[] | undefined>,
): TraceContext | undefined {
	const first = (value: string | string[] | undefined): string | undefined =>
		Array.isArray(value) ? value[0] : value
	const traceparent = first(headers[TRACEPARENT_HEADER])?.trim()
	if (!traceparent) return undefined
	const tracestate = first(headers[TRACESTATE_HEADER])?.trim()
	return tracestate ? { traceparent, tracestate } : { traceparent }
}

/** Render a {@link TraceContext} as the headers an outbound HTTP request should carry. */
export function traceContextToHeaders(trace: TraceContext | undefined): Record<string, string> {
	if (!trace?.traceparent) return {}
	return trace.tracestate
		? { [TRACEPARENT_HEADER]: trace.traceparent, [TRACESTATE_HEADER]: trace.tracestate }
		: { [TRACEPARENT_HEADER]: trace.traceparent }
}
