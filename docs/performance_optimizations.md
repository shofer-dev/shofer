# Shofer Performance Optimizations

> Updated 2026-06-13: Re-verified all landed items (H0–H24, H15–H22, IPC
> refinement) against HEAD — **all present and intact** (see
> [Re-verification (2026-06-13)](#re-verification-2026-06-13)). Added four newly
> identified opportunities **H25–H28** (see
> [Newly Identified Opportunities (2026-06-13)](#newly-identified-opportunities-2026-06-13)).
>
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
> | **H2**        | Windowed message loading                                    | Load last K messages with Virtuoso scroll-to-load sentinel                                                                                                                                                                                                                                      | 🔴 High    | ✅ Superseded (T1.B)     | 2026-06-10     |
> | **H7**        | Paginate history index                                      | Split `_index.json` into pages at 1,000+ tasks                                                                                                                                                                                                                                                  | 🟢 Low     | ❌ Open                  | —              |
> | **H23**       | Eliminate duplicate `getTaskWithId` read (T1.A)             | `showTaskWithId` eagerly reads `api_conversation_history.jsonl` + dedupes, then immediately re-reads in `preloadShoferMessages`. Added `skipApiHistory` flag — 100% wasted I/O eliminated on cold switch.                                                                                       | 🟢 Low     | ✅ Done                  | 2026-06-10     |
> | **H24**       | Tail-only JSONL read on cold switch (T1.B)                  | `readJsonLinesTail` reads last N records; `preloadShoferMessages` accepts `maxMessages`; `COLD_LOAD_TAIL_WINDOW=200`. Webview "Load older messages…" sentinel → `loadOlderMessages` IPC + batched `shoferMessagesPrepended` (ordered older page, union-by-`ts` merge).                          | 🟡 Medium  | ✅ Done                  | 2026-06-10     |
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

## Re-verification (2026-06-13)

> Full sweep of every landed item against HEAD. **All implemented optimizations
> are present and unaffected.** Anchors below verified by direct source read.

| Item                                                                 | Verified at                                                                                                                                                                      |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **H5.a** `UV_THREADPOOL_SIZE = "16"`                                 | `extension.ts:11` (`if (!process.env.UV_THREADPOOL_SIZE) { … = "16" }`, before any fs import)                                                                                    |
| **H0** debounced save                                                | `Task.ts` `SAVE_DEBOUNCE_INTERVAL_MS = 250`, `_debouncedSaveShoferMessages` (`maxWait` = 250×4), `_flushSaveShoferMessages`                                                      |
| **H11** incremental token-bearing count                              | `Task.ts` `_tokenBearingMessageCount` field, incremented in `addToShoferMessages` / `updateShoferMessage`, recount in `overwriteShoferMessages`; `_cachedTokenUsage`             |
| **H12** threshold compaction                                         | `Task.ts` `COMPACTION_APPEND_THRESHOLD = 100`, `_appendedSinceCompaction`; forced at `_flushSaveShoferMessages`                                                                  |
| **H13** append handle + memoized mkdir                               | `jsonlLog.ts` `ensuredDirs: Set<string>` + `ensureDirOnce()`, `appendHandles: Map`, `disposeAppendHandle()`                                                                      |
| **H14** BlobStore content cache                                      | `BlobStore.ts` `_readCache: Map<string,string>`, checked in `resolveRefs()` before disk                                                                                          |
| **H23** `skipApiHistory`                                             | `ShoferProvider.ts` `getTaskWithId(id, { skipApiHistory })`; `showTaskWithId` passes `true`                                                                                      |
| **H24** tail read + paging                                           | `ShoferProvider.ts` `COLD_LOAD_TAIL_WINDOW = 200`, `loadOlderShoferMessages`, `shoferMessagesPrepended`; `jsonlLog.ts` `readJsonLinesTail`; `preloadShoferMessages(maxMessages)` |
| **H1+H3** parallel preload, no re-read                               | `Task.ts` `Promise.all([…getSavedShoferMessagesTail…, getSavedApiConversationHistory()])`, fire-and-forget `overwriteShoferMessages`                                             |
| **IPC** `postInitState` / `postConfigUpdate` / `postTaskStateUpdate` | `ShoferProvider.ts:3252/3271/3289`; old `postStateToWebview*` = **zero refs** in `src/`                                                                                          |
| **streaming deltas** focus-gated                                     | `Task.ts` `addToShoferMessages` / `updateShoferMessage` dual gate `getFocusedTaskId() === taskId \|\| getCurrentTask()?.taskId === taskId`                                       |
| **H8 removed**                                                       | `ShoferProvider.ts:224` removal comment; `mergeAllowedCommands`/`mergeDeniedCommands` recomputed fresh in `getStateToPostToWebview()`                                            |
| **H15** cached system prompt                                         | `Task.ts` `_cachedSystemPromptBase` / `_cachedSystemPromptKey`; busted at turn boundary + context management                                                                     |
| **H16** cached tools array                                           | `Task.ts` `_getOrBuildTools()` → `_cachedToolsResult` / `_cachedToolsKey`; both call sites routed through it                                                                     |
| **H17** MCP-connect gate folded into cache-miss                      | `Task.ts` `pWaitFor(() => !mcpHub.isConnecting, { timeout: 10_000 })` inside the cache-miss branch of `getSystemPrompt()`                                                        |
| **H10** incremental consolidation                                    | `incrementalMessageProcessing.ts` `computeReach` / `findSafeSplitIndex` / `OPEN_REACH = Infinity`; spec present; `ChatView.tsx` `processorRef`                                   |
| **H18** memoized context value                                       | `ExtensionStateContext.tsx` `contextValue = useMemo(() => ({…}), [21 deps])`                                                                                                     |
| **H19/H20** memoized ChatRow parses                                  | `ChatRow.tsx` `parsedRagSearch` / `parsedGitSearch` keyed on `message.text`; `previousTodos = useMemo(…, [shoferMessages, message.ts])`                                          |
| **H21** `memo(MermaidBlock)`                                         | `MermaidBlock.tsx:90` `memo(function MermaidBlock(…))`                                                                                                                           |
| **H22** hoisted Virtuoso identities                                  | `ChatView.tsx:67` `VIRTUOSO_VIEWPORT_INCREASE`; `visibleMessages = useMemo(…)`                                                                                                   |

Still open from the prior plan: **H7** (paginate `_index.json` at 1,000+ tasks).

## Task-Switch Latency: Hot / Cold / Warm Paths

> Added 2026-06-10. Anchors verified against HEAD. The user-reported symptom —
> "switching to a long task is slow to populate the ChatView" — is the **cold**
> path below. The landed H0–H14 work is concentrated on the **hot** (streaming)
> path; the cold path was largely left intact.

Three distinct task-switch paths are dispatched from
[`ShoferProvider.focusTask()`](extensions/shofer/src/core/webview/ShoferProvider.ts#L4931):

- **Hot** — the task is already open and the agent is streaming. New content
  arrives as `shoferMessageAppended` / `messageUpdated` deltas (incremental
  messaging), with debounced saves (H0), O(1) JSONL appends (H12–H13), and
  incremental webview consolidation (H10). Almost all landed items optimize this
  path.

- **Cold** — first visit to a task with no live instance (`isTaskAlive` false) →
  `else` branch →
  [`showTaskWithId(taskId, { keepCurrentTask: true })`](extensions/shofer/src/core/webview/ShoferProvider.ts#L4983)
  → full rehydrate:
  [`preloadShoferMessages()`](extensions/shofer/src/core/task/Task.ts#L3192)
  (two parallel reads + `JSON.parse` of both files via `getSavedShoferMessages` /
  `getSavedApiConversationHistory`, then a cheap pure-JS sanitize), `Task`
  construction, `resumeTaskFromHistory`, then `postInitState()`. The rehydrated
  instance is then kept alive via
  [`registerBackgroundTask(resumedTask)`](extensions/shofer/src/core/webview/ShoferProvider.ts#L4993)
  (see the comment at L4984).

- **Warm re-switch** — revisiting an already-visited task (`isTaskAlive` true) →
  LIVE path
  ([`focusTask`](extensions/shofer/src/core/webview/ShoferProvider.ts#L4944)):
  the retained in-memory `Task` instance is swapped into the stack and
  `postInitState()` is called. **No disk read, no `JSON.parse`, no sanitize, no
  construction.**

### Attributed costs (hand-timed, not yet sub-step-instrumented)

For a representative long task the observed split was **~4–5 s cold** vs
**~1 s warm**. Because warm and cold differ by exactly one stage — the host-side
rehydrate — the two numbers attribute as:

| Term                                                                                                                         | Runs on   | Approx cost          |
| ---------------------------------------------------------------------------------------------------------------------------- | --------- | -------------------- |
| Host rehydrate: parallel read + `JSON.parse` + sanitize + construct + `resumeTaskFromHistory`                                | cold only | ~3–4 s (cold−warm Δ) |
| Shared tail: `postInitState()` full-array IPC clone + webview `processorRef.reset()` → full consolidation + Virtuoso remount | both      | ~1 s (warm floor)    |

The dominant term is the host rehydrate, **not** the IPC clone or the webview
consolidation — if those dominated, warm re-switch would also be slow.

### Already-wired instrumentation (correction)

Coarse wall-time instrumentation already exists via the
[`time()`](extensions/shofer/src/utils/perf.ts#L75) helper:
[`preloadShoferMessages`](extensions/shofer/src/core/task/Task.ts#L3193),
`saveShoferMessages`, and
[`postInitState`](extensions/shofer/src/core/webview/ShoferProvider.ts#L3063)
each report to a Prometheus histogram and, when `process.env.DEBUG` is set, log
p50/p95 to the output channel. The cold-path split (whole-`preloadShoferMessages`
vs whole-`postInitState`) is therefore **already measurable today** under
`DEBUG` — no new code required.

What is **not** yet instrumented: (a) the sub-step breakdown _inside_
`_preloadShoferMessagesImpl` — read+parse (which lives inside
`getSavedShoferMessages` / `getSavedApiConversationHistory`) vs the cheap
sanitize — and (b) the webview-side first consolidation pass (host `time()`
calls do not cross the IPC boundary). Add those two splits before choosing
between simdjson and a tail-read.

### Implications for the open items

- **H10 gives zero benefit on task switch.** On every switch the webview calls
  `processorRef.current.reset()`, so the next `process()` is a full
  `combineApiRequests(combineCommandSequences(...))` + `getApiMetrics` pass over
  the whole array (including `JSON.parse` of every `api_req_started.text`). H10's
  incremental cache only amortizes _subsequent_ streamed chunks within a task.

- The dominant ~3–4 s term is attacked by **windowed/tail JSONL read** (read only
  the last K lines → bounded parse; the read-half of H2) and **H5.b (simdjson /
  off-main-thread parse)**. The tail-read also shrinks the ~1 s floor (smaller
  IPC clone, K-message first consolidation), so it hits both terms.

- The "render most-recent-first / chunk the IPC" idea — a lower-risk alternative
  to full H2 that keeps the full array in host memory and chunks only delivery +
  consolidation order, leaving every host-side invariant untouched — targets only
  the ~1 s floor, not the dominant rehydrate term. Worth doing for perceived
  latency, but it cannot by itself fix slow long-task switches.

### H24 (T1.B) implementation details

- **Tail read**: `preloadShoferMessages` with `maxMessages` uses
  `readJsonLinesTail` (last N lines) for `shoferMessages` only. The API
  conversation history is read in full (tail-reading it is wasted work —
  `resumeTaskFromHistory` re-reads the full file before building any LLM
  request).
- **Batch delivery**: `loadOlderShoferMessages` sends the older page in a
  single `shoferMessagesPrepended` IPC with an ordered (oldest-first)
  array, applied by the webview in one `setState`. No O(n) round-trips, no
  order reversal.
- **Union-by-`ts` merge**: the host rebuilds its in-memory array as
  `[...olderPage, ...in-memory tail, ...newTail]`, where `newTail` is any
  disk-tail message not already resident — so a background append that
  landed between the disk read and the merge is preserved rather than lost
  to a wholesale replace-from-disk. The webview likewise dedupes the
  prepended page by `ts` against its current tail before concatenating.
- **Known artifact**: the 200-message UI tail can begin mid-turn (e.g. a
  `command_output` whose originating `command` ask is older than the
  window). The webview handles this gracefully — orphaned outputs render
  without a parent block — and the full turn is restored once the user
  clicks "Load older messages".
- **Residual hardening (advisory, not blocking)**: (a)
  `shoferMessagesPrepended` carries no `taskId`, so a task switch during
  the awaited send could apply the page to the wrong array — the window is
  now a single message-batch rather than N, so the risk is small, but a
  `taskId` guard mirroring the `shoferMessageAppended` focus gate would
  close it. (b) The host-side prefix/tail disjointness relies on
  `getSavedShoferMessages` deduping by `ts` and the split aligning to the
  window start; this invariant is currently unstated in code and should
  carry a comment to survive future edits to the windowing logic.

## Root Causes Identified

### 1. `preloadShoferMessages()` — Redundant Re-Read on Every Task Switch

[`Task.preloadShoferMessages()`](extensions/shofer/src/core/task/Task.ts#L3192) is called from
[`ShoferProvider.createTaskWithHistoryItem()`](extensions/shofer/src/core/webview/ShoferProvider.ts#L1467)
every time the user switches to a task. **(H1 + H3 resolved in pre-2026-05-21.)** The
current implementation performs parallel `shoferMessages` + `apiConversationHistory` reads
and publishes the sanitized array in-memory without a redundant re-read:

```typescript
// Task.ts ~L3196–3265: _preloadShoferMessagesImpl()
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

### 3. State Broadcasting — Streaming Path Superseded; Task-Switch Init Still Full-Array

The old [`getStateToPostToWebview()`](extensions/shofer/src/core/webview/ShoferProvider.ts#L3212)
carried the full `taskHistory` + `shoferMessages` arrays on every state push.
**Resolved 2026-06-09 for the streaming path** by incremental messaging:
`postInitState()` (full snapshot, O(1) per task lifetime), `postConfigUpdate(key, value)`
(single-key delta), and `postTaskStateUpdate(updates)` (task lifecycle delta). Per-message
`shoferMessageAppended` / `messageUpdated` deltas replace full-array pushes on the
streaming path.

**Cold-path caveat (2026-06-10):** the supersession applies to the _streaming_
path only. On a task switch, `postInitState()` →
[`getStateToPostToWebview()`](extensions/shofer/src/core/webview/ShoferProvider.ts#L3212)
still serializes the **entire** `shoferMessages` + `taskHistory` arrays and
structured-clones them across the IPC boundary — every switch, cold or warm.
This is the ~1 s warm-floor term in the
[Task-Switch Latency: Hot / Cold / Warm Paths](#task-switch-latency-hot--cold--warm-paths)
section above; see it for the full attribution.

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

## Future Opportunities (2026-06-10) — All Implemented (verified 2026-06-11)

> These items were surfaced during a 2026-06-10 review pass. Unlike H0–H14
> (persistence + IPC/state-broadcast axes), they cover two hot paths the
> existing plan does not address: the **per-API-request build path** (host) and
> **React render hygiene** in the webview (beyond the H10 consolidation work).
> **All H15–H22 landed and were verified against HEAD on 2026-06-11.** The
> per-item sections below retain the original problem framing for context; each
> now carries a ✅ Done marker with the implementing call site. Line-number
> anchors are intentionally omitted in favor of symbolic names per the Doc
> Code-Example Line-Number Rule — re-verify call sites if revisiting.
>
> | #       | Item                                      | Path         | Description                                                                                        | Risk      | Status  |
> | ------- | ----------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------- | --------- | ------- |
> | **H15** | Cache the assembled system prompt         | Host (build) | `getSystemPrompt`/`SYSTEM_PROMPT` re-walks rules dirs + `AGENTS.md` per LLM round-trip             | 🟡 Medium | ✅ Done |
> | **H16** | Dedupe the per-request tool-array build   | Host (build) | `buildNativeToolsArrayWithRestrictions` runs 2× per request with identical params; MCP/dir scan    | 🟢 Low    | ✅ Done |
> | **H17** | Sidestep the per-request MCP-connect wait | Host (build) | 10s `pWaitFor` MCP gate on the system-prompt path; subsumed by H15 caching                         | 🟢 Low    | ✅ Done |
> | **H18** | Memoize `ExtensionStateContext` value     | Webview      | Bare object literal rebuilt every render → all `useExtensionState()` consumers re-render per delta | 🟡 Medium | ✅ Done |
> | **H19** | Memoize `ChatRow` per-render `JSON.parse` | Webview      | git/RAG/git-integration result rows re-parse `message.text` on every parent re-render              | 🟢 Low    | ✅ Done |
> | **H20** | Memoize `getPreviousTodos` reverse scan   | Webview      | O(n) reverse scan + `JSON.parse` per `updateTodoList` row render                                   | 🟢 Low    | ✅ Done |
> | **H21** | Wrap `MermaidBlock` in `memo()`           | Webview      | Re-renders with parent; `CodeBlock`/`MarkdownBlock` already memoized — the odd one out             | 🟢 Low    | ✅ Done |
> | **H22** | Hoist inline object/array identities      | Webview      | Inline `increaseViewportBy={{…}}` on Virtuoso + constant arrays in the visible-messages filter     | 🟢 Low    | ✅ Done |

### Host-side: the request-build path

`attemptApiRequest()` runs once per LLM call, and a single user turn often issues
many (every tool use → another round-trip). The following work repeats per call
even though its inputs are stable across the turn.

#### 🟡 H15: Cache the Assembled System Prompt ✅ Done (2026-06-10)

**Target:** [`Task.getSystemPrompt()`](extensions/shofer/src/core/task/Task.ts) →
`SYSTEM_PROMPT` →
[`addCustomInstructions`](extensions/shofer/src/core/prompts/sections/custom-instructions.ts)

**Implemented:** `getSystemPrompt()` memoizes the assembled base prompt in
`_cachedSystemPromptBase`, keyed on `_cachedSystemPromptKey` — a `|`-joined
signature of `taskMode`, `cwd`, `customInstructions`, `experiments`, `language`,
`enableSubfolderRules`, `useAgentRules`, `todoListEnabled`, `isStealthModel`,
`newTaskRequireTodos`, model id, `mcpEnabled`, the MCP server-set id
(`_mcpServerSetId`), and the shoferIgnore instructions. Cache hit returns the
stored prompt; cache miss recomputes and refreshes both fields. The cache is
busted explicitly after context management. Subtask constraints and peer
notifications are still appended fresh per request (intentionally outside the
cached base).

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

#### 🟢 H16: Dedupe the Per-Request Tool-Array Build ✅ Done (2026-06-10)

**Target:** [`buildNativeToolsArrayWithRestrictions`](extensions/shofer/src/core/task/build-tools.ts),
called twice per `attemptApiRequest` (context-management metadata + the actual
call) with identical `(mode, cwd, experiments, apiConfiguration, disabledTools,
modelInfo)`. Internally it enumerates MCP tools + normalizes schemas, and (if
`customTools`) scans the `.shofer` directory.

**Implemented:** `Task._getOrBuildTools()` wraps
`buildNativeToolsArrayWithRestrictions`, caching the result in
`_cachedToolsResult` keyed on `_cachedToolsKey` (`_buildToolsCacheKey(mode,
state, apiConfiguration, …)`). Both the context-management call site and the
main-request call site go through the cache, so the build runs once per
`attemptApiRequest` and is reused across round-trips while the key is stable.

**Risk:** 🟢 Low — single-call-scoped reuse is mechanical.

#### 🟢 H17: Sidestep the Per-Request MCP-Connect Wait ✅ Done (2026-06-10)

**Target:** the `pWaitFor` MCP-connected gate on the system-prompt path in
[`Task.getSystemPrompt()`](extensions/shofer/src/core/task/Task.ts).

Benign when connected, but it is a per-request gate (up to ~10s) that H15's
caching would also sidestep. Fold into H15 rather than fixing standalone.

**Implemented:** folded into H15 as intended. The `pWaitFor(() =>
!mcpHub.isConnecting, { timeout: 10_000 })` gate now lives inside the
cache-miss branch of `getSystemPrompt()`, so a hot system-prompt cache skips the
MCP-connect wait entirely. On cache miss the gate still runs and captures the
server-set id for cache-key participation.

**Risk:** 🟢 Low.

### Webview-side: render hygiene beyond H10

H10 removed the O(n²) consolidation cost; these are the remaining classic React
identity/parse costs on the render path.

#### 🟡 H18: Memoize the `ExtensionStateContext` Value ✅ Done (2026-06-10)

**Target:** the context value object in
[`ExtensionStateContext.tsx`](extensions/shofer/webview-ui/src/context/ExtensionStateContext.tsx).

It is a bare object literal (70+ fields + inline setters) rebuilt every render,
not `useMemo`'d — so every `useExtensionState()` consumer re-renders on any
state change, including each streamed delta. This likely dominates webview CPU
during streaming and sits **upstream of all the H10 work**, making it the
single highest-leverage webview fix still on the table.

**Implemented:** the `contextValue` object is now wrapped in `useMemo` with an
explicit dependency list (`state`, `didHydrateState`, `showWelcome`, `theme`,
`mcpServers`, …), so consumers no longer re-render on an unrelated parent render.

**Risk:** 🟡 Medium — wide consumer surface, but mechanical.

#### 🟢 H19: Memoize `ChatRow` Per-Render `JSON.parse` ✅ Done (2026-06-10)

**Target:** the git/RAG/git-integration result-row branches in
[`ChatRow.tsx`](extensions/shofer/webview-ui/src/components/chat/ChatRow.tsx).

These call `JSON.parse(message.text)` directly in render, re-parsing on every
parent re-render (which H18 makes frequent).

**Implemented:** the RAG-search, git-search, and rate-limit-wait branches each
parse `message.text` inside a `useMemo` keyed on `message.text`
(`parsedRagSearch` and siblings), so the parse runs only when the text changes.

**Risk:** 🟢 Low. Compounds with H18 during streaming.

#### 🟢 H20: Memoize `getPreviousTodos` Reverse Scan ✅ Done (2026-06-10)

**Target:** `getPreviousTodos` in
[`ChatRow.tsx`](extensions/shofer/webview-ui/src/components/chat/ChatRow.tsx) —
an O(n) reverse scan + `JSON.parse` run per `updateTodoList` row render, not
memoized.

**Implemented:** `previousTodos` is now a `useMemo` over
`getPreviousTodos(shoferMessages, message.ts)`, keyed on `shoferMessages` and
`message.ts`, so the reverse scan + parse runs only when those change.

**Risk:** 🟢 Low.

#### 🟢 H21: Wrap `MermaidBlock` in `memo()` ✅ Done (2026-06-10)

**Target:** [`MermaidBlock.tsx`](extensions/shofer/webview-ui/src/components/common/MermaidBlock.tsx).

Re-renders with its parent; `CodeBlock`/`MarkdownBlock` are already memoized, so
this is the odd one out.

**Implemented:** `MermaidBlock` is now declared as `memo(function MermaidBlock(
{ code }) { … })` and exported as the memoized component.

**Risk:** 🟢 Low.

#### 🟢 H22: Hoist Inline Object/Array Identities ✅ Done (2026-06-10)

**Targets:** inline `increaseViewportBy={{…}}` on the Virtuoso list and the
constant arrays allocated inside the visible-messages filter in
[`ChatView.tsx`](extensions/shofer/webview-ui/src/components/chat/ChatView.tsx).

New object/array identities per render defeat child memoization. Low value
individually; trivial to hoist to module-level constants or `useMemo`.

**Implemented:** the viewport config is hoisted to a module constant
(`VIRTUOSO_VIEWPORT_INCREASE = { top: 3_000, bottom: 1000 }`) and passed as
`increaseViewportBy={VIRTUOSO_VIEWPORT_INCREASE}`; `visibleMessages` is computed
inside a `useMemo` rather than rebuilt inline each render.

**Risk:** 🟢 Low.

---

## Newly Identified Opportunities (2026-06-13)

> Surfaced during the 2026-06-13 re-verification sweep. These are **distinct**
> from H0–H24 / H15–H22 (verified above) and from the known-open H7. Two of them
> (H25, H26) attack the **~1 s warm-floor** identified in
> [Task-Switch Latency](#task-switch-latency-hot--cold--warm-paths) — the part of
> the cold/warm cost the landed hot-path work did **not** touch. None is started.

| #       | Item                                             | Path          | Description                                                                                                                                     | Risk       | Status  |
| ------- | ------------------------------------------------ | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------- |
| **H25** | Cache sorted+filtered `taskHistory` in the store | Host (state)  | `TaskHistoryStore.getAll()` re-sorts the whole map and `getStateToPostToWebview()` re-filters it on **every** state push                        | 🟢 Low     | ❌ Open |
| **H26** | Lazy / delta `taskHistory` IPC channel           | Host↔Webview | The full `taskHistory` array is serialized + structured-cloned across IPC on every `postInitState`, even when it didn't change                  | 🟡 Medium  | ❌ Open |
| **H27** | Fuse the per-request history-prep passes         | Host (build)  | Five sequential O(n) allocating walks (`getEffectiveApiHistory`→`getMessagesSinceLastSummary`→`merge`→`stripImages`→`clean`) run per round-trip | 🟡 Low–Med | ❌ Open |
| **H28** | O(n) child-map for `TaskSelector.buildFlatTree`  | Webview       | O(n²) nested `filter` to find each node's children when building the task tree                                                                  | 🟢 Low     | ❌ Open |

### 🟢 H25: Cache the Sorted+Filtered `taskHistory` in `TaskHistoryStore`

**Targets:**
[`TaskHistoryStore.getAll()`](extensions/shofer/src/core/task-persistence/TaskHistoryStore.ts#L142),
[`getStateToPostToWebview()`](extensions/shofer/src/core/webview/ShoferProvider.ts#L3590)

`getAll()` rebuilds and re-sorts the entire history on **every** call:

```typescript
getAll(): HistoryItem[] {
	return Array.from(this.cache.values()).sort((a, b) => (b.createdAt ?? b.ts) - (a.createdAt ?? a.ts))
}
```

and the only caller on the state-push path immediately re-filters it:

```typescript
taskHistory: this.taskHistoryStore.getAll().filter((item: HistoryItem) => item.ts && item.task),
```

`getStateToPostToWebview()` runs inside `postInitState()` — i.e. on **every task
switch** (cold and warm) and on settings changes. So every switch pays an
`Array.from` + O(n log n) sort + O(n) filter over the **entire** task store to
deliver a list whose contents are unchanged since the last switch. This is part
of the ~1 s warm floor and it grows with total task count, not conversation
length.

**Fix:** Memoize a sorted, validity-filtered `HistoryItem[]` inside
`TaskHistoryStore`, invalidated only inside the existing write/mutation paths
(`upsert`/`delete`/`deleteMany`, which already hold the write lock). `getAll()`
(and a new `getValidSortedAll()` for the state path) return the cached array.
Reads — the common case during a switch — become O(1).

**Risk:** 🟢 Low. Invalidation is confined to the already-serialized mutation
paths; the returned array must stay treated as read-only (it already is at the
call site).

### 🟡 H26: Lazy / Delta `taskHistory` IPC Channel on Init

**Target:**
[`postInitState()`](extensions/shofer/src/core/webview/ShoferProvider.ts#L3252) →
[`getStateToPostToWebview()`](extensions/shofer/src/core/webview/ShoferProvider.ts#L3590)

Even after H25 removes the _recompute_ cost, `postInitState` still
**serializes + structured-clones the full `taskHistory` array** across the IPC
boundary on every switch. Incremental messaging (2026-06-09) split the _message_
stream into deltas but left the init snapshot carrying the entire task list —
the analogue of H4 for `taskHistory` was never applied to the init path. For a
user with a large history this is the sibling cost to the full-`shoferMessages`
clone already noted as the warm floor in
[State Broadcasting §3](#3-state-broadcasting--streaming-path-superseded-task-switch-init-still-full-array).

**Fix:** Treat `taskHistory` like the other deltas. `postInitState` sends the
list **once** (or a windowed top-N for the visible selector), and subsequent
mutations flow through the existing `taskHistoryItemUpdated` delta channel rather
than being re-sent inside each init snapshot. The webview already has a reducer
for HistoryItem mutations, so this is mostly removing `taskHistory` from the init
payload and seeding it through the delta path. A top-N window (the
`TaskSelector` only shows a scrollable list anyway) caps the one-time cost too.

**Risk:** 🟡 Medium. Touches the webview state reducer; the exhaustive
`ExtensionMessage` switch will surface every consumer (per the Exhaustive Switch
Rule). Sequence carefully so a switch that lands mid-mutation can't drop an
update — mirror the `ts`/`taskId` guards used by the message deltas.

### 🟡 H27: Fuse the Per-Request History-Prep Passes

**Target:**
[`Task.attemptApiRequest()`](extensions/shofer/src/core/task/Task.ts#L6579)
build block:

```typescript
const effectiveHistory = getEffectiveApiHistory(this.apiConversationHistory) // O(n) filter
const messagesSinceLastSummary = getMessagesSinceLastSummary(effectiveHistory) // O(n)
const mergedForApi = mergeConsecutiveApiMessages(messagesSinceLastSummary, { roles: ["user"] }) // O(n)
const messagesWithoutImages = maybeRemoveImageBlocks(mergedForApi, this.api) // O(n)
const cleanConversationHistory = this.buildCleanConversationHistory(messagesWithoutImages) // O(n) + per-msg rebuild
```

This runs once **per LLM round-trip**, and a single user turn issues many
round-trips (every tool use → another request). It is five sequential O(n)
walks, each allocating a fresh array of the full effective history, plus the
per-message content-block rebuild in `buildCleanConversationHistory`. Across a
turn of `r` round-trips on `n` messages that is O(n·r) allocate-and-copy.

**Fix (the safe kind):** Fuse the independent filter/transform passes into one or
two walks (e.g. fold `getEffectiveApiHistory` + `getMessagesSinceLastSummary` +
`mergeConsecutiveApiMessages` + image-strip into a single pass that emits the
cleaned array directly), and give `mergeConsecutiveApiMessages` an O(1) no-op
fast path (a single scan that, finding no adjacent same-role pair, returns the
input array unchanged instead of rebuilding it).

**Do NOT** try to cache this derived array across round-trips by prefix-cloning —
that is exactly the **H14 index-delta reversion** trap (see
[Reversion notes (2026-06-10)](#reversion-notes-2026-06-10)): the cleaned view is
post-truncation/merge/strip/re-index, so any index-keyed prefix cache
desynchronises and can send un-resolved blob refs to the LLM. The append between
round-trips also defeats a whole-array length-keyed cache. Pass fusion is the
win that has no such failure mode.

**Risk:** 🟡 Low–Med. Pure restructuring of existing transforms; cover with the
existing API-history fixtures to assert byte-identical output to the current
five-pass pipeline (including the reasoning-block and image-strip edge cases).

### 🟢 H28: O(n) Child-Map for `TaskSelector.buildFlatTree`

**Target:**
[`buildFlatTree()`](extensions/shofer/webview-ui/src/components/chat/TaskSelector.tsx#L43)

Each node re-scans the whole history to find its children:

```typescript
const children = taskHistory.filter((i) => i.parentTaskId === item.id).sort(sortDesc)
```

Inside the recursive `visit`, this is O(n) per node → **O(n²)** to build the
tree, run inside the `useMemo(() => buildFlatTree(taskHistory), [taskHistory])`
that backs the task selector. The existing
[What NOT to Optimize](#what-not-to-optimize) entry rightly calls this negligible
**below ~500 tasks** — this item does not change that verdict, it just notes the
fix is nearly free and worth taking opportunistically: pre-build a
`Map<parentId, HistoryItem[]>` in one O(n) pass, sort each bucket once, and have
`visit` read `childrenByParent.get(item.id) ?? []`. Same output shape, O(n log n)
total.

**Risk:** 🟢 Low. Pure algorithmic swap; identical tree output.

## What NOT to Optimize

| Area                                        | Reason                                                                  |
| ------------------------------------------- | ----------------------------------------------------------------------- |
| `TaskSelector.buildFlatTree()` O(n²)        | Webview-side, negligible for <500 tasks (cheap O(n) fix tracked as H28) |
| `TaskManager.restoreManagedTasks()`         | Simple O(n) loop, no I/O                                                |
| Memory from `HistoryItem` objects           | ~1 KB each — 1,000 tasks ≈ 1 MB, negligible                             |
| `extension.ts` activation order             | Already non-blocking                                                    |
| `TaskHistoryStore.reconcile()` startup scan | Only runs on cold cache; mitigated by `_index.json`                     |

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
