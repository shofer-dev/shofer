/**
 * Prometheus metrics registry for the Shofer VS Code extension.
 *
 * Backed by `prom-client` — gives correct text-format exposition, proper
 * `Counter`/`Gauge`/`Histogram` semantics with first-class label sets, and
 * default Node.js process metrics
 * (`process_cpu_seconds_total`, `nodejs_eventloop_lag_seconds`,
 * `nodejs_heap_size_used_bytes`, GC duration histogram, …) for free.
 *
 * Always-on, independent of the user telemetry opt-in.  Scraped by
 * Prometheus via the `/metrics` endpoint on `127.0.0.1:<port>`.
 *
 * ## Design notes
 *
 * - One `prom-client` instrument per metric name; per-labelset state is
 *   handled internally by `prom-client`, so quantiles are correct even
 *   when multiple call sites share a metric name.
 * - A per-window `windowId` is attached as a registry default label so
 *   multiple VS Code windows on one host produce disambiguable series.
 * - `registerCollector()` lets the HTTP server pull fresh gauge values
 *   synchronously at scrape time, so memory / queue depth are never stale.
 * - GC observation uses the top-level `PerformanceObserver` export of
 *   `perf_hooks` (NOT a property of `performance`); no V8 flag required.
 *   `prom-client`'s default metrics also include a GC histogram, but the
 *   Shofer-specific `shofer_gc_*` metrics keep the prefix consistent with
 *   the rest of the catalog.
 */

import client from "prom-client"
import { type CallStatus, type LlmErrorType, type ToolErrorType, type McpErrorType } from "@shofer/types"
import { setHistogramCallback } from "../utils/perf"
import { getWindowId, getWorkspaceLabel } from "./identity"

// ---------------------------------------------------------------------------
// Bucket presets (ms)
// ---------------------------------------------------------------------------

export const FAST_BUCKETS_MS = [1, 2.5, 5, 10, 25, 50, 100, 250, 500]
export const STD_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000]
export const SLOW_BUCKETS_MS = [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000]

// ---------------------------------------------------------------------------
// Registry singleton
// ---------------------------------------------------------------------------

// Use a dedicated registry (not the prom-client default) so we own the full
// label/metric space and never collide with libraries that may populate the
// global default register.
const _register = new client.Registry()

// Per-window default label — appended to every series emitted by this
// registry.  Mints stability for multi-window Prometheus targets.
_register.setDefaultLabels({ windowId: getWindowId() })

// Node.js process metrics (CPU, event-loop lag, heap, GC, file descriptors).
client.collectDefaultMetrics({ register: _register })

// Constant `shofer_window_info{workspace="…"} 1` gauge: lets Grafana join
// `windowId` back onto a human-readable workspace path.
new client.Gauge({
	name: "shofer_window_info",
	help: "Constant 1 per VS Code window; labels identify the window.",
	labelNames: ["workspace"],
	registers: [_register],
	collect() {
		this.set({ workspace: getWorkspaceLabel() }, 1)
	},
})

// ---------------------------------------------------------------------------
// Get-or-create helpers
//
// `prom-client` throws on duplicate registration; lookups via
// `getSingleMetric()` let the public `registry.observeHistogram()` /
// `incCounter()` API stay create-on-first-use while still hitting a single
// instrument per name.
// ---------------------------------------------------------------------------

function getOrCreateCounter(name: string, help: string, labelNames: string[]): client.Counter<string> {
	const existing = _register.getSingleMetric(name) as client.Counter<string> | undefined
	if (existing) return existing
	return new client.Counter({ name, help, labelNames, registers: [_register] })
}

function getOrCreateGauge(name: string, help: string, labelNames: string[]): client.Gauge<string> {
	const existing = _register.getSingleMetric(name) as client.Gauge<string> | undefined
	if (existing) return existing
	return new client.Gauge({ name, help, labelNames, registers: [_register] })
}

function getOrCreateHistogram(
	name: string,
	help: string,
	labelNames: string[],
	buckets: number[],
): client.Histogram<string> {
	const existing = _register.getSingleMetric(name) as client.Histogram<string> | undefined
	if (existing) return existing
	return new client.Histogram({ name, help, labelNames, buckets, registers: [_register] })
}

// ---------------------------------------------------------------------------
// Public registry facade
// ---------------------------------------------------------------------------

const _collectors: Array<() => void> = []

