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

> **Immune window**: when any input signal triggers `enterUserBrowsingHistory`, a 500 ms timer is started (`userDisengagedRef`). Any `atBottomStateChange(true)` signal that arrives while the timer is active — typically from an in-flight `scrollToBottomAuto()` issued just before the user scrolled up — is ignored and does not snap the user back to `ANCHORED_FOLLOWING`. This prevents the flickering loop that would otherwise occur during heavy streaming. When the timer expires, the hook re-checks `isAtBottomRef`: if the user is still at the bottom in `USER_BROWSING_HISTORY` (e.g. they scrolled up and back down within the 500 ms window, so the in-window `atBottomStateChange(true)` was suppressed), it re-engages `ANCHORED_FOLLOWING` then — otherwise the user would be stranded in browse mode while sitting at the bottom with the button showing.

When a message row grows taller (e.g. streaming text arriving, a tool result expanding), `handleRowHeightChange(isTaller)` triggers an additional imperative `scrollToBottomAuto()`:

- **During streaming**: a force-pin path triggers `scrollToBottomAuto()` even when `isAtBottomRef` is `false` (gated by `!userIntentScrollUpRef.current`), so streaming content growth always pulls the viewport down.
- **Non-streaming**: only scrolls when `isAtBottomRef.current` is `true`.

Both variants use `behavior: "auto"` (instant follow, no compositor animation).

Since Cause D was fixed, **every** row — not just the literal last one — reports its height change to `handleRowHeightChange` (see [`ChatRow.tsx`](../webview-ui/src/components/chat/ChatRow.tsx)); the hook still decides whether to scroll, so a tool result expanding or an image loading mid-list now pulls the viewport down while anchored.

The scroll-to-bottom button is **shown whenever the list is not at the bottom** (see § "Scroll-to-bottom button visibility"), except during the streaming safety-net, where it stays hidden because an auto-rescroll is imminent.

### `USER_BROWSING_HISTORY`

Sticky follow is disabled. Virtuoso's `followOutput` returns `false`. The scroll-to-bottom button is **always shown** in this phase.

### Scroll-to-bottom button visibility

The button is **not** a per-phase boolean — its visibility is recomputed on every `atBottomStateChange` and on every phase transition (`enterUserBrowsingHistory` → show, `enterAnchoredFollowing` and task-switch → hide). The unified rule, computed at the top of [`atBottomStateChangeCallback`](../webview-ui/src/hooks/useScrollLifecycle.ts):

```
streamingSafetyNet = ANCHORED_FOLLOWING && isStreaming && !userIntentScrollUpRef
shouldShow = (phase === USER_BROWSING_HISTORY)
               ? true                                  // always show while browsing
               : !isAtBottom && !isHydrating && !streamingSafetyNet
```

In words: show the button whenever the user is **not at the bottom**, with two suppressions — during the hydration window (`isHydratingRef`), and during the streaming safety-net (a not-at-bottom blip in `ANCHORED_FOLLOWING` that is about to be corrected by an auto-rescroll). This model replaced an earlier "button shown only in `USER_BROWSING_HISTORY`" design, so the button is now visible whenever it is actionable — including a non-streaming `ANCHORED_FOLLOWING` row that drifts off the bottom.

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

When `isAtBottom` becomes `false` while in `ANCHORED_FOLLOWING` and **not** streaming, the hook only disengages to `USER_BROWSING_HISTORY` if `userIntentScrollUpRef` is already set by a real input gesture (Cause C fix). A bare not-at-bottom with no corroborating gesture — a row collapsing, a late image loading, the `FileChangesPanel` resizing — leaves the user in `ANCHORED_FOLLOWING` instead of spuriously ejecting them.

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

| Cause | Summary                                                                | Status                |
| ----- | ---------------------------------------------------------------------- | --------------------- |
| A     | `behavior: "smooth"` restarted the compositor animation every ~10 ms   | **Fixed**             |
| B     | `atBottomThreshold={1}` fired a per-frame not-at-bottom scroll storm   | **Fixed**             |
| C     | Non-streaming disengage treats any not-at-bottom as user scroll-up     | **Fixed**             |
| D     | Only the literal last row reports height; mid-list growth is invisible | **Fixed**             |
| E     | Per-task snapshot capture runs during the render phase                 | **Not a bug** (below) |
| F     | ~a dozen ungated `webviewLog` IPC posts per scroll flooded the bridge  | **Fixed**             |

