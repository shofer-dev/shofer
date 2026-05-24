# Webview Refresh & Liveness Monitor

This document describes the end-to-end design and implementation of the
**heartbeat liveness monitor** (the reliability mechanism that detects and
recovers from webview crashes) and the **Refresh Webview** command (the manual
recovery button in Shofer's toolbar overflow menu).

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Layer 1 — `installWebviewCrashGuard()` IIFE](#3-layer-1--installwebviewcrashguard-iife)
4. [Layer 2 — `ErrorBoundary`](#4-layer-2--errorboundary)
5. [Layer 3 — Heartbeat Timer](#5-layer-3--heartbeat-timer)
6. [Webview Message Handler Dispatching](#6-webview-message-handler-dispatching)
7. [Automatic Recovery — `_resetWebview()`](#7-automatic-recovery--_resetwebview)
8. [Manual Recovery — Refresh Webview Button](#8-manual-recovery--refresh-webview-button)
9. [`refreshWebview()` vs `_resetWebview()`](#9-refreshwebview-vs-_resetwebview)
10. [Heartbeat Lifecycle](#10-heartbeat-lifecycle)
11. [IPC Message Types](#11-ipc-message-types)
12. [Key Bugs Fixed](#12-key-bugs-fixed)
13. [Related Files](#13-related-files)

---

## 1. Overview

The webview (React UI) and the extension host (Node.js) communicate over a
single `postMessage` channel. If the renderer process crashes silently (OOM,
GPU panic, uncaught exception, React rendering failure), the host has no
inherent way to detect this — the `postMessage` channel becomes a black hole.

Shofer defends against this with **three independent layers** that cascade into
a single recovery action:

| Layer | Location | What It Detects |
|-------|----------|-----------------|
| 1 | [`index.tsx`](webview-ui/src/index.tsx) — IIFE before React mounts | Uncaught sync errors, unhandled rejections, and liveness pongs |
| 2 | [`ErrorBoundary.tsx`](webview-ui/src/components/ErrorBoundary.tsx) | React rendering crashes |
| 3 | [`ShoferProvider.ts`](src/core/webview/ShoferProvider.ts) — heartbeat timer | Silent process death (OOM, GPU crash), IPC channel drop |

The **Refresh Webview** button provides a manual escape hatch when the webview
is visibly broken (blank, frozen, or the error boundary fallback is showing).

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    WEBVIEW (React)                          │
│                                                             │
│  ┌─ installWebviewCrashGuard (IIFE, pre-React) ──────────┐ │
│  │ • window.onerror            → fatal_error             │ │
│  │ • window.onunhandledrejection → fatal_error           │ │
│  │ • window.onmessage({ping})  → pong                    │ │
│  └───────────────────────────────────────────────────────┘ │
│                                                             │
│  ┌─ ErrorBoundary (React) ───────────────────────────────┐ │
│  │ • componentDidCatch()       → fatal_error             │ │
│  └───────────────────────────────────────────────────────┘ │
└──────────────────────┬──────────────────────────────────────┘
                       │ postMessage
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                EXTENSION HOST (Node.js)                     │
│                                                             │
│  webviewMessageHandler:                                     │
│  ┌─ "pong"         → _recordPong()  (update _lastPongTs)   │
│  │─ "fatal_error"  → _onFatalError() → _resetWebview()     │
│  │─ "webviewDidLaunch" → _onWebviewLaunched()              │
│  │                         → _startHeartbeat()              │
│  └─────────────────────────────────────────────────────────┘│
│                                                             │
│  Heartbeat timer (every 2s):                                │
│  ┌─ postMessage({type:"ping"})                             │
│  │─ if (Date.now() - _lastPongTs > 10_000ms)               │
│  │    → _resetWebview()                                    │
│  └─────────────────────────────────────────────────────────┘│
│                                                             │
│  Manual: "Refresh Webview" button (overflow ⋯ menu)         │
│  ┌─ shofer.refreshWebview command                          │
│  │  → refreshWebview()                                     │
│  │  → html="" clear + focus + html assign +                │
│  │    workbench.action.webview.reloadWebviewAction          │
│  └─────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Layer 1 — `installWebviewCrashGuard()` IIFE

**File:** [`webview-ui/src/index.tsx:22-59`](webview-ui/src/index.tsx:22)

An immediately-invoked function expression runs **before** `createRoot().render()`,
before React mounts. It installs three raw DOM event listeners on `window`.

### 3.1 Singleton Constraint

```ts
// IMPORTANT: acquireVsCodeApi() may only be invoked once per webview. We
// therefore route every post through the shared `vscode` singleton in
// `utils/vscode.ts` — never call `acquireVsCodeApi()` directly here. Doing so
// throws synchronously and prevents React from mounting (blank webview).
```

All three listeners use `vscode.postMessage()` from
[`utils/vscode.ts`](webview-ui/src/utils/vscode.ts), the shared singleton that
calls `acquireVsCodeApi()` exactly once. This was the fix for the infinite
reset loop in commit `817d290` — the original code called `acquireVsCodeApi()`
directly, which threw before React could mount.

### 3.2 Listener 1: Uncaught Sync Errors

```ts
window.addEventListener("error", (event: ErrorEvent) => {
    vscode.postMessage({
        type: "fatal_error",
        text: `Uncaught Error: ${event.message} at ${event.filename}:${event.lineno}:${event.colno}`,
    })
})
```

Catches uncaught synchronous exceptions anywhere in the webview (including
third-party scripts).

### 3.3 Listener 2: Unhandled Promise Rejections

```ts
window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
    // Extracts reason as string from Error, string, or JSON
    vscode.postMessage({
        type: "fatal_error",
        text: `Unhandled Promise Rejection: ${reason}`,
    })
})
```

Catches promise rejections that escape all `.catch()` handlers.

### 3.4 Listener 3: Pong Responder

```ts
window.addEventListener("message", (event: MessageEvent) => {
    const message = event.data
    if (message && message.type === "ping") {
        vscode.postMessage({ type: "pong" })
    }
})
```

Responds to `{ type: "ping" }` from the host with `{ type: "pong" }`. This is
the liveness signal that drives the heartbeat timer in Layer 3.

**Critical property:** This listener is a raw DOM event handler, not a React
component. It survives React-level crashes. This means **pongs keep arriving**
even when the React tree is dead — which is why Layer 2 and the `fatal_error`
path exist (see §4, §6).

---

## 4. Layer 2 — `ErrorBoundary`

**File:** [`webview-ui/src/components/ErrorBoundary.tsx`](webview-ui/src/components/ErrorBoundary.tsx)

A React error boundary that wraps the entire `<App />` component tree:

```tsx
createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <ErrorBoundary>
            <App />
        </ErrorBoundary>
    </StrictMode>,
)
```

### 4.1 Error Reporting

[`componentDidCatch()`](webview-ui/src/components/ErrorBoundary.tsx:38) performs
three actions on every React rendering crash:

1. **Telemetry:** Reports the error to PostHog via `telemetryClient.capture("error_boundary_caught_error", …)`.
2. **Host notification:** Posts `{ type: "fatal_error", text: … }` via the shared `vscode` singleton so the host can auto-reset the webview.
3. **Fallback UI:** Sets component state to render a crash screen with the error
   stack, component stack, version number, and a link to file a GitHub issue.

### 4.2 Why Layer 2 Is Necessary

The IIFE's pong responder (Layer 1, §3.4) survives React crashes. Without an
explicit `fatal_error` message from `ErrorBoundary`, the host would never know
the React tree is broken — pongs keep arriving, the heartbeat stays green, and
the user sees a crash screen indefinitely. The `componentDidCatch` path
short-circuits this by triggering `_resetWebview()` immediately (see §6).

---

## 5. Layer 3 — Heartbeat Timer

**File:** [`src/core/webview/ShoferProvider.ts:202-815`](src/core/webview/ShoferProvider.ts:202)

The extension host maintains a periodic heartbeat to detect **silent**
renderer deaths (OOM kill, GPU process crash, IPC channel drop) where no
JavaScript error handler fires and no `fatal_error` message is sent.

### 5.1 Configuration

```ts
/** Heartbeat timer ID. Cleared on webview reset and on final dispose. */
private _heartbeatTimer: NodeJS.Timeout | null = null

/** Timestamp (epoch ms) of the most recently received `pong`. */
private _lastPongTs = 0

/** Interval between `ping` messages sent to the webview (ms). */
private static readonly HEARTBEAT_INTERVAL_MS = 2_000

/**
 * Maximum time the webview may go without responding to a ping before we
 * declare it dead and reset it. Must be comfortably larger than
 * `HEARTBEAT_INTERVAL_MS` plus expected main-thread stalls (large file
 * opens, GC pauses, source-map enhancement, …) so transient hiccups don't
 * trip the killer.
 */
private static readonly LIVENESS_TIMEOUT_MS = 10_000
```

### 5.2 Timestamp-Based Liveness (Not Tick-Counting)

The original implementation (commit `6f788a2`) used a tick-driven approach:
each tick incremented `_pingMissCount` synchronously after `postMessage`, then
checked `_pingMissCount > PING_MISS_THRESHOLD`. This raced with in-flight pongs:
a marginally slow event loop could increment the counter before the pong arrived,
intermittently killing a perfectly healthy renderer.

The fix (commit `817d290`) replaced the miss counter with a timestamp:

```ts
this._heartbeatTimer = setInterval(async () => {
    try {
        await this.postMessageToWebview({ type: "ping" })
    } catch {
        this._stopHeartbeat()
        return
    }

    const silentFor = Date.now() - this._lastPongTs
    if (silentFor > ShoferProvider.LIVENESS_TIMEOUT_MS) {
        this.log(`[heartbeat] No pong received for ${silentFor}ms — resetting webview`)
        await this._resetWebview()
    }
}, ShoferProvider.HEARTBEAT_INTERVAL_MS)
```

Each tick sends a ping, then computes `Date.now() - _lastPongTs`. If the
silence exceeds `LIVENESS_TIMEOUT_MS` (10 s), the webview is declared dead
and `_resetWebview()` is called. A pong arriving at any time resets
`_lastPongTs` to `Date.now()` via `_recordPong()`.

The seed `this._lastPongTs = Date.now()` at heartbeat start guarantees the
first tick has a full liveness window — otherwise `Date.now() - 0` would
immediately exceed 10 s and trigger an immediate reset.

### 5.3 Public API

| Method | Caller | Effect |
|--------|--------|--------|
| [`_recordPong()`](src/core/webview/ShoferProvider.ts:770) | `webviewMessageHandler` on `"pong"` | Sets `_lastPongTs = Date.now()` |
| [`_startHeartbeat()`](src/core/webview/ShoferProvider.ts:782) | `_onWebviewLaunched()` | Starts the `setInterval` loop. Idempotent. |
| [`_stopHeartbeat()`](src/core/webview/ShoferProvider.ts:809) | `clearWebviewResources()`, `_resetWebview()`, `refreshWebview()` | Clears the interval and resets `_lastPongTs` to 0 |
| [`_onWebviewLaunched()`](src/core/webview/ShoferProvider.ts:823) | `webviewMessageHandler` on `"webviewDidLaunch"` | Calls `_startHeartbeat()` |
| [`_onFatalError(text)`](src/core/webview/ShoferProvider.ts:838) | `webviewMessageHandler` on `"fatal_error"` | Logs + calls `_resetWebview()` immediately |

Methods prefixed with `_` are intended for internal use by the webview message
handler; they are public only because `ShoferProvider` and `webviewMessageHandler`
are separate modules.

---

## 6. Webview Message Handler Dispatching

**File:** [`src/core/webview/webviewMessageHandler.ts:599-605, 4114-4131`](src/core/webview/webviewMessageHandler.ts:599)

The central message handler dispatches heartbeat-related IPC messages:

### 6.1 `webviewDidLaunch`

```ts
case "webviewDidLaunch":
    provider.log("[webview-lifecycle] webviewDidLaunch received — webview initialized or re-initialized")
    // Now that the renderer's JS has executed and its message listener
    // is wired, it is safe to start the heartbeat. Starting
    // it earlier (e.g. in resolveWebviewView) would count every ping
    // sent during bundle load as a liveness miss → infinite reset loop.
    provider._onWebviewLaunched()
    // …
```

This is the **critical ordering constraint**: the heartbeat MUST NOT start until
the webview's JS bundle has executed and registered the `"message"` event
listener that answers pings. Starting earlier would cause every ping during
bundle load to count as a liveness miss, triggering an infinite reset loop.

### 6.2 `fatal_error`

```ts
case "fatal_error": {
    const text = (message as { text?: string }).text ?? "(no message)"
    provider.log(`[fatal_error] ${text}`)
    // The heartbeat alone cannot detect React-level crashes because the
    // raw pong listener in installWebviewCrashGuard (index.tsx) survives
    // React errors and keeps responding to pings. Trigger an explicit
    // reset here so the renderer is restored without waiting for the
    // 10-second liveness window to expire.
    await provider._onFatalError(text)
    break
}
```

The comment explains the core design tension: the IIFE's pong responder (§3.4)
survives React crashes, so the heartbeat timer alone cannot detect them. The
`fatal_error` message (sent by Layer 1's error listeners and Layer 2's
`ErrorBoundary.componentDidCatch`) provides the explicit signal to reset
immediately.

### 6.3 `pong`

```ts
case "pong": {
    // Record that the webview responded. The consecutive-miss counter
    // is managed by the heartbeat timer in ShoferProvider.
    provider._recordPong()
    break
}
```

---

## 7. Automatic Recovery — `_resetWebview()`

**File:** [`src/core/webview/ShoferProvider.ts:932-955`](src/core/webview/ShoferProvider.ts:932)

The automatic reset path, triggered by the heartbeat timer (silence > 10 s) or
by `_onFatalError()`:

```ts
private async _resetWebview(): Promise<void> {
    const view = this.view
    if (!view || this._disposed) { return }

    this._stopHeartbeat()
    this.clearWebviewResources()

    try {
        const html = await this.getHtmlContent(view.webview)
        view.webview.html = html
        // Re-wire the message listener. The heartbeat is restarted only when
        // the freshly-loaded webview posts `webviewDidLaunch`.
        this.setWebviewMessageListener(view.webview)
    } catch (err) {
        this.log(`[webview-lifecycle] _resetWebview FAILED: …`)
    }
}
```

Key design decisions:

- **Produces only:** always calls `getHtmlContent()` — no HMR support here,
  since this path fires when the webview is already dead and we want the
  fastest possible recovery.
- **Heartbeat is NOT restarted eagerly.** Re-assigning `webview.html` triggers
  a full page reload. The fresh page will emit `webviewDidLaunch` when its JS
  executes, which calls `_onWebviewLaunched()` → `_startHeartbeat()`. Starting
  the heartbeat before the new page is ready would re-enter the infinite reset
  loop.
- **Message listener is re-wired.** `setWebviewMessageListener()` re-registers
  the `webview.onDidReceiveMessage` handler on the new frame. Without this,
  `webviewDidLaunch` would never arrive and the heartbeat would never restart.

---

## 8. Manual Recovery — Refresh Webview Button

### 8.1 User-Facing Placement

The **Refresh Webview** command (`shofer.refreshWebview`) appears in the
toolbar **overflow (⋯) menu** at position `overflow@3` for both the sidebar
and tab panel:

- Sidebar: `when: view == shofer.SidebarProvider`
- Tab panel: `when: activeWebviewPanelId == shofer.TabPanelProvider`

It was originally placed at `navigation@4` (a visible icon in the toolbar)
but was reverted because the refresh icon was too prominent for a recovery
action that should rarely be needed.

### 8.2 Registration Chain

| Artifact | Location | Purpose |
|----------|----------|---------|
| Command ID | [`src/package.json:208`](src/package.json:208) | Declares `"shofer.refreshWebview"` command |
| NLS label | [`src/package.nls.json:29`](src/package.nls.json:29) | `"Refresh Webview"` |
| Menu entries | [`src/package.json:246`](src/package.json:246) (sidebar), [`src/package.json:329`](src/package.json:329) (tab panel) | `overflow@3` in both `view/title` menus |
| Type symbol | [`packages/types/src/vscode.ts:64`](packages/types/src/vscode.ts:64) | `"refreshWebview"` in `commandIds` |
| Handler | [`src/activate/registerCommands.ts:335-341`](src/activate/registerCommands.ts:335) | Calls `visibleProvider.refreshWebview()` |

### 8.3 Implementation

**File:** [`src/core/webview/ShoferProvider.ts:864-925`](src/core/webview/ShoferProvider.ts:864)

```ts
public async refreshWebview(): Promise<void> {
    const view = this.view
    if (!view || this._disposed) { return }

    this.log("[webview-lifecycle] refreshWebview: user-initiated forceful reset")
    this._stopHeartbeat()
    this.clearWebviewResources()

    // Step 1: explicit clear so the browser unloads the old frame before
    // we start building the new HTML (avoids flash of old content during
    // the async getHtmlContent call).
    view.webview.html = ""

    // Step 2: build new HTML (HMR in dev, production bundle otherwise).
    const html = this.contextProxy.extensionMode === vscode.ExtensionMode.Development
        ? await this.getHMRHtmlContent(view.webview)
        : await this.getHtmlContent(view.webview)

    // Step 3: focus the webview AND steal focus into it (the `true` arg).
    if ("show" in view) {
        ;(view as vscode.WebviewView).show(true)
    } else {
        ;(view as vscode.WebviewPanel).reveal(undefined, false)
    }

    // Step 4: assign the new HTML content.
    view.webview.html = html
    this.setWebviewMessageListener(view.webview)

    // Step 5: belt-and-suspenders — ask the VS Code workbench to navigate
    // the webview frame at the browser level.
    await new Promise((resolve) => setTimeout(resolve, 50))
    try {
        await vscode.commands.executeCommand("workbench.action.webview.reloadWebviewAction")
    } catch {
        this.log("[webview-lifecycle] refreshWebview: workbench reload command unavailable, relying on html reassignment only")
    }
}
```

### 8.4 Design Rationale

The `refreshWebview()` method is more aggressive than `_resetWebview()` for
several reasons:

1. **`webview.html = ""` explicit clear:** VS Code's webview implementation may
   defer frame teardown when a new HTML string is assigned before the old one
   finishes loading. An explicit `""` assignment signals "tear down now" before
   the async HTML build starts.

2. **HMR-aware HTML build:** Uses `getHMRHtmlContent()` in development mode so
   the refreshed page picks up the latest code changes. `_resetWebview()` only
   uses `getHtmlContent()` for speed.

3. **Focus stealing:** `show(true)` / `reveal()` ensures the webview is visible
   and focused. `workbench.action.webview.reloadWebviewAction` targets the
   *focused* webview, so we must guarantee ours has focus. The `true` parameter
   on `show()` steals focus from the editor — acceptable for a manual recovery
   action but too disruptive for automatic recovery.

4. **`workbench.action.webview.reloadWebviewAction`:** This is the VS Code
   workbench's native "Developer: Reload Webviews" command. Unlike reassigning
   `webview.html` (which sends an IPC message to the renderer that may never
   arrive if the renderer is stuck), this command navigates the browser frame
   at the DOM level. It is a belt-and-suspenders measure for when the
   renderer's event loop is dead.

5. **50 ms delay:** After `show(true)`, focus has shifted but may not have
   propagated through VS Code's internal state before we execute the reload
   command. The 50 ms yield lets the focus change settle so
   `reloadWebviewAction` resolves the correct webview.

---

## 9. `refreshWebview()` vs `_resetWebview()`

| Step | `_resetWebview()` (automatic) | `refreshWebview()` (manual) |
|------|-------------------------------|-----------------------------|
| Stop heartbeat | ✅ | ✅ |
| Clear webview resources | ✅ | ✅ |
| **`webview.html = ""` explicit clear** | ❌ | ✅ |
| HTML build | `getHtmlContent()` only | `getHMRHtmlContent()` in dev, `getHtmlContent()` in prod |
| **Focus panel** | ❌ | ✅ — `show(true)` for sidebar, `reveal()` for tab |
| Assign new `webview.html` | ✅ | ✅ |
| Re-wire `onDidReceiveMessage` listener | ✅ | ✅ |
| **`workbench.action.webview.reloadWebviewAction`** | ❌ | ✅ |
| 50 ms yield before reload action | ❌ | ✅ |
| Heartbeat restart | Deferred to `webviewDidLaunch` | Deferred to `webviewDidLaunch` |

---

## 10. Heartbeat Lifecycle

### 10.1 Start

The heartbeat timer starts **exactly once per webview lifecycle**, when the
webview's JS signals it is ready:

```
resolveWebviewView()
    → webview.html = "…"
    → [bundle loads in browser]
    → webview sends { type: "webviewDidLaunch" }
    → webviewMessageHandler case "webviewDidLaunch"
    → provider._onWebviewLaunched()
    → _startHeartbeat()
```

It MUST NOT start earlier — pings sent during bundle load would count as
liveness misses and trigger an infinite reset loop.

### 10.2 Stop

The heartbeat stops in three scenarios:

| Trigger | Method | Notes |
|---------|--------|-------|
| Webview resources cleared | [`clearWebviewResources()`](src/core/webview/ShoferProvider.ts:753) | Called on view replacement, reset, and dispose |
| Automatic reset | [`_resetWebview()`](src/core/webview/ShoferProvider.ts:932) → `_stopHeartbeat()` | Not restarted until fresh `webviewDidLaunch` |
| Manual refresh | [`refreshWebview()`](src/core/webview/ShoferProvider.ts:864) → `_stopHeartbeat()` | Not restarted until fresh `webviewDidLaunch` |
| `postMessage` throws | `_startHeartbeat()` catch block | View may be disposed; let dispose clean up |

### 10.3 Restart After Reset

Both `_resetWebview()` and `refreshWebview()` do **NOT** restart the heartbeat.
Instead, they assign new `webview.html` content, which causes the renderer to
reload from scratch. The freshly-loaded page emits `webviewDidLaunch`, which
triggers `_onWebviewLaunched()` → `_startHeartbeat()`. This avoids the race
where the host starts pinging before the new page's JS bundle has executed.

---

## 11. IPC Message Types

### 11.1 Host → Webview (`ExtensionMessage`)

| Type | Direction | Purpose | Declared In |
|------|-----------|---------|-------------|
| `"ping"` | Host → Webview | Liveness probe | [`packages/types/src/message.ts`](packages/types/src/message.ts) (in `ExtensionMessage`) |

### 11.2 Webview → Host (`WebviewMessage`)

| Type | Direction | Purpose | Declared In |
|------|-----------|---------|-------------|
| `"pong"` | Webview → Host | Liveness acknowledgement | [`packages/types/src/message.ts`](packages/types/src/message.ts) (in `WebviewMessage`) |
| `"fatal_error"` | Webview → Host | Crash notification (auto-triggers reset) | [`packages/types/src/message.ts`](packages/types/src/message.ts) (in `WebviewMessage`) |
| `"webviewDidLaunch"` | Webview → Host | Bundle loaded, safe to start heartbeat | [`packages/types/src/message.ts`](packages/types/src/message.ts) (in `WebviewMessage`) |

### 11.3 Payloads

```ts
// "ping" — no payload
{ type: "ping" }

// "pong" — no payload
{ type: "pong" }

// "fatal_error"
{ type: "fatal_error", text: string }

// "webviewDidLaunch" — no payload (handled in its own case)
{ type: "webviewDidLaunch" }
```

---

## 12. Key Bugs Fixed

### 12.1 Duplicate `acquireVsCodeApi()` Crash (commit `817d290`)

The original `installWebviewCrashGuard()` IIFE called `acquireVsCodeApi()`
directly. The shared `vscode` singleton in `utils/vscode.ts` had already
consumed the one allowed call when `App` → `ExtensionStateContext` imported it.
The IIFE's call threw synchronously at module-eval time, halting the script
before `createRoot().render()` ran. No React tree mounted, no `message`
listener was installed, every host ping went unanswered → infinite reset loop.

**Fix:** Route every `postMessage` through the shared `vscode` singleton.

### 12.2 Heartbeat Before Bundle Load (commit `817d290`)

`_startHeartbeat()` was called from `resolveWebviewView()` immediately after
assigning `webview.html`. With a 1 s interval and a 2-miss threshold, the
webview was declared dead before the JS bundle could finish loading.

**Fix:**
- Defer `_startHeartbeat()` until `webviewDidLaunch` arrives.
- `_resetWebview()` no longer restarts the heartbeat eagerly.
- Replaced tick-driven miss counter with timestamp-based liveness.

### 12.3 Heartbeat Misses React Crashes (commit `d1313b0`)

The IIFE's pong responder (raw `window.addEventListener`) survived React
crashes. Pongs kept arriving, the heartbeat stayed green, and a broken React
tree was never detected.

**Fix:** Introduced `_onFatalError()` — the `fatal_error` handler calls
`_resetWebview()` immediately, bypassing the heartbeat timer. Also added
auto-reset wiring for the existing `fatal_error` IPC message sent by both
`ErrorBoundary.componentDidCatch` and the IIFE's error listeners.

---

## 13. Related Files

| File | Role |
|------|------|
| [`webview-ui/src/index.tsx`](webview-ui/src/index.tsx) | `installWebviewCrashGuard()` IIFE: error listeners + pong responder |
| [`webview-ui/src/components/ErrorBoundary.tsx`](webview-ui/src/components/ErrorBoundary.tsx) | React error boundary: forwards crashes to host |
| [`webview-ui/src/utils/vscode.ts`](webview-ui/src/utils/vscode.ts) | Shared `acquireVsCodeApi()` singleton |
| [`src/core/webview/ShoferProvider.ts`](src/core/webview/ShoferProvider.ts) | Heartbeat timer, `_resetWebview()`, `refreshWebview()` |
| [`src/core/webview/webviewMessageHandler.ts`](src/core/webview/webviewMessageHandler.ts) | Dispatching `pong`, `fatal_error`, `webviewDidLaunch` |
| [`src/activate/registerCommands.ts`](src/activate/registerCommands.ts) | Command registration for `shofer.refreshWebview` |
| [`src/package.json`](src/package.json) | Command declaration, menu entries (overflow@3) |
| [`src/package.nls.json`](src/package.nls.json) | NLS label: "Refresh Webview" |
| [`packages/types/src/vscode.ts`](packages/types/src/vscode.ts) | `"refreshWebview"` in `commandIds` |
| [`packages/types/src/message.ts`](packages/types/src/message.ts) | `"ping"`, `"pong"`, `"fatal_error"`, `"webviewDidLaunch"` type declarations |
