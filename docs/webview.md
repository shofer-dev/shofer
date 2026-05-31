# Shofer Webview Architecture

This document explains how the Shofer webview UI communicates with the extension host, covering the full lifecycle from initialization through crash recovery.

## Architecture Overview

Shofer uses VS Code's [`WebviewViewProvider`](https://code.visualstudio.com/api/references/vscode-api#WebviewViewProvider) API to render its UI inside the VS Code sidebar. The architecture has two halves:

| Side               | Runtime                   | Language                  | Key Entry Point                                                            |
| ------------------ | ------------------------- | ------------------------- | -------------------------------------------------------------------------- |
| **Extension Host** | Node.js (VS Code process) | TypeScript                | [`src/core/webview/ShoferProvider.ts`](src/core/webview/ShoferProvider.ts) |
| **Webview UI**     | Browser (iframe sandbox)  | React + TypeScript + Vite | [`webview-ui/src/index.tsx`](webview-ui/src/index.tsx)                     |

The extension host is the **source of truth** for all state. The webview is a **pure renderer** — it has no autonomous data fetching or persistence. Every piece of data the UI displays arrives via `postMessage` from the host.

## Lifecycle

### 1. Registration

When VS Code activates the extension, [`extension.ts`](src/extension.ts:264) registers a `ShoferProvider` instance as the sidebar's webview view provider:

```typescript
vscode.window.registerWebviewViewProvider(ShoferProvider.sideBarId, provider, {
	webviewOptions: { retainContextWhenHidden: true },
})
```

`retainContextWhenHidden: true` keeps the webview iframe alive when the user switches tabs or hides the sidebar. This preserves React state and avoids re-initialization cost.

### 2. Webview Creation — `resolveWebviewView`

[`ShoferProvider.resolveWebviewView(webviewView)`](src/core/webview/ShoferProvider.ts:1230) is called by VS Code whenever the sidebar needs a webview:

1. **Idempotency guard** — if the same `WebviewView` reference is re-resolved, it short-circuits to prevent re-assigning `webview.html` (which triggers a service-worker conflict in Chromium).

2. **Set options** — `enableScripts: true`, `localResourceRoots` from extension URI + workspace folders.

3. **Build HTML** — In development mode, generates HTML pointing to the Vite HMR dev server ([`getHMRHtmlContent`](src/core/webview/ShoferProvider.ts:1907)). In production, inlines the bundled JS/CSS URIs ([`getHtmlContent`](src/core/webview/ShoferProvider.ts:2020)).

4. **Assign HTML** — `view.webview.html = html` triggers Chromium to load and execute the page.

5. **Wire message listener** — [`setWebviewMessageListener`](src/core/webview/ShoferProvider.ts:2094) routes all webview messages to [`webviewMessageHandler.ts`](src/core/webview/webviewMessageHandler.ts).

6. **Wait for `webviewDidLaunch`** — the heartbeat is deferred until the webview signals readiness.

### 3. Webview Bootstrap

When the HTML loads, [`webview-ui/src/index.tsx`](webview-ui/src/index.tsx) executes:

1. **Crash guard** — an IIFE installs `window.onerror` and `unhandledrejection` listeners that post `fatal_error` messages back to the host.

2. **Heartbeat pong responder** — an IIFE installs a raw `window.addEventListener("message")` listener that responds to `ping` with `pong`. This survives React crashes.

3. **React mount** — `<App />` wrapped in `<ErrorBoundary>` is rendered into `#root`.

### 4. Handshake — `webviewDidLaunch`

[`App.tsx`](webview-ui/src/App.tsx:198) posts `{ type: "webviewDidLaunch" }` on mount. This is the critical signal that tells the host "the renderer is ready."

The host responds in [`webviewMessageHandler.ts`](src/core/webview/webviewMessageHandler.ts:644):

```typescript
case "webviewDidLaunch":
    provider._onWebviewLaunched()  // starts ping/pong heartbeat (if experiment enabled)
    provider.postStateToWebview()  // pushes full state snapshot
```

### 5. State Hydration

The webview receives `{ type: "state" }` in [`ExtensionStateContext.handleMessage`](webview-ui/src/context/ExtensionStateContext.tsx:362):

```typescript
case "state":
    setState((prevState) => mergeExtensionState(prevState, newState))
    setDidHydrateState(true)
```

