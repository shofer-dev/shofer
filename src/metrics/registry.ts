/**
 * Metrics registry for the Shofer VS Code extension (§8).
 *
 * Backed by the OpenTelemetry metrics API (`@opentelemetry/api`). Instruments
 * are created lazily, one per metric name, and cached. Counters/histograms/gauges
 * are emitted through the global `MeterProvider`; until the host registers an
 * OTel SDK (exporter + views), the API is a no-op, so this is zero-overhead and
 * works with any observability backend.
 *
 * ## Design notes
 *
 * - Histogram bucket boundaries are an SDK concern in OTel (configured via Views),
 *   not an instrument-creation parameter. The `*_BUCKETS_MS` presets below are
 *   kept as advisory hints for the operator's View config; `observeHistogram`
 *   accepts them for call-site documentation but does not apply them.
 * - Scrape-time gauges (process memory, queue depth, focused-task size) are
 *   modeled as OTel *observable* gauges via `registerObservableGauge`: the SDK
 *   invokes the callback at export time, so values are never stale and no
 *   event-loop-waking timer is needed.
 * - Process/runtime metrics (CPU, event-loop lag, heap, GC) come from the host's
 *   OTel runtime instrumentation (e.g. `@opentelemetry/instrumentation-runtime-node`),
 *   not a bespoke collector.
 */

import {
	metrics,
	type Counter,
	type Histogram,
	type Gauge,
	type ObservableGauge,
	type ObservableResult,
} from "@opentelemetry/api"
import { type CallStatus, type LlmErrorType, type ToolErrorType, type McpErrorType } from "@shofer/types"
import { setHistogramCallback } from "../utils/perf"

// ---------------------------------------------------------------------------
// Bucket presets (ms) — advisory hints for OTel SDK View configuration.
// ---------------------------------------------------------------------------

export const FAST_BUCKETS_MS = [1, 2.5, 5, 10, 25, 50, 100, 250, 500]
export const STD_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000]
export const SLOW_BUCKETS_MS = [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000]

// ---------------------------------------------------------------------------
// Instrument cache (one per metric name)
// ---------------------------------------------------------------------------

const meter = metrics.getMeter("shofer")

const _counters = new Map<string, Counter>()
const _histograms = new Map<string, Histogram>()
const _gauges = new Map<string, Gauge>()
const _observable = new Map<string, ObservableGauge>()

function getCounter(name: string, help: string): Counter {
	let c = _counters.get(name)
	if (!c) {
		c = meter.createCounter(name, { description: help })
		_counters.set(name, c)
	}
	return c
}

function getHistogram(name: string, help: string): Histogram {
	let h = _histograms.get(name)
	if (!h) {
		h = meter.createHistogram(name, { description: help })
		_histograms.set(name, h)
	}
	return h
}

function getGauge(name: string, help: string): Gauge {
	let g = _gauges.get(name)
	if (!g) {
		g = meter.createGauge(name, { description: help })
		_gauges.set(name, g)
	}
	return g
}

// ---------------------------------------------------------------------------
// Public registry facade (unchanged call-site API)
// ---------------------------------------------------------------------------

export const registry = {
	/** Observe a value on a histogram, creating it on first use. */
	observeHistogram(
		name: string,
		help: string,
		value: number,
		_buckets: number[] = STD_BUCKETS_MS,
		labels?: Record<string, string>,
	): void {
		getHistogram(name, help).record(value, labels)
	},

	/** Increment a counter, creating it on first use. */
	incCounter(name: string, help: string, labels?: Record<string, string>, amount = 1): void {
		getCounter(name, help).add(amount, labels)
	},

	/** Set a gauge to an absolute value, creating it on first use. */
	setGauge(name: string, help: string, value: number, labels?: Record<string, string>): void {
		getGauge(name, help).record(value, labels)
	},

	/**
	 * Register an observable gauge whose callback the OTel SDK polls at export
	 * time. Idempotent per `name`. Use for O(1) snapshots (memory, queue depth)
	 * that should always reflect current state without a timer.
	 */
	registerObservableGauge(name: string, help: string, observe: (result: ObservableResult) => void): void {
		if (_observable.has(name)) return
		const g = meter.createObservableGauge(name, { description: help })
		g.addCallback(observe)
		_observable.set(name, g)
	},
}

// ---------------------------------------------------------------------------
// time() → histogram routing table
// ---------------------------------------------------------------------------

interface TimeRoute {
	name: string
	help: string
	buckets: number[]
}

