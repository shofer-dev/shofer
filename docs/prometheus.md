# Prometheus / Observability for Shofer VS Code Extension

> **Status (verified May 2026):** Phases 1–2 fully implemented, and **most of Phase 3 has shipped** — the doc previously listed it as "pending," which is stale. Implemented today: prom-client registry + `/metrics` HTTP server, `time()` latency histograms, **LLM/tool/MCP latency + error counters wired at their real call sites** (`Task.ts`, `BaseTool.execute()`, `McpHub`), memory/process gauges, `shofer_event_listeners_total`, the `metrics_self_*` family, and the `arkware.heapSnapshot` command. LLM **cost/token** counters (`shofer_llm_cost_usd_total`, `shofer_llm_tokens_total`) were added alongside the duration/call metrics. `shofer_embedder_queue_depth` is now wired to the real per-provider concurrency-lane depth (no longer stubbed to `0`), and GC pause visibility is provided by `collectDefaultMetrics`' `nodejs_gc_duration_seconds` (a bespoke `shofer_gc_*` family is intentionally not implemented — redundant). **Genuinely still missing:** only the **webview-side metrics sender** (Phase 4 — the host-side ingestion, Zod schema, and `/metrics` exposure are all already built; only the webview emitter is missing). Phase 5 (Grafana dashboard) is pending.
>
> **Gating:** the entire `/metrics` server only starts when the `PROMETHEUS_METRICS` experiment is enabled (`extension.ts` checks `EXPERIMENT_IDS.PROMETHEUS_METRICS` before `startMetricsServer`). When the experiment is off, no server binds and no metrics are exposed.
>
> **Motivation:** Shofer has no operational dashboard. A Prometheus-scraped HTTP endpoint inside the extension host gives real-time insight into latency distributions, memory health, task throughput, and resource usage — all exposed as standard Prometheus metrics, viewable in Grafana alongside the rest of the arkware.ai infrastructure.

---

## 1. Metrics HTTP Endpoint

### 1.1 Server lifecycle

The extension host runs per VS Code window — one process, one server.

- **Port**: static, read from `SHOFER_METRICS_PORT` env var (default **30099**).
  A static port lets Prometheus point at a fixed target with no file-SD sidecar.
  If the port is already bound when a second VS Code window tries to start,
  `startMetricsServer` rejects and the extension logs an error — one window wins.
- **Start**: during `activate()`, **gated behind the `PROMETHEUS_METRICS`
  experiment** (`extension.ts` checks `EXPERIMENT_IDS.PROMETHEUS_METRICS` before
  calling `startMetricsServer`). With the experiment off, the server never binds.
  A per-PID metadata file (`globalStorage/metrics-ports/<pid>-<windowId>.json`)
  is written for windowId / workspace labelling.
- **Stop**: on `deactivate()`, close the server.
- **Readiness**: the server returns `200 OK` from `/health` once the provider
  is fully initialized (`taskHistoryStoreInitialized === true`).

### 1.2 Endpoints

| Path       | Method | Description                                                              |
| ---------- | ------ | ------------------------------------------------------------------------ |
| `/metrics` | GET    | Prometheus text format exposition (one-line `<name>{<labels>} <value>`). |
| `/health`  | GET    | `200 OK` when provider is initialized; `503` during startup.             |

### 1.3 Webview-side metrics (browser)

The webview runs in the browser context of the VS Code window. It cannot run its
own HTTP server, so it pushes metrics to the extension host registry via a
dedicated `WebviewMessage` variant (`pushMetrics`). All webview data is then
exposed on the shared `/metrics` endpoint — one scrape target per VS Code window.

**Cross-origin**: the extension host serves `/metrics` on `127.0.0.1:<port>`,
the same origin as the webview — no CORS issues.

**Reliability**: webview → extension host pushes are best-effort. If the
extension host crashes or the webview is torn down before a push, metrics are
lost. Mitigate by keeping a small in-memory buffer in the webview and
pushing on a fixed interval (e.g. every 30 s).

### 1.4 Scrape config

Because the port is static, no file-SD sidecar is needed:

```yaml
- job_name: shofer
  scrape_interval: 15s
  static_configs:
      - targets: ["<workstation-ip>:30099"]
        labels:
            host: "<hostname>"
```

Override the port with the `SHOFER_METRICS_PORT` environment variable when
30099 conflicts with another service on a host.

### 1.5 Independence from `TELEMETRY_ENABLED`

