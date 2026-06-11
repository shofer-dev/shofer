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

> **Immune window**: when any input signal triggers `enterUserBrowsingHistory`, a 500 ms timer is started (`userDisengagedRef`). Any `atBottomStateChange(true)` signal that arrives while the timer is active — typically from an in-flight `scrollToBottomAuto()` issued just before the user scrolled up — is ignored and does not snap the user back to `ANCHORED_FOLLOWING`. This prevents the flickering loop that would otherwise occur during heavy streaming.

When a message row grows taller (e.g. streaming text arriving, a tool result expanding), `handleRowHeightChange(isTaller)` triggers an additional imperative `scrollToBottomAuto()`:

- **During streaming**: a force-pin path triggers `scrollToBottomAuto()` even when `isAtBottomRef` is `false` (gated by `!userIntentScrollUpRef.current`), so streaming content growth always pulls the viewport down.
- **Non-streaming**: only scrolls when `isAtBottomRef.current` is `true`.

Both variants use `behavior: "auto"` (instant follow, no compositor animation).

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

`atBottomStateChangeCallback` fires whenever Virtuoso's bottom-detection crosses the 16 px threshold ([`atBottomThreshold={16}`](../webview-ui/src/components/chat/ChatView.tsx:2094)). When `isAtBottom` becomes `true`, the hook calls `enterAnchoredFollowing()` — except when in `USER_BROWSING_HISTORY` during the hydration window or the disengage immune window, where the signal is suppressed (see the immune window description above).

When `isAtBottom` becomes `false` while already in `ANCHORED_FOLLOWING` during streaming (a transient not-at-bottom blip from rapid content growth), the hook calls `scrollToBottomAuto()` and keeps the button hidden — a safety net that prevents Virtuoso from momentarily dropping the follow anchor.

## Scroll Commands

There is a single scroll command. Row-height changes and all follow re-engagements use `behavior: "auto"` (instant) — no compositor animation, no debounce, no "smooth" path.

| Function               | Virtuoso call                                                      | Used when                                                                              |
| ---------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `scrollToBottomAuto()` | `scrollToIndex({ index: "LAST", align: "end", behavior: "auto" })` | Task switch, hydration retries, button click, row-height changes, safety-net re-scroll |

## Key Refs

| Ref                  | Type                                      | Purpose                                                                                                                                                         |
| -------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `virtuosoRef`        | `React.RefObject<VirtuosoHandle \| null>` | Imperative scroll commands                                                                                                                                      |
| `scrollContainerRef` | `React.RefObject<HTMLDivElement \| null>` | Scopes scroll/wheel/pointer event listeners to the chat column                                                                                                  |
| `isAtBottomRef`      | `React.MutableRefObject<boolean>`         | Live bottom-detection flag; updated synchronously by `atBottomStateChangeCallback`                                                                              |
| `scrollPhaseRef`     | `React.MutableRefObject<ScrollPhase>`     | Mirror of phase state for use inside event handlers (avoids stale closure captures)                                                                             |
| `isHydratingRef`     | `React.MutableRefObject<boolean>`         | Guards hydration-time bottom signals from being misinterpreted as user browse intent                                                                            |
| `userDisengagedRef`  | `React.MutableRefObject<boolean>`         | Immune-window flag: set for 500 ms whenever `enterUserBrowsingHistory` is called; prevents in-flight programmatic scrolls from re-engaging `ANCHORED_FOLLOWING` |

## Debug Logging

All scroll lifecycle instrumentation posts to the Shofer Output Channel via `vscode.postMessage({ type: "webviewLog", … })` rather than `console.log`. These calls are gated behind [`SCROLL_DEBUG`](../webview-ui/src/hooks/useScrollLifecycle.ts:34) (module-level `const`, default `false`). Set to `true` during scroll development to enable per-event logging of phase transitions, scroll commands, safety-net re-scrolls, hydration retries, and disengage events.

## Current Status

A root-cause analysis identified six contributing causes (A–F) behind the four competing "pin to bottom" mechanisms that were fighting each other during streaming.

| Cause | Summary                                                                | Status    |
| ----- | ---------------------------------------------------------------------- | --------- |
| A     | `behavior: "smooth"` restarted the compositor animation every ~10 ms   | **Fixed** |
| B     | `atBottomThreshold={1}` fired a per-frame not-at-bottom scroll storm   | **Fixed** |
| F     | ~a dozen ungated `webviewLog` IPC posts per scroll flooded the bridge  | **Fixed** |
| C     | Non-streaming disengage treats any not-at-bottom as user scroll-up     | Open      |
| D     | Only the literal last row reports height; mid-list growth is invisible | Open      |
| E     | Per-task snapshot capture runs during the render phase (StrictMode)    | Open      |

The three fixes (Causes A, B, F) are implemented in the working tree across [`useScrollLifecycle.ts`](../webview-ui/src/hooks/useScrollLifecycle.ts) and [`ChatView.tsx`](../webview-ui/src/components/chat/ChatView.tsx). They are detailed below. Causes C, D, and E remain open and are described in § "Open Issues (Causes C, D, E)".

