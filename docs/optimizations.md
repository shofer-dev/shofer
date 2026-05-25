# Shofer Optimizations — Performance & Memory

> **Scope.** This document combines two previously separate analyses:
>
> - **Performance / latency tuning** (formerly `todos/done/performance_optimizations.md`,
>   originally written 2026-05-20, last revised 2026-05-21).
> - **Extension-host memory utilisation & profiling** (formerly
>   `docs/mem-utilization-profiling.md`, originally written 2026-05-25).
>
> The first part (§§1–4) covers the performance improvement program (items H0–H9),
> root causes, optimisation plans, and implementation status. The second part
> (§§5–13) covers the memory/OOM analysis: why the extension host OOMs, what
> design changes address each suspect, how to profile, and the performance/lagginess
> impact of each change. The two analyses overlap substantially — several H-items
> in Part A are the same design changes described as §4 items in Part B — and the
> cross-reference tables in §14 make those relationships explicit.

---

## Table of Contents

- [Part A — Performance Optimizations](#part-a--performance-optimizations)
    - [1. Implementation Status](#1-implementation-status)
    - [2. Root Causes Identified](#2-root-causes-identified)
    - [3. Optimization Plan (Ranked by Impact)](#3-optimization-plan-ranked-by-impact)
    - [4. What NOT to Optimize](#4-what-not-to-optimize)
- [Part B — Memory Utilisation & Profiling](#part-b--memory-utilisation--profiling)
    - [5. Symptom & Diagnosis](#5-symptom--diagnosis)
    - [6. Why It's `large_object` Space](#6-why-its-large_object-space)
    - [7. Plausible Culprits](#7-plausible-culprits)
    - [8. Design Changes by Culprit](#8-design-changes-by-culprit)
    - [9. Profiling Toolbox](#9-profiling-toolbox)
    - [10. Recommended Investigation Sequence](#10-recommended-investigation-sequence)
    - [11. Performance / Lagginess Impact](#11-performance--lagginess-impact)
    - [12. Known Constraints](#12-known-constraints)
    - [13. Related Files](#13-related-files)
- [14. Cross-Reference: H-Items ↔ §4 Items](#14-cross-reference-h-items--4-items)
- [15. Implementation Order (Combined)](#15-implementation-order-combined)
- [16. Metrics to Track](#16-metrics-to-track)

---

# Part A — Performance Optimizations

> Analysis performed 2026-05-20. Source code paths verified against HEAD.
> Revised 2026-05-20 after code-level review.

## 1. Implementation Status

> The cheap, stability-positive slice landed first — **H5.a, H1, H3, H6, metrics**.

### Status Table

| #            | Item                                                        | Description                                                                                                                                                                                                                                                                                     | Risk       | Status                   | Implemented    |
| ------------ | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------ | -------------- |
| **H5.a**     | Raise `UV_THREADPOOL_SIZE`                                  | One-line env var in `extension.ts`; removes fs-ops serialization bottleneck                                                                                                                                                                                                                     | 🟢 Low     | ✅ Done                  | pre-2026-05-21 |
| **H1**       | Eliminate redundant re-read in `preloadShoferMessages()`    | Skip READ #2 after sanitized save; compose with H3                                                                                                                                                                                                                                              | 🟢 Low     | ✅ Done                  | pre-2026-05-21 |
| **H3**       | Parallelize `preloadShoferMessages()` I/O                   | `Promise.all` for independent `shoferMessages` + `apiConversationHistory` reads                                                                                                                                                                                                                 | 🟢 Low     | ✅ Done                  | pre-2026-05-21 |
| **H6**       | Sync `JSON.stringify` snapshot instead of `structuredClone` | Freeze string before async write; avoids O(n) deep copy per save                                                                                                                                                                                                                                | 🟡 Low–Med | ✅ Done                  | pre-2026-05-21 |
| **metrics**  | Instrumentation scaffolding                                 | Perf logging gated on `process.env.DEBUG`                                                                                                                                                                                                                                                       | 🟢 Low     | ✅ Done                  | pre-2026-05-21 |
| **H0**       | Debounce `saveShoferMessages` during streaming              | 250ms trailing debounce (1s maxWait); flush at turn boundaries                                                                                                                                                                                                                                  | 🟡 Medium  | ✅ Done                  | 2026-05-21     |
| **H4**       | Delta channel for `taskHistory`/`shoferMessages`            | Converted 8 `postStateToWebview()` callers to `withoutTaskHistory` variant                                                                                                                                                                                                                      | 🟡 Medium  | ✅ Done                  | 2026-05-21     |
| **H2.bis**   | Incremental `taskMetadata` token accounting                 | Dirty-flag cache skips O(n) token walk when no new token-bearing messages                                                                                                                                                                                                                       | 🟡 Medium  | ✅ Done                  | 2026-05-21     |
| ~~**H5.b**~~ | ~~Native `simdjson` addon for large-file parse~~            | Implemented + benchmarked 2026-05-21 — on Node 22, V8 `JSON.parse` was ~5× _faster_ than `simdjson` on the representative payload (4.5 ms vs 22.9 ms for 1.6 MB); wrapper and dep reverted.                                                                                                     | —          | ❌ Dropped (empirically) | —              |
| **H5.c**     | `worker_threads` for parse of large files                   | Worker read file + `JSON.parse`d; only result crossed postMessage. 1 MiB threshold. Implemented + benchmarked 2026-05-21 — on Node 22, the worker path was 2.7× _slower_ than main-thread baseline (52 ms vs 19 ms for 2.3 MB) because structuredClone of the parsed array dominates. Reverted. | —          | ❌ Dropped (empirically) | —              |
| **H8**       | `ContextProxy.onDidChange` + memoize static state           | EventEmitter + generation counter cache for merged command lists                                                                                                                                                                                                                                | 🟢 Low     | ✅ Done                  | 2026-05-21     |
| **H2**       | Windowed message loading                                    | Load last K messages with Virtuoso scroll-to-load sentinel                                                                                                                                                                                                                                      | 🔴 High    | ❌ Open                  | —              |
| **H7**       | Paginate history index                                      | Split `_index.json` into pages at 1,000+ tasks                                                                                                                                                                                                                                                  | 🟢 Low     | ❌ Open                  | —              |
| **H9**       | Gate state pushes for background tasks                      | Add `isFocusedTask()` check to `addToShoferMessages` + stream start/end state pushes                                                                                                                                                                                                            | 🟢 Low     | ❌ Open                  | —              |

### H0: Debounce `saveShoferMessages` During Streaming

**Landed 2026-05-21.** `saveShoferMessages` is now debounced (250 ms trailing, 1000 ms
maxWait) during streaming. `addToShoferMessages` and the streaming-loop save points
(`api_req_started`, usage updates, reasoning complete) use the debounced path. Turn
boundaries (ask/say completion, abort, overwrite) flush synchronously via
`_flushSaveShoferMessages`.

See [`Task.ts`](extensions/shofer/src/core/task/Task.ts:654) for the debounce constants
and [`Task.ts`](extensions/shofer/src/core/task/Task.ts:858) for the initializer.

### H4: Delta Channel for `taskHistory`/`shoferMessages`

**Landed 2026-05-21.** 8 additional `postStateToWebview()` call sites converted to
`postStateToWebviewWithoutTaskHistory()` — settings updates, mode changes, API
configuration mutations, custom instruction updates, and workspace refreshes. These
callers don't change taskHistory so carrying the full array was pure waste. The
remaining 9 `postStateToWebview()` callers are task-switch or webview-visibility
events where taskHistory is genuinely needed. The `taskHistoryItemUpdated` /
`taskHistoryUpdated` delta channels (already present) and `messageUpdated` (already
present) remain the canonical single-message update paths.

See [`ShoferProvider.ts`](extensions/shofer/src/core/webview/ShoferProvider.ts) for
the converted call sites.

### H2.bis: Incremental `taskMetadata` Token Accounting

**Landed 2026-05-21.** Incremental token-usage caching added to
[`saveShoferMessages`](extensions/shofer/src/core/task/Task.ts:1545). The expensive
O(n) `getApiMetrics(combineApiRequests(combineCommandSequences(…)))` walk is now
skipped when no token-bearing messages (`api_req_started`, `condense_context`) have been
added since the last computation. A dirty-flag counter is tracked in
`_tokenBearingMessageCount` and compared on each save.
[`taskMetadata`](extensions/shofer/src/core/task-persistence/taskMetadata.ts:39)
accepts an optional `tokenUsageOverride` to bypass the walk.

### H5.b / H5.c — Dropped After Benchmarking

**H5.b dropped 2026-05-21:** A wrapper that delegated to `simdjson` for files ≥1 MiB
was implemented, the native addon was built locally, and a smoke test was run on a
~1.6 MB array-of-small-objects payload (representative of `ui_messages.json`):

```
len(bytes)= 1,608,891
simdjson_ms  = 22.91
JSON.parse_ms =  4.52
```

On Node 22, V8's SIMD-accelerated `JSON.parse` is ~5× faster than simdjson for our
payload shape; the design-note assumption (2–4× faster via the NAPI binding, plus V8-lock
release) does not hold. Wrapper + wiring reverted; `simdjson` removed from
`optionalDependencies` and from the build-allowlist.

**H5.c implemented + dropped 2026-05-21:** A `workerpool`-based parse-in-worker was
wired into `readTaskMessages` / `readApiMessages` with a 1 MiB threshold. The worker
read the file AND parsed it (only the result crossed the postMessage boundary).
Benchmarked on a representative ~2.3 MB array-of-small-objects payload:

```
size_bytes      = 2,308,891
main_thread_ms  = 19.20
worker_ms       = 52.09   (2.7× slower than baseline)
```

Same root cause as H5.b: V8 `JSON.parse` on Node 22 is fast enough that the
structuredClone cost of returning the parsed array dominates any off-main-thread
benefit, and the main thread only loses ~19 ms anyway (well below perceptible-hitch
territory). Wrapper, worker entry, esbuild entry-point and deactivate hook reverted.
The remaining persistence-read path is plain `JSON.parse` again.

**Conclusion on H5.\* (parse path):** on Node 22 with realistic `ui_messages.json` /
`api_conversation_history.json` sizes, neither a native NAPI parser (H5.b) nor a
worker_threads off-load (H5.c) beats V8's `JSON.parse`. Future work in this area
should target the _save_ path (H5.c-bis: stringify-in-worker under H6) or message
volume itself (H2 windowed loading), not the parse step.

### H8: Memoize Static Parts of `getStateToPostToWebview()`

**Landed 2026-05-21.** ContextProxy now exposes an
[`onDidChange`](extensions/shofer/src/core/config/ContextProxy.ts:51)
vscode.EventEmitter. [`ShoferProvider`](extensions/shofer/src/core/webview/ShoferProvider.ts:244)
subscribes — filtered to only `allowedCommands`/`deniedCommands` keys — and also
watches `vscode.workspace.onDidChangeConfiguration` for the same sections. A
generation counter invalidates `_cachedMergedAllowed` / `_cachedMergedDenied`,
avoiding redundant merge+dedup work on every state push.

### Open Items

**H2, H5.c (worker_threads), H7, H9** remain open.

---

## 2. Root Causes Identified

### 2.1 `preloadShoferMessages()` — Redundant Re-Read on Every Task Switch

[`Task.preloadShoferMessages()`](extensions/shofer/src/core/task/Task.ts#L2493) is
called from
[`ShoferProvider.createTaskWithHistoryItem()`](extensions/shofer/src/core/webview/ShoferProvider.ts#L1215)
every time the user switches to a task. It performs the following sequential disk I/O:

```
preloadShoferMessages()
  → readTaskMessages()                                      // READ  #1: fs.readFile + JSON.parse  ui_messages.json
  → splice/resize/trim the array                            //       in-memory manipulation only
  → overwriteShoferMessages() → saveTaskMessages()          // WRITE:   safeWriteJson  ui_messages.json
                              → taskMetadata()              //       walks full array to recompute token usage + HistoryItem
  → getSavedShoferMessages() → readTaskMessages()           // READ  #2: re-reads the file just written (REDUNDANT)
  → getSavedApiConversationHistory()                        // READ  #3: fs.readFile + JSON.parse  api_conversation_history.json
```

READ #2 is pure waste — `modifiedShoferMessages` is byte-identical to what was just
persisted. READ #3 is sequential with the rest but independent of `shoferMessages` and
can be parallelized.

For a typical ~2 MB `ui_messages.json`, `JSON.parse` is ~4 ms (Node parses at
~500 MB/s); the dominant cost on cold task switch is the **combination** of all I/O, the
`taskMetadata` full-array walk, and `safeWriteJson`'s tmp → fsync → rename sequence.

### 2.2 `saveShoferMessages` Save Frequency — Write Amplification on the Streaming Hot Path

[`saveShoferMessages()`](extensions/shofer/src/core/task/Task.ts#L1479) is invoked from
`addToShoferMessages` / `updateShoferMessage` on **every streamed chunk** during an agent
turn (partial messages, streamed reasoning chunks, `api_req_started` cost updates, …).
Each call:

1. `structuredClone(this.shoferMessages)` — full O(n) deep copy of the conversation array.
2. `safeWriteJson()` — tmp file write + `fsync` + `rename`.
3. `taskMetadata()` — walks the full message array to recompute token usage and rebuild
   the `HistoryItem`.
4. `updateTaskHistory()` — persists the rebuilt `HistoryItem`.

For a long turn this is hundreds of full-array clone + write + walk cycles. In
steady-state streaming, this dwarfs every gain available on the task-switch path.

### 2.3 State Broadcasting — Full `taskHistory` Array on Every State Push

[`ShoferProvider.getStateToPostToWebview()`](extensions/shofer/src/core/webview/ShoferProvider.ts#L2620)
serializes the full `taskHistory` array on every state push, and the host → webview
`postMessage` performs a structured clone of the whole payload (including
`shoferMessages`) per push. Mitigations exist (`postStateToWebviewWithoutTaskHistory`,
`postStateToWebviewWithoutShoferMessages`) but `postStateToWebview()` is still called
from many paths — task switch, settings change, mode change, MCP updates, etc. — not
just one.

### 2.4 `JSON.parse` Is Blocking (Single-Threaded Event Loop)

All `JSON.parse()` calls block the Node.js event loop. No `worker_threads` are used.
For typical file sizes (<5 MB) this is not actually a hot-path issue; it only matters
for the long-tail of >10 MB conversations.

### 2.5 Task History Index Grows Unboundedly

[`TaskHistoryStore.writeIndex()`](extensions/shofer/src/core/task-persistence/TaskHistoryStore.ts#L391)
writes the full `HistoryItem[]` into `_index.json` on every mutation (with 2 s debounce).
The index grows linearly with task count. Negligible until ~1,000+ tasks.

---

## 3. Optimization Plan (Ranked by Impact)

### 🔴 H0: Coalesce / Debounce `saveShoferMessages` During Streaming

**Target file:** [`Task.ts`](extensions/shofer/src/core/task/Task.ts#L1479)

The save fires on every streamed chunk. Coalesce trailing edits with a short debounce
(e.g., 100–250 ms) so a burst of streaming updates collapses to a single write.
On turn boundaries (turn end, `attempt_completion`, abort, suspend) flush synchronously
so persisted state matches in-memory state at every observable checkpoint.

Pair with item H6 below (avoid `structuredClone` per save) and item H2.bis (incremental
`taskMetadata` token accounting) — together these are the dominant steady-state cost
during agent execution.

**Estimated improvement:** Order-of-magnitude reduction in steady-state write/fsync rate
and CPU spent in `taskMetadata` during long turns. Single biggest realistic win.

**Risk:** Medium. Crash-loss window grows from "0" to "≤ debounce interval". Mitigation:
flush on every `say`/`ask` that ends a turn or yields the agent loop, on extension
deactivation, and on abort. Make the debounce interval a setting (typed via
`ContextProxy` per the Typed Settings Rule).

### 🔴 H1: Eliminate the Unnecessary Re-Read in `preloadShoferMessages()`

**Target file:** [`Task.ts`](extensions/shofer/src/core/task/Task.ts#L2493)

**Current code (lines 2541–2544):**

```typescript
await this.overwriteShoferMessages(modifiedShoferMessages) // WRITE + taskMetadata recompute
this.shoferMessages = await this.getSavedShoferMessages() // READ #2 (REDUNDANT)
this.apiConversationHistory = await this.getSavedApiConversationHistory() // READ #3
```

**Proposed:**

```typescript
this.shoferMessages = modifiedShoferMessages // skip READ #2
// Fire-and-forget the sanitized save; in-memory is already canonical.
void this.persistSanitizedPreloadSnapshot(modifiedShoferMessages)
this.apiConversationHistory = await this.getSavedApiConversationHistory()
```

**Tradeoff to call out explicitly:** Preload trims trailing `api_req_started` /
`reasoning` / `resume_*` entries. Those trims change what `taskMetadata` would compute.
Two options:

- **(a) Keep the metadata recompute** in `persistSanitizedPreloadSnapshot` (correct token
  accounting; same cost as today's write, minus only READ #2).
- **(b) Skip the metadata recompute** on preload and accept that `HistoryItem` token
  counts stay momentarily stale until the next real save during the resumed turn
  (cheaper, but `HistoryItem.tokensIn/Out` displayed in the task selector may briefly
  reflect the pre-trim state).

Choose (a) by default; only move to (b) after measuring that the recompute is itself a
meaningful slice of the preload cost.

**Risk:** Low. The in-memory array is byte-identical to what was written.

### 🔴 H3: Parallelize `preloadShoferMessages()` I/O

`shoferMessages` and `apiConversationHistory` are independent files. Compose with H1:

```typescript
const [shoferMsgs, apiHistory] = await Promise.all([
	this.getSavedShoferMessages(),
	this.getSavedApiConversationHistory(),
])
// … sanitize shoferMsgs in memory …
this.shoferMessages = shoferMsgs
this.apiConversationHistory = apiHistory
void this.persistSanitizedPreloadSnapshot(shoferMsgs)
```

**Risk:** Low. **Estimated improvement:** ~25–35 % of remaining preload time when both
files are large and comparable in size.

### 🟡 H4: Use a `taskHistoryUpdated` Delta Channel; Don't Send the Full Array on State Pushes

**Targets:**

- [`ShoferProvider.getStateToPostToWebview()`](extensions/shofer/src/core/webview/ShoferProvider.ts#L2620)
- [`ShoferProvider.postStateToWebview()`](extensions/shofer/src/core/webview/ShoferProvider.ts)

Today `taskHistory` is serialized on every `postStateToWebview()` call site — task
switch, settings change, mode change, MCP refresh, etc. Replace with:

1. A lightweight `taskHistoryUpdated` `ExtensionMessage` variant carrying only the
   changed `HistoryItem` (insert / update / delete + id). Add to `@shofer/types` per the
   Module Boundaries Rule.
2. An initial-load `taskHistorySnapshot` variant sent once when the webview mounts.
3. Switch all `postStateToWebview()` callers off carrying `taskHistory`; route mutations
   exclusively through `taskHistoryUpdated`.

Apply the same treatment to `shoferMessages` (large array, structure-cloned per push):
push a `messagesUpdated` delta for partial-message edits instead of re-sending the full
array. (`messageUpdated` already exists for the single-message case — generalize.)

**Risk:** Medium. Webview state-reducer changes; the exhaustive switch on
`ExtensionMessage` will surface every consumer (per the Exhaustive Switch Rule).
**Estimated improvement:** Removes O(N_tasks) and O(N_messages) per state push from the
IPC structured-clone path — biggest win for users with large histories.

### 🟡 H2: Windowed Message Loading (Last N Messages on Rehydrate)

**Target files:**

- [`Task.ts`](extensions/shofer/src/core/task/Task.ts#L2493) — `preloadShoferMessages()`
- [`taskMessages.ts`](extensions/shofer/src/core/task-persistence/taskMessages.ts) — new `readTaskMessagesWindowed`
- [`ChatView.tsx`](extensions/shofer/webview-ui/src/components/chat/ChatView.tsx) — sentinel + scroll-to-load
- [`ShoferProvider.ts`](extensions/shofer/src/core/webview/ShoferProvider.ts) — state push
- [`vscode-extension-host.ts`](extensions/shofer/packages/types/src/vscode-extension-host.ts) — new IPC variants

**Design:** On rehydrate load only the last K messages (e.g., 100) into memory and push
them to the webview. The webview shows a "Load older messages…" sentinel row at the top
of Virtuoso; reaching it posts `loadOlderMessages` and the host streams an older page.

**Implementation steps:** add `readTaskMessagesWindowed` / `readTaskMessagesRange`,
thread `hasMoreMessages` through state, register new typed IPC variants per the Webview
Message Routing Rule, coordinate prepend + scroll preservation in `ChatView`.

**Implementation note (parser):** For typical 1–5 MB files plain `JSON.parse` + tail
slice is already fast; reach for a streaming JSON tokenizer only for the long-tail of
files >10 MB. Measure first.

**Page-file alternative — explicitly rejected.** The earlier "split into
`ui_messages_page_*.json`" proposal had `saveShoferMessages` write both the full file
and the page files, doubling steady-state write cost on the hot streaming path to
optimize the cold task-switch path. Net regression.

**Risk:** **High** (revised up from Medium). The full-in-memory-array invariant is
relied on by:

- `taskMetadata()` (walks all messages for token usage — needs incremental accounting
  per item H2.bis below, or a separate persisted summary).
- Checkpoint restore / pending-edit replay in
  [`createTaskWithHistoryItem`](extensions/shofer/src/core/webview/ShoferProvider.ts#L1215).
- Message edit / delete flows operating by `ts` and array index.
- `prependMessage` and the message-queue drain path.
- The Virtuoso scroll lifecycle (`USER_BROWSING_HISTORY`) must coexist with
  prepend-on-load.

Recommend a feasibility spike before committing.

**Estimated improvement:** For a 1,000-message (~2 MB) task, loads ~10 % of bytes —
meaningful only after H0/H1/H3/H4 are in place, since steady-state save cost (H0) and
state-push payload (H4) dominate the user-visible perf today.

### 🟡 H2.bis: Incremental `taskMetadata` Token Accounting

`taskMetadata()` re-walks the entire message array on every save to recompute token
usage. Maintain a running total on `Task` (updated when messages are appended / edited /
removed) and pass it to `taskMetadata` instead of re-summing. Required prerequisite for
H2 (windowed loading can't recompute totals from an in-memory subset). Also a meaningful
standalone win because of H0/save frequency.

**Risk:** Medium — must keep the running total consistent across all message mutation
paths (`addToShoferMessages`, `updateShoferMessage`, `overwriteShoferMessages`, edit
flows, checkpoint restore). Unit-test the invariant.

### 🟡 H6: Replace `structuredClone` in `saveShoferMessages` With a Sync Snapshot

[`saveShoferMessages()`](extensions/shofer/src/core/task/Task.ts#L1479) currently clones
the whole array because `safeWriteJson` is async and `this.shoferMessages` is mutated
concurrently by the streaming loop (partial message updates, appended reasoning chunks).

Safer rewrite: snapshot synchronously to a string before awaiting:

```ts
const snapshot = JSON.stringify(this.shoferMessages) // sync; no concurrent mutation possible
await safeWriteJsonFromString(filePath, snapshot)
```

Requires a small addition to [`safeWriteJson`](extensions/shofer/src/utils/safeWriteJson.ts)
to accept a pre-serialized string (or expose a sibling helper). This avoids the O(n) deep
clone while preserving the concurrency invariant. Compose with H0 — debounced saves take
the snapshot once per debounce window, not once per chunk.

**Risk:** Low–Medium. New `safeWriteJson` overload; audit any other call site that
depends on the clone-isolation side effect (unlikely — it was just defensive
snapshotting).

### 🟡 H5: Parallelism — What Actually Works in Node.js

Node.js gives us three distinct knobs, with very different cost/benefit profiles.

**Non-options (call out and dismiss):**

- **Green threads / fibers.** Not available in modern Node. `async`/`await` is already
  cooperative multitasking on a single thread and does **not** help CPU-bound work
  (`JSON.parse`, `structuredClone`, `taskMetadata` walks) — those still block the event
  loop. Don't reach for `setImmediate`-chunking either; it just hides latency, it does
  not add cores.
- **Direct POSIX threads from JS.** Not exposed. Only reachable through a native
  addon — see H5.b.

**H5.a — Raise `UV_THREADPOOL_SIZE` (libuv's POSIX thread pool).**

libuv already uses POSIX threads under the hood for `fs.readFile`, `fs.writeFile`,
`fsync`, `rename`, DNS, and crypto. Default pool size is **4**. With H3 (parallel
preload reads), H0 (debounced writes that may still overlap across tasks), and the
`safeWriteJson` tmp → fsync → rename sequence (3 fs ops per save), we can exhaust the
default pool under modest concurrency, queuing further fs work behind the busy slots.

Set `process.env.UV_THREADPOOL_SIZE = "16"` (or 2–4× host core count, capped) **at the
very top of [`extension.ts`](extensions/shofer/src/extension.ts) before any module
that touches `fs` is imported**. After-the-fact assignment is ignored by libuv.

**Risk:** Very low. Memory cost is ~1 MB per extra thread (stack reservation). Real
ceiling is host disk bandwidth, not threads.

**Estimated improvement:** Removes a hidden serialization point when many fs ops are
in flight (e.g. concurrent task switch + background save + checkpoint write). No
effect on the single-file critical path.

**H5.b — Native `simdjson` addon for hot-path JSON parse. (Dropped — see status table.)**

**H5.c — `worker_threads` for parse/stringify of very large files. (Dropped — see status table.)**

The compelling use case for H5.c is the **save path** under H6: stringify is also O(n)
CPU and is currently the reason H6 needs a sync snapshot. Stringify-in-worker would let
us skip even the sync `JSON.stringify` from the main thread.

**Risk:** Medium–High. Worker lifecycle (creation, error propagation, abort
propagation per the Cooperative Cancellation Rule), and the IPC contract must be
carefully designed. Don't start here.

**Order within H5:** H5.a immediately (one-line change); H5.c only if measurements
demand it.

### 🟢 H7: Paginate the History Index — Defer

Only matters at ~1,000+ tasks. Revisit when telemetry shows index size or write latency
becoming a real problem.

### 🟢 H8: Memoize Static Parts of `getStateToPostToWebview()`

Settings rebuilt on every state push (`allowedCommands`, `deniedCommands`, `mcpServers`,
`customModes`) can be cached with invalidation via `ContextProxy.onDidChange` (already
wired). Low risk; small win — keep as cleanup pass.

### 🟡 H9: Gate `postStateToWebview` for Non-Focused (Background) Tasks

**Target file:** [`Task.ts`](extensions/shofer/src/core/task/Task.ts)

`updateShoferMessage()` already has a focus gate (line 1529):

```typescript
if (provider && provider.taskManager?.getFocusedTaskId() === this.taskId) {
	await provider.postMessageToWebview({ type: "messageUpdated", shoferMessage: message })
}
```

This means partial text updates (the dominant streaming hot path) and `api_req_started`
usage updates skip the webview push for background tasks — good.

But three other call sites unconditionally push full state:

1. **`addToShoferMessages()`** at [`Task.ts:1505`](extensions/shofer/src/core/task/Task.ts:1505):
   Called from `say()` for non-partial messages (`api_req_started`, `completion_result`,
   tool messages, new partial first-chunks) and from `ask()` for tool-approval/command
   approval asks.

2. **Stream start** at [`Task.ts:3733`](extensions/shofer/src/core/task/Task.ts:3733):
   After updating the placeholder `api_req_started` message with real data — always
   pushes state.

3. **Stream completion** at [`Task.ts:4555`](extensions/shofer/src/core/task/Task.ts:4555):
   After processing all streaming chunks — always pushes state.

All three call `getStateToPostToWebview()` (builds ~100-key state object), serialize it,
and push via IPC. The `shoferMessages` field reflects the FOCUSED task's messages
(`getCurrentTask()` at [`ShoferProvider.ts:2773`](extensions/shofer/src/core/webview/ShoferProvider.ts:2773)),
so the pushed data is actually stale — none of the focused task's messages changed.

**Impact per background task API turn:** 2 full state rebuild + push cycles (stream start
and end), plus 1 per non-partial `say`/`ask` call (~4-8 per turn).

**Fix:** Add `isFocusedTask()` gate before all three state pushes:

```typescript
// In addToShoferMessages (Task.ts line 1505):
if (provider && provider.taskManager?.getFocusedTaskId() === this.taskId) {
	await provider.postStateToWebviewWithoutTaskHistory()
}

// Same pattern for stream start (line 3733) and completion (line 4555).
```

**Risk:** 🟢 Low. Same pattern already proven in `updateShoferMessage`. The only risk is
if any webview component depends on receiving a full state push when a background
task transitions states — but background task state is communicated via
`taskHistoryItemUpdated` / `taskHistoryUpdated` delta channels (per H4), not via full
state pushes.

**Estimated improvement:** Eliminates 6–10 `getStateToPostToWebview()` + IPC pushes per
background task API turn. For a typical orchestrator scenario with 2–3 concurrent
background children each running 8-turn tasks, this removes ~50–150 wasteful state
pushes. The `getStateToPostToWebview()` call alone is ~50–200 µs (pure JS, no I/O),
so while not enormous individually, it adds up under concurrency.

### Verified: Paths that already skip webview pushes for background tasks

| Path                                    | Gate                                      | Location                                                                                                                        |
| --------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Partial text updates (streaming chunks) | `updateShoferMessage` focus check         | [`Task.ts:2367`](extensions/shofer/src/core/task/Task.ts:2367) → [`Task.ts:1529`](extensions/shofer/src/core/task/Task.ts:1529) |
| Partial reasoning updates               | Same                                      | [`Task.ts:4550`](extensions/shofer/src/core/task/Task.ts:4550)                                                                  |
| Tool_preparing dismiss                  | Same                                      | [`Task.ts:2464`](extensions/shofer/src/core/task/Task.ts:2464)                                                                  |
| api_req_started in-place usage updates  | Same                                      | [`Task.ts:4247`](extensions/shofer/src/core/task/Task.ts:4247)                                                                  |
| saveShoferMessages (disk write)         | ✅ Always fires for persistence — correct | [`Task.ts:1535`](extensions/shofer/src/core/task/Task.ts:1535) — debounced by H0                                                |

### Save path note

`safeWriteJson` to `ui_messages.json` still fires for background tasks (via H0-debounced
`saveShoferMessages`). This is intentional — background task messages must survive VS Code
restarts. H0 already reduces the write frequency to 250 ms trailing debounce. If profiling
shows disk I/O from concurrent background saves is still a bottleneck, further
optimizations could include:

- Longer debounce interval for background tasks (1–2 s) vs focused (250 ms)
- `fsync`-less writes for background tasks (accept crash-loss window)

---

## 4. What NOT to Optimize

| Area                                        | Reason                                              |
| ------------------------------------------- | --------------------------------------------------- |
| `TaskSelector.buildFlatTree()` O(n²)        | Webview-side, negligible for <500 tasks             |
| `TaskManager.restoreManagedTasks()`         | Simple O(n) loop, no I/O                            |
| Memory from `HistoryItem` objects           | ~1 KB each — 1,000 tasks ≈ 1 MB, negligible         |
| `extension.ts` activation order             | Already non-blocking                                |
| `TaskHistoryStore.reconcile()` startup scan | Only runs on cold cache; mitigated by `_index.json` |

---

# Part B — Memory Utilisation & Profiling

> This part explains why the Shofer extension host occasionally OOMs the underlying
> Node/V8 process, where the transient memory bloat most plausibly originates, what
> design changes would address each suspect, and how to profile the running extension
> host to confirm or refute each hypothesis.
>
> It is a debugging playbook, not a refactor proposal. It does not change any code;
> it lists the changes that would. Pick from the menu based on what the profiling
> data points at — do not implement everything upfront.

## 5. Symptom & Diagnosis

Observed in the Grafana memory dashboard (Node.js extension host):

- Steady-state heap: ~256 MiB.
- Recurring **spikes** to 1–2 GiB that recover to baseline within seconds.
- On the failing occasion, a spike climbed to ~2.5 GiB, V8 logged
  `last resort … GC in old space requested`, then:
    ```
    OOM error in V8: CALL_AND_RETRY_LAST Allocation failed - JavaScript heap out of memory
    log.ts:117  INFO Extension host (LocalProcess pid: 477566) is unresponsive.
    ```
- Heap-space breakdown at the time of the snapshot showed `large_object`
  dominating the spike component (~273 MiB at sample time, much higher at
  peaks), while `old` and `new` spaces stayed flat.

**Conclusion:** this is not a leak. It is one-or-few very large transient
allocations whose lifetime briefly overlaps and pushes V8 past its limit. The
fact that recovery happens between spikes proves the retainers are released
under normal circumstances.

---

## 6. Why It's `large_object` Space

V8 allocates objects larger than a page (~512 KiB on 64-bit, configurable per
build) directly into the `large_object` space. Anything in this space
implies a single contiguous allocation of at least half a megabyte. The
realistic shapes that land there in a Node.js extension host:

- Large `String` (concatenation result, `JSON.stringify` output, large
  template literal, base64 of a binary file).
- Large `Buffer` / `Uint8Array` / `ArrayBuffer` (file reads, fetched response
  bodies, image data, embeddings as `Float32Array`).
- Large pre-sized `Array` (rare in user code; common in serialisation
  libraries).
- WASM heap copies (tree-sitter, encryption libs, native deps).

We are therefore looking for code paths that produce a **single very big
object** and then drop it. Many small allocations cannot produce this
signature regardless of count.

A worst-case interaction pattern multiplies the peak: if a single piece of
data (e.g. a long conversation history) is **simultaneously**
(a) serialised to disk, (b) sent to the LLM provider as a request body, and
(c) posted to the webview as part of state, the same logical bytes can exist
3–4× in `large_object` for the few hundred milliseconds the operations
overlap. That alone can take a healthy ~600 MiB working set into OOM
territory.

---

## 7. Plausible Culprits

Ranked by typical peak size in a Shofer extension host. The ranking should be
treated as a starting search order, not a verdict — profiling is what
identifies the actual culprit.

### 7.1 Conversation history serialisation

`Task.saveApiConversationHistory()` and `Task.saveShoferMessages()` in
[`src/core/task/Task.ts`](../src/core/task/Task.ts) call `JSON.stringify` on
the whole array of messages before writing to disk. For a long task with
many tool outputs (full file contents, browser-tool HTML dumps, MCP
responses), the array can serialise to 50–500 MiB. During `JSON.stringify`
V8 holds the input graph plus the output string simultaneously, so the
on-heap peak is at least 2× the on-disk size.

Co-located writers via [`src/utils/safeWriteJson.ts`](../src/utils/safeWriteJson.ts)
inherit the same peak.

### 7.2 `postStateToWebview`

[`src/core/webview/ShoferProvider.ts`](../src/core/webview/ShoferProvider.ts)
`postStateToWebview()` and its `*WithoutTaskHistory` /
`*WithoutShoferMessages` variants (see the corresponding metrics in
[`src/metrics/registry.ts`](../src/metrics/registry.ts)) ship a state object
containing the same conversation arrays. VS Code structured-clones the
payload across the IPC boundary, so for a few ms the host holds the source
object plus the serialised clone. A debounced burst of these (e.g. during
streaming) compounds with §7.1 because both touch the same data.

### 7.3 LLM request-body assembly

The Anthropic / OpenAI / Gemini SDKs serialise the entire `messages` array
on every `chat.completions.create()` / `messages.create()` call — there is
no streaming-in counterpart. For a 200K-token context with inline tool
results, a single send is commonly 20–80 MiB. The SDK keeps the raw bytes
on the heap until the request resolves.

If any provider implementation under [`src/api/providers/`](../src/api/providers/)
does its own `JSON.stringify(messages)` before handing to the SDK, the peak
doubles.

### 7.4 LLM streaming-response accumulation

If anywhere we build the full response text via `accumulated += chunk` (or
equivalent), that is an O(n²) string grower: each `+=` allocates a new
backing buffer of the new total length and copies, so the moment-of-peak is
twice the final size. Grep targets: `accumulated`, `+=`, `concat`, anywhere
inside provider streaming loops.

### 7.5 `read_file` and `@file` mention expansion

A single `read_file` of a multi-MB file (`package-lock.json`, generated
code, log dump, PDF text, image-as-base64) materialises the full string in
one allocation. Base64 inflates 4/3; a 20 MiB image becomes a ~27 MiB
string. Several stacked reads in one tool turn compound.

### 7.6 Code-index / RAG batch processing

Workers under [`src/services/code-index/processors/`](../src/services/code-index/processors/)
read and embed files in batches. If a batch holds the full file contents
_and_ their Float32 embedding vectors at once, this can be hundreds of MiB
on a large repository. The retainer here is the batch container array, not
any individual file.

### 7.7 Tree-sitter parsing

The source string itself, plus internal WASM heap allocations for the AST.
Each top-level parse of a very large file briefly pins the source string in
`large_object`.

### 7.8 Helper-agent context window assembly

[`src/services/helper-agent/context-window.ts`](../src/services/helper-agent/context-window.ts)
concatenates many message bodies into a single prompt string before the
helper LLM call. Same shape as §7.1, but bounded by the helper model
context window.

### 7.9 Terminal output buffering

Long-running command output (`npm install`, `cargo build`, `pytest -v`)
flooding stdout into an in-memory buffer.

### 7.10 Misbehaving MCP tool responses

An MCP server returning a huge payload (e.g. a tool that dumps an entire
webpage) — Shofer has no application-level cap on incoming MCP-tool
results.

---

## 8. Design Changes by Culprit

Apply **only** the entries whose culprit profiling has confirmed. Each item
is an independent change with a self-contained mitigation.

### Implementation Status (as of v0.26.4)

| Item                                                    | Status                                                      | Commit                |
| ------------------------------------------------------- | ----------------------------------------------------------- | --------------------- |
| §8.1 Streaming JSON write for conversation snapshots    | Not started                                                 | —                     |
| §8.2 Webview state diffs instead of full snapshots      | Partial — incremental `shoferMessages` append delta shipped | `3a67eb015`           |
| §8.3 Inline-content caps and externalisation            | Implemented                                                 | `e6c246eeb` (v0.26.0) |
| §8.4 LLM request-body streaming where supported         | Not started                                                 | —                     |
| §8.5 Eliminate `+=` accumulation in streaming providers | Implemented                                                 | `bd831cac1` (v0.26.1) |
| §8.6 Bounded batches in the code indexer                | Implemented                                                 | `66b529249` (v0.26.4) |
| §8.7 Cap MCP tool response sizes                        | Implemented                                                 | `e9f633215` (v0.26.3) |
| §8.8 Cap terminal output retained in memory             | Not started                                                 | —                     |
| §8.9 Defer `JSON.stringify`-style cost in logs          | Implemented                                                 | `2d2f7e037` (v0.26.2) |

### 8.1 Streaming JSON write for conversation snapshots

> **Relation to prior art.** H0 (see §3 of Part A) debounced `saveShoferMessages`
> (250 ms trailing, 1000 ms maxWait) and H6 replaced the per-save
> `structuredClone` with a sync `JSON.stringify` snapshot. Both reduce **how
> often** and **how much extra** memory we spend per save, but every save still
> materialises a string the size of the entire conversation. This item is the
> next step beyond H0/H6.

Replace `JSON.stringify(messages)` + `fs.writeFile` with an
**append-only / streaming** persistence layer:

- Persist as JSONL (one message per line). New messages append; full
  rewrites only on rare compactions (e.g. truncation, mode change). This
  caps the serialisation peak at "one message" rather than "whole history".
- Where a single-file format is required, use a streaming serialiser
  (`stream-json` or a hand-rolled writer that emits `[`, each element with
  a trailing comma, `]`) so the host never materialises the whole string.

Knock-on: load-path becomes a line-by-line reader; existing snapshot
schemas/migrations need an adapter — but per the **No Backward Compatibility
Unless Asked** rule in the repo conventions, the migration can be one-shot
on first load.

### 8.2 Webview state diffs instead of full snapshots

> **Status — Partial.** The incremental `shoferMessages` append delta
> protocol shipped in `3a67eb015`. The remaining gap is extending the
> same delta channel to `apiConversationHistory` and `taskHistory`.

> **Relation to prior art.** H4 (see §3 of Part A) landed eight call-site
> conversions from `postStateToWebview()` to
> `postStateToWebviewWithoutTaskHistory()` and the single-message
> `messageUpdated` delta channel already exists. The remaining gap is the
> **generalised per-array delta protocol** for `shoferMessages` /
> `apiConversationHistory` / `taskHistory` — today every full-snapshot
> call site still ships the whole array.

`postStateToWebview` already has skinnier variants
(`postStateToWebviewWithoutTaskHistory`,
`postStateToWebviewWithoutShoferMessages`). The next step is to ship
**incremental updates** for the large arrays (`apiConversationHistory`,
`shoferMessages`, `taskHistory`) instead of the full array on every change.

A minimal incremental protocol:

- `messageAppended { taskId, message }`
- `messageUpdated { taskId, index, patch }`
- `messageReplaced { taskId, index, message }`
- `fullSync { taskId, messages }` — only on initial load or after a webview
  reload.

The webview already retains state across host pushes, so applying patches
is a small `useReducer` reducer per array.

This eliminates the §7.2 peak entirely except on full-sync, and on full-sync
collapses into §8.1's append-only file read.

### 8.3 Inline-content caps and externalisation

> **Status — Implemented in `e6c246eeb` (shofer v0.26.0).** A configurable
> `shoferBlobCapBytes` setting (default 64 KiB) gates inline tool-result
> content; oversized payloads are written to `.shofer/blobs/<sha256>.txt`
> and replaced inline with a `<shofer-blob …/>` reference token resolved
> on demand by the UI and the outbound LLM packer.

Inside tool results that get embedded in the conversation history, cap the
inline portion and externalise the rest:

- **Per-tool-result cap** (e.g. 64 KiB) on the inline text persisted in
  `shoferMessages` / `apiConversationHistory`. Beyond the cap, write the
  full content to `.shofer/blobs/<sha256>.txt` and embed a reference token
  `<shofer-blob sha256="…" bytes="…"/>`.
- The UI resolves blob refs on demand; the LLM call expands them only when
  the message is part of the outgoing context window, and even then the
  truncation policy in [`src/core/sliding-window/`](../src/core/sliding-window/)
  may already drop them.

This addresses §7.1, §7.3, §7.5, §7.7, and §7.10 in one stroke because they
all become a constant-size reference plus a content-addressable file.

### 8.4 LLM request-body streaming where supported

For providers whose SDK supports it, hand the request body in as an
`AsyncIterable<Uint8Array>` rather than a fully-materialised JSON. Where the
SDK only accepts a JS object, do the serialisation lazily via a wrapping
`Readable` and let undici stream it out. This addresses §7.3.

### 8.5 Eliminate `+=` accumulation in streaming providers

> **Status — Implemented in `bd831cac1` (shofer v0.26.1).** All providers
> in [`src/api/providers/`](../src/api/providers/) now push chunks into an
> array and emit a single `chunks.join("")` at end-of-stream; no
> quadratic-growth `accumulated += chunk` paths remain.

Audit every provider in [`src/api/providers/`](../src/api/providers/) for
`accumulated += chunk` and equivalent patterns; replace with `chunks.push`
and a single `chunks.join("")` at the end (one allocation, no quadratic
growth). Even better, yield each chunk to the consumer instead of
re-emitting the full text, and have the consumer maintain its own
incremental buffer. Addresses §7.4.

### 8.6 Bounded batches in the code indexer

> **Status — Implemented in `66b529249` (shofer v0.26.4).** A new
> `MAX_BATCH_BYTES = 2 MiB` constant in
> [`services/code-index/constants/index.ts`](../src/services/code-index/constants/index.ts)
> gates both `DirectoryScanner.scanDirectory` and `scanSpecificFiles`
> alongside the existing segment-count threshold. Either gate triggers a
> flush, keeping peak in-flight scanner memory bounded regardless of
> repository shape (minified bundles, generated code, large docstrings).

Cap the in-flight bytes (not just file count) in the batch loop under
[`src/services/code-index/processors/`](../src/services/code-index/processors/).
A simple `currentBatchBytes += fileSize; if (currentBatchBytes > LIMIT)
flushBatch()` keeps the peak deterministic regardless of repository shape.
Addresses §7.6.

### 8.7 Cap MCP tool response sizes

> **Status — Implemented in `e9f633215` (shofer v0.26.3).** New setting
> `shoferMcpMaxResponseBytes` (default 1 MiB, `0` disables) is read by
> `Task.getMcpMaxResponseBytes()` and threaded through
> `processMcpToolContent` and `runMcpToolCall` (in
> [`src/core/tools/mcp/use-mcp-shared.ts`](../src/core/tools/mcp/use-mcp-shared.ts))
> plus the three `UseMcpToolTool` / `CheckMcpCallStatusTool` /
> `WaitForMcpCallTool` call sites. Truncation is UTF-8-boundary-safe
> (trailing U+FFFD bytes stripped) and appends a banner pointing the
> agent at the setting.

In the MCP client adapter, truncate responses larger than a configured
threshold (default e.g. 1 MiB) and surface a warning to the agent. Addresses
§7.10 and protects against a single malicious/buggy MCP server.

### 8.8 Cap terminal output retained in memory

In the terminal capture layer, switch the in-memory ring buffer to a fixed
byte cap with overflow spilled to a temp file that the LLM can be pointed
at via a tool. Addresses §7.9.

### 8.9 Defer `JSON.stringify`-style cost in logs

> **Status — Implemented in `2d2f7e037` (shofer v0.26.2).** > `createOutputChannelLogger` in
> [`src/utils/outputChannelLogger.ts`](../src/utils/outputChannelLogger.ts)
> now caps every non-string log argument at `MAX_LOG_ARG_BYTES = 8 KiB`
> with a `…[+N more bytes]` suffix. A `stringifyForLog(value, maxBytes?)`
> helper is exported for template-literal call sites in
> `presentAssistantMessage.ts` and `api/providers/vscode-lm.ts` that
> bypass the logger and would otherwise stringify whole tool args /
> stream chunks.

Any `outputChannel.appendLine(JSON.stringify(largeObject))` in hot paths is
itself a `large_object` allocation. Audit logger call sites for accidental
full-stringify of conversation/state objects; replace with size summaries
(`messages.length`, `Buffer.byteLength(JSON.stringify(x))` only when above
a threshold).

---

## 9. Profiling Toolbox

The order here is the order of bang-for-buck. The first three usually
suffice.

### 9.1 `--heapsnapshot-near-heap-limit=N` (most surgical)

V8 dumps a `.heapsnapshot` automatically the last `N` times it is about to
OOM. Set `N=3` to catch the last three near-misses including the fatal one.

VS Code intentionally strips `NODE_OPTIONS` from the extension-host process
(see [§12](#12-known-constraints)), so this flag cannot be passed via env.
It must be:

- passed to the workbench/extension-host launcher (code-server-side patch),
  **or**
- threaded through whatever launches the host in our packaging
  ([`build-code-server.sh`](../../../build-code-server.sh)).

Once enabled, snapshots land in the extension-host process's cwd. Open in
Chrome DevTools → **Memory** → **Load** → switch to "Statistics" view to
confirm `large_object` is the dominant space, then "Containment" view to
find the dominator object that retained the memory. The dominator is the
culprit's root.

### 9.2 On-demand `shofer.heapSnapshot` command (already implemented)

The repo already registers `shofer.heapSnapshot` in
[`src/activate/registerCommands.ts`](../src/activate/registerCommands.ts);
it calls `v8.writeHeapSnapshot()` and writes to
`.shofer/heap-snapshots/heap-<timestamp>.heapsnapshot`. Use this to capture
a baseline at task start and a peak snapshot mid-task, then diff in
DevTools (`Comparison` view) to find what was newly retained.

### 9.3 Automatic snapshot on watermark

Add a small singleton that polls `process.memoryUsage().heapUsed` every 5 s
and, when it crosses a threshold (e.g. 1.5 GiB), calls `v8.writeHeapSnapshot`
**once per host session** (rate-limit; snapshots themselves cost ~100 MiB to
produce and we don't want a feedback loop). Log the path to the output
channel so the user can attach it to a bug report.

This is the cheapest way to capture the bad spike in the field, where
reproducing it under a debugger is impractical.

### 9.4 Per-suspect size logs

Five surgical instrumentation points covering the §7 suspects:

| Where                                                           | What to log                                                                                               |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Just before each LLM send                                       | `messages.length` and serialised byte size (only when above 1 MiB to avoid the O(n) cost in steady state) |
| Inside `Task.saveApiConversationHistory` / `saveShoferMessages` | Serialised byte length being written                                                                      |
| Inside `read_file` / `@file` mention expansion                  | Bytes read per call                                                                                       |
| Inside the code-index batch loop                                | Pending-bytes total at flush time                                                                         |
| Inside `postStateToWebview*`                                    | Serialised state byte size (only above a threshold)                                                       |

These correlate spikes from the Grafana board with concrete code paths
without needing a debugger attach.

### 9.5 `--inspect-extensions=9229` + DevTools Allocation Sampling

For transient spikes that resist reproduction:

1. Launch the extension host with `--inspect-extensions=9229`.
2. In Chrome, open `chrome://inspect`, attach to the host.
3. **Memory** tab → "Allocation sampling" → Start.
4. Reproduce the workload (long task, large file read, big repo index).
5. Stop. The aggregated view shows allocations grouped by source location,
   weighted by retained bytes.

Requires the extension-host bundle to ship **source maps**; the production
minified bundle otherwise shows `t.e.r()` symbols and the report is
unreadable. Ensure the build under [`src/dist/`](../src/dist/) includes
sourcemaps when profiling.

### 9.6 `v8.getHeapSpaceStatistics()` in the metrics exporter

The Grafana board already breaks down by space, so this is presumably
wired. If not, add a periodic poll in the metrics layer and emit one
gauge per space (`new`, `old`, `large_object`, `code`, `map`, …). The
breakdown is what reveals "single big allocations" (large_object spike)
vs. "lots of medium allocations" (old space spike) and changes the search
radically.

### 9.7 Allocation profiling via V8 Inspector

`require("v8").inspector` and the V8 Inspector protocol's
`HeapProfiler.startSampling` give the same data as §9.5 without needing a
GUI; the result is a JSON profile loadable into DevTools. Useful for
long-running headless capture (CI, long sessions).

---

## 10. Recommended Investigation Sequence

1. **Land §9.3 (watermark auto-snapshot).** ~30 lines. Captures the next
   crash without needing the user to do anything.
2. **Confirm via §9.6 that `large_object` is the dominant space at the
   spike.** If it is not, the analysis in §6 changes — old-space dominance
   would point at a genuine leak instead.
3. **Open the captured snapshot.** Identify the dominator object and the
   retainer path.
4. **Map the retainer path to one of §7's culprits** (usually obvious from
   the class/string names).
5. **Apply the matching §8 design change** — only the one, not all of them.
   Each one of §8.1, §8.2, §8.3 is a substantial design change in its own
   right; do not do them speculatively.
6. **Re-measure** with the same auto-snapshot infrastructure. The spike's
   peak should drop visibly in the Grafana board.

---

## 11. Performance / Lagginess Impact

The §8 items target memory peaks, but several of them are independently
the biggest realistic UI-responsiveness wins in the extension. The mental
model: the extension host is single-threaded. Anything that allocates a
multi-MB object, serialises a multi-MB string, or structured-clones a big
payload across the IPC boundary **stalls the event loop for the duration**.
That stall is what the user perceives as lag — typing freezes, cursor
stutter, scroll jank in the chat, slow chip clicks, delayed tool approvals.
GC pauses on large heaps compound it: a major GC on a 1.5 GiB heap is
100–300 ms, visible as a hitch even when nothing is "wrong".

The ranking below is by **expected lagginess win**, which is a different
order from the OOM-win ranking implicit in §7.

### 11.1 High impact

- **§8.2 — Webview state diffs instead of full `postStateToWebview`
  snapshots.** Almost certainly the #1 lag win. Today every change to the
  conversation (every streamed chunk that triggers a non-partial
  `addToShoferMessages`, every tool result, every status flip) triggers a
  serialise + structured-clone of the entire state object containing the
  full conversation arrays. On a long task that's tens of MiB cloned
  hundreds of times per minute. Each clone is a synchronous main-thread
  stall on **both** sides (host serialises, renderer deserialises).
  Switching to append/patch IPC drops per-message cost to O(1) instead of
  O(history). Users will feel this immediately as smoother streaming and
  snappier UI during long sessions. H4 already removed some of the
  worst-offending call sites; this is the generalisation that closes the
  gap.

- **§8.5 — Eliminate `+=` accumulation in streaming providers.** O(n²)
  string growth on every streamed chunk means each chunk reallocates and
  copies the whole accumulated response. Mid-stream, a single chunk
  arriving when the response is already 500 KiB costs a 1 MiB allocation +
  memcpy + the old string becoming GC-eligible. Replace with
  `chunks.push(…) + join` at end, O(n) total. Visible win: streaming feels
  even-paced instead of "fast then sluggish".

- **§8.1 — Streaming JSON write for conversation snapshots.** H0 already
  debounced the saves and H6 already removed the per-save `structuredClone`
  but, when the debounced save does fire on a long task, `JSON.stringify`
  on the full array is still a synchronous multi-hundred-ms event-loop
  stall. JSONL append makes the steady-state save O(1 message). Visible
  win: no periodic typing-freeze every few seconds during long tasks.

### 11.2 Medium impact

- **§8.3 — Inline-content caps + blob externalisation.** Indirect lag win:
  smaller messages → cheaper §8.2 (less to diff) → cheaper §8.1 (less to
  serialise) → less GC pressure overall. Also makes the sliding-window
  truncation pass cheaper because it walks shorter strings.

- **§8.9 — Defer `JSON.stringify` in log calls.** Tiny code change,
  surprisingly large effect if any hot path is doing
  `appendLine(JSON.stringify(state))`. A single accidental full-state
  stringify in a logger called per-chunk could be the lag source by
  itself.

- **§8.6 — Bounded code-indexer batches.** Indexing is supposed to be
  background, but unbounded batches periodically jam the event loop with
  file-IO bursts and embedding-vector allocations. Capping bytes-in-flight
  smooths that into a steady drip the user doesn't feel.

### 11.3 Low impact on lag

- **§8.4 — LLM request-body streaming.** OOM-relevant, but the one-shot
  serialise happens once per turn, not per chunk — not a major lag source.
- **§8.7 — MCP response caps.** Pure defence against worst-case payloads;
  no steady-state lag win.
- **§8.8 — Terminal output ring buffer.** Only matters during very chatty
  commands. Niche.

### 11.4 Why GC pressure matters regardless of which §8 items land

- **GC pressure scales superlinearly with live heap.** If steady-state
  working set drops from ~600 MiB to ~256 MiB (which §8.1 + §8.2 + §8.3
  plausibly achieve), major GCs become both shorter and less frequent.
  That alone removes a class of periodic hitches the user currently
  perceives as random sluggishness.
- **`large_object` allocations are paged separately and not movable.** A
  churn of multi-MB allocations fragments that space and is one of the
  few cases where V8 does a stop-the-world compaction. Killing the source
  of large-object churn (§8.1, §8.2, §8.5) eliminates that pause entirely.

### 11.5 Recommended sequencing for the lagginess goal

Different from §10's OOM-driven order. If the goal is responsiveness:

1. **§8.5** — smallest change, immediate effect on streaming smoothness.
   An afternoon's audit across providers.
2. **§8.9** — even smaller; may surface a "wait, we were stringifying
   _that_?" moment.
3. **§8.2** — biggest steady-state lag win but real design work. The diff
   protocol is small (per §8.2 above) but the host and webview reducers
   need careful wiring and good tests around message-ordering edge cases.
   Picks up directly where H4 stopped.
4. **§8.1** — pairs naturally with §8.2; together they collapse the
   §7.1+§7.2 peak that's both the OOM cause and the periodic-stall cause.

§8.5 and §8.9 are worth landing first as cheap wins while §8.1+§8.2 are
designed properly. They are independently testable and don't interact.

### 11.6 Anti-pattern: raising `--max-old-space-size`

A larger heap means longer GCs, which makes lag **worse** even when it
postpones OOM. The right order is shrink the working set first; bump the
cap only as insurance once the steady-state allocation rate is under
control. See also §12's first bullet on why the env-var route doesn't even
work today.

---

## 12. Known Constraints

- **VS Code strips `NODE_OPTIONS` from the extension host.** This is visible
  in [`code-server/lib/vscode/src/vs/platform/agentHost/electron-main/electronAgentHostStarter.ts`](../../../code-server/lib/vscode/src/vs/platform/agentHost/electron-main/electronAgentHostStarter.ts)
  and in the related Copilot-agent file. The workspace's
  `NODE_OPTIONS="--max-old-space-size=16384"` in
  [`build-code-server.sh`](../../../build-code-server.sh) therefore does **not**
  reach the extension host, which runs at V8's default
  (~1.5–2 GiB) — exactly the ceiling we are hitting. Raising the limit (or
  enabling `--heapsnapshot-near-heap-limit`) requires a patch to the
  code-server launcher path, not an env-var change.

- **Raising the heap limit is treatment, not cure.** It postpones OOM but
  does not address the underlying transient-bloat pattern. Useful as a
  safety net while §8 changes land, not as a permanent fix.

- **Source maps for the production extension-host bundle.** The current
  build is minified; any heap snapshot or allocation sample taken against a
  production install will be partially unreadable. Profiling work should be
  done against a build that ships sourcemaps, or with source maps available
  alongside via a separate `.map` upload.

- **Snapshots are expensive.** A `v8.writeHeapSnapshot()` call on a 2 GiB
  heap takes seconds and stalls the event loop. Watermark-triggered
  snapshots must be rate-limited (once per session) and ideally are
  off-by-default in production behind a `shofer.diagnostics.autoHeapDump`
  setting.

---

## 13. Related Files

| File                                                                                            | Role                                                                   |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [`src/core/task/Task.ts`](../src/core/task/Task.ts)                                             | `saveApiConversationHistory`, `saveShoferMessages` — the §7.1 culprits |
| [`src/utils/safeWriteJson.ts`](../src/utils/safeWriteJson.ts)                                   | Shared JSON write path used by the persistence layer                   |
| [`src/core/webview/ShoferProvider.ts`](../src/core/webview/ShoferProvider.ts)                   | `postStateToWebview` and skinnier variants — the §7.2 culprit          |
| [`src/api/providers/`](../src/api/providers/)                                                   | LLM provider implementations — §7.3, §7.4                              |
| [`src/services/code-index/processors/`](../src/services/code-index/processors/)                 | Batch readers / embedders — §7.6                                       |
| [`src/services/helper-agent/context-window.ts`](../src/services/helper-agent/context-window.ts) | Helper-agent prompt assembly — §7.8                                    |
| [`src/activate/registerCommands.ts`](../src/activate/registerCommands.ts)                       | `shofer.heapSnapshot` command (§9.2)                                   |
| [`src/metrics/registry.ts`](../src/metrics/registry.ts)                                         | Histograms for `saveShoferMessages` and `postStateToWebview*`          |
| [`build-code-server.sh`](../../../build-code-server.sh)                                         | Where the (currently-stripped) `NODE_OPTIONS` is set — see §12         |

---

## 14. Cross-Reference: H-Items ↔ §4 Items

This table maps the Part A performance items (H0–H9) to the corresponding
Part B design changes (§8.1–§8.9) and vice versa. Several items are the same
change described from different angles — latency/throughput in Part A, memory/OOM
in Part B.

| Part A (Perf)                               | Part B (Mem)                      | Relationship                                                                                                                             |
| ------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| H0 (debounce `saveShoferMessages`)          | §8.1 (streaming JSON write)       | H0 reduces save **frequency**; §8.1 reduces per-save **peak**. Together they eliminate the §7.1 peak.                                    |
| H4 (delta channel for tasks/messages)       | §8.2 (webview state diffs)        | Same change. H4 did the first pass (8 call-site conversions + `messageUpdated`); §8.2 is the generalisation to `apiConversationHistory`. |
| H6 (sync `JSON.stringify` snapshot)         | §8.1 (streaming JSON write)       | H6 replaced `structuredClone` with sync stringify (same peak, less GC). §8.1 reduces the peak itself.                                    |
| §8.3 (inline-content caps)                  | —                                 | Standalone; not directly mapped to an H-item. Addresses §7.1, §7.3, §7.5, §7.7, §7.10.                                                   |
| —                                           | §8.4 (LLM request-body streaming) | Not mapped to any H-item.                                                                                                                |
| §8.5 (eliminate `+=` in providers)          | —                                 | Standalone; not an H-item. Landed as `bd831cac1`.                                                                                        |
| §8.6 (bounded code-indexer batches)         | —                                 | Standalone; not an H-item. Landed as `66b529249`.                                                                                        |
| §8.7 (cap MCP response sizes)               | —                                 | Standalone; not an H-item. Landed as `e9f633215`.                                                                                        |
| §8.8 (cap terminal output)                  | —                                 | Standalone; not an H-item.                                                                                                               |
| §8.9 (defer `JSON.stringify` in logs)       | —                                 | Standalone; not an H-item. Landed as `2d2f7e037`.                                                                                        |
| H2 (windowed message loading)               | §8.1 (§8.2)                       | H2 attacks the same arrays from the load side; complements the save-side and IPC-side changes.                                           |
| H9 (gate state pushes for background tasks) | §8.2                              | H9 is a narrow optimisation within the broader §8.2 diff protocol; both reduce IPC payload frequency.                                    |

---

## 15. Implementation Order (Combined)

This merges the Part A implementation order (§3) with the Part B lagginess
sequencing (§11.5). Items already done are omitted.

1. **(Quick win) §8.5 / §8.9** — Already implemented. Verify in production.
2. **§9.3 (watermark auto-snapshot)** — Prerequisite for diagnosing the
   remaining OOM. ~30 lines.
3. **§8.2 generalisation** — Extend the H4 delta protocol to
   `apiConversationHistory` and `taskHistory`. Biggest remaining lag win.
4. **H9** — Gate state pushes for background tasks. One-line focus check
   per call site; proven pattern.
5. **§8.1 / JSONL persistence** — Streaming JSON write for conversation
   snapshots. Eliminates the §7.1 peak. Design work.
6. **H2** — Windowed message loading. Feasibility spike first.
7. **§8.4** — LLM request-body streaming (provider-dependent).
8. **§8.8** — Cap terminal output buffer.
9. **H7** — Paginate history index. Defer until task count warrants it.
10. **Anti-pattern guardrail:** Do NOT raise `--max-old-space-size` until
    the working set is under control (§11.6).

---

## 16. Metrics to Track

Instrument these before committing the larger items (H2, §8.1, §8.2
generalisation) so we can attribute wins.

- **Task-switch latency:** `Date.now()` at start and end of
  `createTaskWithHistoryItem()`, log via output channel.
- **`preloadShoferMessages` breakdown:** time each of READ #1, the sanitize
  block, the WRITE (incl. `taskMetadata`), and READ #3 separately.
- **`saveShoferMessages` call frequency and duration** during a turn (count +
  p50/p95 ms).
- **`ui_messages.json` file size distribution:** log size on save to identify
  outliers.
- **`postStateToWebview()` JSON payload size:** log byte length before
  `postMessage`.
- **`_index.json` size and parse time** during `loadIndex()` / `writeIndex()`.
- **Background task state push count:** log how many
  `postStateToWebviewWithoutTaskHistory` / `addToShoferMessages` calls come
  from background tasks vs focused task per minute. Gated on
  `process.env.DEBUG`.
- **Per-suspect size logs (§9.4):** LLM send sizes, save sizes, read_file
  sizes, batch flush totals, state push sizes — all above thresholds.

Per the Output Channel Logging Rule, route diagnostics through
`outputChannelLogger` gated on `process.env.DEBUG` (cf. existing
`home-screen-flash` pattern in
[`ShoferProvider.ts`](extensions/shofer/src/core/webview/ShoferProvider.ts#L2672)) — not
`console.log`.

---

## Revision History

| Date       | Change                                                                                                                                                                     |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-05-20 | Original performance analysis (H0–H9).                                                                                                                                     |
| 2026-05-20 | Review pass: numbers walked back, H0 added, H2 risk raised to High, H4 broadened, H6 reclassified, H5 split, H1 tradeoff explicit.                                         |
| 2026-05-21 | H0, H4, H2.bis, H8 landed. H5.b/H5.c dropped after benchmarking. H9 added.                                                                                                 |
| 2026-05-25 | Memory utilisation analysis added (§§5–13). Documents merged into single `optimizations.md`. Cross-reference table added (§14). Combined implementation order added (§15). |