In addition, a latent immune-window stuck-state was fixed (scrolling up then back to the bottom within the 500 ms window could strand the user in browse mode — see the immune-window note under `ANCHORED_FOLLOWING`).

Causes A, B, F are detailed below. Causes C and D are described in § "Resolved: Causes C and D", and the reclassification of Cause E in § "Cause E — render-phase capture is correct, not a bug".

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

## Resolved: Causes C and D

### Cause C — Non-streaming disengage false positives (Fixed)

In `ANCHORED_FOLLOWING` while **not** streaming, `atBottomStateChangeCallback` used to treat **any** `isAtBottom === false` as a user scroll-up and transition to `USER_BROWSING_HISTORY`. Non-user causes (collapsing row, late-loading image, [`FileChangesPanel`](../webview-ui/src/components/chat/ChatView.tsx) resizing) spuriously ejected the user from follow and flashed the scroll-to-bottom button.

**Fix:** the non-streaming disengage branch now also requires `userIntentScrollUpRef.current` to be set. Genuine scroll-up gestures (`wheel-up`, `keyboard-nav-up`, `pointer-scroll-up`) set that flag and disengage via their own handlers, so the at-bottom callback only acts on a corroborated gesture and ignores bare layout-driven not-at-bottom blips.

### Cause D — Mid-list height growth is invisible to the hook (Fixed)

`ChatRow` reports its measured `height` (via `useSize` from `react-use`) to `handleRowHeightChange`. The effect previously fired `onHeightChange(...)` **only when the row was `isLast`**, so a row growing in the middle of the list (a tool result expanding or an image loading above the last message) never notified the hook and the viewport was not pulled down.

**Fix:** the `isLast` guard was removed — every row now reports its height changes. The scroll decision stays in the hook (`handleRowHeightChange`), which only pins when at-bottom or streaming and is a no-op while the user is browsing history, so reporting from every row is safe. This is complementary to the `"row-expansion"` disengage: a **user** expanding a row first transitions to `USER_BROWSING_HISTORY` (so they keep reading the expansion), and the subsequent height notification is a no-op; only **non-user** growth (streaming, image loads) reaches the pull-down path.

## Cause E — render-phase capture is correct, not a bug

An earlier revision of this doc flagged the per-task snapshot capture as a bug and proposed moving it into `useLayoutEffect`. **That proposal is wrong and would break scroll restoration.**

`ChatView` calls `virtuosoRef.current?.getState(...)` and writes to `virtuosoStateByTaskTsRef` during the React render phase, gated by `taskTs !== prevHydratableTaskTsRef.current`. Because `<Virtuoso key={task.ts}>` is **keyed by the task**, it unmounts and remounts on every task switch. `virtuosoRef` therefore points at the **outgoing** instance only during the render phase — by the time any post-commit effect (`useLayoutEffect`/`useEffect`) runs, the ref has already been reassigned to the **incoming** task's instance. Capturing from an effect would snapshot the wrong task. The render-phase capture is correct _by necessity_ for this keyed-remount design.

The StrictMode concern (render runs twice in dev) is already neutralized by the `prevHydratableTaskTsRef` gate: the second invoke sees `taskTs === prevHydratableTaskTsRef.current` and skips the block, so the capture is idempotent. `virtuosoRef` still points at the outgoing instance in both invokes, and StrictMode double-invoke does not occur in production at all. The `snapshot.ranges.length > 0 || snapshot.scrollTop > 0` guard additionally prevents storing an empty snapshot from a transient double-mount.

The only genuinely cleaner alternative would be to capture the current task's state through a committed side-effect path (e.g. Virtuoso's `isScrolling` stop callback, keyed by the _current_ `taskTs`) and drop the render-phase `getState` — but that trades the render-phase impurity for a small correctness gap (a never-scrolled overflowing task could miss its final position) and was judged not worth the regression risk on a subsystem this sensitive.

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
