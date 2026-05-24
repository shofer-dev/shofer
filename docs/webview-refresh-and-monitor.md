# Webview Refresh & Liveness Monitor

This document describes the end-to-end design and implementation of the
**heartbeat liveness monitor** (the reliability mechanism that detects and
recovers from webview crashes) and the **Refresh Webview** command (the manual
recovery button in Shofer's toolbar overflow menu).

> **⚠️ Known issue (2026-05-24):** The `refreshWebview()` recovery path sometimes
> fails to revive a stuck webview iframe. See §15 ("Recovery Escalation Ladder")
> for the `Reload Window` nuclear option, and §16 ("Further Ideas to Explore")
> for hardening ideas not yet implemented.

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
13. [Diagnostic Instrumentation](#13-diagnostic-instrumentation)
14. [Recovery Escalation Ladder](#14-recovery-escalation-ladder)
15. [Further Ideas to Explore](#15-further-ideas-to-explore)
16. [Related Files](#16-related-files)

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
is visibly broken. If that fails, the **Reload Window** button restarts the
entire VS Code window (guaranteed to work but disruptive).

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    WEBVIEW (React)                          │
│                                                             │
│  ┌─ installWebviewCrashGuard (IIFE, pre-React) ──────────┐ │
│  │ • window.onerror            → fatal_error             │ │
│  │ • window.onunhandledrejection → fatal_error           │ │
│  │ • window.onmessage({ping})  → pong + RTT logging      │ │
│  │ • window.__shoferHeartbeat  (diagnostic counters)     │ │
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
│  ┌─ "pong"         → _recordPong() (RTT ring buffer)       │
│  │─ "fatal_error"  → _onFatalError() → _resetWebview()     │
│  │─ "webviewDidLaunch" → _onWebviewLaunched()              │
│  │                         → _startHeartbeat()              │
│  └─────────────────────────────────────────────────────────┘│
│                                                             │
│  Heartbeat timer (every 2s):                                │
│  ┌─ set _pingSentTs → postMessage({type:"ping"})           │
│  │─ if (Date.now() - _lastPongTs > 10_000ms)               │
│  │    → dump RTT history → _resetWebview("heartbeat_timeout")│
│  └─────────────────────────────────────────────────────────┘│
│                                                             │
│  Manual recovery (overflow ⋯ menu):                         │
│  ┌─ Refresh Webview  (overflow@3)                          │
│  │  → html="" + focus + html assign + reloadWebviewAction   │
│  │─ Reload Window    (overflow@4)   ← NUCLEAR OPTION       │
│  │  → confirmation dialog → workbench.action.reloadWindow   │
│  └─────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Layer 1 — `installWebviewCrashGuard()` IIFE

**File:** [`webview-ui/src/index.tsx:22-59`](webview-ui/src/index.tsx:22)

An immediately-invoked function expression runs **before** `createRoot().render()`,
before React mounts. It installs three raw DOM event listeners on `window` and
exposes diagnostic counters on `window.__shoferHeartbeat`.

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
    let reason = ""
    if (event.reason instanceof Error) {
        reason = `${event.reason.message}\n${event.reason.stack ?? ""}`
    } else if (typeof event.reason === "string") {
        reason = event.reason
    } else {
        try { reason = JSON.stringify(event.reason) }
        catch { reason = String(event.reason) }
    }
    vscode.postMessage({ type: "fatal_error", text: `Unhandled Promise Rejection: ${reason}` })
})
```

Catches promise rejections that escape all `.catch()` handlers.

### 3.4 Listener 3: Pong Responder (with diagnostic counters)

```ts
;(window as any).__shoferHeartbeat = {
    pingCount: 0,
    pongCount: 0,
    lastPingTimestamps: [] as number[],
    MAX_TIMESTAMPS: 20,
}
window.addEventListener("message", (event: MessageEvent) => {
    const message = event.data
    if (message && message.type === "ping") {
        const hb = (window as any).__shoferHeartbeat
        hb.pingCount++
        hb.lastPingTimestamps.push(Date.now())
        if (hb.lastPingTimestamps.length > hb.MAX_TIMESTAMPS) {
            hb.lastPingTimestamps.shift()
        }
        hb.pongCount++
        vscode.postMessage({ type: "pong" })
    }
})
```

Responds to `{ type: "ping" }` from the host with `{ type: "pong" }`. Also
maintains `window.__shoferHeartbeat` — a diagnostic object inspectable at
runtime via DevTools to verify the webview is receiving pings and sending pongs.

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

**File:** [`src/core/webview/ShoferProvider.ts:202-855`](src/core/webview/ShoferProvider.ts:202)

The extension host maintains a periodic heartbeat to detect **silent**
renderer deaths (OOM kill, GPU process crash, IPC channel drop) where no
JavaScript error handler fires and no `fatal_error` message is sent.

### 5.1 Configuration

```ts
/** Heartbeat timer ID. Cleared on webview reset and on final dispose. */
private _heartbeatTimer: NodeJS.Timeout | null = null

/** Timestamp (epoch ms) of the most recently received `pong`. */
private _lastPongTs = 0

/**
 * Timestamp (epoch ms) set immediately before each postMessage({type:"ping"}).
 * Used to compute per-heartbeat round-trip time (RTT) when the corresponding
 * pong arrives.
 */
private _pingSentTs = 0

/**
 * Ring buffer of the last RTT_HISTORY_SIZE heartbeat round-trip times (ms).
 * Dumped to the output channel when a webview reset is triggered so we can
 * distinguish gradual slowdown (rising RTT → memory pressure) from abrupt
 * death (normal RTT → sudden silence → OOM kill / GPU crash).
 */
private _heartbeatRttHistory: number[] = []
private static readonly RTT_HISTORY_SIZE = 40

/** Total heartbeat ticks completed in the current webview session. */
private _heartbeatTickCount = 0

/** Number of webview resets (automatic + manual) in the current host session. */
private _webviewResetCount = 0

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

### 5.2 Timestamp-Based Liveness with RTT Tracking

The original implementation (commit `6f788a2`) used a tick-driven approach:
each tick incremented `_pingMissCount` synchronously after `postMessage`, then
checked `_pingMissCount > PING_MISS_THRESHOLD`. This raced with in-flight pongs:
a marginally slow event loop could increment the counter before the pong arrived,
intermittently killing a perfectly healthy renderer.

The fix (commit `817d290`) replaced the miss counter with a timestamp.
A further improvement (commit `6ea920b`) added RTT tracking:

```ts
this._heartbeatTimer = setInterval(async () => {
    try {
        this._pingSentTs = Date.now()
        await this.postMessageToWebview({ type: "ping" })
    } catch {
        this._stopHeartbeat()
        return
    }

    this._heartbeatTickCount++
    const silentFor = Date.now() - this._lastPongTs
    if (silentFor > ShoferProvider.LIVENESS_TIMEOUT_MS) {
        this.log(`[heartbeat] No pong received for ${silentFor}ms — resetting webview`)
        await this._resetWebview("heartbeat_timeout")
    }
}, ShoferProvider.HEARTBEAT_INTERVAL_MS)
```

In `_recordPong()`, each pong computes RTT and pushes to the ring buffer:

```ts
public _recordPong(): void {
    const now = Date.now()
    this._lastPongTs = now
    const rtt = now - this._pingSentTs
    if (rtt > 0 && rtt < ShoferProvider.HEARTBEAT_INTERVAL_MS * 3) {
        if (this._heartbeatRttHistory.length >= ShoferProvider.RTT_HISTORY_SIZE) {
            this._heartbeatRttHistory.shift()
        }
        this._heartbeatRttHistory.push(rtt)
    }
}
```

### 5.3 Public API

| Method | Caller | Effect |
|--------|--------|--------|
| [`_recordPong()`](src/core/webview/ShoferProvider.ts) | `webviewMessageHandler` on `"pong"` | Updates `_lastPongTs` + computes RTT → ring buffer |
| [`_startHeartbeat()`](src/core/webview/ShoferProvider.ts) | `_onWebviewLaunched()` | Starts the `setInterval` loop. Idempotent. Resets RTT history. |
| [`_stopHeartbeat()`](src/core/webview/ShoferProvider.ts) | `clearWebviewResources()`, `_resetWebview()`, `refreshWebview()` | Clears the interval, resets timestamps to 0 |
| [`_onWebviewLaunched()`](src/core/webview/ShoferProvider.ts) | `webviewMessageHandler` on `"webviewDidLaunch"` | Calls `_startHeartbeat()` |
| [`_onFatalError(text)`](src/core/webview/ShoferProvider.ts) | `webviewMessageHandler` on `"fatal_error"` | Logs + calls `_resetWebview("fatal_error")` |

Methods prefixed with `_` are intended for internal use by the webview message
handler; they are public only because `ShoferProvider` and `webviewMessageHandler`
are separate modules.

---

## 6. Webview Message Handler Dispatching

**File:** [`src/core/webview/webviewMessageHandler.ts:599-605, 4114-4131`](src/core/webview/webviewMessageHandler.ts:599)

### 6.1 `webviewDidLaunch`

```ts
case "webviewDidLaunch":
    provider.log("[webview-lifecycle] webviewDidLaunch received — webview initialized or re-initialized")
    provider._onWebviewLaunched()
    // …
```

The heartbeat MUST NOT start until the webview's JS bundle has executed and
registered the `"message"` event listener.

### 6.2 `fatal_error`

```ts
case "fatal_error": {
    const text = (message as { text?: string }).text ?? "(no message)"
    provider.log(`[fatal_error] ${text}`)
    await provider._onFatalError(text)
    break
}
```

The `fatal_error` message provides the explicit signal to reset immediately,
bypassing the 10-second liveness window. This is essential because the IIFE's
pong responder survives React crashes (see §4.2).

### 6.3 `pong`

```ts
case "pong": {
    provider._recordPong()
    break
}
```

---

## 7. Automatic Recovery — `_resetWebview()`

**File:** [`src/core/webview/ShoferProvider.ts`](src/core/webview/ShoferProvider.ts)

Triggered by the heartbeat timer (silence > 10 s) or by `_onFatalError()`.

```ts
private async _resetWebview(
    trigger: "heartbeat_timeout" | "fatal_error" | "manual" = "heartbeat_timeout",
): Promise<void> {
    const view = this.view
    if (!view || this._disposed) { return }

    // ── Dump heartbeat diagnostics before resetting ──────────────────────
    this._webviewResetCount++
    const rttHistory = [...this._heartbeatRttHistory]
    const rttSummary = rttHistory.length > 0
        ? `min=${Math.min(...rttHistory)}ms avg=${Math.round(…)}ms max=${Math.max(…)}ms n=${rttHistory.length}`
        : "no RTT samples"
    const silentFor = this._lastPongTs > 0 ? Date.now() - this._lastPongTs : -1
    this.log(
        `[webview-lifecycle] _resetWebview: trigger=${trigger} resetCount=${this._webviewResetCount} heartbeatTicks=${this._heartbeatTickCount} silentFor=${silentFor}ms rtt=[${rttSummary}]`,
    )

    this._stopHeartbeat()
    this.clearWebviewResources()

    try {
        const html = await this.getHtmlContent(view.webview)
        view.webview.html = html
        this.setWebviewMessageListener(view.webview)
    } catch (err) {
        this.log(`[webview-lifecycle] _resetWebview FAILED: …`)
    }
}
```

Key design decisions:

- **Dumps RTT diagnostics before resetting.** The log line
  `trigger=heartbeat_timeout rtt=[min=2ms avg=5ms max=18ms n=40]` reveals
  whether the crash was gradual (rising RTT → memory pressure) or abrupt
  (normal RTT → sudden silence → OOM kill).
- **Production-only HTML.** Always calls `getHtmlContent()` — no HMR support,
  since this path fires when the webview is already dead.
- **Heartbeat is NOT restarted eagerly.** The fresh page will emit
  `webviewDidLaunch` which calls `_startHeartbeat()`.
- **Message listener is re-wired.** `setWebviewMessageListener()` re-registers
  the `webview.onDidReceiveMessage` handler on the new frame.

---

## 8. Manual Recovery — Refresh Webview Button

### 8.1 User-Facing Placement

The **Refresh Webview** command (`shofer.refreshWebview`) appears in the
toolbar **overflow (⋯) menu** at position `overflow@3`, followed by
**Reload Window** at `overflow@4`.

### 8.2 Registration Chain

| Artifact | Location | Purpose |
|----------|----------|---------|
| Command ID — Refresh | [`src/package.json`](src/package.json) | `"shofer.refreshWebview"` |
| NLS label | [`src/package.nls.json`](src/package.nls.json) | `"Refresh Webview"` |
| Menu entries | [`src/package.json`](src/package.json) | `overflow@3` in both sidebar & tab panel menus |
| Type symbol | [`packages/types/src/vscode.ts`](packages/types/src/vscode.ts) | `"refreshWebview"` in `commandIds` |
| Handler | [`src/activate/registerCommands.ts`](src/activate/registerCommands.ts) | Calls `visibleProvider.refreshWebview()` |
| Command ID — Reload | [`src/package.json`](src/package.json) | `"shofer.reloadWindow"` |
| NLS label | [`src/package.nls.json`](src/package.nls.json) | `"Reload Window"` |
| Menu entries | [`src/package.json`](src/package.json) | `overflow@4` in both sidebar & tab panel menus |
| Type symbol | [`packages/types/src/vscode.ts`](packages/types/src/vscode.ts) | `"reloadWindow"` in `commandIds` |
| Handler | [`src/activate/registerCommands.ts`](src/activate/registerCommands.ts) | Shows modal confirmation, then `workbench.action.reloadWindow` |

### 8.3 `refreshWebview()` Implementation

**File:** [`src/core/webview/ShoferProvider.ts`](src/core/webview/ShoferProvider.ts)

```ts
public async refreshWebview(): Promise<void> {
    const view = this.view
    if (!view || this._disposed) { return }

    this._webviewResetCount++
    this.log(`[webview-lifecycle] refreshWebview: user-initiated forceful reset (session reset #${this._webviewResetCount})`)
    this._stopHeartbeat()
    this.clearWebviewResources()

    // Step 1: explicit clear so the browser unloads the old frame
    view.webview.html = ""

    // Step 2: build new HTML (HMR in dev, production bundle otherwise)
    const html = this.contextProxy.extensionMode === vscode.ExtensionMode.Development
        ? await this.getHMRHtmlContent(view.webview)
        : await this.getHtmlContent(view.webview)

    // Step 3: focus the webview AND steal focus into it
    if ("show" in view) {
        ;(view as vscode.WebviewView).show(true)
    } else {
        ;(view as vscode.WebviewPanel).reveal(undefined, false)
    }

    // Step 4: assign the new HTML content
    view.webview.html = html
    this.setWebviewMessageListener(view.webview)

    // Step 5: belt-and-suspenders — reload at the browser-frame level
    await new Promise((resolve) => setTimeout(resolve, 50))
    try {
        await vscode.commands.executeCommand("workbench.action.webview.reloadWebviewAction")
    } catch {
        this.log("[webview-lifecycle] refreshWebview: workbench reload command unavailable")
    }
}
```

### 8.4 Design Rationale

1. **`webview.html = ""` explicit clear:** Signals "tear down now" before the
   async HTML build starts.
2. **HMR-aware HTML build:** Uses `getHMRHtmlContent()` in development mode.
3. **Focus stealing:** `show(true)` / `reveal()` ensures the webview is visible
   and focused. `reloadWebviewAction` targets the *focused* webview.
4. **`workbench.action.webview.reloadWebviewAction`:** Navigates the browser
   frame at the DOM level, unlike `webview.html` assignment which is an IPC
   message that can be silently dropped when the renderer is stuck.
5. **50 ms delay:** Lets the focus shift from step 3 settle before the reload
   command resolves its target.

---

## 9. `refreshWebview()` vs `_resetWebview()`

| Step | `_resetWebview()` (automatic) | `refreshWebview()` (manual) |
|------|-------------------------------|-----------------------------|
| Stop heartbeat | ✅ | ✅ |
| Clear webview resources | ✅ | ✅ |
| **RTT diagnostic dump before reset** | ✅ | ✅ (via `_webviewResetCount` log) |
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

The heartbeat stops in the following scenarios:

| Trigger | Method | Notes |
|---------|--------|-------|
| Webview resources cleared | [`clearWebviewResources()`](src/core/webview/ShoferProvider.ts) | Called on view replacement, reset, and dispose |
| Automatic reset | [`_resetWebview()`](src/core/webview/ShoferProvider.ts) → `_stopHeartbeat()` | Not restarted until fresh `webviewDidLaunch` |
| Manual refresh | [`refreshWebview()`](src/core/webview/ShoferProvider.ts) → `_stopHeartbeat()` | Not restarted until fresh `webviewDidLaunch` |
| `postMessage` throws | `_startHeartbeat()` catch block | View may be disposed; let dispose clean up |

### 10.3 Restart After Reset

Both `_resetWebview()` and `refreshWebview()` do **NOT** restart the heartbeat.
Instead, they assign new `webview.html` content, which causes the renderer to
reload from scratch. The freshly-loaded page emits `webviewDidLaunch`, which
triggers `_onWebviewLaunched()` → `_startHeartbeat()`.

---

## 11. IPC Message Types

### 11.1 Host → Webview (`ExtensionMessage`)

| Type | Direction | Purpose | Declared In |
|------|-----------|---------|-------------|
| `"ping"` | Host → Webview | Liveness probe | [`packages/types/src/message.ts`](packages/types/src/message.ts) |

### 11.2 Webview → Host (`WebviewMessage`)

| Type | Direction | Purpose | Declared In |
|------|-----------|---------|-------------|
| `"pong"` | Webview → Host | Liveness acknowledgement | [`packages/types/src/message.ts`](packages/types/src/message.ts) |
| `"fatal_error"` | Webview → Host | Crash notification (auto-triggers reset) | [`packages/types/src/message.ts`](packages/types/src/message.ts) |
| `"webviewDidLaunch"` | Webview → Host | Bundle loaded, safe to start heartbeat | [`packages/types/src/message.ts`](packages/types/src/message.ts) |

### 11.3 Payloads

```ts
{ type: "ping" }                                    // no payload
{ type: "pong" }                                    // no payload
{ type: "fatal_error", text: string }               // crash details
{ type: "webviewDidLaunch" }                        // no payload
```

---

## 12. Key Bugs Fixed

### 12.1 Duplicate `acquireVsCodeApi()` Crash (commit `817d290`)

The original `installWebviewCrashGuard()` IIFE called `acquireVsCodeApi()`
directly, but the shared `vscode` singleton had already consumed the one
allowed call. The IIFE's call threw synchronously at module-eval time,
halting the script before `createRoot().render()` ran.

**Fix:** Route every `postMessage` through the shared `vscode` singleton.

### 12.2 Heartbeat Before Bundle Load (commit `817d290`)

`_startHeartbeat()` was called from `resolveWebviewView()` before the JS
bundle could finish loading. With a 1 s interval and 2-miss threshold, the
webview was declared dead before it could respond.

**Fix:** Defer heartbeat until `webviewDidLaunch`; replace tick-counter with
timestamp-based liveness.

### 12.3 Heartbeat Misses React Crashes (commit `d1313b0`)

The IIFE's pong responder (raw `window.addEventListener`) survived React
crashes. Pongs kept arriving, the heartbeat stayed green, and a broken React
tree was never detected.

**Fix:** `_onFatalError()` calls `_resetWebview()` immediately, bypassing the
heartbeat timer.

---

## 13. Diagnostic Instrumentation

Added in commit `6ea920b`. All instrumentation is additive — it does not change
existing behavior, only adds logging and counters.

### 13.1 Host-Side RTT Ring Buffer (`ShoferProvider.ts`)

| Field | Purpose |
|-------|---------|
| `_pingSentTs` | Timestamp set immediately before each `postMessage({type:"ping"})` |
| `_heartbeatRttHistory` | Ring buffer of last 40 round-trip latencies (ms) |
| `_heartbeatTickCount` | Total ticks in current webview session |
| `_webviewResetCount` | Total resets in current host session (survives webview restarts) |

On every reset, the output channel logs:
```
[webview-lifecycle] _resetWebview: trigger=heartbeat_timeout resetCount=3
  heartbeatTicks=452 silentFor=11000ms
  rtt=[min=2ms avg=5ms max=18ms n=40]
```

This distinguishes **gradual slowdown** (rising RTT → memory pressure / GC stalls)
from **abrupt death** (normal RTT → sudden silence → OOM kill / GPU crash).

### 13.2 Reset-Trigger Tagging

`_resetWebview()` accepts a `trigger` parameter:

| Trigger | Source |
|---------|--------|
| `"heartbeat_timeout"` | Heartbeat timer detected > 10 s silence |
| `"fatal_error"` | Webview posted a `fatal_error` message |
| `"manual"` | User clicked Refresh Webview |

### 13.3 Webview-Side Diagnostic Counters (`index.tsx`)

```js
window.__shoferHeartbeat
// {
//   pingCount: 452,
//   pongCount: 452,
//   lastPingTimestamps: [1706123456789, 1706123458789, …]  // last 20
// }
```

Inspectable at runtime via VS Code's webview DevTools (`Help → Toggle Developer Tools`).

---

## 14. Recovery Escalation Ladder

When the webview is frozen, blank, or stuck, the user follows this ladder:

### Step 1: Refresh Webview (`overflow@3`)

What it does: `webview.html = ""` → build new HTML → focus panel → assign HTML → `reloadWebviewAction`.

**When it works:** The renderer process is alive but the React tree is broken,
or the IPC channel is degraded but not dead.

**When it fails:** The iframe is stuck at the VS Code workbench level —
`postMessage` is a black hole, the Chromium renderer process is dead, or the
iframe element has been reparented into a wrong DOM position.

### Step 2: Reload Window (`overflow@4`) — NUCLEAR OPTION

What it does: Shows a modal confirmation dialog, then executes
`workbench.action.reloadWindow` — restarts the entire VS Code window.

**When it works:** Always. This destroys and recreates the entire VS Code
window including the webview iframe at the Electron/Chromium level.

**Trade-off:** All unsaved editor changes are lost. All running tasks are
terminated. The user must confirm a modal dialog before this fires.

```ts
// registerCommands.ts
reloadWindow: async () => {
    const answer = await vscode.window.showWarningMessage(
        "Reload the entire VS Code window? All unsaved editor changes will be lost.",
        { modal: true },
        "Reload Window",
    )
    if (answer === "Reload Window") {
        await vscode.commands.executeCommand("workbench.action.reloadWindow")
    }
}
```

---

## 15. Further Ideas to Explore

**The issue is still present.** The `refreshWebview()` recovery path sometimes
fails to revive a stuck webview iframe. The `Reload Window` nuclear option
always works but is disruptive. Below are hardening ideas to bridge the gap —
none are yet implemented.

### 15.1 Two-Phase HTML Reload

**Current:** `html = ""` → build real HTML → `html = realHtml`

**Proposed:** `html = ""` → wait 200ms → `html = "<html><body></body></html>"` (bootstrap) → wait for `webviewDidLaunch` → `html = realHtml`

By posting a minimal bootstrap page first and waiting for its `webviewDidLaunch`,
we guarantee the old execution context is fully torn down and a fresh one exists
before the heavy React bundle loads. This prevents the race where the old
service worker / blob URL / CSP state hasn't been fully released.

**Risk:** Adds ~500ms to recovery time. `webviewDidLaunch` from the bootstrap
page must be distinguishable from the real page's `webviewDidLaunch`.

### 15.2 Re-Apply `webview.options` Before HTML Reassignment

**Current:** `refreshWebview()` never touches `webview.options`.

**Proposed:** Before `html = realHtml`, re-apply:

```ts
view.webview.options = {
    enableScripts: true,
    localResourceRoots: [this.contextProxy.extensionUri, ...workspaceFolders],
}
```

If the iframe lost its `localResourceRoots` (e.g., VS Code re-parented the
iframe into a different security origin), the bundle won't load even if the
HTML is correct. Re-applying options could fix this silently.

### 15.3 Retry Loop with Increasing Backoff

**Current:** One attempt at `html = ""` → `html = realHtml`.

**Proposed:** Try up to 3 times with 500ms / 1s / 2s gaps between attempts.
After each attempt, send a verification ping and wait up to 5s for a pong.
If pong arrives, recovery succeeded. If all 3 attempts fail, escalate to
Reload Window.

### 15.4 Alternative Ordering: `reloadWebviewAction` FIRST, Then HTML

**Current order:** HTML → `reloadWebviewAction`.

**Proposed:** `reloadWebviewAction` first (tear down the iframe at the browser-frame level), THEN assign new HTML (push into the now-clean frame).

Rationale: If the iframe is stuck because the Chromium renderer process is in a
bad state, `reloadWebviewAction` kills the old process and creates a fresh one.
Assigning HTML into a dead process is pointless; reloading the frame into a
clean process then pushing content is more likely to succeed.

### 15.5 Dispose + Recreate the Webview View

**Current:** We mutate the existing `WebviewView` / `WebviewPanel` in-place.

**Proposed:** Call `view.dispose()`, let VS Code's provider system detect the
disposed view, and call `resolveWebviewView()` with a fresh instance. This is
the closest thing to a "soft restart" of the webview host without restarting
the entire VS Code window.

**Risk:** Timing is tricky — we need to wait for VS Code to recreate the view
before we can interact with it. The provider system may not trigger a recreate
reliably.

### 15.6 Force Webview Recreation via Visibility Toggle

**Current:** We focus the panel but don't toggle visibility.

**Proposed:** For sidebar mode: hide the sidebar (`workbench.action.closeSidebar`), wait 500ms, show it again (`workbench.action.focusSidebar`). VS Code may dispose and recreate the webview on re-show, giving us a fresh iframe.

### 15.7 Unload Beacon for Crash Forensics

**Current:** When the webview dies silently (OOM), we get no diagnostic
information from the dying process.

**Proposed:** Register a `beforeunload` handler in `installWebviewCrashGuard`:

```ts
window.addEventListener("beforeunload", () => {
    const hb = (window as any).__shoferHeartbeat
    // Store last-known state to localStorage so the NEXT webview instance
    // can report it in its webviewDidLaunch payload.
    try {
        localStorage.setItem("__shofer_last_unload", JSON.stringify({
            pingCount: hb?.pingCount ?? -1,
            pongCount: hb?.pongCount ?? -1,
            timestamp: Date.now(),
            memory: (performance as any).memory?.usedJSHeapSize,
        }))
    } catch {}
})
```

The fresh webview reads this in `webviewDidLaunch` and includes it:
```ts
vscode.postMessage({
    type: "webviewDidLaunch",
    priorUnload: JSON.parse(localStorage.getItem("__shofer_last_unload") || "null"),
})
```

This tells us: "the previous webview died after receiving N pings; its JS heap
was M bytes at unload time."

### 15.8 Webview-Side Long Task Observer

**Current:** The host only knows about liveness from the heartbeat.

**Proposed:** Use the `PerformanceObserver` API for `longtask` to detect when
the main thread is blocked:

```ts
try {
    const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
            if (entry.duration > 200) {  // 200ms+
                vscode.postMessage({
                    type: "long_task",
                    duration: entry.duration,
                    timestamp: Date.now(),
                })
            }
        }
    })
    observer.observe({ type: "longtask", buffered: true })
} catch {}
```

The host can correlate "long task reported at T" with "heartbeat RTT spiked at
T+1s" to confirm GC stalls as the root cause of webview unresponsiveness.

### 15.9 `navigator.sendBeacon` for Last-Ditch Diagnostics

**Current:** If the webview process is OOM-killed, no JavaScript runs.

**Proposed:** The `beforeunload` handler (see §15.7) could use `sendBeacon` to
post a final payload to a data URI. VS Code webviews don't have network access,
so this would need a custom URI scheme or a relay through the extension host.

**Risk:** High complexity for marginal gain. The localStorage approach (§15.7)
covers most cases with much less complexity.

### 15.10 Heartbeat Adaptive Threshold

**Current:** `LIVENESS_TIMEOUT_MS = 10_000` is static.

**Proposed:** Monitor the RTT history and auto-adjust the threshold:

- If RTT is consistently < 10ms: `LIVENESS_TIMEOUT_MS = 5_000` (fast detection)
- If RTT is consistently 100–500ms (large workspace, slow machine): `LIVENESS_TIMEOUT_MS = 15_000` (avoid false positives)
- If RTT is trending upward (memory leak): log a warning before the webview dies

```ts
// In _startHeartbeat, compute adaptive threshold from recent RTT
const avgRtt = rttHistory.length > 0
    ? rttHistory.reduce((a, b) => a + b, 0) / rttHistory.length
    : 0