const TIME_ROUTES: Record<string, TimeRoute> = {
	saveShoferMessages: {
		name: "shofer_save_messages_duration_ms",
		help: "Duration of Task.saveShoferMessages (ms).",
		buckets: STD_BUCKETS_MS,
	},
	preloadShoferMessages: {
		name: "shofer_preload_duration_ms",
		help: "Duration of Task.preloadShoferMessages (ms).",
		buckets: STD_BUCKETS_MS,
	},
	postInitState: {
		name: "shofer_post_init_state_duration_ms",
		help: "Duration of ShoferProvider.postInitState (ms).",
		buckets: STD_BUCKETS_MS,
	},
	createTaskWithHistoryItem: {
		name: "shofer_task_switch_duration_ms",
		help: "Duration of ShoferProvider.createTaskWithHistoryItem (ms).",
		buckets: STD_BUCKETS_MS,
	},
}

setHistogramCallback((key: string, ms: number) => {
	const route = TIME_ROUTES[key]
	if (route) {
		registry.observeHistogram(route.name, route.help, ms, route.buckets)
		return
	}
	// Catch-all for ad-hoc time() call sites that have not been wired into
	// the route table yet.  Their values land in a single labeled histogram
	// keyed by `operation`.
	registry.observeHistogram(
		"shofer_generic_duration_ms",
		"Generic duration histogram for un-routed time() call sites.",
		ms,
		STD_BUCKETS_MS,
		{ operation: key },
	)
})

// ---------------------------------------------------------------------------
// Closed-enum error classifiers
// ---------------------------------------------------------------------------

export function classifyLlmError(error: unknown): LlmErrorType {
	const msg = error instanceof Error ? error.message : String(error)
	const m = msg.toLowerCase()
	if (m.includes("rate") && (m.includes("limit") || m.includes("exceeded") || m.includes("quota")))
		return "rate_limit"
	if (m.includes("timeout") || (m.includes("timed") && m.includes("out"))) return "timeout"
	if (m.includes("auth") || m.includes("unauthorized") || m.includes("credential")) return "auth_error"
	if (m.includes("context") && m.includes("window")) return "context_window"
	if (m.includes("api") || m.includes("status") || m.includes("http")) return "api_error"
	return "unknown"
}

export function classifyMcpError(error: unknown): McpErrorType {
	const msg = error instanceof Error ? error.message : String(error)
	const m = msg.toLowerCase()
	if (m.includes("timeout") || (m.includes("timed") && m.includes("out"))) return "timeout"
	if (m.includes("cancelled") || m.includes("aborted")) return "cancelled"
	if (m.includes("server") && m.includes("error")) return "server_error"
	return "unknown"
}

export function classifyToolError(error: unknown): ToolErrorType {
	if (!(error instanceof Error)) return "unknown"
	const m = error.message.toLowerCase()
	if (m.includes("timeout") || m.includes("timed out")) return "timeout"
	if (m.includes("enoent") || m.includes("not found")) return "not_found"
	if (m.includes("permission") || m.includes("eacces")) return "permission"
	if (m.includes("cancelled") || m.includes("aborted")) return "cancelled"
	return "unknown"
}

/** Map an MCP `errorType` into a `status` label value. */
export function mcpErrorTypeToStatus(t: McpErrorType): CallStatus {
	switch (t) {
		case "timeout":
			return "timeout"
		case "cancelled":
			return "cancelled"
		case "server_error":
		case "unknown":
			return "error"
	}
}

// ---------------------------------------------------------------------------
// Typed convenience helpers (single per-metric definitions)
// ---------------------------------------------------------------------------

// --- LLM ---

const LLM_DURATION = "shofer_llm_duration_ms"
const LLM_CALLS = "shofer_llm_calls_total"
const LLM_ERRORS = "shofer_llm_errors_total"
const LLM_COST = "shofer_llm_cost_usd_total"
const LLM_TOKENS = "shofer_llm_tokens_total"

export function recordLlmDuration(provider: string, modelId: string, ms: number): void {
	registry.observeHistogram(LLM_DURATION, "LLM API call duration (ms).", ms, SLOW_BUCKETS_MS, { provider, modelId })
}

export function incLlmCalls(provider: string, modelId: string, status: CallStatus): void {
	registry.incCounter(LLM_CALLS, "Total LLM API calls by status.", { provider, modelId, status })
}

export function incLlmErrors(provider: string, modelId: string, errorType: LlmErrorType): void {
	registry.incCounter(LLM_ERRORS, "Total LLM API errors by errorType.", { provider, modelId, errorType })
}

