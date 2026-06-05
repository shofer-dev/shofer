# Chat Message Panel — Scroll Architecture

This document describes how scrolling works in the task message panel (the list of messages and prompts shown during a task).

## Components Involved

| File                                                                                            | Role                                                                         |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [`webview-ui/src/hooks/useScrollLifecycle.ts`](../webview-ui/src/hooks/useScrollLifecycle.ts)   | All scroll state and logic                                                   |
| [`webview-ui/src/components/chat/ChatView.tsx`](../webview-ui/src/components/chat/ChatView.tsx) | Renders the Virtuoso list and the scroll-to-bottom button; wires up the hook |

## Virtualization

The message list is rendered by **[react-virtuoso](https://virtuoso.dev/)** (`<Virtuoso key={task.ts}>`). Only the rows visible in the viewport (plus a 3 000 px top / 1 000 px bottom overscan buffer) are mounted in the DOM. Imperatives like `scrollToIndex({ index: "LAST", … })` are issued via a `VirtuosoHandle` ref (`virtuosoRef`).

A sibling `<div ref={scrollContainerRef}>` wraps the Virtuoso and is used to scope scroll/wheel/pointer event listeners so they only fire for interactions inside the chat column.

### Render-phase ref synchronization

When `taskTs` changes, the `<Virtuoso key={task.ts}>` unmounts the old instance and mounts a new one **during the render phase** — before the `useEffect` that transitions to `HYDRATING_PINNED_TO_BOTTOM` fires. Without pre-emptive ref sync, the freshly mounted Virtuoso fires its callbacks (notably `atBottomStateChangeCallback`) against stale refs from the previous task, causing the scroll anchor to be lost.

To close this race, `useScrollLifecycle` synchronizes `scrollPhaseRef`, `isAtBottomRef`, and `userDisengagedRef` **during the render phase** via `taskTs !== prevTaskTsRef.current` — before the Virtuoso mounts. This mirrors the Preload-Before-Publish Rule: refs consumed by the Virtuoso must be set before the Virtuoso is "published" (mounted).

## Scroll Phase State Machine

All scroll state lives in `useScrollLifecycle`. It is a three-phase state machine:

```
HYDRATING_PINNED_TO_BOTTOM
        |
        | isAtBottom confirmed (or retry budget exhausted)
        ↓
 ANCHORED_FOLLOWING  ←──────────────────────────────────────────┐
        |                                                        │
        | user scrolls up (wheel / drag / keyboard / row expand) │
        ↓                                                        │
 USER_BROWSING_HISTORY                                           │
        |                                                        │
        | user clicks scroll-to-bottom button ───────────────────┘
```

### `HYDRATING_PINNED_TO_BOTTOM`

Entered whenever `taskTs` changes (task switch, new task, task restore).

1. `isAtBottomRef` is reset to `false`.
2. A 600 ms hydration window opens (`HYDRATION_WINDOW_MS`).
3. After two animation frames (giving Virtuoso time to mount and measure), `scrollToBottomAuto()` is called.
4. Virtuoso's `atBottomStateChange` callback updates `isAtBottomRef`.
5. At the end of the window:
    - If `isAtBottom` is `true` → transition to `ANCHORED_FOLLOWING`.
    - Otherwise → retry up to `MAX_HYDRATION_RETRIES` (3) times at 160 ms intervals (`HYDRATION_RETRY_WINDOW_MS`), calling `scrollToBottomAuto()` each time.
    - If retries are exhausted → transition to `ANCHORED_FOLLOWING` anyway (a transient measurement glitch should not strand the user in browse mode).

During this phase the scroll-to-bottom button is **hidden** (a not-at-bottom signal during hydration is not treated as a user intent to browse).

### `ANCHORED_FOLLOWING`

The list is pinned to the bottom. Virtuoso's `followOutput` prop returns `"auto"`, so Virtuoso itself scrolls to the bottom when new items are appended.

> **Immune window**: when any input signal triggers `enterUserBrowsingHistory`, a 500 ms timer is started (`userDisengagedRef`). Any `atBottomStateChange(true)` signal that arrives while the timer is active — typically from an in-flight `scrollToBottomSmooth()` issued just before the user scrolled up — is ignored and does not snap the user back to `ANCHORED_FOLLOWING`. This prevents the flickering loop that would otherwise occur during heavy streaming.

When a message row grows taller (e.g. streaming text arriving, a tool result expanding), `handleRowHeightChange(isTaller)` triggers an additional imperative scroll:

- Row grew taller → `scrollToBottomSmooth()` (debounced, 10 ms, leading-edge).
- Row shrank → `scrollToBottomAuto()`.

The scroll-to-bottom button is **hidden**.

### `USER_BROWSING_HISTORY`

Sticky follow is disabled. Virtuoso's `followOutput` returns `false`. The scroll-to-bottom button is **shown**.

## Disengaging Sticky Follow (Entering `USER_BROWSING_HISTORY`)

Four input signals trigger `enterUserBrowsingHistory(source)`:

| Source                | Event                                                | Condition                                                                                                                |
| --------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `"wheel-up"`          | `wheel` on `window`                                  | `deltaY < 0` and target is inside `scrollContainerRef`                                                                   |
| `"pointer-scroll-up"` | `scroll` on `window` (capture) during active pointer | pointer is down, target is inside `scrollContainerRef`, `scrollTop` decreased                                            |
| `"keyboard-nav-up"`   | `keydown` on `window`                                | Key is `PageUp`, `Home`, or `ArrowUp`; focus is inside the chat or on `document.body`; target is not an editable element |
| `"row-expansion"`     | `expandedRows` state change in `ChatView`            | A row that was previously collapsed is now expanded                                                                      |

## Re-engaging Sticky Follow

### Via the scroll-to-bottom button

Clicking the `codicon-chevron-down` button calls `handleScrollToBottomClick`:

1. Transitions to `ANCHORED_FOLLOWING`.
2. Calls `scrollToBottomAuto()` immediately.
3. Schedules a second `scrollToBottomAuto()` in the next animation frame to absorb any pending layout flush.

### Naturally reaching the bottom

`atBottomStateChangeCallback` fires whenever Virtuoso's bottom-detection crosses the 1 px threshold (`atBottomThreshold={1}`). When `isAtBottom` becomes `true`, the hook calls `enterAnchoredFollowing()` — except when in `USER_BROWSING_HISTORY` during the hydration window or the disengage immune window, where the signal is suppressed (see the immune window description above).

When `isAtBottom` becomes `false` while already in `ANCHORED_FOLLOWING` during streaming (a transient not-at-bottom blip from rapid content growth), the hook calls `scrollToBottomAuto()` and keeps the button hidden — a safety net that prevents Virtuoso from momentarily dropping the follow anchor.

## Scroll Commands

| Function                 | Virtuoso call                                                        | Used when                                                                                     |
| ------------------------ | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `scrollToBottomAuto()`   | `scrollToIndex({ index: "LAST", align: "end", behavior: "auto" })`   | Task switch, hydration retries, button click, pointer-detected not-at-bottom during streaming |
| `scrollToBottomSmooth()` | `scrollToIndex({ index: "LAST", align: "end", behavior: "smooth" })` | Row grew taller while anchored                                                                |

`scrollToBottomSmooth` is created with `debounce(..., 10, { immediate: true })` so rapid height changes fire once at the leading edge and then at most once more after the 10 ms window.

## Key Refs

| Ref                  | Type             | Purpose                                                                                                                                                         |
| -------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `virtuosoRef`        | `VirtuosoHandle` | Imperative scroll commands                                                                                                                                      |
| `scrollContainerRef` | `HTMLDivElement` | Scopes scroll/wheel/pointer event listeners to the chat column                                                                                                  |
| `isAtBottomRef`      | `boolean`        | Live bottom-detection flag; updated synchronously by `atBottomStateChangeCallback`                                                                              |
| `scrollPhaseRef`     | `ScrollPhase`    | Mirror of phase state for use inside event handlers (avoids stale closure captures)                                                                             |
| `isHydratingRef`     | `boolean`        | Guards hydration-time bottom signals from being misinterpreted as user browse intent                                                                            |
| `userDisengagedRef`  | `boolean`        | Immune-window flag: set for 500 ms whenever `enterUserBrowsingHistory` is called; prevents in-flight programmatic scrolls from re-engaging `ANCHORED_FOLLOWING` |

## Per-Task Scroll Restoration (Re-entry)

The `<Virtuoso key={task.ts}>` is keyed on the task timestamp, so switching tasks **unmounts and remounts** the entire list — any scroll position held in the DOM is destroyed. To make re-entering a previously-viewed task restore exactly where the user left off, `ChatView`/`WorkflowView` capture and replay react-virtuoso's native **`StateSnapshot`** (`{ ranges, scrollTop }`).

### Why not a bare `scrollTop`?

An earlier implementation snapshotted only the scroller's `scrollTop` pixel value and replayed it via `scrollTo({ top })` two animation frames after mount. This is fundamentally incompatible with virtualization: at mount the freshly-keyed Virtuoso has only measured the handful of rows in the initial viewport, so the scrollable element's `scrollHeight` is a few hundred pixels. A saved offset of tens of thousands of pixels is therefore **clamped back to ~0**, landing the user near the top instead of where they were. (Observed in the logs as `scrollTo top=49454 … scrollerHeight=293`.)

### Capture

In the render-phase task-switch block (the same place the outgoing task is marked hydrated), the hook owners call `virtuosoRef.current?.getState(cb)`. `getState` invokes its callback **synchronously**, and during the render phase `virtuosoRef` still points at the outgoing (committed) instance, so this captures the task being left. The snapshot — which includes the **measured item `ranges`** as well as `scrollTop` — is stored in a `Map<number, StateSnapshot>` keyed by `taskTs`.

A guard (`snapshot.ranges.length > 0 || snapshot.scrollTop > 0`) prevents a transient empty/double-mount from clobbering a good snapshot with an all-zero one.

### Restore

On re-entry, `restoreSnapshot = virtuosoStateByTaskTsRef.current.get(taskTs)` is passed to the `restoreStateFrom` prop. react-virtuoso seeds its size cache from the snapshot's `ranges` **before first paint**, so the full content height is known immediately and the saved `scrollTop` resolves to the correct position with no clamping and no deferred `scrollTo`. The hook stays in `USER_BROWSING_HISTORY` (via `skipHydration`), so no scroll-to-bottom cycle fights the restore.

When no snapshot exists (a never-viewed task), `restoreStateFrom` is `undefined` and the list falls back to `initialTopMostItemIndex` (the last item) plus the hydration scroll-to-bottom cycle.

## Session Search Integration

The `<SessionSearch>` overlay (Ctrl+F) can navigate to a specific message. When the user jumps to a search result, `virtuosoRef.current.scrollToIndex({ index, align: "center" })` is called directly from `ChatView` — bypassing the scroll lifecycle phase transitions. This intentionally leaves the phase unchanged (the user is actively seeking a message, not passively browsing).

## Gaps & Areas for Improvement

The following issues were identified during an audit of this doc against the source implementation in [`useScrollLifecycle.ts`](../webview-ui/src/hooks/useScrollLifecycle.ts) and [`ChatView.tsx`](../webview-ui/src/components/chat/ChatView.tsx).

### Undocumented hook parameters

The [`UseScrollLifecycleOptions`](../webview-ui/src/hooks/useScrollLifecycle.ts:56) interface accepts four parameters not described above: `isStreaming`, `isHidden`, `hasTask`, and `taskTs` (mentioned only implicitly). Their behavioral effects are significant:

- `isStreaming` — gates the safety-net re-scroll in `atBottomStateChangeCallback` (line 403) and enables `shouldForcePinForAnchoredStreaming` in `handleRowHeightChange` (line 324), which triggers `scrollToBottomSmooth` even when `isAtBottomRef` is `false`.
- `isHidden` — when `true`, disables keyboard-nav-up disengagement (line 511), preventing `PageUp`/`Home`/`ArrowUp` from escaping sticky follow while the chat panel is not visible.
- `hasTask` — same guard on keyboard-nav-up disengagement (line 511).

### `handleRowHeightChange` force-pin logic

The doc states "Row grew taller → `scrollToBottomSmooth()`, Row shrank → `scrollToBottomAuto()`", but omits the critical additional condition: during `ANCHORED_FOLLOWING` with `isStreaming`, **both** variants are triggered regardless of `isAtBottomRef` (the `shouldForcePinForAnchoredStreaming` branch at [line 324](../webview-ui/src/hooks/useScrollLifecycle.ts:324)). This means streaming content growth always pulls the viewport down even if the user has drifted slightly from the absolute bottom.

### `followOutput` returns `"auto"` for all non-browsing phases

The doc's `ANCHORED_FOLLOWING` section says "Virtuoso's `followOutput` prop returns `"auto"`" but does not clarify that `followOutputCallback` returns `"auto"` for `HYDRATING_PINNED_TO_BOTTOM` as well — only `USER_BROWSING_HISTORY` returns `false` (line 360). The table in §"Components Involved" should reflect this.

### Ref types simplified

The Key Refs table lists bare types (`HTMLDivElement`, `boolean`, `ScrollPhase`) where the actual types are React ref wrappers (`React.RefObject<HTMLDivElement | null>`, `React.MutableRefObject<boolean>`, `React.MutableRefObject<ScrollPhase>`). The nullable nature of `virtuosoRef` and `scrollContainerRef` matters for callers that null-check before imperative commands.

### External dependencies not listed

The hook depends on three external packages not mentioned:

- [`react-virtuoso`](https://virtuoso.dev/) — `<Virtuoso>` component and `VirtuosoHandle` type
- [`react-use`](https://github.com/streamich/react-use) — `useEvent` hook for window-level event listeners (wheel, pointerdown, pointerup, scroll, keydown)
- [`debounce`](https://www.npmjs.com/package/debounce) — used via `useMemo` to create `scrollToBottomSmooth`

### Debug `console.log` instrumentation

The hook contains 10 `console.log` statements logging every phase transition, scroll command, and state change. These are intentional debug instrumentation but are not gated behind a debug flag. A future improvement would be to replace them with the IPC-forwarded logger or a `__DEV__` guard.

### Resolved: Render-phase ref synchronization (task-switch race)

Previously, when `taskTs` changed, `scrollPhaseRef`, `isAtBottomRef`, and `userDisengagedRef` would retain stale values from the previous task until the hydration `useEffect` fired **after paint**. The newly mounted `<Virtuoso key={task.ts}>` would fire `atBottomStateChangeCallback` during render, reading those stale refs and making wrong decisions (suppressing the scroll-to-bottom or entering the wrong phase). Fixed by synchronizing the refs during the **render phase** via `taskTs !== prevTaskTsRef.current`, before the Virtuoso mounts. See § "Render-phase ref synchronization" above.

### Resolved: `initialTopMostItemIndex` out-of-bounds on empty lists

The `initialTopMostItemIndex={groupedMessages.length}` prop passed an out-of-bounds index (one past the last item) when `groupedMessages` is non-empty, and index 0 when empty. react-virtuoso may ignore out-of-bounds `initialTopMostItemIndex` values, causing the list to render at the top instead of the bottom. Fixed by clamping to `groupedMessages.length - 1` when non-empty.

### Pointer-scroll tracking deserves a dedicated subsection

The pointer-scroll-up detection mechanism (lines 432–501) tracks `pointerdown` → set active element + last `scrollTop` → `scroll` compare → `pointerup`/`pointercancel` clear. The doc compresses this into a single table row; a dedicated subsection with the three-event lifecycle would improve clarity.

### Missing cleanup guards

The hook uses `isMountedRef` (line 91) to prevent state updates after unmount, and `cancelReanchorFrame` to cancel pending animation frames. Neither is mentioned in the doc.

### `ChatRow.onHeightChange` wiring

The doc does not explain how `ChatView` propagates row height changes to the hook. `ChatRow` receives `onHeightChange={handleRowHeightChange}` ([line 1732](../webview-ui/src/components/chat/ChatView.tsx:1732)); the implementation of `onHeightChange` inside `ChatRow` (likely a `ResizeObserver`) is undocumented.