The `/metrics` endpoint and all metrics in §4 are **fully independent** of
`TELEMETRY_ENABLED`. The telemetry pipeline (`TelemetryService` → PostHog) is for
**user analytics only** (cross-user aggregates in PostHog Cloud). The Prometheus
pipeline (`src/metrics/registry.ts` → `/metrics`) is for **operational
monitoring only** (always-on, per-instance, no user opt-in required). The two
pipelines share call sites but have independent instrumentation paths.

---

## 2. Method-Level Instrumentation (`time()` helper) ✅

### 2.1 Design

A `time<T>(key, fn)` helper (see [`src/utils/perf.ts`](../src/utils/perf.ts)) wraps any async call, measures wall time, pushes to a ring buffer, and emits percentile summaries to the output channel on extension deactivation. The original `@perf` decorator design was superseded by `time()` (§7.1).

### 2.2 High-latency call sites (priorities for instrumentation)

The following operations are confirmed slow (>100 ms under typical conditions)
and are the primary targets for `time()` / registry instrumentation:

| Method                            | File                                        | Typical Latency | Notes                                                                  |
| --------------------------------- | ------------------------------------------- | --------------- | ---------------------------------------------------------------------- |
| `resumeTaskFromHistory`           | `core/task/Task.ts`                         | 500 ms – 2 s    | Loads UI messages + API history from disk; task startup hot path       |
| `saveShoferMessages`              | `core/task/Task.ts`                         | 100 – 500 ms    | `JSON.stringify` of large message array + disk write; debounced 250 ms |
| `postStateToWebview`              | `core/webview/ShoferProvider.ts`            | 100 – 500 ms    | Serializes full extension state + VS Code IPC serialization            |
| `createMessage` (LLM API)         | `api/providers/*.ts`                        | 1 – 30 s        | Network + model inference; primary task-loop blocking call             |
| `countTokens`                     | `utils/countTokens.ts`                      | 10 – 100 ms     | tiktoken WASM; large histories are at the slow end                     |
| `loadRequiredLanguageParsers`     | `services/tree-sitter/languageParser.ts`    | 500 ms – 2 s    | WASM grammar loading; first-call only but blocks startup               |
| `searchIndex`                     | `services/code-index/search-service.ts`     | 200 ms – 2 s    | Embedding + Qdrant vector search; user wait path                       |
| Full workspace scan & index       | `services/code-index/processors/scanner.ts` | 30 s – minutes  | Directory walk + parsing + embedding; heaviest extension operation     |
| `callTool` (MCP)                  | `services/mcp/McpHub.ts`                    | 100 ms – 30 s   | Network round-trip to external MCP server; unbounded latency           |
| `searchCommits` / `getCommitInfo` | `utils/git.ts`                              | 100 – 500 ms    | `git log`, `git show`, `git diff` shell execs                          |

**Instrumentation priority order** (Phase 1 targets in bold):

1. \*\* **`saveShoferMessages`** — hottest path, every message update during streaming
2. \*\* **`postStateToWebview`** — every state transition
3. \*\* **`resumeTaskFromHistory`** — task startup
4. **`createMessage`** — primary LLM blocking call
5. **`searchIndex`** — user-initiated search latency
6. **`searchCommits` / `getCommitInfo`** — git-history panel
7. **`countTokens`** — token budgeting on large histories
8. **`loadRequiredLanguageParsers`** — startup blocker
9. **`callTool` (MCP)** — MCP server round-trip latency
10. Full workspace scan — batch mode, not latency-sensitive

```ts
// src/utils/perf.ts (simplified)

export function time<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const t0 = performance.now()
	return fn().finally(() => {
		_histogramCallback?.(key, performance.now() - t0)
	})
}
```

### 2.3 Usage

Wrap the call, not the method definition:

```ts
class Task {
    private async _saveShoferMessagesImpl() { ... }
    private saveShoferMessages = () => time("saveShoferMessages", () => this._saveShoferMessagesImpl())
}

class ShoferProvider {
    async postStateToWebview() {
        return time("postStateToWebview", () => this._postStateToWebviewImpl())
    }
}
```

### 2.4 Output format (DEBUG-gated)

```
[perf] saveShoferMessages dur=12.3ms
[perf] saveShoferMessages p50=8.0ms p95=22.5ms n=200
```

The ring buffer feeds a Histogram that gets scraped every 15 s — no need to
scrape the output channel logs.

---

## 3. Memory Instrumentation

### 3.1 Hypothesis

Users report Shofer getting slower over time, fast after reboot. Likely
causes:

- **Message array bloat** — `shoferMessages` grows unboundedly in memory
  (H2 windowed loading is still open from `todos/performance_optimizations.md`).
- **Leaked event listeners** — tasks subscribe to `ShoferProvider` events but
  `dispose()` may not always tear down listeners.
