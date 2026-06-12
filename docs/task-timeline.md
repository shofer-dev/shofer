# Task Timeline (Chrome-Network-Trace)

This document describes the design for rendering a Chrome DevTools Network-panel-style waterfall trace for a Shofer Task, showing every API request and tool execution on a shared horizontal time axis with timing, cost, and error metadata.

## Goals

1. Show the chronological sequence of API requests and tool calls within a task as horizontal waterfall bars.
2. Provide timing data (TTFB, duration, tool execution latency) independent of provider `response_metadata` chunks — we measure our own.
3. Display per-call metadata on hover/tap: model, tokens, cost, retries, errors, wire request.
4. Build the waterfall incrementally as the task runs (live push), not just as a post-hoc export.
5. Keep the data model immutable — spans are written once, never mutated in-place.

## Design Decisions

| #   | Decision                                                                              | Rationale                                                                                                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | All timestamps are **offsets** from a single `timelineOriginMs`                       | Avoids epoch drift; keeps numbers small; makes the timeline self-contained                                                                                                                                                                                    |
| 2   | `ApiRequestFinishedPayload` + nested `ToolSpan[]` are **written once, never mutated** | Today `api_req_started` is mutated in-place by `updateApiReqMsg`; the new model emits an immutable `api_req_finished` message and leaves `api_req_started` as a lightweight placeholder                                                                       |
| 3   | Stored in **`ui_messages.json`** as an `api_req_finished` `ShoferSay`                 | `api_req_finished` already exists in [`shoferSaySchema`](../packages/types/src/message.ts:190); extends `ui_messages.json` instead of introducing a new file — one read path, leverages existing message ordering, no separate persistence                    |
| 4   | **Our own** TTFB computation                                                          | Fallback when the llm-provider doesn't emit `response_metadata`; use stream delta from request start to first content-bearing chunk                                                                                                                           |
| 5   | `ToolSpan.resultSizeChars` for response-size analog                                   | Mirrors Chrome's "Size" column for tool results                                                                                                                                                                                                               |
| 6   | **Incremental IPC push** via existing message pipeline                                | `api_req_finished` messages are pushed to the webview as they're emitted — `ChatView`'s existing `addToShoferMessages` → `postStateToWebview` path delivers them; the `TaskTimelineView` component filters `say === "api_req_finished"` from `shoferMessages` |

No backward compatibility is preserved. Existing `api_req_started` mutation code (`updateApiReqMsg`) will be simplified to only emit the placeholder; timing/cost/error data flows into the new `api_req_finished` message instead. The `shoferSaySchema` already includes `"api_req_finished"` — no schema change needed.

## Data Model

The timeline extends the existing `ui_messages.json` — each completed API request produces a `ShoferSay` message with `say: "api_req_finished"` and `text` carrying a JSON payload. This message is immutable (written once, never mutated) and is ordered naturally after the request's `api_req_started` and tool-call messages.

### `api_req_finished` Message Shape

A standard [`ShoferMessage`](../packages/types/src/message.ts:295) with:

| Field     | Value                                                   |
| --------- | ------------------------------------------------------- |
| `type`    | `"say"`                                                 |
| `say`     | `"api_req_finished"`                                    |
| `ts`      | `Date.now()` at write time (standard message timestamp) |
| `text`    | JSON string — see `ApiRequestFinishedPayload` below     |
| `partial` | `false` (always a complete message)                     |