## Fixes Applied

### Fix 1 — Removed `behavior: "smooth"` (Cause A)

**Problem:** [`scrollToBottomSmooth` was a debounced `scrollToIndex({ behavior: "smooth" })` that issued a fresh compositor animation ~every 10 ms during streaming, interrupting and restarting the previous animation so the viewport never landed. `enterUserBrowsingHistory` even had to force a `scrollTop = scrollTop` reflow specifically to tear down that animation.

**Applied:** Deleted `scrollToBottomSmooth` and the `debounce` / `useMemo` imports entirely. All callers now use `scrollToBottomAuto()` (`behavior: "auto"`). Row-height changes no longer branch on `isTaller` — both growth and shrinkage use the same `scrollToBottomAuto()`.

Files changed:

- [`useScrollLifecycle.ts`](../webview-ui/src/hooks/useScrollLifecycle.ts) — removed `debounce` import (line 22), removed `useMemo` import (line 20), removed `scrollToBottomSmooth` definition (was lines 215–244), removed `scrollToBottomSmooth.clear()` call from `enterUserBrowsingHistory` (was line 291), removed `scrollTop = scrollTop` reflow hack (was line 300), removed `scrollToBottomSmooth.clear()` from mount cleanup (was line 413), removed `scrollToBottomSmooth` from `enterUserBrowsingHistory` deps (was line 327), removed `scrollToBottomSmooth` from `handleRowHeightChange` deps (was line 490), collapsed `handleRowHeightChange` `isTaller`/`!isTaller` branches to single `scrollToBottomAuto()` call ([line 447](../webview-ui/src/hooks/useScrollLifecycle.ts:447)).

### Fix 2 — Raised `atBottomThreshold` from 1 to 16 (Cause B)

**Problem:** [`atBottomThreshold={1}` caused Virtuoso to report not-at-bottom the instant content exceeded scroll position by more than 1 px, triggering the safety-net re-scroll almost continuously during streaming.

**Applied:** Raised to [`atBottomThreshold={16}`](../webview-ui/src/components/chat/ChatView.tsx:2094). With 16 px of slack, Virtuoso no longer fires `atBottomStateChange(false)` on every frame of streaming growth, eliminating the scroll storm that compounded Cause A.

File changed:

- [`ChatView.tsx`](../webview-ui/src/components/chat/ChatView.tsx) — line 2094.

### Fix 5 — Gated scroll logging behind `SCROLL_DEBUG` (Cause F)

**Problem:** ~a dozen `webviewLog` IPC posts fired on every scroll command, phase transition, and safety-net re-scroll — many messages per second across the webview↔host bridge during streaming.

**Applied:** Added module-level [`SCROLL_DEBUG = false`](../webview-ui/src/hooks/useScrollLifecycle.ts:34) constant. All `vscode.postMessage({ type: "webviewLog", … })` calls are now guarded by `if (SCROLL_DEBUG)`. Setting to `true` during scroll development restores the full log stream.

File changed:

- [`useScrollLifecycle.ts`](../webview-ui/src/hooks/useScrollLifecycle.ts) — line 34, plus guards at: task-switch block (line 181), `transitionScrollPhase` (line 203), `scrollToBottomAuto` (line 221), `enterUserBrowsingHistory` (line 253), `finishHydrationWindow` retry (line 312), `finishHydrationWindow` exhausted (line 326), `startHydrationWindow` (line 340), `handleRowHeightChange` force-pin (line 439), `atBottomStateChangeCallback` safety-net (line 509).

## Open Issues (Causes C, D, E)

These are genuine scroll-behavior issues identified by the root-cause analysis that are **not yet fixed**. Each is a residual source of the churn that the applied fixes (A, B, F) did not address.

### Cause C — Non-streaming disengage false positives

In `ANCHORED_FOLLOWING` while **not** streaming, `atBottomStateChangeCallback` ([line 526](../webview-ui/src/hooks/useScrollLifecycle.ts:526)) treats **any** `isAtBottom === false` as a user scroll-up and transitions to `USER_BROWSING_HISTORY`. Non-user causes (collapsing row, late-loading image, [`FileChangesPanel`](../webview-ui/src/components/chat/ChatView.tsx:2136) resizing) spuriously eject the user from follow and flash the scroll-to-bottom button. **Proposed fix:** require a corroborating signal (the wheel/pointer/keyboard `userIntentScrollUpRef` already being set) or a measured `scrollTop` delta before disengaging, rather than trusting the bare not-at-bottom flag.

### Cause D — Mid-list height growth is invisible to the hook

`ChatRow` receives `onHeightChange={handleRowHeightChange}` from `ChatView` ([`ChatView.tsx` line 1811](../webview-ui/src/components/chat/ChatView.tsx:1811)). The implementation inside `ChatRow` uses `useSize` from `react-use`, which wraps the row in an extra measuring `<div>` and reports `height`; an effect fires `onHeightChange(height > prevHeightRef.current)` **only when the row `isLast`** ([`ChatRow.tsx` lines 215–227](../webview-ui/src/components/chat/ChatRow.tsx:215), `isLast` guard at line 221). A row growing in the middle of the list (a tool result expanding above the last message) therefore never notifies the hook, so the viewport is not pulled down. **Proposed fix:** report height changes for any row near the bottom of the list, not just the literal last one, or rely on Virtuoso's own `followOutput` measurement instead of the per-row callback.

### Cause E — Per-task snapshot capture runs during the render phase

`ChatView` calls `virtuosoRef.current?.getState(...)` and writes to `virtuosoStateByTaskTsRef` during the React **render phase** at [lines 204–220](../webview-ui/src/components/chat/ChatView.tsx:204). Under React StrictMode (double-invoked render) these run twice; the `ranges.length > 0` guard at [line 214](../webview-ui/src/components/chat/ChatView.tsx:214) is a mitigation, not a fix. **Proposed fix:** move the snapshot capture into `useLayoutEffect` so it is a committed side effect, not a render-phase one.

## Doc-vs-Source Discrepancies (Lower Priority)

The following are documentation-accuracy gaps found while auditing this doc against [`useScrollLifecycle.ts`](../webview-ui/src/hooks/useScrollLifecycle.ts) and [`ChatView.tsx`](../webview-ui/src/components/chat/ChatView.tsx). They do not cause scroll bugs but should be corrected for the doc to stay trustworthy.

### Undocumented hook parameters

The [`UseScrollLifecycleOptions`](../webview-ui/src/hooks/useScrollLifecycle.ts:63) interface accepts four parameters not described above: `isStreaming`, `isHidden`, `hasTask`, and `taskTs` (mentioned only implicitly). Their behavioral effects are significant:

- `isStreaming` — gates the safety-net re-scroll in `atBottomStateChangeCallback` ([line 508](../webview-ui/src/hooks/useScrollLifecycle.ts:508)) and enables the `shouldForcePinForAnchoredStreaming` path in `handleRowHeightChange` ([line 436](../webview-ui/src/hooks/useScrollLifecycle.ts:436)).
- `isHidden` — when `true`, disables keyboard-nav-up disengagement ([line 650](../webview-ui/src/hooks/useScrollLifecycle.ts:650)), preventing `PageUp`/`Home`/`ArrowUp` from escaping sticky follow while the chat panel is not visible.
- `hasTask` — same guard on keyboard-nav-up disengagement ([line 650](../webview-ui/src/hooks/useScrollLifecycle.ts:650)).

### `followOutput` returns `"auto"` for all non-browsing phases

The doc's `ANCHORED_FOLLOWING` section says "Virtuoso's `followOutput` prop returns `"auto"`" but does not clarify that `followOutputCallback` returns `"auto"` for `HYDRATING_PINNED_TO_BOTTOM` as well — only `USER_BROWSING_HISTORY` returns `false` ([line 473](../webview-ui/src/hooks/useScrollLifecycle.ts:473)).

### External dependencies not listed

The hook depends on three external packages not mentioned:

- [`react-virtuoso`](https://virtuoso.dev/) — `<Virtuoso>` component and `VirtuosoHandle` type
- [`react-use`](https://github.com/streamich/react-use) — `useEvent` hook for window-level event listeners (wheel, pointerdown, pointerup, scroll, keydown)
- ~~[`debounce`](https://www.npmjs.com/package/debounce)~~ — removed in Fix 1

### Resolved: Render-phase ref synchronization (task-switch race)

Previously, when `taskTs` changed, `scrollPhaseRef`, `isAtBottomRef`, and `userDisengagedRef` would retain stale values from the previous task until the hydration `useEffect` fired **after paint**. The newly mounted `<Virtuoso key={task.ts}>` would fire `atBottomStateChangeCallback` during render, reading those stale refs and making wrong decisions (suppressing the scroll-to-bottom or entering the wrong phase). Fixed by synchronizing the refs during the **render phase** via `taskTs !== prevTaskTsRef.current`, before the Virtuoso mounts. See § "Render-phase ref synchronization" above.

### Resolved: `initialTopMostItemIndex` out-of-bounds on empty lists

The `initialTopMostItemIndex={groupedMessages.length}` prop passed an out-of-bounds index (one past the last item) when `groupedMessages` is non-empty, and index 0 when empty. react-virtuoso may ignore out-of-bounds `initialTopMostItemIndex` values, causing the list to render at the top instead of the bottom. Fixed by clamping to `groupedMessages.length - 1` when non-empty.

### Pointer-scroll tracking deserves a dedicated subsection

The pointer-scroll-up detection mechanism ([lines 568–640](../webview-ui/src/hooks/useScrollLifecycle.ts:568)) tracks `pointerdown` → set active element + last `scrollTop` → `scroll` compare → `pointerup`/`pointercancel` clear. The doc compresses this into a single table row; a dedicated subsection with the three-event lifecycle would improve clarity.

### Missing cleanup guards

The hook uses `isMountedRef` ([line 105](../webview-ui/src/hooks/useScrollLifecycle.ts:105)) to prevent state updates after unmount, and `cancelReanchorFrame` to cancel pending animation frames. Neither is mentioned in the doc.
