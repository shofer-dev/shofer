# Shofer Performance Optimizations

> Updated 2026-06-09: Incremental messaging (IPC protocol refinement) landed.

> Analysis performed 2026-05-20. Source code paths verified against HEAD.
> Revised 2026-06-09 after incremental messaging (IPC protocol refinement) landed.
>
> **Implementation status (2026-06-09):** all H0–H10 items resolved.
>
> **Incremental messaging landed 2026-06-09 (IPC protocol refinement):** > `postStateToWebview()` and its two `Without*` variants are replaced by three
> targeted IPC methods: `postInitState()` (full-snapshot on task switch/webview
> reset), `postConfigUpdate(key, value)` (single key/value pair for settings
> mutations), and `postTaskStateUpdate(updates)` (task lifecycle fields only).
> The webview-side `mergeExtensionState` no longer carries the `shoferMessagesSeq`
> stale-overwrite guard — it's superseded by the protocol-level split into
> distinct message types. Per-message deltas (`shoferMessageAppended`) are now
> the **sole** streaming path — skinny `postStateToWebviewWithoutShoferMessages`
> pushes at stream-start and stream-end are removed. The H8 static-state cache
> (`_cachedMergedAllowed`, etc.) is removed because `postInitState` fires O(1)
> per task lifetime (not per streaming chunk).
>
> New log category `IPC` records every protocol message; enable `IPC` + `Webview`
> in `shofer.logCategories` to monitor fallback paths.
>
> ### Status Table
>
> | #             | Item                                                        | Description                                                                                                                                                                                                                                                                                     | Risk       | Status                   | Implemented    |
> | ------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------ | -------------- |
> | **H5.a**      | Raise `UV_THREADPOOL_SIZE`                                  | One-line env var in `extension.ts`; removes fs-ops serialization bottleneck                                                                                                                                                                                                                     | 🟢 Low     | ✅ Done                  | pre-2026-05-21 |
> | **H1**        | Eliminate redundant re-read in `preloadShoferMessages()`    | Skip READ #2 after sanitized save; compose with H3                                                                                                                                                                                                                                              | 🟢 Low     | ✅ Done                  | pre-2026-05-21 |
> | **H3**        | Parallelize `preloadShoferMessages()` I/O                   | `Promise.all` for independent `shoferMessages` + `apiConversationHistory` reads                                                                                                                                                                                                                 | 🟢 Low     | ✅ Done                  | pre-2026-05-21 |
> | **H6**        | Sync `JSON.stringify` snapshot instead of `structuredClone` | Freeze string before async write; avoids O(n) deep copy per save                                                                                                                                                                                                                                | 🟡 Low–Med | ✅ Done                  | pre-2026-05-21 |
> | **metrics**   | Instrumentation scaffolding                                 | Perf logging gated on `process.env.DEBUG`                                                                                                                                                                                                                                                       | 🟢 Low     | ✅ Done                  | pre-2026-05-21 |
> | **H0**        | Debounce `saveShoferMessages` during streaming              | 250ms trailing debounce (1s maxWait); flush at turn boundaries                                                                                                                                                                                                                                  | 🟡 Medium  | ✅ Done                  | 2026-05-21     |
> | **H2.bis**    | Incremental `taskMetadata` token accounting                 | Dirty-flag cache skips O(n) token walk when no new token-bearing messages                                                                                                                                                                                                                       | 🟡 Medium  | ✅ Done                  | 2026-05-21     |
> | **H8**        | `ContextProxy.onDidChange` + memoize static state           | EventEmitter + generation counter cache for merged command lists. **Removed 2026-06-09** — cache invalidated when `postInitState` became O(1) per task lifetime.                                                                                                                                | 🟢 Low     | ✅ Done → Removed        | 2026-06-09     |
> | **H10**       | Incremental webview message consolidation                   | Cache consolidated prefix at a safe split boundary; re-consolidate only the changed tail per streamed chunk — removes the webview-side O(n²) per-task slowdown                                                                                                                                  | 🟢 Low–Med | ✅ Done                  | 2026-05-30     |
> | **H9**        | Gate state pushes for background tasks                      | Add `isFocusedTask()` check to `addToShoferMessages` + stream start/end state pushes. **Superseded 2026-06-09** — the `shoferMessageAppended` path already gates; the skinny-push blocks removed by incremental messaging are the same ones H9 would have gated.                                | —          | ✅ Superseded            | 2026-06-09     |
> | **H4**        | Delta channel for `taskHistory`/`shoferMessages`            | Converted `postStateToWebview()` callers to `withoutTaskHistory` variant. **Superseded 2026-06-09** — incremental messaging splits `postInitState` (full snapshot) from `postConfigUpdate`/`postTaskStateUpdate` (targeted deltas), achieving the same IPC payload reduction at the type level. | —          | ✅ Superseded            | 2026-06-09     |
> | ~~**H5.b**~~  | ~~Native `simdjson` addon for large-file parse~~            | Implemented + benchmarked 2026-05-21 — on Node 22, V8 `JSON.parse` was ~5× _faster_ than `simdjson` on the representative payload (4.5 ms vs 22.9 ms for 1.6 MB); wrapper and dep reverted. See H5.c instead.                                                                                   | —          | ❌ Dropped (empirically) | —              |
> | ~~**H5.c**~~  | ~~`worker_threads` for parse of large files~~               | Worker read file + `JSON.parse`d; only result crossed postMessage. 1 MiB threshold. Implemented + benchmarked 2026-05-21 — on Node 22, the worker path was 2.7× _slower_ than main-thread baseline (52 ms vs 19 ms for 2.3 MB) because structuredClone of the parsed array dominates. Reverted. | —          | ❌ Dropped (empirically) | —              |
> | **H11**       | Incremental token-bearing message count                     | Maintain `_tokenBearingMessageCount` as a live field; O(1) validity check in `_refreshTaskMetadata`                                                                                                                                                                                             | 🟡 Medium  | ✅ Done                  | 2026-06-10     |
> | **H12**       | Threshold-triggered JSONL compaction                        | Skip O(n) serialize+write when `_appendedSinceCompaction < 100`; compact at turn boundaries                                                                                                                                                                                                     | 🟡 Medium  | ✅ Done                  | 2026-06-10     |
> | **H13**       | Reuse append file handle + memoized `mkdir`                 | Long-lived `fs.open(…, "a")` handle; `Set<string>` directory-ensured cache; handle lifecycle tied to `dispose`/`abortTask`                                                                                                                                                                      | 🟢 Low     | ✅ Done                  | 2026-06-10     |
> | **H14**       | BlobStore cross-call content cache                          | `_readCache` Map skips repeated `fs.readFile` per blob; index-delta variant at `prepareMessagesForApi` layer implemented and reverted (see reversion notes)                                                                                                                                     | 🟡 Medium  | ✅ Done                  | 2026-06-10     |
> | **H2**        | Windowed message loading                                    | Load last K messages with Virtuoso scroll-to-load sentinel                                                                                                                                                                                                                                      | 🔴 High    | ❌ Open                  | —              |
> | **H7**        | Paginate history index                                      | Split `_index.json` into pages at 1,000+ tasks                                                                                                                                                                                                                                                  | 🟢 Low     | ❌ Open                  | —              |
> | **IPC proto** | Incremental messaging (IPC protocol refinement)             | Replace three `postStateToWebview*` methods with `postInitState` (full snapshot), `postConfigUpdate(key,value)` (single-key delta), and `postTaskStateUpdate(updates)` (task lifecycle delta). Webview splits `"state"` handler into `stateInit`/`configUpdate`/`taskStateUpdate`.              | 🟡 Medium  | ✅ Done                  | 2026-06-09     |