```typescript
// ── Stored in text field of api_req_finished ShoferMessage ──

interface ApiRequestFinishedPayload {
	/** 0-based index of this request within the task. */
	requestIndex: number
	/** Offset in ms from timelineOriginMs when the request was initiated
	 *  (immediately before the llm-provider streaming call). */
	startedAtOffsetMs: number
	/** Offset in ms from timelineOriginMs when the request resolved
	 *  (stream ended: success, cancellation, or error). */
	finishedAtOffsetMs: number
	/** Time to first byte.  Sourced from provider `response_metadata` if
	 *  available; otherwise computed as the delta from startedAtOffsetMs to
	 *  the first content-bearing stream chunk.  Null when neither is
	 *  available (e.g. instant error without metadata). */
	ttfbMs: number | null
	/** Requested model ID. */
	model: string
	/** Wire protocol. */
	apiProtocol: "anthropic" | "openai"
	/** Retry attempt number (0 = first try). */
	retryAttempt: number
	/** Final token counts. */
	tokensIn: number
	tokensOut: number
	cacheWrites: number
	cacheReads: number
	/** Estimated cost in USD. */
	cost: number
	/** Outcome of the request. */
	status: "completed" | "cancelled" | "error"
	cancelReason?: "streaming_failed" | "user_cancelled"
	/** Structured error information when status === "error". */
	error?: ApiReqError
	/** Serialised wire-request body (if `recordResponses` is enabled). */
	wireRequest?: string
	/** The underlying model that actually served the request (may differ from
	 *  `model` when failover routing is active). */
	actualModel?: string
	/** Number of provider-level attempts (1 = first try succeeded). */
	attempts?: number
	/** Error message from the LLM provider when the request failed. */
	responseError?: string
	/** Tool calls executed during this request, in execution order. */
	toolSpans: ToolSpan[]
}

// ── Per-Tool-Use (nested in toolSpans[]) ──

interface ToolSpan {
	/** Offset in ms from timelineOriginMs when tool execution began. */
	startedAtOffsetMs: number
	/** Offset in ms from timelineOriginMs when tool execution completed. */
	finishedAtOffsetMs: number
	/** Canonical tool name (e.g. "read_file", "execute_command"). */
	toolName: string
	/** Tool call ID from the API conversation. */
	toolId: string
	/** Approximate size of the tool result in characters.  Null when not
	 *  captured (e.g. legacy data or tool result processing errors). */
	resultSizeChars: number | null
	/** Whether the tool returned an error. */
	isError: boolean
}
```

### `shoferSaySchema` Addition

The `"api_req_finished"` value already exists in [`shoferSaySchema`](../packages/types/src/message.ts:190). No schema change needed — only the `text` payload shape (`ApiRequestFinishedPayload`) is new.

### Invariants

- **Immutable**: each `api_req_finished` message is written once at stream end and never mutated. `api_req_started` is reduced to a lightweight placeholder (no in-place mutation).
- **Offsets, not absolutes**: `startedAtOffsetMs` and `finishedAtOffsetMs` are relative to `Task.timelineOriginMs` (`performance.now()` captured at construction). To reconstruct wall-clock time: `new Date(baseEpoch + timelineOriginMs + offset)`.
- **Tool spans nested under requests**: `toolSpans[]` lives inside the `api_req_finished` payload — tools are scoped to a single API request.
- **Single read path**: the `TaskTimelineView` component filters `say === "api_req_finished"` from the same `shoferMessages` array that powers `ChatView`. No separate file, no separate load logic.

## Instrumentation Points in `Task.ts`

### 1. Constructor — timeline origin

```typescript
// In Task constructor, after taskId assignment:
this.timelineOriginMs = performance.now()
this._pendingToolSpans = []
this._pendingRequestStartOffset = 0
this._pendingTtfbMs = null
this._currentRequestIndex = 0
```

### 2. `recursivelyMakeShoferRequests()` — request span lifecycle

```
Before rate-limit gate:
  this._pendingRequestStartOffset = performance.now() - this.timelineOriginMs

After stream loop exits (success / cancel / error):
  Build ApiRequestFinishedPayload:
    requestIndex = this._currentRequestIndex
    startedAtOffsetMs = this._pendingRequestStartOffset
    finishedAtOffsetMs = performance.now() - this.timelineOriginMs
    ttfbMs = this._pendingTtfbMs
    status = "completed" | "cancelled" | "error"
    toolSpans = drain this._pendingToolSpans[]
    // ... fill model, apiProtocol, retryAttempt, tokens, cost, error, ...

  Emit via this.say("api_req_finished", JSON.stringify(payload))
  // Standard say() persists to ui_messages.json and pushes to webview
  this._pendingToolSpans = []
  this._pendingTtfbMs = null
  this._currentRequestIndex++
```

