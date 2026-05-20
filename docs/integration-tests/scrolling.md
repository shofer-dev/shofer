# Integration Tests: Chat Scroll Lifecycle

> Feature doc: [`docs/scrolling.md`](../docs/scrolling.md)
> User manual: [`docs/user-manual/scrolling.md`](../docs/user-manual/scrolling.md)
> Implementation: [`useScrollLifecycle.ts`](../webview-ui/src/hooks/useScrollLifecycle.ts),
> [`ChatView.tsx`](../webview-ui/src/components/chat/ChatView.tsx)

## Scenarios

### 1. New task auto-scrolls to bottom (hydration)

**Given** the user switches to a task that has messages
**When** the `taskTs` prop changes
**Then** `scrollPhase` transitions to `HYDRATING_PINNED_TO_BOTTOM`
**And** `scrollToBottomAuto()` is called after two animation frames
**And** after 600 ms (`HYDRATION_WINDOW_MS`), if `isAtBottom` is `true`, phase transitions to `ANCHORED_FOLLOWING`
**And** `showScrollToBottom` is `false` throughout hydration

**Verification**: Render `ChatView` with a task, assert `scrollPhase === "ANCHORED_FOLLOWING"` within 1 second. Assert the scroll-to-bottom button is not rendered.

### 2. Hydration retry on initial not-at-bottom

**Given** a task with enough messages that Virtuoso reports not-at-bottom after the initial `scrollToBottomAuto`
**When** the 600 ms hydration window expires
**Then** `scrollToBottomAuto()` is called again, up to `MAX_HYDRATION_RETRIES` (3) times at `HYDRATION_RETRY_WINDOW_MS` (160 ms) intervals
**And** if retries are exhausted, phase still transitions to `ANCHORED_FOLLOWING` (not `USER_BROWSING_HISTORY`)
**And** the scroll-to-bottom button remains hidden

**Verification**: Mock `isAtBottomRef.current = false` through all retries. Assert final phase is `ANCHORED_FOLLOWING` and button is hidden.

### 3. User scrolls up → browse mode + button

**Given** phase is `ANCHORED_FOLLOWING`
**When** the user scrolls up (wheel `deltaY < 0` inside `scrollContainerRef`)
**Then** `enterUserBrowsingHistory("wheel-up")` is called
**And** phase transitions to `USER_BROWSING_HISTORY`
**And** `followOutput` returns `false`
**And** `showScrollToBottom` becomes `true`
**And** the `codicon-chevron-down` button renders

**Verification**: Fire a `wheel` event with `deltaY = -100` inside the scroll container. Assert phase, `followOutput`, and button visibility.

### 4. User scrolls up via pointer drag

**Given** phase is `ANCHORED_FOLLOWING`
**When** the user pointer-downs on a scrollable element inside `scrollContainerRef`, then scrolls up (`scrollTop` decreases while pointer is still down)
**Then** `enterUserBrowsingHistory("pointer-scroll-up")` is called

**Verification**: Dispatch `pointerdown` on a `.scrollable` div inside the container. Dispatch `scroll` on the same div with a decreased `scrollTop`. Assert phase transition.

### 5. User scrolls up via keyboard (PageUp / Home / ArrowUp)

**Given** phase is `ANCHORED_FOLLOWING`, `isHidden` is `false`, `hasTask` is `true`
**When** the user presses `PageUp`, `Home`, or `ArrowUp`
**And** the event target is inside `scrollContainerRef` and not an editable element
**Then** `enterUserBrowsingHistory("keyboard-nav-up")` is called

**Verification**: Simulate `keydown` with `key: "ArrowUp"` on a non-editable element inside the scroll container. Assert phase transition.

### 6. Row expansion → browse mode

**Given** phase is `ANCHORED_FOLLOWING`, a collapsed row exists
**When** the user expands a row (toggles it in `expandedRows` state)
**Then** `enterUserBrowsingHistory("row-expansion")` is called

**Verification**: Render `ChatView` with a collapsible message. Toggle `expandedRows` state from collapsed to expanded. Assert phase transition.

### 7. Disengage immune window suppresses snap-back

**Given** the user just entered `USER_BROWSING_HISTORY` (e.g., scrolled up)
**When** `atBottomStateChange(true)` fires within 500 ms of the disengage
**Then** the phase stays `USER_BROWSING_HISTORY` (does NOT transition back to `ANCHORED_FOLLOWING`)
**And** the scroll-to-bottom button stays visible