- **Terminal process handles** — `ExecaTerminalProcess` instances may not
  always be killed on task abort.
- **Tree-sitter / code-index caches** — parser and embedder caches grow
  with the workspace file count.

### 3.2 Metrics to expose

| Metric                         | Type      | Description                                                 |
| ------------------------------ | --------- | ----------------------------------------------------------- |
| `shofer_heap_used_bytes`       | Gauge     | `process.memoryUsage().heapUsed`                            |
| `shofer_heap_total_bytes`      | Gauge     | `process.memoryUsage().heapTotal`                           |
| `shofer_rss_bytes`             | Gauge     | `process.memoryUsage().rss`                                 |
| `shofer_messages_total`        | Gauge     | `shoferMessages.length` of the focused task                 |
| `shofer_messages_bytes`        | Gauge     | `JSON.stringify(shoferMessages).length` of focused task     |
| `shofer_tasks_total`           | Gauge     | `taskHistoryStore.getAll().length`                          |
| `shofer_active_tasks`          | Gauge     | Number of `Task` instances with `abort === false`           |
| `shofer_event_listeners_total` | Gauge     | `this.listenerCount()` on `ShoferProvider`                  |
| `shofer_heap_snapshot_bytes`   | Histogram | Size of a `v8.writeHeapSnapshot()` file (opt-in, expensive) |

### 3.3 Heap snapshot trigger

Add an extension command (`arkware.heapSnapshot`) that calls
`v8.writeHeapSnapshot()` to disk and logs the path to the output channel.
Operators can trigger it manually when they notice degradation. The path can
also be exposed via an admin MCP tool so it's accessible from the chat UI.

### 3.4 Garbage-collection monitoring

GC pause monitoring is provided **for free** by `prom-client`'s
`collectDefaultMetrics()`, which is enabled in `registry.ts`:

| Metric                       | Type      | Description                                                |
| ---------------------------- | --------- | ---------------------------------------------------------- |
| `nodejs_gc_duration_seconds` | Histogram | GC pause duration by kind (`major`/`minor`/`incremental`). |

No V8 flag (`--expose-gc`) is required, and no bespoke `shofer_gc_*` family is
implemented — it would be redundant. (An earlier draft of this doc specified
`shofer_gc_duration_ms` / `shofer_gc_total_ms`; those were never implemented and
are superseded by `nodejs_gc_duration_seconds`.)

### 3.5 Key design decisions

1. **Don't poll heap snapshot**. `v8.writeHeapSnapshot()` blocks the event loop
   for hundreds of ms. Only trigger it manually or on a schedule (every 30 min
   if `SHOFER_HEAP_SNAPSHOT_INTERVAL` is set).
2. **Heap numeric gauges are cheap**. `process.memoryUsage()` is O(1) and
   synchronous — safe to read on every metrics scrape.
3. **Active task count needs a source of truth**. The `TaskManager` already
   knows about managed tasks; expose `managedTasks.size` filtered by
   `!task.abort && !task.abandoned`.

---

## 4. Metrics Specification (always-on)

All metrics in this section are collected via direct instrumentation in
`src/metrics/registry.ts` — **always-on**, independent of `TELEMETRY_ENABLED`,
and independent of user telemetry opt-in. They are scraped by Prometheus via the
`/metrics` endpoint (§1).

> **Also exposed but not enumerated below:** the full `prom-client` > `collectDefaultMetrics()` family (`process_*`, `nodejs_*`, including
> `nodejs_gc_duration_seconds`) is enabled in `registry.ts`, and a catch-all
> `shofer_generic_duration_ms{operation}` histogram captures any `time()` key
> that isn't explicitly routed to a named histogram. These appear on `/metrics`
> alongside the `shofer_*` series specified here.

### 4.1 Availability (calls, errors, error types)