### 3. Stream loop — TTFB capture

```typescript
// In the chunk-processing loop, on the first non-placeholder chunk:
if (this._pendingTtfbMs === null && !isPlaceholderChunk(chunk)) {
	this._pendingTtfbMs = performance.now() - this.timelineOriginMs - this._pendingRequestStartOffset
}
```

When provider `response_metadata` arrives later with its own `ttfbMs`, our value takes precedence if already set (we trust our own measurement). If ours is null, the provider's value is used. The value is written as `ttfbMs` in the `ApiRequestFinishedPayload`.

### 4. `presentAssistantMessage()` — tool span capture

```typescript
// In presentAssistantMessage, around each tool's execute() call:
const toolStartedAt = performance.now()
// ... execute tool via BaseTool.handle() ...
const toolFinishedAt = performance.now()

this._pendingToolSpans.push({
	startedAtOffsetMs: toolStartedAt - this.timelineOriginMs,
	finishedAtOffsetMs: toolFinishedAt - this.timelineOriginMs,
	toolName: block.name,
	toolId: block.id,
	resultSizeChars: computeResultSize(resultContent),
	isError: resultIsError,
})
```

### 5. `abortTask()` + `cancelAndProcessQueuedMessages()` — cancellation marking

When a request is interrupted, the accumulated `api_req_finished` message is still emitted — its `status` is set to `"cancelled"` and `cancelReason` is set accordingly. The partial `toolSpans[]` (tools that did complete before cancellation) are included.

## Persistence

No new persistence path. `api_req_finished` messages are saved as part of `ui_messages.json` via the existing `Task.say()` → `Task.saveShoferMessages()` pipeline. On task rehydration, they are loaded alongside all other `ShoferMessage`s. This is the same path used by `api_req_started`, `text`, `tool`, and every other `ShoferSay` variant.

**Storage size**: each `api_req_finished` payload is ~400 bytes plus tool spans (~80 bytes each). A task with 50 requests × 5 tools = ~40 KB added to `ui_messages.json` (alongside the much larger `text` and `tool` messages).

## IPC to Webview

No new IPC type needed. `api_req_finished` messages are pushed to the webview through the existing `addToShoferMessages` → `postStateToWebview` pipeline — the same mechanism that delivers all other chat messages. The `TaskTimelineView` component reads `shoferMessages` from `ExtensionState` and filters `say === "api_req_finished"`.

When the user opens a historical task, `api_req_finished` messages are part of the already-loaded `shoferMessages` from `ui_messages.json` — no separate pull needed.

## Rendering (TaskTimelineView)

### Layout

```
┌─ TaskTimelineView ──────────────────────────────────────────────┐
│  Time axis: 0ms ───── 500ms ───── 1000ms ───── 1500ms ───── ... │
│                                                                  │
│  [0] claude-sonnet-4  ████████████████████░░░░░░░░░░░░  3.4s    │
│      ├ read_file      ░░░░░███░░░░░░░░░░░░░░░░░░░░░░░░  170ms   │
│      ├ grep_search    ░░░░░░░░░░███░░░░░░░░░░░░░░░░░░░   160ms   │
│      └ write_to_file  ░░░░░░░░░░░░░░░░░░███░░░░░░░░░░░   120ms   │
│                                                                  │
│  [1] claude-sonnet-4  ████████████░░░░░░░░░░░░░░░░░░░░  2.1s    │
│      ├ execute_cmd    ░░░░░████████████░░░░░░░░░░░░░░░░  850ms   │
│      └ read_file      ░░░░░░░░░░░░░░░░░░░░██░░░░░░░░░░░   45ms   │
│                                                                  │
│  [2] claude-sonnet-4  ████ (cancelled)                    0.8s    │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

── Bar phases (color):
   ░  Light gray  = queuing / pre-processing (start → first tool / first content)
   ██ Blue        = TTFB / waiting for LLM
   ██ Green       = streaming / receiving content
   ██ Orange      = tool execution (ToolSpan sub-bars)
   ██ Red         = error

── Row info (left gutter):
   [index] model
   tokensIn │ tokensOut │ cost
   status icon (✓ / ⚡ / ⨯)
```