const adaptiveTimeout = Math.max(5_000, Math.min(15_000, avgRtt * 20))
```

---

## 16. Related Files

| File | Role |
|------|------|
| [`webview-ui/src/index.tsx`](webview-ui/src/index.tsx) | `installWebviewCrashGuard()` IIFE: error listeners + pong responder + `__shoferHeartbeat` |
| [`webview-ui/src/components/ErrorBoundary.tsx`](webview-ui/src/components/ErrorBoundary.tsx) | React error boundary: forwards crashes to host |
| [`webview-ui/src/utils/vscode.ts`](webview-ui/src/utils/vscode.ts) | Shared `acquireVsCodeApi()` singleton |
| [`src/core/webview/ShoferProvider.ts`](src/core/webview/ShoferProvider.ts) | Heartbeat timer with RTT, `_resetWebview(trigger)`, `refreshWebview()` |
| [`src/core/webview/webviewMessageHandler.ts`](src/core/webview/webviewMessageHandler.ts) | Dispatching `pong`, `fatal_error`, `webviewDidLaunch` |
| [`src/activate/registerCommands.ts`](src/activate/registerCommands.ts) | Command registration for `shofer.refreshWebview` and `shofer.reloadWindow` |
| [`src/package.json`](src/package.json) | Command declarations, menu entries (`overflow@3` / `overflow@4`) |
| [`src/package.nls.json`](src/package.nls.json) | NLS labels: "Refresh Webview", "Reload Window" |
| [`packages/types/src/vscode.ts`](packages/types/src/vscode.ts) | `"refreshWebview"`, `"reloadWindow"` in `commandIds` |
| [`packages/types/src/message.ts`](packages/types/src/message.ts) | `"ping"`, `"pong"`, `"fatal_error"`, `"webviewDidLaunch"` type declarations |
