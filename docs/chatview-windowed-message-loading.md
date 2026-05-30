# ChatView — Windowed Message Loading (H2)

> **Status:** ❌ Reverted (2026-05-30)
>
> This implementation was reverted due to issues, but worth revisiting later.
>
> **Implementation commits (reverted):**
>
> | Commit                                                                | Description                                                                       |
> | --------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
> | [`14de80284`](https://github.com/arkware/arkware.ai/commit/14de80284) | H2: Windowed Message Loading for ChatView (9 files, +180/-17)                     |
> | [`94afc1d24`](https://github.com/arkware/arkware.ai/commit/94afc1d24) | chore: bump version to 1.0.16 for H2 windowed message loading                     |
> | [`fbb8ff8a3`](https://github.com/arkware/arkware.ai/commit/fbb8ff8a3) | docs(H2): move design doc to docs/ with implementation details                    |
> | [`a6bf5413a`](https://github.com/arkware/arkware.ai/commit/a6bf5413a) | fix(chat): prevent Virtuoso snap-back when scrolling (firstItemIndex conditional) |
>
> **Associated version bumps (also reverted):**
>
> | Commit                                                                | Description                                                   |
> | --------------------------------------------------------------------- | ------------------------------------------------------------- |
> | [`899fbdbfe`](https://github.com/arkware/arkware.ai/commit/899fbdbfe) | ChatRow metadata tooltip + brace fix + test file (superseded) |
>
> Original design document follows for historical reference.
>
> ---
>
> This is **Approach B** from the investigation into "as a single Task becomes
> longer, it becomes slower and slower." It corresponds to **H2** in
> [`performance_optimizations.md`](./performance_optimizations.md)
> (status there: **❌ Reverted**).
>
> **Relationship to Approach A (H10, done).** The lower-risk webview-only fix —
> incremental message consolidation — already landed (see
> [`../todos/done/chatview-incremental-message-processing.md`](../todos/done/chatview-incremental-message-processing.md)
> and H10 in the perf doc). It removes the O(n²) per-chunk recompute regardless
> of `n`. H2 was intended to be complementary: bounding the **cold task-switch**
> cost — the IPC structured clone and initial render of a very large history —
> by never materializing the whole array in the webview.

## Problem

On rehydrate / task switch, the full `shoferMessages` array is loaded from disk,
pushed across the host→webview IPC boundary (VS Code structured-clones the whole
payload), and handed to the webview state. For a task with thousands of messages
(several MB) this is a single large transient cost on every switch into the task:

- `JSON.parse` of the whole `ui_messages.jsonl` on the host.
- One large structured clone over IPC.
- Initial Virtuoso mount over the full array, plus the derived-state passes in
  `ChatView` (now incremental after H10, but the first pass is still full-size).

The user only ever sees the **bottom** of the conversation on open, so loading
the entire history up front is wasted work for the cold-open case.

## Goal

On rehydrate, load only the **last 100 messages** (`DEFAULT_WINDOW_LIMIT`) into
webview state and render them. Show a "Load older messages…" sentinel at the top
of the Virtuoso list; reaching it requests the previous page from the host, which
pushes an older slice that the webview **prepends** while preserving scroll position.

Behavior parity: scrolling to the very top eventually reveals the full history,
identical in content to today; no message is lost or reordered.

## Implementation

### IPC protocol

New typed variants in [`vscode-extension-host.ts`](../packages/types/src/vscode-extension-host.ts):

- `ExtensionState` gains `hasMoreMessages?: boolean`, `oldestLoadedTs?: number`,
  `lastPrependedCount?: number`, and `tokenUsage?: TokenUsage`.
- `ExtensionMessage.type` gains `"olderMessagesLoaded"` with payload fields
  `olderMessages`, `olderHasMore`, `olderOldestTs`.
- `WebviewMessage.type` gains `"loadOlderMessages"` with `beforeTs` / `limit`
  fields.

### Host side ([`ShoferProvider.ts`](../src/core/webview/ShoferProvider.ts))

- `getStateToPostToWebview()`: When the current task is history-preloaded,
  pushes only the last `DEFAULT_WINDOW_LIMIT` (100) messages, sets
  `hasMoreMessages`, `oldestLoadedTs`, and `tokenUsage` from the host's
  synchronous `Task.getTokenUsage()` (which walks the full array).
- `loadOlderMessages(beforeTs, limit)`: slices the full in-memory
  `task.shoferMessages` array for messages older than `beforeTs` and pushes an
  `olderMessagesLoaded` delta.
- Handled in [`webviewMessageHandler.ts`](../src/core/webview/webviewMessageHandler.ts)
  via a new `case "loadOlderMessages"`.

### Webview side

- **Reducer** ([`ExtensionStateContext.tsx`](../webview-ui/src/context/ExtensionStateContext.tsx)):
  On `olderMessagesLoaded`, prepends deduplicated older messages (by `ts`) to
  `shoferMessages`, stamps `lastPrependedCount` with the exact count after
  de-duplication, and updates `hasMoreMessages` / `oldestLoadedTs`.
- **ChatView** ([`ChatView.tsx`](../webview-ui/src/components/chat/ChatView.tsx)):
    - Renders a "Load older messages…" sentinel at the Virtuoso list top when
      `hasMoreMessages` is true.
    - `startReached` handler posts `loadOlderMessages` with `beforeTs = oldestLoadedTs`.
    - Scroll preservation via Virtuoso's `firstItemIndex` prepend pattern:
      `firstItemIndex = H2_PREPEND_BASE - prependedCount` where `H2_PREPEND_BASE = 1_000_000`.
      `prependedCount` is incremented when `oldestLoadedTs` decreases (older page
      loaded), using the exact `lastPrependedCount` stamped by the reducer.
    - Token totals consumed from host's authoritative `tokenUsage` instead of the
      partial-window `apiMetrics` from the incremental processor.
    - Guard against duplicate in-flight page requests via `loadingOlderRef`.

### Token totals

The host's synchronous `Task.getTokenUsage()` walks the full `shoferMessages`
array — correct even on cold-switch, on the very first state push. The webview
reads `ExtensionState.tokenUsage` and overrides the incremental processor's
(partial-window) `apiMetrics`. No under-counting.

## Constraints / invariants

| Consumer                                              | Concern                                    | Resolution                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **TaskHeader token usage / cost**                     | `getApiMetrics` sums over all messages     | ✅ Host computes totals from the full array via `Task.getTokenUsage()`; webview consumes host-provided `tokenUsage`                                                                                                                                                                                  |
| **Checkpoint restore / pending-edit replay**          | operate by `ts` and array index            | ✅ Host holds the full in-memory array; webview addresses messages by `ts`, never by absolute index                                                                                                                                                                                                  |
| **Message edit / delete**                             | webview posts by `ts`                      | ✅ Already `ts`-keyed                                                                                                                                                                                                                                                                                |
| **`messageUpdated` / `shoferMessageAppended` deltas** | target a message outside the loaded window | ✅ If `ts` not in window → dropped (correct when page loads); appends target the tail (always in-window)                                                                                                                                                                                             |
| **Scroll lifecycle**                                  | prepend must not fight sticky-follow       | ✅ `firstItemIndex` pattern preserves viewport position; `initialTopMostItemIndex` captured as stale ref to prevent snap-back on data growth                                                                                                                                                         |
| **Incremental consolidation (H10)**                   | prefix cache invalidated by prepend        | ✅ Reference-prefix check detects changed array head → triggers full recompute of now-larger window                                                                                                                                                                                                  |
| **Search across history**                             | result outside window                      | N/A — search stays host-side                                                                                                                                                                                                                                                                         |
| **Re-window on state push**                           | loaded older pages lost on next push       | ⚠️ **Known limitation.** `getStateToPostToWebview()` re-windows to last-100 on every push. Seq guard protects against concurrent stale pushes, but any message mutation bumps the seq → collapsed back to 100. A future fix would track a per-task "expanded to ts X" and honor it in the host push. |

## Files changed

| File                                                                                                 | Change                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| [`vscode-extension-host.ts`](../packages/types/src/vscode-extension-host.ts)                         | `olderMessagesLoaded`/`loadOlderMessages` variants; `hasMoreMessages`, `oldestLoadedTs`, `lastPrependedCount`, `tokenUsage` on `ExtensionState` |
| [`taskMessages.ts`](../src/core/task-persistence/taskMessages.ts)                                    | `DEFAULT_WINDOW_LIMIT` constant (100)                                                                                                           |
| [`ShoferProvider.ts`](../src/core/webview/ShoferProvider.ts)                                         | windowed state push; `loadOlderMessages` handler; imports `DEFAULT_WINDOW_LIMIT`                                                                |
| [`webviewMessageHandler.ts`](../src/core/webview/webviewMessageHandler.ts)                           | `case "loadOlderMessages"` handler                                                                                                              |
| [`ExtensionStateContext.tsx`](../webview-ui/src/context/ExtensionStateContext.tsx)                   | `olderMessagesLoaded` reducer (prepend + dedupe + `lastPrependedCount`); merge guard for windowing metadata                                     |
| [`ChatView.tsx`](../webview-ui/src/components/chat/ChatView.tsx)                                     | top sentinel; `startReached` handler; `firstItemIndex` scroll anchoring; host `tokenUsage` override; `H2_WINDOW_LIMIT` / `H2_PREPEND_BASE`      |
| [`ChatRow.tsx`](../webview-ui/src/components/chat/ChatRow.tsx)                                       | removed unrelated `promptTokens`/`completionTokens`/`costUsd` scope creep                                                                       |
| [`ExtensionStateContext.spec.ts`](../webview-ui/src/context/__tests__/ExtensionStateContext.spec.ts) | 12 new H2 tests (prepend, dedupe, seq guard)                                                                                                    |

## Testing

- **Webview reducer:** 12 tests covering prepend with dedupe, partial final pages,
  fully-deduped races, `hasMoreMessages` flip, seq guard for windowing metadata.
  Run: `npx vitest run src/context/__tests__/ExtensionStateContext.spec.ts`

## Known limitations

1. **Re-window on state push.** A streaming tick after expanding older pages
   collapses back to last-100. Fix requires tracking expanded range on the host.
2. **No integration test.** Not yet tested end-to-end with a large task.

## Design decisions

### Why not paginated disk files?

Splitting persistence into `ui_messages_page_*.json` files was considered and
rejected: it forces `saveShoferMessages` to write both the full file and the page
files, doubling steady-state write cost on the hot streaming path to optimize the
cold task-switch path. The JSONL append-only format already supports cheap
tail/range reads without a second on-disk representation.

### Why no host-side disk savings?

The host still loads the full array into `Task.shoferMessages` for `taskMetadata`,
checkpoint restore, LLM context packing, etc. The optimization is purely on the
IPC boundary — the structured clone payload to the webview is bounded to K
messages.

### Why the `initialTopMostItemIndex` fight?

Virtuoso's `initialTopMostItemIndex` is **not** a one-shot initial placement —
Virtuoso treats it as authoritative and re-applies it when the `data` prop grows.
When older messages are prepended and `groupedMessages.length` increases,
Virtuoso jumps to the new index. Solution: `firstItemIndex` handles scroll
anchoring; `initialTopMostItemIndex` is only needed for the first render
(already correct without H2).
