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

## Session Search Integration

The `<SessionSearch>` overlay (Ctrl+F) can navigate to a specific message. When the user jumps to a search result, `virtuosoRef.current.scrollToIndex({ index, align: "center" })` is called directly from `ChatView` — bypassing the scroll lifecycle hook. This intentionally leaves the phase unchanged (the user is actively seeking a message, not passively browsing).