/** Add a request's USD cost to the cumulative LLM cost counter. No-op for non-positive/unknown cost. */
export function incLlmCost(provider: string, modelId: string, usd: number): void {
	if (!(usd > 0) || !Number.isFinite(usd)) return
	registry.incCounter(LLM_COST, "Cumulative LLM cost in USD by provider and model.", { provider, modelId }, usd)
}

/**
 * Add a request's token counts to the cumulative LLM token counter, split by
 * `direction`. The four directions mirror the `LLM_COMPLETION` telemetry
 * breakdown (input / output / cache_read / cache_write) so OTel and PostHog
 * agree; note `input` follows each protocol's own convention (OpenAI counts
 * include cached prompt tokens, Anthropic counts do not).
 */
export function incLlmTokens(
	provider: string,
	modelId: string,
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number },
): void {
	const add = (direction: string, n: number) => {
		if (n > 0 && Number.isFinite(n)) {
			registry.incCounter(
				LLM_TOKENS,
				"Cumulative LLM tokens by provider, model, and direction.",
				{ provider, modelId, direction },
				n,
			)
		}
	}
	add("input", tokens.input)
	add("output", tokens.output)
	add("cache_read", tokens.cacheRead)
	add("cache_write", tokens.cacheWrite)
}

// --- Tools ---

const TOOL_DURATION = "shofer_tool_duration_ms"
const TOOL_CALLS = "shofer_tool_calls_total"
const TOOL_ERRORS = "shofer_tool_errors_total"

export function recordToolDuration(tool: string, ms: number): void {
	registry.observeHistogram(TOOL_DURATION, "Tool execution duration (ms).", ms, STD_BUCKETS_MS, { tool })
}

export function incToolCalls(tool: string, status: Extract<CallStatus, "success" | "error">): void {
	registry.incCounter(TOOL_CALLS, "Total tool calls by status.", { tool, status })
}

export function incToolErrors(tool: string, errorType: ToolErrorType): void {
	registry.incCounter(TOOL_ERRORS, "Total tool errors by errorType.", { tool, errorType })
}

// --- MCP ---

const MCP_DURATION = "shofer_mcp_duration_ms"
const MCP_CALLS = "shofer_mcp_calls_total"
const MCP_ERRORS = "shofer_mcp_errors_total"

export function recordMcpDuration(server: string, tool: string, ms: number): void {
	registry.observeHistogram(MCP_DURATION, "MCP call duration (ms).", ms, SLOW_BUCKETS_MS, { server, tool })
}

export function incMcpCalls(server: string, tool: string, status: CallStatus): void {
	registry.incCounter(MCP_CALLS, "Total MCP calls by status.", { server, tool, status })
}

export function incMcpErrors(server: string, tool: string, errorType: McpErrorType): void {
	registry.incCounter(MCP_ERRORS, "Total MCP errors by errorType.", { server, tool, errorType })
}

// --- Task lifecycle ---

export function incTaskCreated(mode: string): void {
	registry.incCounter("shofer_tasks_created_total", "Total tasks created.", { mode })
}

export function incTaskCompleted(mode: string, rating: string): void {
	registry.incCounter("shofer_tasks_completed_total", "Total tasks completed by rating.", { mode, rating })
}

export function incTaskErrored(mode: string, errorType: string): void {
	registry.incCounter("shofer_tasks_errored_total", "Total tasks errored by errorType.", { mode, errorType })
}

// --- Code index ---

export function incCodeIndexError(subsystem: string, amount = 1): void {
	registry.incCounter(
		"shofer_code_index_errors_total",
		"Total code-index errors by subsystem.",
		{ subsystem },
		amount,
	)
}

export function recordIndexLoadDuration(ms: number): void {
	registry.observeHistogram("shofer_index_load_duration_ms", "Duration of _index.json load (ms).", ms, STD_BUCKETS_MS)
}

export function recordIndexWriteDuration(ms: number): void {
	registry.observeHistogram(
		"shofer_index_write_duration_ms",
		"Duration of _index.json write (ms).",
		ms,
		STD_BUCKETS_MS,
	)
}

export function updateCodeIndexMetrics(fileCount: number, embedderQueueDepth: number, provider: string): void {
	registry.setGauge("shofer_code_index_files", "Number of indexed files.", fileCount)
	registry.setGauge("shofer_embedder_queue_depth", "Embedder pending-queue depth per provider.", embedderQueueDepth, {
		provider,
	})
}

// --- Metrics-pipeline self-observation ---

export function incWebviewPushError(): void {
	registry.incCounter(
		"shofer_metrics_webview_push_errors_total",
		"Total failed validations of inbound pushMetrics payloads.",
	)
}
