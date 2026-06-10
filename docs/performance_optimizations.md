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
> | **H2**        | Windowed message loading                                    | Load last K messages with Virtuoso scroll-to-load sentinel                                                                                                                                                                                                                                      | 🔴 High    | ❌ Open                  | —              |
> | **H7**        | Paginate history index                                      | Split `_index.json` into pages at 1,000+ tasks                                                                                                                                                                                                                                                  | 🟢 Low     | ❌ Open                  | —              |
> | **IPC proto** | Incremental messaging (IPC protocol refinement)             | Replace three `postStateToWebview*` methods with `postInitState` (full snapshot), `postConfigUpdate(key,value)` (single-key delta), and `postTaskStateUpdate(updates)` (task lifecycle delta). Webview splits `"state"` handler into `stateInit`/`configUpdate`/`taskStateUpdate`.              | 🟡 Medium  | ✅ Done                  | 2026-06-09     |

## Verification (2026-06-10)

Claims in this document were re-verified against HEAD. The **behavioral** claims
hold; the **anchors and one root-cause narrative have drifted** and are flagged
below (per the repo's Doc Line-Number Freshness Rule and Docs-Implementation
Coherence Rule).

**Verified accurate:**

- Incremental messaging is real and wired: `postInitState`, `postConfigUpdate`,
  and `postTaskStateUpdate` exist on `ShoferProvider` and are the live IPC
  surface; the old `postStateToWebview*` variants are gone.
