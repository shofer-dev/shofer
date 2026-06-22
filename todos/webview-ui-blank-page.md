# Webview-UI Blank Page After Extension Host Freeze

## Symptom

When the extension host event loop blocks (freezes, not crashes), the webview-ui becomes a blank page and **never recovers** after the host thaws. The IPC channel remains alive, state is preserved on the host side, but the React tree renders nothing.

## Observed Behavior (from real incident log)

```
log.ts:117  INFO Extension host (LocalProcess pid: 641569) is unresponsive.
log.ts:117  INFO Extension host (LocalProcess pid: 641569) is responsive.

index.js:467 [messageUpdated] Received update for unknown message ts=1780216624537, dropping. Frontend has 638 messages.
  ... (80 identical lines — one per queued message) ...

index.js:467 [ExtensionStateContext] received 'skills' message. loadedSkills: {}
```

## Architecture Context

### Host-Webview Connection Lifecycle

```
VS Code activates extension
  → creates ShoferProvider
  → registerWebviewViewProvider("shofer-code.SidebarProvider", provider, { retainContextWhenHidden: true })
  → calls resolveWebviewView(webviewView)
    → sets webview.options
    → builds HTML (HMR dev or production bundle)
    → assigns webviewView.webview.html = html
    → wires webview.onDidReceiveMessage → webviewMessageHandler
    → waits for webviewDidLaunch message

Webview loads HTML
  → index.tsx executes:
    → installWebviewCrashGuard() — crash error listener + heartbeat pong responder
    → React mounts App + ExtensionStateContext
    → App sends "webviewDidLaunch" via vscode.postMessage()

Host receives "webviewDidLaunch"
  → starts ping/pong heartbeat (gated behind WEBVIEW_LIVENESS_MONITOR experiment — OFF by default)
  → pushes full state via postStateToWebview()
  → webview receives { type: "state" }
  → ExtensionStateContext sets didHydrateState = true
  → App renders
```

### Key Files

| File                                                                                                                                               | Role                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [`extensions/shofer/src/extension.ts:264`](extensions/shofer/src/extension.ts:264)                                                                 | Registers ShoferProvider with `retainContextWhenHidden: true`                                        |
| [`extensions/shofer/src/core/webview/ShoferProvider.ts:1230`](extensions/shofer/src/core/webview/ShoferProvider.ts:1230)                           | `resolveWebviewView` — host-side webview lifecycle                                                   |
| [`extensions/shofer/src/core/webview/ShoferProvider.ts:2020`](extensions/shofer/src/core/webview/ShoferProvider.ts:2020)                           | `getHtmlContent` — production HTML generation                                                        |
| [`extensions/shofer/src/core/webview/ShoferProvider.ts:2848`](extensions/shofer/src/core/webview/ShoferProvider.ts:2848)                           | `postStateToWebview` — pushes full state to webview                                                  |
| [`extensions/shofer/src/core/webview/ShoferProvider.ts:1783`](extensions/shofer/src/core/webview/ShoferProvider.ts:1783)                           | `postMessageToWebview` — wraps `view?.webview.postMessage()`                                         |
| [`extensions/shofer/webview-ui/src/index.tsx:22`](extensions/shofer/webview-ui/src/index.tsx:22)                                                   | `installWebviewCrashGuard()` — crash listeners + ping responder                                      |
| [`extensions/shofer/webview-ui/src/utils/vscode.ts:14`](extensions/shofer/webview-ui/src/utils/vscode.ts:14)                                       | `acquireVsCodeApi()` singleton wrapper                                                               |
| [`extensions/shofer/webview-ui/src/App.tsx:198`](extensions/shofer/webview-ui/src/App.tsx:198)                                                     | Sends `webviewDidLaunch` on mount                                                                    |
| [`extensions/shofer/webview-ui/src/App.tsx:230`](extensions/shofer/webview-ui/src/App.tsx:230)                                                     | Returns `null` if `!didHydrateState` — renders nothing                                               |
| [`extensions/shofer/webview-ui/src/context/ExtensionStateContext.tsx:358`](extensions/shofer/webview-ui/src/context/ExtensionStateContext.tsx:358) | `handleMessage` — receives host messages                                                             |
| [`extensions/shofer/webview-ui/src/context/ExtensionStateContext.tsx:375`](extensions/shofer/webview-ui/src/context/ExtensionStateContext.tsx:375) | Sets `didHydrateState = true` on `state` message                                                     |
| [`extensions/shofer/src/core/webview/webviewMessageHandler.ts:644`](extensions/shofer/src/core/webview/webviewMessageHandler.ts:644)               | Handles `webviewDidLaunch` → calls `provider._onWebviewLaunched()` + `provider.postStateToWebview()` |

### Crash Detection Infrastructure

| Component                                                             | Status                                     |
| --------------------------------------------------------------------- | ------------------------------------------ |
| `installWebviewCrashGuard()` — posts `fatal_error` on uncaught errors | ✅ Always active                           |
| `ErrorBoundary` — posts `fatal_error` on React render crashes         | ✅ Always active                           |
| Ping/pong heartbeat — host pings every 5s, expects pong within 30s    | ❌ Gated behind `WEBVIEW_LIVENESS_MONITOR` |
| `_onFatalError` auto-reset — resets webview on `fatal_error`          | ❌ Gated behind `WEBVIEW_LIVENESS_MONITOR` |
| `refreshWebview` command — manual "Reload Webviews"                   | ❌ Gated behind `WEBVIEW_LIVENESS_MONITOR` |