Until `didHydrateState === true`, [`App` returns `null`](webview-ui/src/App.tsx:230) — rendering nothing. This is intentional: without state from the host, the UI has nothing meaningful to show.

### 6. Ongoing Communication

After hydration, the host and webview communicate via typed messages:

**Webview → Host** (`WebviewMessage`):

- `webviewDidLaunch`, `fatal_error`, `pong` — lifecycle
- `askResponse`, `invoke` — user actions
- `settingsButtonClicked`, `chatButtonClicked` — navigation
- Settings mutations (auto-approval toggles, mode changes, etc.)

**Host → Webview** (`ExtensionMessage`):

- `state` — full state snapshot (on launch, settings changes)
- `messageUpdated`, `shoferMessageAppended` — incremental chat updates
- `parallelTasksUpdated` — task list changes
- `action` — navigation commands (`switchTab`, `tasksButtonClicked`)
- `theme` — color theme updates
- `skills`, `mcpServers` — configuration lists

### 7. Incremental Updates

To avoid re-serializing the entire state on every chat message, the host pushes incremental deltas:

- `shoferMessageAppended` — new chat message added
- `messageUpdated` — existing message modified (e.g., streaming updates)
- `parallelTasksUpdated` — task list changed

These bypass the full state snapshot and are applied directly by [`ExtensionStateContext`](webview-ui/src/context/ExtensionStateContext.tsx).

## Message Bridge

### Webview Side

[`webview-ui/src/utils/vscode.ts`](webview-ui/src/utils/vscode.ts) wraps `acquireVsCodeApi()` in a singleton:

```typescript
class VSCodeAPIWrapper {
	private readonly vsCodeApi: WebviewApi<unknown> | undefined
	constructor() {
		if (typeof acquireVsCodeApi === "function") {
			this.vsCodeApi = acquireVsCodeApi() // can only be called ONCE
		}
	}
	public postMessage(message: WebviewMessage) {
		if (this.vsCodeApi) {
			this.vsCodeApi.postMessage(message)
		} else {
			console.log(message) // fallback for browser dev mode
		}
	}
}
export const vscode = new VSCodeAPIWrapper()
```

Key constraints:

- `acquireVsCodeApi()` can only be called **once** per webview lifecycle. Calling it again throws synchronously.
- The singleton is a module-level `const` — if construction fails, React never mounts.
- There is no error handling for `postMessage` failures (dead host, disconnected channel). Messages are silently dropped.

### Host Side

[`ShoferProvider.postMessageToWebview(message)`](src/core/webview/ShoferProvider.ts:1783):

```typescript
public async postMessageToWebview(message: ExtensionMessage) {
    if (this._disposed) { return }
    try {
        await this.view?.webview.postMessage(message)
    } catch {
        // View disposed, drop message silently
    }
}
```

Messages are dropped silently when `this.view` is `undefined` (not yet resolved, or disposed).

## Crash Detection (Liveness Monitor)

Shofer has a liveness monitoring infrastructure, but it is **gated behind the `WEBVIEW_LIVENESS_MONITOR` experiment flag** (default: off).

### Components

| Layer               | Location                                                                     | What It Does                                                    | Status          |
| ------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------- | --------------- |
| Crash guard         | [`index.tsx`](webview-ui/src/index.tsx:22)                                   | Posts `fatal_error` on uncaught errors and unhandled rejections | Always active   |
| Error boundary      | [`ErrorBoundary.tsx`](webview-ui/src/components/ErrorBoundary.tsx)           | Catches React render crashes → posts `fatal_error`              | Always active   |
| Ping/pong heartbeat | [`ShoferProvider._startHeartbeat()`](src/core/webview/ShoferProvider.ts:839) | Host pings every 5s, expects pong within 30s                    | Experiment only |
| Fatal error handler | [`ShoferProvider._onFatalError()`](src/core/webview/ShoferProvider.ts:906)   | Receives `fatal_error` → logs + optionally resets webview       | Experiment only |
| Webview reset       | [`ShoferProvider._resetWebview()`](src/core/webview/ShoferProvider.ts:1018)  | Re-assigns `webview.html` to force reload                       | Experiment only |
| Manual refresh      | [`ShoferProvider.refreshWebview()`](src/core/webview/ShoferProvider.ts:939)  | User-triggered forceful reload via VS Code command              | Experiment only |