## Verification (2026-06-10, corrected)

> All line-number anchors verified against HEAD (Task.ts ≈ 7,186 lines).
> Root Cause #2 rewritten for JSONL-append architecture. H9 section rewritten
> as historical (referenced `postStateToWebviewWithoutTaskHistory` has zero refs
> in `src/`).

**Verified accurate:**

- Incremental messaging is real and wired: `postInitState`, `postConfigUpdate`,
  and `postTaskStateUpdate` exist on `ShoferProvider` and are the live IPC
  surface; the old `postStateToWebview*` variants are gone.
- `shoferMessageAppended` is the sole streaming delta path
  ([`Task.ts`](extensions/shofer/src/core/task/Task.ts#L1903) `addToShoferMessages`,
  gated on `getFocusedTaskId() === taskId || getCurrentTask()?.taskId === taskId`).
- `UV_THREADPOOL_SIZE = "16"` is set at the top of
  [`extension.ts`](extensions/shofer/src/extension.ts#L12) before any `fs` import (H5.a).
- The H10 incremental-consolidation module
  ([`incrementalMessageProcessing.ts`](extensions/shofer/webview-ui/src/components/chat/incrementalMessageProcessing.ts))
  and its spec exist.
- The H8 static-state cache was removed (see comment at
  [`ShoferProvider.ts`](extensions/shofer/src/core/webview/ShoferProvider.ts#L217)).

## Root Causes Identified

### 1. `preloadShoferMessages()` — Redundant Re-Read on Every Task Switch

[`Task.preloadShoferMessages()`](extensions/shofer/src/core/task/Task.ts#L3154) is called from
[`ShoferProvider.createTaskWithHistoryItem()`](extensions/shofer/src/core/webview/ShoferProvider.ts#L1467)
every time the user switches to a task. **(H1 + H3 resolved in pre-2026-05-21.)** The
current implementation performs parallel `shoferMessages` + `apiConversationHistory` reads
and publishes the sanitized array in-memory without a redundant re-read:

```typescript
// Task.ts ~L3158–3226: _preloadShoferMessagesImpl()
this.shoferMessages = modifiedShoferMessages
this.apiConversationHistory = apiConversationHistory
this.historyPreloaded = true
// Fire-and-forget the sanitized save; in-memory is already canonical.
void this.overwriteShoferMessages(modifiedShoferMessages).catch(...)
```

### 2. Streaming Hot Path — Now O(1) JSONL Appends (Post-Migration)

> **Note (2026-06-10):** This section has been rewritten for the current
> JSONL-append architecture. The pre-JSONL narrative described `structuredClone`
>
> - `safeWriteJson` per chunk — those costs no longer exist on the streaming hot
>   path.

Persistence is now append-only JSONL
([`taskMessages.ts`](extensions/shofer/src/core/task-persistence/taskMessages.ts),
[`jsonlLog.ts`](extensions/shofer/src/core/task-persistence/jsonlLog.ts)).

- **New and mutated messages** are written via **O(1) `appendTaskMessage`** →
  `appendJsonLine()` at the [`addToShoferMessages()`](extensions/shofer/src/core/task/Task.ts#L1851)
  and [`updateShoferMessage()`](extensions/shofer/src/core/task/Task.ts#L1926)
  call sites — one line per mutation, no clone, no full-array serialize.
- The debounced [`saveShoferMessages()`](extensions/shofer/src/core/task/Task.ts#L1970)
  (H0, 250 ms trailing) now only calls `_refreshTaskMetadata()` (lightweight
  HistoryItem derivation) — it does **not** rewrite the JSONL log. The streaming
  hot path is a debounced metadata refresh, not a full file write.
- **Compaction** (`writeJsonLines`, tmp→rename) runs only at turn boundaries via
  [`_flushSaveShoferMessages()`](extensions/shofer/src/core/task/Task.ts#L2111),
  `dispose`, `abortTask`, and `overwriteShoferMessages`. Per-chunk appends are
  O(1); full rewrites are bounded to ~once per turn.
- The read path collapses duplicates with `dedupeByKey(m => m.ts)`, preserving
  first-occurrence position.

Residual O(n) work on/near the hot path that survived the migration is covered by
H11–H14 under Additional Optimizations.

### 3. State Broadcasting — Superseded by Incremental Messaging

The old [`getStateToPostToWebview()`](extensions/shofer/src/core/webview/ShoferProvider.ts#L3206)
carried the full `taskHistory` + `shoferMessages` arrays on every state push.
**Resolved 2026-06-09** by incremental messaging: `postInitState()` (full snapshot,
O(1) per task lifetime), `postConfigUpdate(key, value)` (single-key delta), and
`postTaskStateUpdate(updates)` (task lifecycle delta). Per-message
`shoferMessageAppended` / `messageUpdated` deltas replace full-array pushes on the
streaming path.

### 4. `JSON.parse` Is Blocking (Single-Threaded Event Loop)

All `JSON.parse()` calls block the Node.js event loop. No `worker_threads` are used.
For typical file sizes (<5 MB) this is not actually a hot-path issue; it only matters
for the long-tail of >10 MB conversations.

### 5. Task History Index Grows Unboundedly

[`TaskHistoryStore.writeIndex()`](extensions/shofer/src/core/task-persistence/TaskHistoryStore.ts#L398)
writes the full `HistoryItem[]` into `_index.json` on every mutation (with 2 s debounce).
The index grows linearly with task count. Negligible until ~1,000+ tasks.

---

## Optimization Plan (Ranked by Impact)

### 🔴 H0: Coalesce / Debounce `saveShoferMessages` During Streaming

**Target file:** [`Task.ts`](extensions/shofer/src/core/task/Task.ts#L1970)

The save fires on every streamed chunk. Coalesce trailing edits with a short debounce
(e.g., 100–250 ms) so a burst of streaming updates collapses to a single write.
On turn boundaries (turn end, `attempt_completion`, abort, suspend) flush synchronously
so persisted state matches in-memory state at every observable checkpoint.

Pair with H2.bis (incremental `taskMetadata` token accounting) — together these are
the dominant steady-state cost during agent execution.

**Estimated improvement:** Order-of-magnitude reduction in steady-state write/fsync rate
and CPU spent in `taskMetadata` during long turns. Single biggest realistic win.

**Risk:** Medium. Crash-loss window grows from "0" to "≤ debounce interval". Mitigation:
flush on every `say`/`ask` that ends a turn or yields the agent loop, on extension
deactivation, and on abort. Make the debounce interval a setting (typed via
`ContextProxy` per the Typed Settings Rule).

### 🔴 H1: Eliminate the Unnecessary Re-Read in `preloadShoferMessages()`

**Target file:** [`Task.ts`](extensions/shofer/src/core/task/Task.ts#L3154)

**Pre-fix code (now resolved):**

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

`shoferMessages` and `apiConversationHistory` are independent files. **Resolved:**
the current implementation at [`Task.ts`](extensions/shofer/src/core/task/Task.ts#L3158)
reads both in parallel via `Promise.all` and publishes the sanitized array in-memory
without a round-trip re-read.

**Risk:** Low. **Estimated improvement:** ~25–35 % of remaining preload time when both
files are large and comparable in size.

### 🟡 H4: Delta Channels for `taskHistory` / `shoferMessages`

**Targets:**

- [`ShoferProvider.getStateToPostToWebview()`](extensions/shofer/src/core/webview/ShoferProvider.ts#L3206)
- [`ShoferProvider.postInitState()`](extensions/shofer/src/core/webview/ShoferProvider.ts#L3052)

**Superseded 2026-06-09** by incremental messaging. `postInitState()` carries the full
snapshot O(1) per task lifetime; `postConfigUpdate(key, value)` and
`postTaskStateUpdate(updates)` deliver targeted deltas. Per-message
`shoferMessageAppended` / `messageUpdated` replace full-array pushes on the streaming
path. The `taskHistoryItemUpdated` delta channel covers HistoryItem mutations.

**Risk:** Medium. Webview state-reducer changes; the exhaustive switch on
`ExtensionMessage` will surface every consumer (per the Exhaustive Switch Rule).
**Estimated improvement:** Removes O(N_tasks) and O(N_messages) per state push from the
IPC structured-clone path — biggest win for users with large histories.

### 🟡 H2: Windowed Message Loading (Last N Messages on Rehydrate)

**Target files:**

- [`Task.ts`](extensions/shofer/src/core/task/Task.ts#L3154) — `preloadShoferMessages()`
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
  [`createTaskWithHistoryItem`](extensions/shofer/src/core/webview/ShoferProvider.ts#L1467).
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

### 🟡 H6: Sync `JSON.stringify` Snapshot Instead of `structuredClone`

**Superseded by the JSONL-append migration.** The current implementation at
[`saveShoferMessages()`](extensions/shofer/src/core/task/Task.ts#L1970) uses
`serializeJsonLines(this.shoferMessages)` (sync snapshot) and writes atomically via
`writeJsonLines`. This is only called at compaction boundaries (turn end, dispose, abort,
overwrite). On the streaming hot path, `appendTaskMessage` → `appendJsonLine()` is O(1)
and never clones the full array. The `safeWriteJson` utility
([`safeWriteJson.ts`](extensions/shofer/src/utils/safeWriteJson.ts)) retains support for
a pre-serialized string parameter via `jsonString` for callers that want to supply
pre-serialized data.

**Risk:** Low–Medium. New `safeWriteJson` overload; audit any other call site that
depends on the clone-isolation side effect (unlikely — it was just defensive
snapshotting).

### � H5: Parallelism — What Actually Works in Node.js

The original revision filed this as "worker thread for JSON parsing — drop". That was
too coarse. Node.js gives us three distinct knobs, with very different cost/benefit
profiles. Spelling them out so we choose deliberately:

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

**H5.b — Native `simdjson` addon for hot-path JSON parse.**

[`simdjson`](https://www.npmjs.com/package/simdjson) is a NAPI binding to the
simdjson C++ library. It is typically **2–4× faster than `JSON.parse`** for our shape
of payload (large arrays of small objects) and — critically — **releases the V8 lock
during parsing**, so other JS work runs in parallel on the main thread while the
parse executes on a libuv worker.

Use it specifically in `readTaskMessages` and `readApiConversationHistory` for files
above a size threshold (e.g. 1 MB). Pure `JSON.parse` fallback below the threshold to
avoid the NAPI call overhead on small payloads.

Note that simdjson returns a lazy proxy by default; for our use case (we touch every
element soon after) materialize eagerly via the documented "parse + reify" API.

**Risk:** Medium. Adds a native dependency that must build (or ship prebuilds) for
every supported `electron`/`vscode` ABI and every OS × arch combo we target. Validate
prebuilds cover Linux x64, Linux arm64, macOS x64, macOS arm64, Windows x64; fall
back to `JSON.parse` if `require("simdjson")` throws.

**Estimated improvement:** 50–75 % reduction in cold-load `JSON.parse` wall time for
large `ui_messages.json` / `api_conversation_history.json`; main-thread non-blocking
is the bigger qualitative win.

**H5.c — `worker_threads` for parse/stringify of very large files.**

Reconsidered from the previous "drop" verdict. The structured-clone tax across the
worker boundary is the real concern, but it can be mitigated:

- **Read the file _inside_ the worker** (worker gets `{ filePath }`, returns parsed
  object). Only the result crosses — same clone cost as returning from `simdjson`, but
  the parse itself is fully off-main-thread without needing a native addon.
- For `JSON.stringify` on the save path, do the same in reverse: worker stringifies
  and writes the tmp file, main thread receives only the `rename` signal.
- Use a **single long-lived worker** (not one-per-call) to amortize startup
  (`~30–50 ms` for a fresh worker). Maintain a request queue keyed by `taskId`.
- Avoid `SharedArrayBuffer` complexity — it does not help here because the data
  originates as JS objects, not binary buffers.

H5.c is **dominated by H5.b on the parse path** (`simdjson` gets the same off-main-
thread benefit without the worker round-trip and clone). The compelling use case for
H5.c is the **save path** under H6: stringify is also O(n) CPU and is currently the
reason H6 needs a sync snapshot. Stringify-in-worker would let us skip even the
sync `JSON.stringify` from the main thread.

**Risk:** Medium–High. Worker lifecycle (creation, error propagation, abort
propagation per the Cooperative Cancellation Rule), and the IPC contract must be
carefully designed. Don't start here.

**Recommendation:** Implement only after H5.b is in place and only if profiling shows
`JSON.stringify` (not parse) on the main thread is the residual bottleneck. Likely
unnecessary in practice once H0 reduces save frequency.

**Order within H5:** H5.a immediately (one-line change), H5.b once H2 is decided (the
benefit overlaps), H5.c only if measurements demand it.

### 🟢 H7: Paginate the History Index — Defer

Only matters at ~1,000+ tasks. Revisit when telemetry shows index size or write latency
becoming a real problem.

### 🟢 H8: Memoize Static Parts of `getStateToPostToWebview()`

**Removed 2026-06-09** — the static-state cache (`_cachedMergedAllowed`, etc.) was
removed because `postInitState()` fires O(1) per task lifetime, not per streaming
token. See comment at
[`ShoferProvider.ts`](extensions/shofer/src/core/webview/ShoferProvider.ts#L217).
Allowed/denied commands are recomputed fresh in
[`getStateToPostToWebview()`](extensions/shofer/src/core/webview/ShoferProvider.ts#L3206).

---

## 🟡 H9: Background-Task State Push Gating (Historical)

> **Status:** ✅ Superseded 2026-06-09. This section is preserved as design
> rationale. The `postStateToWebviewWithoutTaskHistory` and
> `postStateToWebviewWithoutShoferMessages` methods referenced below have **zero
> references** in `src/` — they were removed by incremental messaging. The H9
> goal (avoid wasteful state pushes for background tasks) is achieved by the
> current architecture: the `shoferMessageAppended` delta path at
> [`Task.ts`](extensions/shofer/src/core/task/Task.ts#L1903) already gates on
> `getFocusedTaskId() === taskId || getCurrentTask()?.taskId === taskId`,
> [`updateShoferMessage()`](extensions/shofer/src/core/task/Task.ts#L1926)
> gates on the same dual check, and the stream-start/stream-completion
> skinny-push blocks that H9 would have gated were removed entirely by the IPC
> protocol refinement.

### Historical problem (pre-2026-06-09)

Before incremental messaging, `updateShoferMessage()` already had a focus gate:

```typescript
if (provider && provider.taskManager?.getFocusedTaskId() === this.taskId) {
	await provider.postMessageToWebview({ type: "messageUpdated", shoferMessage: message })
}
```

This meant partial text updates (the dominant streaming hot path) and
`api_req_started` usage updates skipped the webview push for background tasks —
good. But three other call sites unconditionally pushed full state via
`postStateToWebviewWithoutTaskHistory()` — from `addToShoferMessages()` (for
non-partial messages), stream-start, and stream-completion blocks. These
full-array serialization + IPC pushes ran unconditionally regardless of focus.

With incremental messaging, the streaming delta path intrinsically gates on
focus, and those full-snapshot paths were removed — achieving H9's goal at the
protocol level.

### Current focus-gated streaming paths

| Path                                    | Gate                            | Location                                                                          |
| --------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------- |
| `shoferMessageAppended` delta           | Dual focus/current check        | [`Task.ts:1903`](extensions/shofer/src/core/task/Task.ts#L1903)                   |
| `messageUpdated` delta                  | Dual focus/current check        | [`Task.ts:1939`](extensions/shofer/src/core/task/Task.ts#L1939)                   |
| `_refreshTaskMetadata` (debounced)      | ✅ Always fires for persistence | [`Task.ts:2020`](extensions/shofer/src/core/task/Task.ts#L2020) — H0-debounced    |
| `_flushSaveShoferMessages` (compaction) | ✅ Always fires for persistence | [`Task.ts:2111`](extensions/shofer/src/core/task/Task.ts#L2111) — turn boundaries |

### Save path note

The H0-debounced
[`_debouncedSaveShoferMessages`](extensions/shofer/src/core/task/Task.ts#L703)
fires for all tasks — this is intentional, as background task messages must
survive VS Code restarts. The debounce interval is 250 ms trailing. If profiling
shows disk I/O from concurrent background saves is a bottleneck, further
optimizations could include:

- Longer debounce interval for background tasks (1–2 s) vs focused (250 ms)
- `fsync`-less writes for background tasks (accept crash-loss window)

---

## 🟢 H10: Incremental Webview Message Consolidation

**Status:** ✅ Done (2026-05-30).

**Target files:**

- [`incrementalMessageProcessing.ts`](extensions/shofer/webview-ui/src/components/chat/incrementalMessageProcessing.ts) — new module
- [`incrementalMessageProcessing.spec.ts`](extensions/shofer/webview-ui/src/components/chat/__tests__/incrementalMessageProcessing.spec.ts) — randomized equivalence tests
- [`ChatView.tsx`](extensions/shofer/webview-ui/src/components/chat/ChatView.tsx) — `modifiedMessages` / `apiMetrics` memos (consumer)

### Problem

H0/H4/H2.bis removed the steady-state cost on the **host** side. The residual
"a single long task gets progressively slower" symptom is **webview** CPU. On
every streamed chunk `ChatView` re-derives:

```ts
const modifiedMessages = combineApiRequests(combineCommandSequences(messages.slice(1)))
const apiMetrics = getApiMetrics(modifiedMessages)
```

Both walk the **entire** message array. Across a turn of `m` chunks on a task of
`n` messages this is O(n) per chunk × `m` chunks = **O(n²)** per task, and the
dominant constant is repeated `JSON.parse` of every `api_req_started.text` inside
`combineApiRequests` + `getApiMetrics`. The list itself is already virtualized
(Virtuoso), so rendering is _not_ the bottleneck — the derived-state passes are.

### Design

Cache the consolidated output of a reference-stable **prefix** at a provably-safe
split boundary `B`, and re-consolidate only the bounded **tail** `[B, n)` on each
chunk → O(tail) per chunk, byte-identical output to the full pass.

A split at `B` is safe iff `consolidate(msgs) === consolidate(msgs[0:B]) ++
consolidate(msgs[B:])`. This holds iff no consolidation _head_ before `B` absorbs
or resolves anything at index `≥ B`. `computeReach` assigns each head its last
affected index (`reach[i]`):

- `command` / `use_mcp_server` asks → last `command_output` / `mcp_server_response`
  before the next same-kind ask.
- `api_req_started` → matching `api_req_finished` (LIFO).
- **Open** (unclosed) heads → `OPEN_REACH = Infinity`.

`findSafeSplitIndex` returns the largest `B` with `max(reach[0..B-1]) < B`,
seeded from the current cached `splitIndex` (or `0`). Reference-identity of the
prefix (`a[i] === b[i]`) detects task switch / edit / delete / checkpoint restore
and triggers a full recompute + re-establishment of `B`.

### Open-group correctness bug (fixed during implementation)

The first cut used `n` as the sentinel for open heads and advanced `B` _past_
blockers. That collided with the legitimate `B = n` boundary: an **open** command
(no following `command` ask — e.g. the last command in the array, which always
stays open and keeps receiving `command_output`) got frozen into the prefix, and
its later outputs landed in the suffix as **orphans** the suffix could not absorb
→ dropped output. Two-part fix:

1. Use a true `OPEN_REACH = Infinity` sentinel so an open head can never be
   confused with `B = n`.
2. Rewrite `findSafeSplitIndex` as a single O(n) forward pass that maintains
   `runningMax = max(reach[0..B-1])` and **stops at the first open head**, leaving
   it (and everything after) in the re-consolidated suffix. This also removed an
   O(n²) inner-loop recompute and an empty-range `-Infinity` bug that had
   permanently pinned `splitIndex` to `0` after any edit (silently disabling the
   cache).

### Verification

Randomized equivalence tests (seeded mulberry32, structurally deterministic)
stream message sequences chunk-by-chunk and assert the incremental output is
byte-identical to the full-pass pipeline (modulo float-addition order for
`totalCost`, folded via `foldMetrics`), including the open-group-across-boundary
edge case. 18/18 passing, stable across repeated runs.

### Relationship to H2

H10 removes the quadratic **regardless of `n`** and is webview-only (Low–Med
risk). H2 (windowed loading) is the complementary, higher-risk follow-up that
additionally bounds the cold-load render of very large histories. Land H10 first;
H2 only becomes worthwhile once the steady-state quadratic is gone.

---

## Additional Optimizations (2026-06-10) — All Implemented

> H11–H14 landed 2026-06-10. Anchors verified against HEAD.

### 🟡 H11: Incremental Token-Bearing Message Count ✅ Done (2026-06-10)

**Target:** [`Task._countTokenBearingMessages()`](extensions/shofer/src/core/task/Task.ts#L2092)

H2.bis cached the _result_ of token accounting in `_cachedTokenUsage`, keyed on
`_tokenBearingMessageCount`. But the cache-validity check still calls
`_countTokenBearingMessages()`, which **walks the entire `shoferMessages` array**
on every metadata refresh (`_refreshTaskMetadata`, on the debounced save path):

```typescript
private _countTokenBearingMessages(): number {
	let count = 0
	for (const m of this.shoferMessages) {
		if (
			(m.type === "say" && m.say === "api_req_started" && m.text) ||
			(m.type === "say" && m.say === "condense_context")
		) {
			count++
		}
	}
	return count
}
```

So every refresh is still O(n) — just O(n) counting instead of O(n) summing. For
a long task this is the residual per-save walk H2.bis was meant to eliminate.

**Fix:** Maintain the count as a field updated at the (few) mutation sites that
can change it — `addToShoferMessages` (+1 when the appended message is
token-bearing), `updateShoferMessage` (a partial→final `api_req_started` flips
`text` from empty to non-empty: +1 on that transition), and reset/recount in
`overwriteShoferMessages` (the only place the whole array is replaced). The
recount on `overwrite*` is acceptable — it is already an O(n) compaction path.
Then the validity check becomes O(1).

**Risk:** 🟡 Medium — same invariant-maintenance concern as H2.bis; the tricky
case is the partial-message `api_req_started` whose `text` is populated by a
later `updateShoferMessage`. Unit-test the count against
`_countTokenBearingMessages()` as an oracle across append/update/overwrite/edit
flows (mirror the H2.bis test).

### 🟡 H12: Threshold-Triggered JSONL Compaction ✅ Done (2026-06-10)

**Targets:**
[`saveTaskMessages()`](extensions/shofer/src/core/task-persistence/taskMessages.ts#L113),
[`Task._flushSaveShoferMessages()`](extensions/shofer/src/core/task/Task.ts)

Compaction (`writeJsonLines` → `serializeJsonLines(entire array)` + tmp + rename)
runs **unconditionally at every turn boundary**. For an n-message task that is an
O(n) serialize + O(n) write every turn, even when only a handful of lines were
appended since the last compaction. The append log is already durable and the
read path already dedupes by `ts`, so compaction is purely a **log-size bound**,
not a correctness requirement.

**Fix:** Track appended-line count and duplicate count since the last
compaction (cheap counters incremented alongside `appendTaskMessage`). Compact
only when a threshold is crossed — e.g. `linesSinceCompaction > K` (bounds file
growth) **or** `duplicateRatio > 0.5` (bounds dedup work on next cold read).
Skip the rewrite otherwise; the next genuine `overwrite*` (checkpoint/edit) or
extension shutdown still compacts. This removes the per-turn O(n) serialize+write
from long tasks while keeping the log bounded.

**Risk:** 🟡 Medium. The log file grows between compactions, so cold-read
`dedupeByKey` does more work; the duplicate-ratio threshold caps that. Crash
durability is unchanged (appends are already flushed). Keep an unconditional
compaction on `dispose`/`deactivate` so idle tasks settle to a compact form.

### 🟢 H13: Reuse Append Handle + Memoized `mkdir` ✅ Done (2026-06-10)

**Target:** [`appendJsonLine()`](extensions/shofer/src/core/task-persistence/jsonlLog.ts#L103)

Every append currently does:

```typescript
await fs.mkdir(path.dirname(filePath), { recursive: true })
await fs.appendFile(filePath, line, "utf8") // open → write → close
```

On a streaming turn, partial-message updates re-append the mutated message **per
chunk**, so this is one redundant `mkdir` (the directory exists after the first
write) plus one open/write/close cycle **per chunk**. The `mkdir` is pure waste
after the task directory exists; the repeated open/close adds syscall overhead
under high chunk rates.

**Fix:** (a) Hoist the `mkdir` to task-directory creation (or memoize a
"directory ensured" flag per `filePath`) so it runs once, not per append.
(b) Optionally keep a long-lived append handle (`fs.open(..., "a")`) per task,
reused across appends and closed on `dispose`, replacing open/write/close with a
single `write`. The existing per-file `enqueueWrite` serialization already
guarantees appends don't interleave, so a shared handle is safe.

**Risk:** 🟢 Low for (a) — trivial. 🟡 Low–Med for (b) — handle lifecycle must be
tied to `dispose`/`abortTask`, and a write error must invalidate the cached
handle so the next append reopens. Do (a) unconditionally; do (b) only if
profiling shows append syscall overhead is material under heavy streaming.

### 🟡 H14: BlobStore Cross-Call Content Cache ✅ Done (2026-06-10)

> **Design note:** An index-delta variant (caching resolved messages keyed by
> `_lastResolvedApiHistoryLength` and cloning a prefix from
> `apiConversationHistory`) was implemented and reverted — the caller passes
> `cleanConversationHistory`, a derived view post
> truncation/merge/image-stripping/re-indexing, so the prefix-cloning index was
> desynchronised from the actual messages and sent un-resolved blob refs to the
> LLM. See the **Reversion notes (2026-06-10)** below.

**Target:** [`BlobStore.resolveRefs()`](extensions/shofer/src/services/blob-store/BlobStore.ts#L149)

The correct fix operates one level down: Blob content is immutable
(sha256-addressed), so resolved content is cached in a cross-call map:

- [`BlobStore._readCache`](extensions/shofer/src/services/blob-store/BlobStore.ts#L77) — `Map<sha256, content>`, lives for the lifetime of the `BlobStore` instance (one per task)
- [`resolveRefs()`](extensions/shofer/src/services/blob-store/BlobStore.ts#L149) — checks `_readCache` before `this.read()` (disk); populates the cache on first resolution
- Cache hit skips the `fs.readFile` disk I/O; cache validity is unconditional (content is content-addressed)
- Working set is self-bounding: only in-context-window blobs are ever resolved, so resident content tracks the context window
- An LRU cap can be added later if profiling shows memory growth in pathological long tasks

### Implementation summary

H11, H13, and H14 are independently done. H12's threshold tuning (`100` appends)
can be adjusted based on field data. The doc's "Metrics to Track" section below
can be extended with compaction frequency/byte-volume and
`prepareMessagesForApi` p50/p95 if desired.

---

## Future Opportunities (2026-06-10) — Not Yet Triaged

> These items were surfaced during a 2026-06-10 review pass. Unlike H0–H14
> (persistence + IPC/state-broadcast axes), they cover two hot paths the
> existing plan does not address: the **per-API-request build path** (host) and
> **React render hygiene** in the webview (beyond the H10 consolidation work).
> All are **❌ Open**. Per the doc's "instrument first" discipline, profile each
> (render-count profiler for the webview items; `IPC`/`Webview` log categories
> and per-request timing for the host items) before committing. Line-number
> anchors are intentionally omitted in favor of symbolic names per the Doc
> Code-Example Line-Number Rule — re-verify call sites at implementation time.
>
> | #       | Item                                      | Path         | Description                                                                                        | Risk      | Status  |
> | ------- | ----------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------- | --------- | ------- |
> | **H15** | Cache the assembled system prompt         | Host (build) | `getSystemPrompt`/`SYSTEM_PROMPT` re-walks rules dirs + `AGENTS.md` per LLM round-trip             | 🟡 Medium | ❌ Open |
> | **H16** | Dedupe the per-request tool-array build   | Host (build) | `buildNativeToolsArrayWithRestrictions` runs 2× per request with identical params; MCP/dir scan    | 🟢 Low    | ❌ Open |
> | **H17** | Sidestep the per-request MCP-connect wait | Host (build) | 10s `pWaitFor` MCP gate on the system-prompt path; subsumed by H15 caching                         | 🟢 Low    | ❌ Open |
> | **H18** | Memoize `ExtensionStateContext` value     | Webview      | Bare object literal rebuilt every render → all `useExtensionState()` consumers re-render per delta | 🟡 Medium | ❌ Open |
> | **H19** | Memoize `ChatRow` per-render `JSON.parse` | Webview      | git/RAG/git-integration result rows re-parse `message.text` on every parent re-render              | 🟢 Low    | ❌ Open |
> | **H20** | Memoize `getPreviousTodos` reverse scan   | Webview      | O(n) reverse scan + `JSON.parse` per `updateTodoList` row render                                   | 🟢 Low    | ❌ Open |
> | **H21** | Wrap `MermaidBlock` in `memo()`           | Webview      | Re-renders with parent; `CodeBlock`/`MarkdownBlock` already memoized — the odd one out             | 🟢 Low    | ❌ Open |
> | **H22** | Hoist inline object/array identities      | Webview      | Inline `increaseViewportBy={{…}}` on Virtuoso + constant arrays in the visible-messages filter     | 🟢 Low    | ❌ Open |

### Host-side: the request-build path

`attemptApiRequest()` runs once per LLM call, and a single user turn often issues
many (every tool use → another round-trip). The following work repeats per call
even though its inputs are stable across the turn.

#### 🟡 H15: Cache the Assembled System Prompt

**Target:** [`Task.getSystemPrompt()`](extensions/shofer/src/core/task/Task.ts) →
`SYSTEM_PROMPT` →
[`addCustomInstructions`](extensions/shofer/src/core/prompts/sections/custom-instructions.ts)

Every request re-reads `.shofer/rules/` (recursive dir walk),
`.roorules`/`.clinerules`, mode-specific rule dirs, and
`AGENTS.md`/`AGENT.md`/`AGENTS.local.md` (each with `lstat` + `readlink` + read,
even on miss). The inputs (mode, cwd, rules files, MCP descriptors) are stable
across a turn.

**Fix:** Memoize the assembled prompt keyed on
`(mode, cwd, customInstructions hash, mcp signature)`; invalidate on a
rules-file `FileSystemWatcher` (one already exists for the code index) and on
mode/MCP change. A per-turn cache (build once at turn start, reuse across the
turn's round-trips) captures most of the win at low risk.

**Risk:** 🟡 Medium — cache invalidation must cover rules-file edits and
mode/MCP changes or the prompt goes stale.

#### 🟢 H16: Dedupe the Per-Request Tool-Array Build

**Target:** [`buildNativeToolsArrayWithRestrictions`](extensions/shofer/src/core/task/build-tools.ts),
called twice per `attemptApiRequest` (context-management metadata + the actual
call) with identical `(mode, cwd, experiments, apiConfiguration, disabledTools,
modelInfo)`. Internally it enumerates MCP tools + normalizes schemas, and (if
`customTools`) scans the `.shofer` directory.

**Fix:** Compute once per `attemptApiRequest` and reuse for both sites;
optionally memoize across round-trips with the same key as H15.

**Risk:** 🟢 Low — single-call-scoped reuse is mechanical.

#### 🟢 H17: Sidestep the Per-Request MCP-Connect Wait

**Target:** the `pWaitFor` MCP-connected gate on the system-prompt path in
[`Task.getSystemPrompt()`](extensions/shofer/src/core/task/Task.ts).

Benign when connected, but it is a per-request gate (up to ~10s) that H15's
caching would also sidestep. Fold into H15 rather than fixing standalone.

**Risk:** 🟢 Low.

### Webview-side: render hygiene beyond H10

H10 removed the O(n²) consolidation cost; these are the remaining classic React
identity/parse costs on the render path.

#### 🟡 H18: Memoize the `ExtensionStateContext` Value

**Target:** the context value object in
[`ExtensionStateContext.tsx`](extensions/shofer/webview-ui/src/context/ExtensionStateContext.tsx).

It is a bare object literal (70+ fields + inline setters) rebuilt every render,
not `useMemo`'d — so every `useExtensionState()` consumer re-renders on any
state change, including each streamed delta. This likely dominates webview CPU
during streaming and sits **upstream of all the H10 work**, making it the
single highest-leverage webview fix still on the table.

**Fix:** `useMemo` the context value; stabilize setters with `useCallback`.

**Risk:** 🟡 Medium — wide consumer surface, but mechanical.

#### 🟢 H19: Memoize `ChatRow` Per-Render `JSON.parse`

**Target:** the git/RAG/git-integration result-row branches in
[`ChatRow.tsx`](extensions/shofer/webview-ui/src/components/chat/ChatRow.tsx).

These call `JSON.parse(message.text)` directly in render, re-parsing on every
parent re-render (which H18 makes frequent).

**Fix:** `useMemo` keyed on `message.text`.

**Risk:** 🟢 Low. Compounds with H18 during streaming.

#### 🟢 H20: Memoize `getPreviousTodos` Reverse Scan

**Target:** `getPreviousTodos` in
[`ChatRow.tsx`](extensions/shofer/webview-ui/src/components/chat/ChatRow.tsx) —
an O(n) reverse scan + `JSON.parse` run per `updateTodoList` row render, not
memoized.

**Fix:** `useMemo` the scan result.

**Risk:** 🟢 Low.

#### 🟢 H21: Wrap `MermaidBlock` in `memo()`

**Target:** [`MermaidBlock.tsx`](extensions/shofer/webview-ui/src/components/common/MermaidBlock.tsx).

Re-renders with its parent; `CodeBlock`/`MarkdownBlock` are already memoized, so
this is the odd one out.

**Fix:** Wrap the component in `memo()`.

**Risk:** 🟢 Low.

#### 🟢 H22: Hoist Inline Object/Array Identities

**Targets:** inline `increaseViewportBy={{…}}` on the Virtuoso list and the
constant arrays allocated inside the visible-messages filter in
[`ChatView.tsx`](extensions/shofer/webview-ui/src/components/chat/ChatView.tsx).

New object/array identities per render defeat child memoization. Low value
individually; trivial to hoist to module-level constants or `useMemo`.

**Risk:** 🟢 Low.

---

## What NOT to Optimize

| Area                                        | Reason                                              |
| ------------------------------------------- | --------------------------------------------------- |
| `TaskSelector.buildFlatTree()` O(n²)        | Webview-side, negligible for <500 tasks             |
| `TaskManager.restoreManagedTasks()`         | Simple O(n) loop, no I/O                            |
| Memory from `HistoryItem` objects           | ~1 KB each — 1,000 tasks ≈ 1 MB, negligible         |
| `extension.ts` activation order             | Already non-blocking                                |
| `TaskHistoryStore.reconcile()` startup scan | Only runs on cold cache; mitigated by `_index.json` |

---

## Implementation Order (revised)

1. **H5.a** — Raise `UV_THREADPOOL_SIZE` in `extension.ts` (one-line, prerequisite for
   H3 to actually parallelize at the libuv layer).
2. **H0** — Debounce `saveShoferMessages` (biggest steady-state win during streaming).
3. **H3** — Parallelize `preloadShoferMessages()` I/O (free win; sets up H1).
4. **H1** — Eliminate the redundant re-read (low risk).
5. **H4** — Delta channel for `taskHistory` / `shoferMessages` (biggest IPC win).
6. **H2.bis** — Incremental token accounting (prereq for H2; also helps H0).
7. **H6** — Sync string snapshot replacing `structuredClone` (composes with H0).
8. **H9** — Gate state pushes for background tasks (one-line focus check per call site).
9. **H5.b** — Native `simdjson` for large-file parse (after H2 decision).
10. **H2** — Windowed message loading (feasibility spike first; reject page-file variant).
11. **H8** — Memoize static state fields.
12. **H5.c** — `worker_threads` for stringify-in-worker, only if profiling demands it.
13. Defer **H7** until task count warrants it.

---

## Metrics to Track

Instrument these before committing the larger items (H2, H4) so we can attribute wins.

- **Task-switch latency**: `Date.now()` at start and end of
  `createTaskWithHistoryItem()`, log via output channel.
- **`preloadShoferMessages` breakdown**: time each of READ #1, the sanitize block, the
  WRITE (incl. `taskMetadata`), and READ #3 separately. Confirms which sub-step dominates
  before we tune it.
- **`saveShoferMessages` call frequency and duration** during a turn (count + p50/p95
  ms). Validates the H0 hypothesis.
- **`ui_messages.json` file size distribution**: log size on save to identify outliers.
- **`postStateToWebview()` JSON payload size**: log byte length before `postMessage`.
  Validates H4.
- **`_index.json` size and parse time** during `loadIndex()` / `writeIndex()`.
- **Background task state push count (historical)**: H9 superseded by incremental
  messaging — the `shoferMessageAppended` and `messageUpdated` delta paths already
  gate on focus. Count background vs focused `_refreshTaskMetadata` calls if needed.

Per the Output Channel Logging Rule, route diagnostics through `outputChannelLogger`
gated on `process.env.DEBUG` (cf. existing `home-screen-flash` pattern in
[`ShoferProvider.ts`](extensions/shofer/src/core/webview/ShoferProvider.ts#L3372)) — not
`console.log`.

---

## Revision notes (2026-05-20 review)

- **Numbers walked back.** "300 ms–1 s+ task switch", "40–60 % H1 win", "90 % H2 win"
  removed where not directly measured. Replaced with "instrument first" guidance.
- **H0 added** as the top item — `saveShoferMessages` runs per streamed chunk and is the
  realistic dominant cost during agent execution. Previous revision missed this entirely.
- **H2 risk raised to High** and the page-file alternative explicitly rejected (it
  increased writes on the hot path).
- **H2.bis added** — incremental token accounting in `taskMetadata`, both a standalone
  win and a hard prerequisite for windowed loading.
- **H4 broadened** beyond task switch to all `postStateToWebview` callers, with a
  symmetric delta channel for `shoferMessages`.
- **H6 reclassified** from 🟢 low-risk to 🟡 — the concurrent-mutation invariant the
  `structuredClone` guards does not hold today; the fix is a sync `JSON.stringify`
  snapshot, not a deletion plus a comment.
- **H5 reinstated and split** into H5.a (raise `UV_THREADPOOL_SIZE` — libuv's POSIX
  pool, one-line win), H5.b (native `simdjson` addon — 2–4× parse speed, releases V8
  lock), and H5.c (`worker_threads` for stringify — only if measurements demand). The
  previous "drop" verdict conflated three distinct mechanisms with very different
  cost/benefit profiles. Green threads / fibers explicitly noted as not available in
  modern Node.
- **H1 tradeoff** around skipping `taskMetadata` on preload now stated explicitly
  (option (a) safe-by-default, option (b) cheaper-but-stale).
- **H9 added (2026-05-21); rewritten 2026-06-10** — audit of background-task
  streaming state pushes. The underlying concern (wasteful state pushes for
  background tasks) was resolved by incremental messaging: the
  `shoferMessageAppended` and `messageUpdated` delta paths intrinsically gate on
  focus, and the skinny-push blocks H9 targeted were removed.

## Reversion notes (2026-06-10)

- **H14 index-delta variant — implemented and reverted.** An earlier cut cached
  resolved messages keyed by `_lastResolvedApiHistoryLength` and cloned a
  prefix from `this.apiConversationHistory` in `prepareMessagesForApi`. The
  caller passes `cleanConversationHistory`, a derived view post truncation,
  consecutive-message merging, image-block stripping, and re-indexing — so
  the cached prefix index was desynchronised from the actual messages,
  producing two compounding defects: (a) wrong-array / index desync
  (re-included stripped blocks, un-merged consecutive user messages,
  pre-summary messages), and (b) un-resolved blob refs sent to the LLM
  (cloned from the externalised stored form with no `resolveRefs`). The
  revert restored the original full-iteration `prepareMessagesForApi`. The
  correct fix operates one level down: [`BlobStore._readCache`](extensions/shofer/src/services/blob-store/BlobStore.ts#L77)
  cross-call sha256 → content cache, immune to re-indexing.