- `shoferMessageAppended` is the sole streaming delta path
  ([`Task.ts`](extensions/shofer/src/core/task/Task.ts#L1885) `addToShoferMessages`,
  gated on `getFocusedTaskId() === taskId || getCurrentTask()?.taskId === taskId`).
- `UV_THREADPOOL_SIZE = "16"` is set at the top of
  [`extension.ts`](extensions/shofer/src/extension.ts#L12) before any `fs` import (H5.a).
- The H10 incremental-consolidation module
  ([`incrementalMessageProcessing.ts`](extensions/shofer/webview-ui/src/components/chat/incrementalMessageProcessing.ts))
  and its spec exist.
- The H8 static-state cache was removed (see comment at
  [`ShoferProvider.ts`](extensions/shofer/src/core/webview/ShoferProvider.ts#L217)).

**Drift to correct (flagged here; inline anchors below are left as-is for diff clarity):**

- **Line numbers throughout are stale.** `Task.ts` has grown to ~7,118 lines.
  Current anchors: `preloadShoferMessages` → L3104 (doc says 2493),
  `saveShoferMessages` → L1933 (doc says 1479), `addToShoferMessages` → L1835,
  `getStateToPostToWebview` → L3206 (doc says 2620), `writeIndex` → L398 (doc says 391).
  The H9 anchors (1505/3733/4555) no longer correspond to anything.
- **Root Cause #2 is written against the pre-JSONL design.** Persistence has
  since migrated to append-only JSONL
  ([`taskMessages.ts`](extensions/shofer/src/core/task-persistence/taskMessages.ts),
  [`jsonlLog.ts`](extensions/shofer/src/core/task-persistence/jsonlLog.ts)): new
  and mutated messages are written via **O(1) `appendJsonLine`**; the read path
  collapses duplicates with `dedupeByKey(m => m.ts)`; a full rewrite
  (`writeJsonLines`, tmp→rename) happens only as **compaction** at turn
  boundaries (`_flushSaveShoferMessages`, `dispose`, `abortTask`,
  `overwriteShoferMessages`). The "`structuredClone` per chunk" and
  "`safeWriteJson` per chunk" costs in Root Cause #2 **no longer exist on the
  streaming hot path** — H0 (debounce) and H6 (sync snapshot) are subsumed by
  the JSONL append architecture.
- **The H9 detail section (below) is superseded but not rewritten.** It still
  cites `postStateToWebviewWithoutTaskHistory`, which has **zero references in
  `src/`**. The status table already marks H9 "Superseded"; treat the narrative
  as historical.

The newly-identified opportunities surfaced by this re-verification are in
**Additional Optimizations (2026-06-10)** near the end of this document.

## Root Causes Identified

### 1. `preloadShoferMessages()` — Redundant Re-Read on Every Task Switch

[`Task.preloadShoferMessages()`](extensions/shofer/src/core/task/Task.ts#L2493) is called from
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

READ #2 is pure waste — `modifiedShoferMessages` is byte-identical to what was just persisted.
READ #3 is sequential with the rest but independent of `shoferMessages` and can be parallelized.

For a typical ~2 MB `ui_messages.json`, `JSON.parse` is ~4 ms (Node parses at ~500 MB/s);
the dominant cost on cold task switch is the **combination** of all I/O, the
`taskMetadata` full-array walk, and `safeWriteJson`'s tmp → fsync → rename sequence. The
"~300 ms–1 s+" figure in the previous revision was unsubstantiated — actual wall-clock
cost needs to be instrumented (see "Metrics to Track" below) before stating a number.

### 2. `saveShoferMessages` Save Frequency — Write Amplification on the Streaming Hot Path

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

### 3. State Broadcasting — Full `taskHistory` Array on Every State Push

[`ShoferProvider.getStateToPostToWebview()`](extensions/shofer/src/core/webview/ShoferProvider.ts#L2620)
serializes the full `taskHistory` array on every state push, and the host → webview
`postMessage` performs a structured clone of the whole payload (including
`shoferMessages`) per push. Mitigations exist (`postStateToWebviewWithoutTaskHistory`,
`postStateToWebviewWithoutShoferMessages`) but `postStateToWebview()` is still called
from many paths — task switch, settings change, mode change, MCP updates, etc. — not
just one.

### 4. `JSON.parse` Is Blocking (Single-Threaded Event Loop)

All `JSON.parse()` calls block the Node.js event loop. No `worker_threads` are used.
For typical file sizes (<5 MB) this is not actually a hot-path issue; it only matters
for the long-tail of >10 MB conversations.

### 5. Task History Index Grows Unboundedly

[`TaskHistoryStore.writeIndex()`](extensions/shofer/src/core/task-persistence/TaskHistoryStore.ts#L391)
writes the full `HistoryItem[]` into `_index.json` on every mutation (with 2 s debounce).
The index grows linearly with task count. Negligible until ~1,000+ tasks.

---

## Optimization Plan (Ranked by Impact)

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
The "just add an invariant comment" suggestion from the previous revision was wrong —
the invariant does **not** hold today.

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

Settings rebuilt on every state push (`allowedCommands`, `deniedCommands`, `mcpServers`,
`customModes`) can be cached with invalidation via `ContextProxy.onDidChange` (already
wired). Low risk; small win — keep as cleanup pass.

---

## 🟡 H9: Gate `postStateToWebview` for Non-Focused (Background) Tasks

**Target file:** [`Task.ts`](extensions/shofer/src/core/task/Task.ts)

### Problem

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

    ```typescript
    await provider?.postStateToWebviewWithoutTaskHistory()
    ```

    Called from `say()` for non-partial messages (api_req_started, completion_result,
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

### Fix

Add `isFocusedTask()` gate before all three state pushes:

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

## Additional Optimizations (2026-06-10)

These four items were surfaced by the 2026-06-10 re-verification. They target
residual O(n) work that survived the JSONL-append migration — the migration
killed per-chunk full rewrites, but several O(n) walks/serializations still run
on or near the streaming hot path. All anchors below are verified against HEAD.

### 🟡 H11: Incremental Token-Bearing Message Count (finish what H2.bis started)

**Target:** [`Task._countTokenBearingMessages()`](extensions/shofer/src/core/task/Task.ts#L2039)

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

### 🟡 H12: Threshold-Triggered JSONL Compaction (stop rewriting the whole log every turn)

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

### 🟢 H13: Reuse the Append File Handle; Drop the Per-Append `mkdir`

**Target:** [`appendJsonLine()`](extensions/shofer/src/core/task-persistence/jsonlLog.ts#L56)

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

### 🟡 H14: Incrementalize `prepareMessagesForApi` / Content Externalization

**Targets:** `Task.prepareMessagesForApi()`, `Task.externalizeMessageContent()`
in [`Task.ts`](extensions/shofer/src/core/task/Task.ts)

Before each API request, `prepareMessagesForApi` walks the **entire**
`apiConversationHistory` and rebuilds every message (cloning nested
`content`/`tool_result` blocks) to resolve blob refs; `externalizeMessageContent`
similarly re-scans content to externalize over-cap strings. This is O(context
size) per turn and grows with conversation length — a quiet per-turn tax that
scales with the same `n` H2/H10 worry about.

**Fix:** Only newly-appended messages can contain un-externalized content, and
already-resolved messages don't change. Cache the resolved/externalized form
keyed by message `ts` (invalidated on edit/delete/checkpoint-restore, which
already go through `overwrite*`), and process only the **delta** since the last
request. Past messages are immutable in steady state, so the per-turn walk
collapses to "resolve the few new blocks."

**Risk:** 🟡 Medium. Correctness hinges on cache invalidation covering every
mutation path (`overwriteApiConversationHistory`, condense, edit/delete). Gate
behind a feasibility check that the resolved form is referentially stable for
unchanged messages. Lower priority than H11–H13 unless profiling shows
`prepareMessagesForApi` is a measurable slice of per-turn latency on long tasks.

### Where these sit in the order

H11 and H13(a) are low-risk, mechanical, and independently shippable — do them
first. H12 is the larger steady-state win for very long single tasks (removes the
per-turn O(n) compaction) but needs the threshold tuning and a shutdown-compaction
guarantee. H14 is the most invasive and should wait for a profile that implicates
`prepareMessagesForApi`. As with the existing items, **instrument before
committing H12/H14** (extend the "Metrics to Track" list with compaction
frequency/byte-volume and `prepareMessagesForApi` p50/p95).

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
- **Background task state push count**: log how many `postStateToWebviewWithoutTaskHistory`/
  `addToShoferMessages` calls come from background tasks vs focused task per minute.
  Gated on `process.env.DEBUG`. Validates H9 hypothesis.

Per the Output Channel Logging Rule, route diagnostics through `outputChannelLogger`
gated on `process.env.DEBUG` (cf. existing `home-screen-flash` pattern in
[`ShoferProvider.ts`](extensions/shofer/src/core/webview/ShoferProvider.ts#L2672)) — not
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
- **H9 added (2026-05-21)** — audit of background-task streaming state pushes.
  `updateShoferMessage` already gates on `isFocusedTask()` (covers 80%+ of streaming
  chunk updates). Three remaining call sites in `addToShoferMessages`, stream-start,
  and stream-completion push full state for every task regardless of focus.
  Fix is a one-line gate at each call site, same pattern already proven in
  `updateShoferMessage`. Found during investigation of whether background-task
  streaming was causing avoidable overhead.