| Metric                           | Type      | Labels                             | Description                                                                                                       |
| -------------------------------- | --------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `shofer_llm_calls_total`         | Counter   | `provider`, `modelId`, `status`    | `status` = `success` \| `error` \| `timeout`                                                                      |
| `shofer_llm_errors_total`        | Counter   | `provider`, `modelId`, `errorType` | `errorType` = `api_error` \| `rate_limit` \| `timeout` \| `auth_error` \| `unknown`                               |
| `shofer_llm_cost_usd_total`      | Counter   | `provider`, `modelId`              | Cumulative USD cost (provider-reported or locally computed; mirrors the per-request cost in `Task.ts`)            |
| `shofer_llm_tokens_total`        | Counter   | `provider`, `modelId`, `direction` | `direction` = `input` \| `output` \| `cache_read` \| `cache_write` (mirrors the `LLM_COMPLETION` token breakdown) |
| `shofer_tool_calls_total`        | Counter   | `tool`, `status`                   | `status` = `success` \| `error`                                                                                   |
| `shofer_tool_errors_total`       | Counter   | `tool`, `errorType`                | Per-tool error classification                                                                                     |
| `shofer_mcp_calls_total`         | Counter   | `server`, `tool`, `status`         | `status` = `success` \| `error` \| `timeout` \| `cancelled`                                                       |
| `shofer_mcp_errors_total`        | Counter   | `server`, `tool`, `errorType`      | `errorType` = `timeout` \| `cancelled` \| `server_error` \| `unknown`                                             |
| `shofer_tasks_created_total`     | Counter   | `mode`                             | Tasks created per mode                                                                                            |
| `shofer_tasks_completed_total`   | Counter   | `mode`, `rating`                   | Tasks completed, per completion rating                                                                            |
| `shofer_tasks_errored_total`     | Counter   | `mode`, `errorType`                | `errorType` = `consecutive_mistake` \| `budget_exceeded` \| `shell_error` \| `unknown`                            |
| `shofer_code_index_errors_total` | Counter   | `subsystem`                        | `subsystem` = `scanner` \| `parser` \| `embedder` \| `cache` \| `orchestrator`                                    |
| ~~`shofer_telemetry_enabled`~~   | ~~Gauge~~ | —                                  | Removed (§7.5 — conflates independent pipelines)                                                                  |

**Implementation notes**:

- `MCP_ASYNC_CALL_*` events already carry `isError` (bool) and `callId` — wire
  error classification into the registry directly at the same call sites.
- Tool error classification requires `ApplyDiffTool` / `ExecuteCommandTool`
  error paths to write to the registry directly.
- **`errorType` labels must be low-cardinality** (< 10 values per metric) to
  avoid Prometheus label cardinality explosion.
- `shofer_telemetry_enabled` was removed (§7.5) — use the PostHog dashboard for
  correlation instead of coupling the two pipelines.

### 4.2 Latency (p50, p95, p99)

| Metric                               | Type      | Labels                | Description                                                                                                    |
| ------------------------------------ | --------- | --------------------- | -------------------------------------------------------------------------------------------------------------- |
| `shofer_llm_duration_ms`             | Histogram | `provider`, `modelId` | LLM API call duration                                                                                          |
| `shofer_tool_duration_ms`            | Histogram | `tool`                | Tool execution duration                                                                                        |
| `shofer_mcp_duration_ms`             | Histogram | `server`, `tool`      | MCP call duration                                                                                              |
| `shofer_task_switch_duration_ms`     | Histogram | —                     | Task context switch duration                                                                                   |
| `shofer_save_messages_duration_ms`   | Histogram | —                     | `saveShoferMessages` duration                                                                                  |
| `shofer_preload_duration_ms`         | Histogram | —                     | `preloadShoferMessages` duration                                                                               |
| `shofer_post_init_state_duration_ms` | Histogram | —                     | `postInitState` duration (the actual emitted name; an earlier draft called it `shofer_post_state_duration_ms`) |
| `shofer_index_load_duration_ms`      | Histogram | —                     | `_index.json` load duration                                                                                    |
| `shofer_index_write_duration_ms`     | Histogram | —                     | `_index.json` write duration                                                                                   |

**Histogram buckets** (ms): `[5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]`

**Implementation notes**:

- Each observation is appended to the histogram. Prometheus computes quantiles
  server-side via `histogram_quantile()`. This requires the scrape interval
  (15 s) to be smaller than the observation rate for accurate quantiles.
- Tool duration: instrument at the `BaseTool.execute()` call site so all tools
  are covered without per-tool decorators.

### 4.3 Memory and process health

| Metric                         | Type      | Description                                                                                    |
| ------------------------------ | --------- | ---------------------------------------------------------------------------------------------- |
| `shofer_heap_used_bytes`       | Gauge     | `process.memoryUsage().heapUsed`                                                               |
| `shofer_heap_total_bytes`      | Gauge     | `process.memoryUsage().heapTotal`                                                              |
| `shofer_rss_bytes`             | Gauge     | `process.memoryUsage().rss`                                                                    |
| `shofer_messages_total`        | Gauge     | `shoferMessages.length` of focused task                                                        |
| `shofer_messages_bytes`        | Gauge     | `JSON.stringify(shoferMessages).length`                                                        |
| `shofer_tasks_total`           | Gauge     | `taskHistoryStore.getAll().length`                                                             |
| `shofer_active_tasks`          | Gauge     | Managed tasks with `abort === false`                                                           |
| `shofer_event_listeners_total` | Gauge     | `ShoferProvider.listenerCount()`                                                               |
| `nodejs_gc_duration_seconds`   | Histogram | GC pause duration (from `collectDefaultMetrics`; replaces the never-implemented `shofer_gc_*`) |