### Why the Heartbeat is Deferred

The heartbeat MUST NOT start until the webview sends `webviewDidLaunch`. Starting it during HTML loading would count every ping sent during bundle load as a liveness miss, triggering an infinite reset loop.

### Why `fatal_error` Alone Can't Detect All Crashes

The `fatal_error` message is sent by the webview's crash guard listeners. These are JavaScript-level handlers — they fire for uncaught exceptions and rejections **within the webview's JS context**. They do NOT fire when:

- The extension host process dies (host-side crash)
- The webview's `acquireVsCodeApi()` channel is orphaned (no error thrown, messages just disappear)
- The webview iframe is torn down by VS Code

## Extension Host Recovery Problem

When the extension host dies and VS Code restarts it:

1. `retainContextWhenHidden: true` may preserve the webview iframe across the crash
2. The preserved iframe's `acquireVsCodeApi()` handle is bound to the **dead** host process
3. The webview's `postMessage` calls silently disappear — the `webviewDidLaunch` message never reaches the new host
4. The new host may or may not call `resolveWebviewView` again
5. Even if the host pushes new state, it goes to a new view, not the orphaned iframe

This is the subject of [`todos/webview-ui-blank-page.md`](../../todos/webview-ui-blank-page.md).

## Key Files

| File                                                                                                   | Role                                                            |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| [`src/extension.ts:264`](src/extension.ts:264)                                                         | Registers ShoferProvider as WebviewViewProvider                 |
| [`src/core/webview/ShoferProvider.ts:1230`](src/core/webview/ShoferProvider.ts:1230)                   | `resolveWebviewView` — host-side webview lifecycle              |
| [`src/core/webview/ShoferProvider.ts:2020`](src/core/webview/ShoferProvider.ts:2020)                   | `getHtmlContent` — production HTML generation                   |
| [`src/core/webview/ShoferProvider.ts:1907`](src/core/webview/ShoferProvider.ts:1907)                   | `getHMRHtmlContent` — dev/HMR HTML generation                   |
| [`src/core/webview/ShoferProvider.ts:2848`](src/core/webview/ShoferProvider.ts:2848)                   | `postStateToWebview` — pushes full state to webview             |
| [`src/core/webview/ShoferProvider.ts:1783`](src/core/webview/ShoferProvider.ts:1783)                   | `postMessageToWebview` — wrapped `view?.webview.postMessage()`  |
| [`src/core/webview/ShoferProvider.ts:839`](src/core/webview/ShoferProvider.ts:839)                     | `_startHeartbeat` — ping/pong liveness monitor                  |
| [`src/core/webview/ShoferProvider.ts:906`](src/core/webview/ShoferProvider.ts:906)                     | `_onFatalError` — crash report handler                          |
| [`src/core/webview/ShoferProvider.ts:1018`](src/core/webview/ShoferProvider.ts:1018)                   | `_resetWebview` — webview reload                                |
| [`src/core/webview/ShoferProvider.ts:2094`](src/core/webview/ShoferProvider.ts:2094)                   | `setWebviewMessageListener` — wires host message handler        |
| [`src/core/webview/webviewMessageHandler.ts`](src/core/webview/webviewMessageHandler.ts)               | Routes all webview messages to handlers                         |
| [`webview-ui/src/index.tsx`](webview-ui/src/index.tsx)                                                 | Webview entry point — crash guard, heartbeat, React mount       |
| [`webview-ui/src/utils/vscode.ts`](webview-ui/src/utils/vscode.ts)                                     | `acquireVsCodeApi()` singleton wrapper                          |
| [`webview-ui/src/App.tsx`](webview-ui/src/App.tsx)                                                     | Main React component — sends `webviewDidLaunch`, routes tabs    |
| [`webview-ui/src/context/ExtensionStateContext.tsx`](webview-ui/src/context/ExtensionStateContext.tsx) | State synchronization — receives all host messages              |
| [`webview-ui/src/components/ErrorBoundary.tsx`](webview-ui/src/components/ErrorBoundary.tsx)           | React error boundary → `fatal_error`                            |
| [`packages/types/src/message.ts`](packages/types/src/message.ts)                                       | Message type definitions (`WebviewMessage`, `ExtensionMessage`) |