export const registry = {
	/** Observe a value on a histogram, creating it on first use. */
	observeHistogram(
		name: string,
		help: string,
		value: number,
		buckets: number[] = STD_BUCKETS_MS,
		labels?: Record<string, string>,
	): void {
		const labelNames = labels ? Object.keys(labels) : []
		const h = getOrCreateHistogram(name, help, labelNames, buckets)
		if (labels) h.observe(labels, value)
		else h.observe(value)
	},

	/** Increment a counter, creating it on first use. */
	incCounter(name: string, help: string, labels?: Record<string, string>, amount = 1): void {
		const labelNames = labels ? Object.keys(labels) : []
		const c = getOrCreateCounter(name, help, labelNames)
		if (labels) c.inc(labels, amount)
		else c.inc(amount)
	},

	/** Set a gauge to an absolute value, creating it on first use. */
	setGauge(name: string, help: string, value: number, labels?: Record<string, string>): void {
		const labelNames = labels ? Object.keys(labels) : []
		const g = getOrCreateGauge(name, help, labelNames)
		if (labels) g.set(labels, value)
		else g.set(value)
	},

	/**
	 * Register a function to run synchronously immediately before
	 * `exposition()` renders.  Use for O(1) gauge refreshes (memory,
	 * queue depth) so the scrape always sees current values without
	 * an event-loop-waking timer.
	 */
	registerCollector(fn: () => void): void {
		_collectors.push(fn)
	},

	/** Render the registry in Prometheus text format. */
	async exposition(): Promise<string> {
		for (const fn of _collectors) {
			try {
				fn()
			} catch {
				// A misbehaving collector must not block the scrape.
			}
		}
		return _register.metrics()
	},

	/** Prometheus `Content-Type` for the exposition format. */
	get contentType(): string {
		return _register.contentType
	},
}

// ---------------------------------------------------------------------------
// time() → histogram routing table
//
// Mapping from the `time(key, …)` label to (canonical metric name, bucket
// preset).  Adding a new instrumented operation means appending one entry
// here — no `switch` statement, no string-coupling between caller and
// registry.
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
 * breakdown (input / output / cache_read / cache_write) so Prometheus and
 * PostHog agree; note `input` follows each protocol's own convention (OpenAI
 * counts include cached prompt tokens, Anthropic counts do not).
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

// --- Process / memory gauges (callable from a registered collector) ---

export function updateMemoryMetrics(): void {
	const mem = process.memoryUsage()
	registry.setGauge("shofer_heap_used_bytes", "process.memoryUsage().heapUsed.", mem.heapUsed)
	registry.setGauge("shofer_heap_total_bytes", "process.memoryUsage().heapTotal.", mem.heapTotal)
	registry.setGauge("shofer_rss_bytes", "process.memoryUsage().rss.", mem.rss)
}

export function updateFocusedTaskMetrics(messageCount: number, messageBytes: number): void {
	registry.setGauge("shofer_messages_total", "Messages on focused task.", messageCount)
	registry.setGauge("shofer_messages_bytes", "Serialized byte size of focused task messages.", messageBytes)
}

export function updateTaskMetrics(total: number, active: number): void {
	registry.setGauge("shofer_tasks_total", "Total tasks in history store.", total)
	registry.setGauge("shofer_active_tasks", "Active managed tasks (abort === false).", active)
}

export function updateEventListenerMetrics(count: number): void {
	registry.setGauge("shofer_event_listeners_total", "Number of listeners attached to ShoferProvider.", count)
}

export function updateCodeIndexMetrics(fileCount: number, embedderQueueDepth: number, provider: string): void {
	registry.setGauge("shofer_code_index_files", "Number of indexed files.", fileCount)
	registry.setGauge("shofer_embedder_queue_depth", "Embedder pending-queue depth per provider.", embedderQueueDepth, {
		provider,
	})
}

// --- Metrics-pipeline self-observation ---

export function incMetricsScrape(): void {
	registry.incCounter("shofer_metrics_scrapes_total", "Total successful /metrics responses.")
}

export function recordMetricsScrapeDuration(ms: number): void {
	registry.observeHistogram(
		"shofer_metrics_scrape_duration_ms",
		"Wall time spent rendering /metrics exposition (ms).",
		ms,
		FAST_BUCKETS_MS,
	)
}

export function incWebviewPushError(): void {
	registry.incCounter(
		"shofer_metrics_webview_push_errors_total",
		"Total failed validations of inbound pushMetrics payloads.",
	)
}

export function incMetricsServerRestart(): void {
	registry.incCounter("shofer_metrics_server_restarts_total", "Times the metrics HTTP server had to rebind.")
}