### 4.4 Webview-side metrics (browser)

The webview pushes metrics to the extension host registry via a `WebviewMessage`
variant (`pushMetrics`). All webview data is included on the same `/metrics`
endpoint.

| Metric                                    | Type      | Labels      | Description                        |
| ----------------------------------------- | --------- | ----------- | ---------------------------------- |
| `shofer_webview_render_duration_ms`       | Histogram | `component` | React component render time        |
| `shofer_webview_messages_total`           | Counter   | `direction` | `direction` = `sent` \| `received` |
| `shofer_webview_postmessage_errors_total` | Counter   | —           | Failed `postMessage` calls         |

### 4.5 Code-index metrics (always-on)

| Metric                        | Type  | Labels     | Description                                                                                                                                           |
| ----------------------------- | ----- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shofer_code_index_files`     | Gauge | —          | Number of indexed files                                                                                                                               |
| `shofer_embedder_queue_depth` | Gauge | `provider` | Embedder concurrency-lane depth (running + queued `createEmbeddings` calls) per provider, read live from `getEmbedderLaneDepth` (`embedder-lane.ts`). |

---

## 5. Implementation Plan

### Phase 1 — Foundation ✅

- [`src/utils/perf.ts`](../src/utils/perf.ts) — `time()` helper (section 2).
- `time()` used for `saveShoferMessages`, `createTaskWithHistoryItem`,
  `preloadShoferMessages`, `postStateToWebview`.
- Removed manual `Date.now()` / `_savePerfRecentMs` scaffolding from
  `Task.ts` and `ShoferProvider.ts`.

### Phase 2 — Metrics endpoint + availability counters ✅

- [`src/metrics/identity.ts`](../src/metrics/identity.ts) — per-window `windowId` + workspace label.
- [`src/metrics/server.ts`](../src/metrics/server.ts) — `http.Server` on `127.0.0.1:<SHOFER_METRICS_PORT>` (static, default **30099** — not a random `:0` port); per-PID port discovery files. `/health` gates on an internal `_providerReady` flag (set via `setProviderReady()` from `ShoferProvider`), not a field literally named `taskHistoryStoreInitialized`.
- [`src/metrics/registry.ts`](../src/metrics/registry.ts) — `prom-client`-backed registry with
  `windowId` default label, `collectDefaultMetrics()`, and `shofer_window_info` gauge.
- `time()` wired to registry histograms via `setHistogramCallback`.
- `process.memoryUsage()` Gauges updated on-scrape (no periodic timer).
- Task-count Gauges from `TaskManager` / `TaskHistoryStore`.
- Availability counters: `BaseTool.execute()`, MCP call sites, task lifecycle.
- Code-index Gauges (§4.5).

### Phase 3 — Latency histograms + memory diagnostics (mostly ✅)

- ✅ `arkware.heapSnapshot` command (writes to workspace `.shofer/heap-snapshots/`;
  see §7.10 for the remaining hardening).
- ✅ Event listener count Gauge (`shofer_event_listeners_total`).
- ✅ `BaseTool.execute()` instrumentation for `shofer_tool_duration_ms` +
  `shofer_tool_calls_total` / `shofer_tool_errors_total`.
- ✅ LLM call-site instrumentation for `shofer_llm_duration_ms`,
  `shofer_llm_calls_total`, and `shofer_llm_errors_total` with error
  classification (wired in `Task.ts`).
- ✅ MCP call-site instrumentation (`shofer_mcp_*`, wired in `McpHub`).
- ✅ **GC monitoring resolved** (§7.11). Rather than a bespoke `perf_hooks`
  observer + `shofer_gc_*` family (redundant), GC pause visibility comes from
  `collectDefaultMetrics()`' `nodejs_gc_duration_seconds`. The dead doc-comment
  describing the unbuilt observer was removed from `registry.ts`.
- ✅ LLM cost/token counters (`shofer_llm_cost_usd_total`,
  `shofer_llm_tokens_total`), recorded next to `captureLlmCompletion` in
  `Task.ts` (fires at most once per request).

### Phase 4 — Webview metrics (host side ✅, sender ❌)

- ✅ `WebviewMessage` variant `pushMetrics`, typed `webviewMetricsPushSchema`
  (`packages/types/src/metrics.ts`), `safeParse` validation, and `/metrics`
  exposure are all built host-side (`webviewMessageHandler.ts`).
- ❌ **No webview-side sender exists** — `webview-ui/src` never calls
  `pushMetrics`, so the `shofer_webview_*` series are never populated. The
  inbound endpoint is currently dead until a webview emitter + 30 s flush is added.

### Phase 5 — Grafana dashboard & scrape config (pending)

- Prometheus `file_sd_configs` sidecar.
- Grafana dashboard JSON (`grafana/dashboards/shofer.json`).

---

## 6. Risks & Open Questions

- **Port exhaustion**: each VS Code window gets a random port. On shared
  hosts, scrape targets could number in the hundreds. Mitigation:
  `file_sd_configs` with labels so Grafana can filter by host.
- **Security**: `127.0.0.1` binding ensures only local scrapers can reach
  the endpoint. No auth needed.
- **Performance**: the metrics server adds ~1 event-loop tick per scrape
  (~50 µs). Gauges are O(1) reads. Histograms are O(1) appends per
  `time()` call. No material impact.
- **Webview `postMessage` reliability**: webview → extension host metric pushes
  are best-effort. If the extension host crashes or the webview is torn down
  before a push, metrics are lost. Mitigate with a small in-memory buffer and
  periodic push-on-interval in the webview.
- **High-cardinality labels**: `tool`, `server`, `modelId` as Prometheus
  labels are fine (low cardinality per user session). `taskId` as a label is
  **not** — use it only as a metric value, not a label. The `time()` key
  must not include per-call values.
- **Histogram cardinality**: per-method × per-label multiplies the number of
  Prometheus time series. Set a fixed bucket scheme per metric type and reuse
  it across all label combinations to avoid cardinality explosion.
- **Scrape flapping**: VS Code windows are ephemeral. Prometheus `target_groups`
  will appear and disappear as users open/close windows. Set `scrape_interval`
  to 15 s and use `target_groups[].last_seen` in Grafana to filter stale targets.
- **`taskId` leakage**: task IDs are UUIDs and must never appear as Prometheus
  label values. They may appear as annotation values in traces (Tempo), not
  as metric labels.

---

## 7. Design Improvements (post-implementation review)

The Phase 1–2 implementation under [`src/metrics/`](../src/metrics/) and [`src/utils/perf.ts`](../src/utils/perf.ts) surfaced gaps in the original design that were corrected before Phase 3 lands. The items below are design-level changes — concrete code bugs are tracked separately in the original review.

**Status (verified May 2026):** §7.1, §7.2, §7.3, §7.4, §7.5, §7.7, §7.8, §7.9,
§7.11, and §7.12 are implemented (or resolved) in
[`src/metrics/`](../src/metrics/). **Two remain partial:** §7.6 (canonical
provider label) is **unfixed** — `Task.ts` still uses
`apiConfiguration?.apiProvider ?? "unknown"`, so a misconfigured handler
silently emits `provider="unknown"` on every LLM series; §7.10 (heapSnapshot)
is **partial** — it passes an explicit path but writes to the workspace
`.shofer/heap-snapshots/` rather than `globalStoragePath`, and has no modal
confirmation. §7.11 (GC observer) is **resolved by design** — rather than a
bespoke `perf_hooks` observer, GC visibility comes from
`collectDefaultMetrics()`' `nodejs_gc_duration_seconds`; the dead doc-comment
was removed from `registry.ts`.

### 7.1 Switch from `@perf` decorator to a `time(key, fn)` helper ✅

The `@perf` decorator was the original design, but two TypeScript realities made it the wrong primitive:

- `src/tsconfig.json` has `experimentalDecorators: true` (legacy / Stage 1 signature `(target, key, descriptor)`), while the rest of the codebase is on TC39 Stage 3 syntax (`ClassMethodDecoratorContext`). The two are mutually incompatible — a method decorator works under exactly one of them.
- Even when the decorator runtime works, `addInitializer`-style replacement rebinds the method on every instance, breaks `super.foo()` calls, and silently no-ops when the decorator is accidentally placed inside a JSDoc block (`@perf("…")` immediately above `*/` — easy to do and impossible to lint).

Replace the decorator with an explicit `time<T>(key: string, fn: () => Promise<T>): Promise<T>` helper that internally calls the histogram callback. Call sites become:

```ts
return time("saveShoferMessages", () => this._saveShoferMessagesImpl())
```

Two-line cost, but: works under both decorator modes, survives JSDoc accidents, types check end-to-end, and the call site is grep-able. Keep the same ring-buffer / debug-summary semantics inside the helper.

### 7.2 Use a real Prometheus client (`prom-client`) instead of a hand-rolled exposition ✅

The hand-rolled `MetricsRegistry` has several Prometheus-spec violations that are easy to introduce and hard to keep working:

- Label-set rendering MUST be `{name="value",…}` with quoted values. The current `labels.join(",")` produces `{provider,openai,modelId,gpt-4}` which Prometheus rejects.
- Counters with labels are stored as one `Counter` per label combination keyed by a synthesized string name; `# HELP` / `# TYPE` headers are missing entirely.
- Histograms re-use the same `name` across label combinations but the exposition emits one `*_bucket{…}` block per stored histogram — there is no aggregation by metric name, so quantiles computed in Prometheus will be wrong if two call sites share a metric.
- `_bucket{le="+Inf"}` is emitted but `_bucket` lines for individual `le` values are not strictly cumulative across labels in the current layout.