## Evidence from Real Incident

### Critical Facts

| Fact                                      | Evidence                                                                                                                                                   |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Host froze, not crashed**               | Same PID (641569), event loop blocked then recovered. "unresponsive" → "responsive" in VS Code logs.                                                       |
| **IPC channel survived**                  | `[ExtensionStateContext] received 'skills' message` arrived AFTER the host became responsive. The channel was not torn down.                               |
| **Heartbeat disabled**                    | `WEBVIEW_LIVENESS_MONITOR` experiment is off — no ping/pong, no auto-reset.                                                                                |
| **Thaw-dump of queued messages**          | 80+ `[messageUpdated] Received update for unknown message ts=...` lines — the host blasts every queued `postMessage` at once when the event loop unblocks. |
| **Webview processes messages after thaw** | The `skills` message was received and logged — React's message handler is still running.                                                                   |

### The Thaw-Dump Mechanism

When the host event loop is blocked:

1. All `postMessageToWebview()` calls queue in the VS Code IPC layer
2. When the host thaws, ALL queued messages are delivered to the webview at once

This burst can include:

- `messageUpdated` for streaming updates that happened during the freeze
- `shoferMessageAppended` for new messages
- `state` snapshots
- Settings/skills/MCP updates

### Known Error: Stale `messageUpdated` Drops

The log shows 80 instances of:

```
[messageUpdated] Received update for unknown message ts=1780216624537, dropping.
```

This happens because `messageUpdated` targets a specific message by timestamp, but the webview's message list may be out of sync with what the host thinks is current. The handler in [`ExtensionStateContext.tsx`](extensions/shofer/webview-ui/src/context/ExtensionStateContext.tsx:435) does:

```typescript
case "messageUpdated":
    const lastIndex = findLastIndex(prevState.shoferMessages, (msg) => msg.ts === shoferMessage.ts)
    if (lastIndex !== -1) { /* update */ }
    // else: drop silently
```

## Potential Failure Hypotheses

### Hypothesis 1: Thaw-Dump React Crash (Silent)

The burst of 80+ queued `postMessage` calls causes a runtime error in React's state synchronization. If the error crashes the tree in a way that bypasses `ErrorBoundary` (e.g., an async error in a `useEffect` callback, or a crash during `setState` reducer execution inside `mergeExtensionState`):

- React unmounts the tree silently
- `<div id="root">` is empty
- No `fatal_error` is posted (the crash guard only catches sync `window.onerror` and `unhandledrejection` — it can't catch React silently unmounting)

**How to verify:** Open `Developer: Open Webview Developer Tools` after the blank screen appears. Check if `#root` contains any DOM nodes and if the console shows any red errors.

### Hypothesis 2: Corrupted State → `didHydrateState` Trap

During the thaw-dump, a `state` message with a corrupted or empty payload arrives. `mergeExtensionState` sets `shoferMessages: undefined` or similar, then a subsequent message handler crashes because it assumes `shoferMessages` is an array. The crash tears down the tree.

Alternatively, if the host pushes an `action` message that triggers a `switchTab` / re-render cycle during the message storm, the `App` component might unmount and remount, resetting `didHydrateState` to `false`.

### Hypothesis 3: `useEffect` Cascade → Infinite Loop → Browser Kills Frame

The `messageUpdated` handler calls `setState` with a reducer. With 80+ messages arriving in the same event loop tick, each triggers a React re-render. If any `useEffect` in the chain triggers another state update, it could cascade into a render loop that the browser sandbox detects and terminates — killing the entire iframe JS context.

**How to verify:** Check the webview devtools console for "Maximum update depth exceeded" or similar React warnings.

### Hypothesis 4: VS Code Webview Overlay Detachment

The log shows `overlayWebview.ts:207` / `claim` / `mountTo` calls for other webviews (markdown-language-features). During the thaw, VS Code may re-layout its webview overlay layer. If Shofer's webview gets detached from the overlay during this re-layout, the iframe exists but is not rendered in the viewport — the DOM is still there but invisible.

**How to verify:** In devtools, check if `<div id="root">` has children despite the page appearing blank. Check `document.body.innerHTML` for content.

## Open Questions

1. **Does `#root` have DOM children after the blank screen?** Run `document.getElementById('root').children.length` in the webview devtools console. This distinguishes "React unmounted" (0 children) from "VS Code detached the webview overlay" (children exist but not visible).

2. **Are there React errors in the webview console?** Look for "Maximum update depth exceeded", "Can't perform a React state update on an unmounted component", or uncaught exceptions at the time of the thaw.

3. **What message types are in the thaw-dump?** The log shows 80 `messageUpdated` drops. Are there also `state`, `action`, or other message types in the dump that could trigger navigation or state resets?

4. **Does VS Code's `overlayWebview.ts` detach Shofer's webview?** The log shows `_show @ overlayWebview.ts:207` being called for markdown-language-features webviews. Could the thaw cause VS Code to re-layout the webview layer and detach Shofer's panel?

5. **Is the blank state consistent across freeze/thaw cycles?** If reproducible, capturing the full webview console output during freeze → thaw would pin down the exact failure point.

## Next Steps

1. Open `Developer: Open Webview Developer Tools` and check `#root` DOM state after a blank page incident
2. Look for React errors in the webview console at the thaw moment
3. If reproducible, add defensive guards to `messageUpdated` / `shoferMessageAppended` handlers to limit processing rate during message storms