### Interaction

- **Hover on request row** → tooltip with full metadata: model, apiProtocol, tokens, cost, retryAttempt, actualModel, attempts, error details
- **Hover on tool sub-row** → tooltip with toolName, toolId, duration, resultSizeChars
- **Click on request row** → expand inline detail panel showing wireRequest (if captured)
- **Click on tool sub-row** → scroll to that tool call's chat row in `ChatView`
- **Zoom/pan** → horizontal scroll + pinch; time axis auto-scales to fit visible range

### Component Files

| Component            | File                                                  | Description                                                                                      |
| -------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **TaskTimelineView** | `webview-ui/src/components/chat/TaskTimelineView.tsx` | Main waterfall panel. Reads `shoferMessages` from context; filters `say === "api_req_finished"`. |
| **TimelineRow**      | `webview-ui/src/components/chat/TimelineRow.tsx`      | Single request row + its nested tool sub-rows.                                                   |
| **TimelineBar**      | `webview-ui/src/components/chat/TimelineBar.tsx`      | Single horizontal bar with phase coloring.                                                       |
| **TimelineTooltip**  | `webview-ui/src/components/chat/TimelineTooltip.tsx`  | Hover tooltip showing metadata for a span.                                                       |
| **TimelineTimeAxis** | `webview-ui/src/components/chat/TimelineTimeAxis.tsx` | Horizontal ruler with ms tick marks.                                                             |

### Integration with ChatView

`TaskTimelineView` is rendered as a **collapsible panel** above `ChatView`'s message list (similar to `FileChangesPanel`). A button in `TaskHeader` toggles it. Since timeline data flows through the same `shoferMessages` array, the timeline updates automatically as `api_req_finished` messages arrive — no separate event subscription needed.

## Key Files

| File                                                                                     | Role                                                                                |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [`Task.ts`](../src/core/task/Task.ts)                                                    | Timeline origin, request span lifecycle, tool span capture, stream TTFB measurement |
| [`presentAssistantMessage.ts`](../src/core/assistant-message/presentAssistantMessage.ts) | Tool execution timing (before/after each `tool.execute()`)                          |
| [`message.ts`](../packages/types/src/message.ts)                                         | `shoferSaySchema` already includes `"api_req_finished"`                             |
| [`TaskTimelineView.tsx`](../webview-ui/src/components/chat/TaskTimelineView.tsx)         | Waterfall React component                                                           |

## Gaps & Areas for Improvement

1. **No per-chunk timing within streaming**: the current design times tool execution but doesn't distinguish between "model is thinking" and "model is streaming tokens" within a request. Could be refined later by instrumenting text-delta chunk arrival times.
2. **No request queuing visualization**: if multiple concurrent tasks share a provider rate-limit lane, one task's request may wait before starting. `maybeWaitForProviderRateLimit` time isn't captured — it's folded into `startedAtOffsetMs` (the span starts after the wait).
3. **No historical timeline comparison**: the timeline is per-task. Cross-task comparison (e.g. "was this task slower than average?") would require aggregating timelines in the webview.
4. **No export integration yet**: `api_req_finished` payloads are not yet wired into the JSON task export (`export-json.ts`). This is a follow-up.
5. **ChatRow should hide `api_req_finished` rows**: the `api_req_finished` messages are in the same `shoferMessages` array as regular chat messages. `ChatRow` needs a guard to skip rendering `say === "api_req_finished"` in the main chat view (they're only consumed by `TaskTimelineView`).