`prom-client` (≈ 60 kB, no native deps) gives correct text-format output, proper `Counter`/`Gauge`/`Histogram`/`Summary` semantics with first-class label sets, default Node.js process metrics (`process_cpu_seconds_total`, `nodejs_eventloop_lag_seconds`, `nodejs_heap_size_used_bytes`, GC duration histogram via `--expose-gc`), and a `register.metrics()` method that drops straight into the existing `/metrics` HTTP handler. This eliminates the entire label-string-mangling helper layer (`incLlCalls`, `incMcpErrors`, …) and replaces it with `counter.labels({ provider, modelId, status }).inc()`.

### 7.3 Make `/metrics` lazy-update memory and queue depth on scrape, not on a 15 s timer ✅

The original design said "Gauges are O(1) reads — safe to read on every metrics scrape", but the implementation runs `updateMemoryMetrics()` on a `setInterval(…, 15_000)`. This means:

- Scrape data can be up to 15 s stale (sub-scrape-interval visibility is lost).
- The timer wakes the event loop every 15 s even when nothing is scraping (e.g. a VS Code window the user has not focused in hours).

Replace the timer with a pre-scrape hook: the `/metrics` HTTP handler calls `collectGauges()` synchronously before rendering exposition. This is the pattern `prom-client` already supports via `Gauge({ collect() { … } })`, and it removes the only periodic timer the metrics subsystem owns.

