/**
 * Shared Prometheus-metric vocabulary used across the extension host
 * and the webview.
 *
 * Two responsibilities:
 *   1. Closed enums for label values (`status`, `errorType`) so the
 *      Prometheus label-cardinality stays bounded.  See AGENTS.md
 *      "Exhaustive Switch Rule".
 *   2. The wire schema for `pushMetrics` (webview → extension host),
 *      validated with `safeParse` at the IPC boundary before being
 *      forwarded to the in-memory registry.
 *
 * Anything serialized over postMessage MUST go through these schemas
 * (Schema-First Persistence Rule).
 */

import { z } from "zod"

// ---------------------------------------------------------------------------
// Closed enums — these MUST stay small (<10 values) to bound cardinality.
// ---------------------------------------------------------------------------

export const callStatusSchema = z.enum(["success", "error", "timeout", "cancelled"])
export type CallStatus = z.infer<typeof callStatusSchema>

export const llmErrorTypeSchema = z.enum([
	"api_error",
	"rate_limit",
	"timeout",
	"auth_error",
	"context_window",
	"unknown",
])
export type LlmErrorType = z.infer<typeof llmErrorTypeSchema>

export const toolErrorTypeSchema = z.enum(["timeout", "not_found", "permission", "cancelled", "unknown"])
export type ToolErrorType = z.infer<typeof toolErrorTypeSchema>

export const mcpErrorTypeSchema = z.enum(["timeout", "cancelled", "server_error", "unknown"])
export type McpErrorType = z.infer<typeof mcpErrorTypeSchema>

// ---------------------------------------------------------------------------
// Webview → host push payload
// ---------------------------------------------------------------------------

/**
 * Allowlist of metric names the webview is permitted to observe.  Anything
 * not in this list is silently dropped at the boundary (and counted in
 * `shofer_metrics_webview_push_errors_total`).
 */
export const webviewHistogramNames = ["shofer_webview_render_duration_ms"] as const
export type WebviewHistogramName = (typeof webviewHistogramNames)[number]

export const webviewCounterNames = ["shofer_webview_messages_total", "shofer_webview_postmessage_errors_total"] as const
export type WebviewCounterName = (typeof webviewCounterNames)[number]

const labelMapSchema = z.record(z.string(), z.string())

export const webviewHistogramObservationSchema = z.object({
	name: z.enum(webviewHistogramNames),
	labels: labelMapSchema.optional(),
	value: z.number().finite().nonnegative(),
})
export type WebviewHistogramObservation = z.infer<typeof webviewHistogramObservationSchema>

export const webviewCounterObservationSchema = z.object({
	name: z.enum(webviewCounterNames),
	labels: labelMapSchema.optional(),
	value: z.number().finite().nonnegative(),
})
export type WebviewCounterObservation = z.infer<typeof webviewCounterObservationSchema>

export const webviewMetricsPushSchema = z.object({
	histograms: z.array(webviewHistogramObservationSchema).max(1024).optional(),
	counters: z.array(webviewCounterObservationSchema).max(1024).optional(),
})
export type WebviewMetricsPush = z.infer<typeof webviewMetricsPushSchema>