**Verification**: Enter browse mode, immediately call `atBottomStateChangeCallback(true)`. Assert phase remains `USER_BROWSING_HISTORY`.

### 8. Clicking scroll-to-bottom button re-engages follow

**Given** phase is `USER_BROWSING_HISTORY`
**When** the user clicks the ↓ button
**Then** `handleScrollToBottomClick()` is called
**And** phase transitions to `ANCHORED_FOLLOWING`
**And** `scrollToBottomAuto()` is called immediately
**And** a second `scrollToBottomAuto()` fires on the next animation frame
**And** `followOutput` returns `"auto"`
**And** the button hides

**Verification**: Click the button. Assert phase is `ANCHORED_FOLLOWING`, button is hidden, `followOutput` returns `"auto"`.

### 9. Keyguard: keyboard nav suppressed when chat hidden

**Given** phase is `ANCHORED_FOLLOWING`, `isHidden` is `true`
**When** the user presses `ArrowUp` inside the scroll container
**Then** phase remains `ANCHORED_FOLLOWING` (no transition)

**Verification**: Set `isHidden = true`, dispatch `ArrowUp` keydown inside container. Assert phase unchanged.

### 10. Keyguard: keyboard nav suppressed in editable targets

**Given** phase is `ANCHORED_FOLLOWING`
**When** the user presses `ArrowUp` while focus is inside an `<input>`, `<textarea>`, `<select>`, or `contentEditable` element
**Then** phase remains `ANCHORED_FOLLOWING`

**Verification**: Focus an `<input>`, dispatch `ArrowUp` keydown. Assert phase unchanged.

### 11. Streaming safety net: not-at-bottom blip → scrollToBottomAuto

**Given** phase is `ANCHORED_FOLLOWING`, `isStreaming` is `true`
**When** `atBottomStateChange(false)` fires (a transient blip from rapid content growth)
**Then** `scrollToBottomAuto()` is called
**And** the button stays hidden
**And** phase remains `ANCHORED_FOLLOWING`

**Verification**: Set `isStreaming = true`, call `atBottomStateChangeCallback(false)`. Assert `scrollToBottomAuto` was invoked, phase unchanged, button hidden.

### 12. `handleRowHeightChange` force-pin during streaming

**Given** phase is `ANCHORED_FOLLOWING`, `isStreaming` is `true`
**When** a row reports it grew taller via `handleRowHeightChange(true)`
**Then** `scrollToBottomSmooth()` is called **even if** `isAtBottomRef.current` is `false`
**And** when a row reports it shrank via `handleRowHeightChange(false)`, `scrollToBottomAuto()` is called regardless of `isAtBottomRef`

**Verification**: Set `isAtBottomRef.current = false`, `isStreaming = true`. Call `handleRowHeightChange(true)`. Assert `scrollToBottomSmooth` was invoked. Call `handleRowHeightChange(false)`. Assert `scrollToBottomAuto` was invoked.

### 13. Row height changes ignored outside ANCHORED_FOLLOWING

**Given** phase is `USER_BROWSING_HISTORY` or `HYDRATING_PINNED_TO_BOTTOM`
**When** a row reports a height change
**Then** no scroll command is issued

**Verification**: Set phase to `USER_BROWSING_HISTORY`, call `handleRowHeightChange(true)`. Assert neither `scrollToBottomSmooth` nor `scrollToBottomAuto` was called.

### 14. Session search scrolls without changing phase

**Given** the SessionSearch overlay is open with results, phase is `ANCHORED_FOLLOWING`
**When** the user navigates to a match
**Then** `virtuosoRef.current.scrollToIndex({ index, align: "center" })` is called directly from `ChatView`
**And** phase remains `ANCHORED_FOLLOWING`

**Verification**: Open SessionSearch, click a match. Assert the Virtuoso imperative scroll was called with `align: "center"`. Assert phase unchanged.

### 15. ScrollToBottomSmooth debounced at 10 ms leading-edge

**Given** `scrollToBottomSmooth` is the debounced function
**When** it is called multiple times rapidly
**Then** it fires once at the leading edge and at most once more after the 10 ms window

**Verification**: Call `scrollToBottomSmooth()` 5 times in rapid succession within 5 ms. Assert `scrollToIndex` was invoked only once. After 15 ms, assert no additional invocation (cleanup via `.clear()`).