### 7.4 Per-window identity must be a metric label, not a scrape-target attribute ✅

The design assumes a Prometheus sidecar adds `host` labels via `file_sd_configs`, but multiple VS Code windows on the same host produce overlapping series with no way to distinguish them. Worse, both windows write to the same `globalStorage/metrics-port` file — second writer wins, first window becomes unscrapable.

Two corrective changes:

1. Mint a per-window `windowId` (random short hex) at activation, expose it as a constant `Gauge` value (`shofer_window_info{windowId="…",workspace="…"} 1`) and append it as a label to every series via a `prom-client` registry default-labels config.
2. Replace the single-file port discovery with an append-only directory: `globalStorage/metrics-ports/<pid>-<windowId>.json` containing `{ port, windowId, workspace, startedAt }`. The Prometheus sidecar globs the directory and prunes entries whose `pid` is no longer alive. Removes the second-window-overwrites-first bug.

### 7.5 Drop `TELEMETRY_ENABLED` correlation gauge — it conflates two pipelines ✅

`shofer_telemetry_enabled` was added to "let Grafana correlate PostHog gaps", but the two pipelines are independent by design (§1.5). Exposing the PostHog flag on the operational endpoint:

- Suggests they are coupled, which is exactly what §1.5 says they must not be.
- Adds a metric whose only consumer is a Grafana annotation that can equally well live in the PostHog dashboard.

Remove the metric. If correlation is needed later, push it from PostHog side instead.

### 7.6 LLM `provider` label needs a single canonical source

The current call site in `Task.ts` reads:

```ts
const _llmProvider = apiConfiguration?.apiProvider ?? this.api.getModel().id ?? "unknown"
```

Using `modelId` as a fallback `provider` value will produce a high-cardinality, semantically wrong label (`provider="gpt-4o"`). The `ApiHandler` interface already exposes `getModel().info.providerName` (or equivalent) — extend `ApiHandler` with a typed `getProvider(): ProviderName` if needed and call it everywhere. Centralizes the provider-label vocabulary the way `ToolName` centralizes tool labels.

### 7.7 Specify the `pushMetrics` payload shape in `@shofer/types`

The Phase 4 webview push currently rides on the loosely-typed `values?: Record<string, any>` field already present on `WebviewMessage`. This violates the **Schema-First Persistence Rule** in `AGENTS.md` for IPC payloads. Add a dedicated `WebviewPushMetrics` Zod schema in [`packages/types/src/`](../packages/types/src/) carrying `{ counters: Array<{ name; labels; value }>, histograms: Array<{ name; labels; observations }> }` and validate inbound payloads with `safeParse` before handing them to the registry. Without this, a malformed webview push silently corrupts the host registry.

### 7.8 Specify the `errorType` taxonomy as a closed enum

`classifyLlmError` / `classifyMcpError` / `errorTypeFrom` (in `BaseTool`) each invent their own substring-match heuristics, returning ad-hoc strings. The result is exactly the high-cardinality label problem §6 warns against — typos, locale-dependent error messages, and refactored upstream errors silently expand the label set.

Declare an `LlmErrorType` / `ToolErrorType` / `McpErrorType` union in `@shofer/types`, exhaust it at the classification site (with the exhaustive-switch idiom from `AGENTS.md`), and validate at the registry boundary (`registry.incLlmError(provider, modelId, errorType)` rejects unknown strings in dev). Same closed-enum treatment for `status` (`success | error | timeout | cancelled`) — currently free-form strings.

### 7.9 Single shared definition of histogram buckets and quantile-significant operations

`DURATION_BUCKETS_MS` is the right starting point, but the design also needs different bucket schemes for short-running ops (e.g. `saveShoferMessages` is < 50 ms typical) and long-running ops (`searchIndex` can be multi-second). Add named bucket presets:

```ts
export const FAST_BUCKETS_MS = [1, 2.5, 5, 10, 25, 50, 100, 250, 500]
export const STD_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000]
export const SLOW_BUCKETS_MS = [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000]
```

…and pin each histogram in §4.2 to one of them. Avoids both the "all buckets at 50 ms are saturated" failure mode and the "everything fell into the +Inf bucket" failure mode.

### 7.10 `heapSnapshot` command should respect the prepared directory

The command creates `.shofer/heap-snapshots/` then calls `v8.writeHeapSnapshot()` with no arguments — V8 writes to `process.cwd()` and the prepared directory is unused. Pass the explicit destination path:

```ts
const filePath = path.join(snapshotDir, `heap-${timestamp}.heapsnapshot`)
v8.writeHeapSnapshot(filePath)
```

Also: heap snapshot is a synchronous, multi-hundred-ms event-loop stall that can produce > 1 GB files. Add a confirmation prompt (`vscode.window.showWarningMessage` with Modal: true) before triggering, and write to `globalStoragePath` rather than the workspace by default (workspace heap dumps risk being committed by accident — the **Protected Files Rule** suggests `.shofer/` is workspace-relative configuration, not a dump ground).

### 7.11 GC observer must use the top-level `PerformanceObserver` export

> **Resolution (superseded):** no bespoke GC observer is implemented. GC pause
> visibility comes from `collectDefaultMetrics()`' `nodejs_gc_duration_seconds`
> instead, which is correct out of the box and needs no V8 flag. The advice
> below is retained only as a record of why a hand-rolled observer was avoided.

The implementation reads `PerformanceObserver` off the `performance` object and gates on `globalThis.gc`. Both are wrong:

- `PerformanceObserver` is a top-level export of `perf_hooks`, not a property of `performance`. The current expression evaluates to `undefined`, so the observer is never installed.
- GC entries are emitted by V8 unconditionally; `--expose-gc` is only needed for _programmatic_ `global.gc()`, not for observation.

The corrected snippet (and the only thing the design needs to specify) is:

```ts
import { PerformanceObserver, constants } from "perf_hooks"
new PerformanceObserver((list) => {
	for (const entry of list.getEntries()) {
		recordGcDuration(entry.duration)
		incGcTotalMs(entry.duration)
	}
}).observe({ entryTypes: ["gc"], buffered: true })
```

Document explicitly that no V8 flag is required.

### 7.12 Add a `metrics_self_*` family for the metrics pipeline itself

Operational metrics with no visibility into their own health become invisible failures. Add:

| Metric                                     | Type      | Description                                                        |
| ------------------------------------------ | --------- | ------------------------------------------------------------------ |
| `shofer_metrics_scrapes_total`             | Counter   | Number of successful `/metrics` responses                          |
| `shofer_metrics_scrape_duration_ms`        | Histogram | Wall time spent rendering exposition                               |
| `shofer_metrics_webview_push_errors_total` | Counter   | Failed validations of inbound `pushMetrics` payloads               |
| `shofer_metrics_server_restarts_total`     | Counter   | Times the HTTP server had to rebind (e.g. port file write failure) |

These cost nothing and turn "the dashboard went blank" from a mystery into a query.
