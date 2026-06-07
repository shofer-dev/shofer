# Multi-Threaded Architecture for Shofer

## 1. Overview

This document captures the gap between Shofer's **current** single-threaded
architecture and a **desired** multi-threaded architecture that decouples agent
execution from the VS Code Extension Host main thread. The core insight is that
**each Agent Worker is essentially a headless runtime of the extension** — the
same model already proven by the CLI (`apps/cli/`), which loads the full
esbuild-bundled `extension.js` inside a Node.js process with a `vscode-shim`
mock layer.

The desired architecture is based on the four-runtime model:

| Runtime                               | Role              | Runs what?                                                                                                                             |
| ------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Main Extension Host**               | "Hands"           | Real `vscode.*` API calls (editors, terminals, commands, `FileSystemWatcher`). Lifecycle management.                                   |
| **Server Worker** (`worker_thread`)   | "Bridge"          | Local WebSocket server on a dynamic port. Routes messages between Webview and Agent workers via `MessageChannel`.                      |
| **Agent Worker(s)** (`worker_thread`) | "Headless Shofer" | One `worker_thread` per active task. Runs the **full extension bundle** against a `vscode-shim` that routes through the Server Worker. |
| **Webview iframe**                    | "UI"              | React app connected to the Server Worker via WebSocket.                                                                                |

The critical simplification is: **the extension code is not refactored or
extracted**. Each Agent Worker loads the exact same `extension.js` bundle that
the CLI loads today, but with a custom `IExtensionHost` that bridges messages
through `MessageChannel` → Server Worker → WebSocket instead of the CLI's
`global.__extensionHost` → TUI/NDJSON stdout.

### 1.1 Why This Approach Works

The CLI already proves that the entire extension runs correctly in a headless
Node.js process with a mock `vscode` API. Key design elements already in place:

- **`vscode-shim`** ([`packages/vscode-shim/src/`](../packages/vscode-shim/src/))
  provides `FileSystemAPI` (real `fs.*` operations — no IPC needed for file
  reads/writes), `WindowAPI` (mock webview, mock terminal), `WorkspaceAPI`,
  `CommandsAPI`, and more. It talks to the outside world through the
  [`IExtensionHost`](../packages/vscode-shim/src/interfaces/extension-host.ts)
  interface.

- **`IExtensionHost`** two-event bridge:

    - `"extensionWebviewMessage"` — extension → webview/CLI messages
    - `"webviewMessage"` — webview/CLI → extension messages

- **Module resolution hook** — `Module._resolveFilename` redirects
  `require("vscode")` to an on-disk `vscode-mock.js`. The CLI carries an
  explicit comment that this on-disk file was **not** optional: in-memory cache
  entries and `_load` monkey-patches did not survive the ESM loader used by
  `tsx`. In a production Agent Worker the **CJS** extension bundle is loaded via
  `require`, so an in-memory `Module._resolveFilename` hook _should_ work
  without the temp file — but this is exactly the kind of "settled fact" the
  existing code already found painful, so **Phase 0 must spike it** rather than
  assume it. Note also that `WindowAPI.registerWebviewViewProvider` reads
  `global.__extensionHost` **directly**, so each worker must still set that
  global on its own isolate before loading the bundle (safe — every worker is a
  separate isolate; see §1.2).

- **Zero `ROO_CLI_RUNTIME` gating** — the extension source has no runtime
  conditionals. Every tool runs identically regardless of environment.

The only new piece is a **second `IExtensionHost` implementation** that bridges
through `MessageChannel` + WebSocket instead of the CLI's `global.__extensionHost`.

### 1.2 Worker Isolation Model — read this before every "runs unchanged" claim

`worker_threads` are **separate V8 isolates**, not threads sharing a heap. Each
Agent Worker has:

- its **own copy of every `require`d module** (including `prom-client`,
  `posthog-node`, the extension bundle, tiktoken encodings, tree-sitter WASM),
- its **own module registry, globals, and `ContextProxy` singleton**,
- **no shared JavaScript objects** with the main thread.

The only things shared across the isolate boundary are `SharedArrayBuffer` and
`MessagePort` (structured-clone message passing). Consequences the rest of this
document obeys:

1. A worker **cannot** write to a main-thread `prom-client` Counter/Gauge, call
   a main-thread `McpHub` method, or read a main-thread `ContextProxy` value
   in-process. Every such interaction is **explicit message passing**.
2. "Runs unchanged in the worker" means _the source is not edited_ — it does
   **not** mean it shares state with the main thread. Singletons are
   **duplicated per worker** unless explicitly owned by one runtime and reached
   via RPC (see §3.7 Ownership Table).
3. Per-worker duplication has a **memory cost** (§7) that must be measured
   before fixing a default pool size.

---

## 2. Current Architecture (Single-Threaded)

### 2.1 Thread Layout

Shofer runs **entirely** on the VS Code Extension Host main thread. The agent
loop, LLM streaming, tool execution, state serialization, and webview bridging
all compete for the same event loop.

```
┌──────────────────────────────────────────────────────────────┐
│                  Extension Host (Main Thread)                 │
│                                                              │
│  ┌─────────────┐  ┌──────────────────┐  ┌────────────────┐  │
│  │ ShoferProvider│  │  Task (Agent)    │  │ CodeIndexMgr   │  │
│  │  (5187 LOC)  │  │  (7040 LOC)      │  │  GitIndexMgr    │  │
│  │              │  │                  │  │  Search         │  │
│  │ • Webview    │  │ • recursivelyMake │  │  Glob           │  │
│  │   lifecycle  │  │   ShoferRequests │  │  MCP            │  │
│  │ • State      │  │ • LLM streaming  │  │  Skills         │  │
│  │   management │  │ • Tool dispatch  │  │  Marketplace    │  │
│  │ • postMessage│  │ • ask() system   │  │  TaskManager    │  │
│  │              │  │ • save/load      │  │  Checkpoints    │  │
│  └──────┬───────┘  └────────┬─────────┘  └────────────────┘  │
│         │                   │                                 │
│         ↓                   ↓                                 │
│  ┌──────────────────────────────────────────────────────┐    │
│  │              vscode.* API Surface                     │    │
│  │  workspace.fs  window.createTerminal  commands        │    │
│  │  window.activeTextEditor  workspace.findFiles         │    │
│  └──────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
         │
         │  postMessage (JSON serialization per push)
         ↓
┌──────────────────┐
│  Webview iframe  │
│  (React app)     │
│                  │
│  window.addEvent │
│  Listener("msg") │
└──────────────────┘
```

### 2.2 Existing Off-Main-Thread Work

| Component                  | Mechanism                                     | File                                                          |
| -------------------------- | --------------------------------------------- | ------------------------------------------------------------- |
| Token counting             | `workerpool` (1 worker)                       | [`src/workers/countTokens.ts`](../src/workers/countTokens.ts) |
| Subprocess execution       | `child_process.exec` / `execFile` / `spawn`   | ripgrep, git commands, terminal (`ExecuteCommandTool.ts`)     |
| **CLI (entire extension)** | **Separate Node.js process with vscode-shim** | [`apps/cli/`](../apps/cli/) — full headless runtime           |

The CLI is the critical precedent: it proves the extension can run entirely
outside the Extension Host. Our task is to adapt that model for `worker_thread`
co-location.

### 2.3 Critical Bottlenecks

#### 2.3.1 Double-Hop Serialization (Every LLM Token)

```
Agent (Task.say())
  → push to this.shoferMessages[]
  → postStateToWebview()                          [Hop 1: Main-thread JSON.stringify]
  → getStateToPostToWebview() builds giant state
  → postMessageToWebview({ type: "state", state })
  → this.view?.webview.postMessage(message)        [Serialized again by VS Code API]
  → Webview iframe message event                   [Hop 2: Browser deserialization]
  → ExtensionStateContext.handleMessage()
```

Every streaming token triggers a full `getStateToPostToWebview()` call that
serializes settings, task history, ALL shoferMessages, code index status, etc.
The `shoferMessagesSeq` guard in
[`ExtensionStateContext.tsx:226-234`](../webview-ui/src/context/ExtensionStateContext.tsx:226-234)
is a symptom of race conditions from this design.

#### 2.3.2 Single Thread for All Agents

All background tasks compete for the same event loop. The libuv threadpool bump
(`UV_THREADPOOL_SIZE=16` in [`extension.ts:11-13`](../src/extension.ts:11-13))
helps with filesystem I/O but does nothing for CPU-bound work.

#### 2.3.3 No Direct WebView ↔ Agent Path

No local WebSocket server, no `MessageChannel` between workers. Everything
routes through [`ShoferProvider.postMessageToWebview()`](../src/core/webview/ShoferProvider.ts:1893):

```typescript
public async postMessageToWebview(message: ExtensionMessage) {
    await this.view?.webview.postMessage(message)
}
```

---

## 3. Desired Architecture: Agent Workers as Headless Runtimes

### 3.1 Core Design Principle

**Each Agent Worker loads the full extension bundle** — the same
`dist/extension.js` that the CLI loads. It intercepts `require("vscode")` to
return a `vscode-shim` instance backed by a custom `IExtensionHost`. The worker
does **not** extract logic from `Task.ts` or `ShoferProvider.ts`; the entire
extension runs unchanged inside the worker.

The agent worker's `IExtensionHost` routes messages differently depending on
their destination:

| `vscode-shim` operation                                | Routes to…                                      | Why                                                                                                                                                                                                                 |
| ------------------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FileSystemAPI` (readFile, writeFile, stat, delete, …) | **Direct `fs.*`**                               | Works from any Node.js thread. VS Code auto-reloads open non-dirty editors via its own watcher; file-change tracking runs in-worker (§3.7). Keeps the hot path local for future remote agents on a shared FS layer. |
| `WindowAPI.createTerminal`                             | **Main Thread** via `parentPort`                | Needs real `vscode.window.createTerminal` or PTY.                                                                                                                                                                   |
| `WindowAPI.showTextDocument`                           | **Main Thread** via `parentPort`                | Needs real `vscode.window.showTextDocument`.                                                                                                                                                                        |
| `CommandsAPI.executeCommand`                           | **Main Thread** via `parentPort`                | Most commands need the real `vscode.commands`.                                                                                                                                                                      |
| `mockWebview.postMessage` (extension → UI)             | **Server Worker** via `MessageChannel`          | Streaming tokens, tool results, state changes → WebSocket → Webview.                                                                                                                                                |
| `mockWebview.onDidReceiveMessage` (UI → extension)     | **Server Worker** via `MessageChannel`          | User input, button clicks ← WebSocket ← Webview.                                                                                                                                                                    |
| `WorkspaceAPI.applyEdit`                               | **Main Thread** via `parentPort`                | Needs real `vscode.workspace.applyEdit` for editor integration.                                                                                                                                                     |
| `WorkspaceAPI.findFiles`                               | **Main Thread** via `parentPort`                | Needs `vscode.workspace.findFiles` (or ripgrep — already works).                                                                                                                                                    |
| `WorkspaceConfiguration` (settings)                    | **Replicated at spawn** + **broadcast updates** | Static settings sent once; changes broadcast via Server Worker.                                                                                                                                                     |
| `ExtensionContext.globalState` / `workspaceState`      | **Direct filesystem**                           | Memento-based JSON persistence — same as CLI (`~/.vscode-mock/`).                                                                                                                                                   |

### 3.2 Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                   Extension Host (Main Thread)                    │
│                   "The Hands" — Real vscode.* only                │
│                                                                  │
│  ┌────────────────────────────────────────────────────────┐      │
│  │ ShoferProvider (thin):                                  │      │
│  │  • resolveWebviewView → spawn Server Worker, inject port│      │
│  │  • Spawn/terminate Agent Workers                       │      │
│  │  • Handle parentPort messages from Agent Workers:       │      │
│  │    - createTerminal, showTextDocument, applyEdit        │      │
│  │    - executeCommand, findFiles                          │      │
│  │  • CodeIndexManager (index orchestration only)          │      │
│  │  • McpServerManager (server lifecycle only)             │      │
│  │  • TaskManager (worker tracking)                        │      │
│  │  • FileSystemWatcher (code-index triggers)              │      │
│  └────────────────────────────────────────────────────────┘      │
│         │                                                         │
│         │ parentPort (minimal: only for real vscode API calls)    │
│         │                                                         │
└─────────┼─────────────────────────────────────────────────────────┘
          │
          │  Port number (one-time, injected into webview HTML)
          │
          ▼
┌──────────────────────────────────────────────────────────────┐
│           Server Worker (worker_thread)                       │
│           "The Bridge" — WebSocket + MessageChannel router    │
│                                                              │
│  ┌───────────────────────────────────────────────────────┐   │
│  │ ws.Server on ws://localhost:<dynamic-port>            │   │
│  │                                                       │   │
│  │ Responsibilities:                                      │   │
│  │  1. Accept WebSocket from Webview                      │   │
│  │  2. Route: WebSocket ↔ Agent Worker MessageChannel      │   │
│  │  3. Route: Agent Worker parentPort ↔ Main Thread        │   │
│  │     (only for vscode API calls: terminal, editor, etc.) │   │
│  │  4. Broadcast shared state changes (skills, MCP list,   │   │
│  │     settings) to all Agent Workers                      │   │
│  │  5. SkillsManager instance (single source of truth)     │   │
│  └───────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
          │                              │
          │  MessageChannel port1        │  MessageChannel port2
          ▼                              ▼
┌──────────────────────────┐  ┌──────────────────────────┐
│  Agent Worker 1          │  │  Agent Worker 2          │
│  "Headless Shofer"       │  │  "Headless Shofer"       │
│                          │  │                          │
│  const vscode = require( │  │  const vscode = require( │
│    "vscode"  // → shim   │  │    "vscode"  // → shim   │
│  )                       │  │  )                       │
│  require("./dist/        │  │  require("./dist/        │
│    extension.js")        │  │    extension.js")        │
│  activate(vscode.context)│  │  activate(vscode.context)│
│                          │  │                          │
│  ┌────────────────────┐  │  │  ┌────────────────────┐  │
│  │ Extension Bundle   │  │  │  │ Extension Bundle   │  │
│  │ • Task             │  │  │  │ • Task             │  │
│  │ • ShoferProvider   │  │  │  │ • ShoferProvider   │  │
│  │ • McpHub           │  │  │  │ • McpHub           │  │
│  │ • CodeIndexManager │  │  │  │ • CodeIndexManager │  │
│  │ • ApiHandler       │  │  │  │ • ApiHandler       │  │
│  │ • All tools        │  │  │  │ • All tools        │  │
│  └────────────────────┘  │  │  └────────────────────┘  │
│                          │  │                          │
│  File I/O: direct fs.*   │  │  File I/O: direct fs.*   │
│  Terminal: → parentPort  │  │  Terminal: → parentPort  │
│      → Main Thread       │  │      → Main Thread       │
│  UI: → serverPort        │  │  UI: → serverPort        │
│      → Server Worker     │  │      → Server Worker     │
│      → WebSocket         │  │      → WebSocket         │
│      → Webview           │  │      → Webview           │
└──────────────────────────┘  └──────────────────────────┘

┌──────────────────┐
│  Webview iframe  │
│  (React app)     │
│                  │
│  new WebSocket(  │  ← Direct connection to Server Worker
│    `ws://local   │    (bypasses Main Thread entirely)
│     host:<port>` │
│  )               │
└──────────────────┘
```

> **Diagram caveat:** the per-worker boxes above list `McpHub` and
> `CodeIndexManager` for illustration only. Per §3.7 these are **owned by a
> single runtime** (the main thread) and reached via RPC — they are **not**
> duplicated inside every Agent Worker. The §3.7 Ownership Table is
> authoritative wherever it disagrees with this diagram.

### 3.3 Data Flow: Streaming LLM Tokens (Desired)

```
Agent Worker (extension bundle, running unchanged):
  Task.say("assistant_message", text)
    → mockWebview.postMessage({ type: "state", state: { shoferMessages: [...] } })
    → IExtensionHost.emit("extensionWebviewMessage", message)
    → serverPort.postMessage(message)           [MessageChannel, structured clone]

Server Worker:
  serverPort.on("message", (msg) => {
    ws.send(JSON.stringify(msg))               [WebSocket, to Webview]
  })

Webview:
  ws.onmessage = (event) => {
    dispatch(JSON.parse(event.data))            [React state update]
  }
```

**Main Thread for token streaming: 0% involvement, zero serialization.** This
0% applies _only_ to LLM token streaming and other pure-data updates. A
tool-heavy task still hops the main thread for terminal output chunks (every
chunk of `ExecuteCommandTool`), diff previews, `executeCommand`, and watcher
events — see §3.6. The headline is "no serialization for streaming," not "no
main-thread involvement for a whole task."

### 3.4 Data Flow: Tool Execution Needing vscode API (Desired)

```
Agent Worker:
  ExecuteCommandTool.execute()
    → vscode.window.createTerminal(...)         [hits WindowAPI mock]
    → WindowAPI.createTerminal()
    → parentPort.postMessage({                  [IPC to Main Thread]
        type: "vscode_api",
        method: "createTerminal",
        args: [...]
      })

Main Thread (ShoferProvider):
  parentPort.on("message", async (msg) => {
    if (msg.method === "createTerminal") {
      const terminal = vscode.window.createTerminal(...)
      // Stream output back
      terminal.onDidWriteData((data) => {
        parentPort.postMessage({ type: "terminal_output", data })
      })
      parentPort.postMessage({ type: "vscode_api_result", ... })
    }
  })
```

This is a **single hop** through the main thread, and only for the ~7 tool
types that genuinely need `vscode.*` APIs. All file I/O, grep, glob, MCP calls,
and LLM operations run directly in the worker without touching the main thread.

### 3.5 Adapting the vscode-shim: Two `IExtensionHost` Implementations

The [`IExtensionHost`](../packages/vscode-shim/src/interfaces/extension-host.ts)
interface is the extension point. Today there is one implementation:
the CLI's [`ExtensionHost`](../apps/cli/src/agent/extension-host.ts). We need
one more:

| Implementation                | Used by      | `"extensionWebviewMessage"` routes to…                           | `"webviewMessage"` routes from…     |
| ----------------------------- | ------------ | ---------------------------------------------------------------- | ----------------------------------- |
| `CliExtensionHost` (existing) | CLI process  | TUI (Ink) or NDJSON stdout                                       | TUI keyboard input or stdin NDJSON  |
| `WorkerExtensionHost` (new)   | Agent Worker | `serverPort.postMessage()` → Server Worker → WebSocket → Webview | Server Worker ← WebSocket ← Webview |

The `WorkerExtensionHost` is the key new piece:

```typescript
// src/workers/worker-extension-host.ts (NEW)
import { parentPort } from "worker_threads"

export class WorkerExtensionHost implements IExtensionHost {
	constructor(
		private serverPort: MessagePort, // → Server Worker (for UI)
	) {}

	// Extension → Webview: route through Server Worker
	emit(event: string, message: unknown): boolean {
		if (event === "extensionWebviewMessage") {
			this.serverPort.postMessage(message)
			return true
		}
		// vscode API calls: route through parentPort → Main Thread
		if (event === "vscodeApi") {
			parentPort?.postMessage(message)
			return true
		}
		return false
	}

	// Webview → Extension: listen on Server Worker port
	on(event: string, listener: (msg: unknown) => void): this {
		if (event === "webviewMessage") {
			this.serverPort.on("message", listener)
		}
		return this
	}

	// ... registerWebviewProvider, isInInitialSetup, markWebviewReady stubs
}
```

The `vscode-shim`'s [`WindowAPI.registerWebviewViewProvider`](../packages/vscode-shim/src/api/WindowAPI.ts:206-311)
already creates a `mockWebview` whose `postMessage` calls
`global.__extensionHost.emit("extensionWebviewMessage", message)`. With
`WorkerExtensionHost`, the same code path transparently routes through
`MessageChannel` → Server Worker → WebSocket → Webview.

**`WorkerExtensionHost` must implement the full `IExtensionHost` interface, not
just `emit`/`on`.** `WindowAPI.registerWebviewViewProvider` actively calls
`isInInitialSetup()` and `markWebviewReady()` and registers the provider via
`registerWebviewProvider()` — these are load-bearing, not optional stubs.
Because that same method reads `global.__extensionHost` **directly**, the Agent
Worker bootstrap must set `global.__extensionHost = workerHost` on its own
isolate before loading the bundle. The per-isolate global is private to the
worker, so there is no cross-worker contamination.

### 3.6 What Moves Where

**The critical point: almost nothing moves.** The extension bundle runs
unchanged in the Agent Worker. The vscode-shim transparently routes operations:

| Operation                                     | Handled by…                                                                     | Touches Main Thread?                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `workspace.fs.readFile/writeFile/stat/delete` | `FileSystemAPI` (direct `fs.*`)                                                 | ❌ No (VS Code auto-reloads editors; tracking is in-worker) |
| `workspace.findFiles` (glob)                  | `GlobService` → ripgrep subprocess                                              | ❌ No (ripgrep is a child process)                          |
| `workspace.applyEdit` (diff preview only)     | **Main Thread** via `parentPort` → real `vscode.workspace.applyEdit`            | ✅ Yes (diff view only — actual writes go direct `fs.*`)    |
| `window.createTerminal`                       | **Main Thread** via `parentPort` → real `vscode.window.createTerminal`          | ✅ Yes                                                      |
| `window.showTextDocument`                     | **Main Thread** via `parentPort` → real `vscode.window.showTextDocument`        | ✅ Yes                                                      |
| `commands.executeCommand`                     | **Main Thread** via `parentPort` → real `vscode.commands.executeCommand`        | ✅ Yes                                                      |
| `window.activeTextEditor`                     | **Main Thread** via `parentPort` → real `vscode.window.activeTextEditor`        | ✅ Yes                                                      |
| LLM API calls (`ApiHandler`)                  | Direct HTTP in Agent Worker                                                     | ❌ No                                                       |
| MCP tool calls (`McpHub.callTool`)            | **Shared `McpHub` on main thread** via `parentPort` RPC (async)                 | ✅ Yes (lightweight async RPC — see §3.7)                   |
| Ripgrep / grep / git commands                 | `child_process` subprocess in Agent Worker                                      | ❌ No                                                       |
| Token counting                                | Direct in Agent Worker (no separate workerpool needed)                          | ❌ No                                                       |
| Checkpoint git operations                     | Direct `execFile` in Agent Worker                                               | ❌ No                                                       |
| File watchers                                 | **Main Thread** (needs `vscode.FileSystemWatcher`)                              | ✅ Yes                                                      |
| UI streaming (webview)                        | `MessageChannel` → Server Worker → WebSocket                                    | ❌ No                                                       |
| Webview → Extension messages                  | WebSocket → Server Worker → `MessageChannel`                                    | ❌ No                                                       |
| Settings read                                 | Replicated at spawn + broadcast on change                                       | ❌ No                                                       |
| Skills metadata                               | Server Worker (single copy, broadcast)                                          | ❌ No                                                       |
| Task history (read/write)                     | Direct filesystem (JSON files) in Agent Worker                                  | ❌ No                                                       |
| `ContextProxy` (settings/secrets)             | **Read replica** in worker (snapshot + broadcast); writes → main thread via RPC | ✅ Yes (writes only; reads are local)                       |

**The main thread only handles operations that genuinely need the VS Code editor
surface: terminals, editor manipulation, commands, and reconciling worker-local
file writes back into open editors.** Everything else — which is the vast
majority of agent work — runs in the worker.

### 3.7 Singleton Ownership Table

Because singletons are duplicated per worker (§1.2), each one must have a
declared **owner** and a declared **access path**. This table is authoritative;
any "runs unchanged" row elsewhere is subject to it.

| Singleton                                                            | Owner                                  | How workers reach it                                                                                                                                                                                                                   | Rationale                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `McpHub` / MCP server processes                                      | **Main thread (single instance)**      | Worker → `parentPort` RPC → `McpHub.callTool()` → result back                                                                                                                                                                          | MCP calls are async network/stdio I/O and the hub is a lightweight pass-through, so one instance avoids N duplicate stdio server processes and N SSE connections. **Revisit only if** a tool performs heavy CPU work _inside_ the hub thread — a blocking hub would argue for per-worker instances.                                    |
| `CodeIndexManager` (build + watchers)                                | **Main thread**                        | n/a (owns indexing + `FileSystemWatcher`)                                                                                                                                                                                              | Index build and `.gitignore` watching need the editor surface and must not be duplicated.                                                                                                                                                                                                                                              |
| `CodeIndexManager` (search/query)                                    | **Main thread, queried via RPC**       | Worker → `parentPort` RPC → `CodeIndexManager.search()`                                                                                                                                                                                | Single embedded vector store, queried by all workers.                                                                                                                                                                                                                                                                                  |
| `ContextProxy` (settings + secrets)                                  | **Main thread = authoritative writer** | Read replica injected at spawn (`workerData`) + broadcast on change; worker-originated writes go via `parentPort` RPC to the main-thread `ContextProxy`                                                                                | Preserves the repo's single-source-of-truth / single-writer invariant for `globalState`/`secrets`; prevents settings split-brain.                                                                                                                                                                                                      |
| `TelemetryService` (`posthog-node`)                                  | **Main thread**                        | Worker `captureEvent()` shim → `parentPort` fire-and-forget → `TelemetryService.instance`                                                                                                                                              | `machineId` + VS Code telemetry gate only resolvable on the main thread; no per-worker PostHog client.                                                                                                                                                                                                                                 |
| `prom-client` registry                                               | **Main thread**                        | Worker shim → `parentPort` → main-thread registry write                                                                                                                                                                                | Separate isolates ⇒ **no shared registry**; all worker metrics are forwarded (corrects the earlier "in-process" assumption — see §9).                                                                                                                                                                                                  |
| Workspace **file writes**                                            | **Worker-local `fs.*`**                | Worker writes directly; `Task.fileContextTracker` (which lives in the worker) issues the `captureOriginal`/`trackFileContext` calls and writes snapshots to disk, surfacing in `FileChangesPanel` via the normal worker→webview stream | Keeps the hot write path local — essential once agents run remotely against a shared FS layer, where per-write main-thread RPC is prohibitively expensive. **No custom editor reconciliation:** VS Code auto-reloads open non-dirty editors via its own watcher, and dirty-file conflicts are pre-existing (architecture-independent). |
| `FileSystemWatcher` (incl. `FileContextTracker`'s user-edit watcher) | **Main thread**                        | Watch events broadcast to workers as needed                                                                                                                                                                                            | Needs real `vscode.FileSystemWatcher`. `FileContextTracker.setupFileWatcher` uses one to detect _user_ edits to tracked files; events route back into the owning worker.                                                                                                                                                               |

---

## 4. Implementation Plan

**Phasing constraint**: every phase must leave the extension **fully
functional** — all tools, all modes, all existing tests passing. Phases are
ordered so that infrastructure is built and verified **before** any traffic
moves onto it.

### Phase 0: vscode-shim Augmentation (no traffic moved)

**Goal**: Add the IPC routing hooks to the vscode-shim without changing any
behavior. The extension still runs entirely on the main thread.

1.  **Add optional `"vscodeApi"` forwarding to `WindowAPI` and `CommandsAPI`.**
    When a `parentPort` is provided at shim-creation time, methods that need
    the real VS Code API (`createTerminal`, `showTextDocument`,
    `executeCommand`) forward the call through `parentPort.postMessage()`.
    When no `parentPort` is provided (current code paths), they behave exactly
    as they do today.

2.  **Add `workerData`-based shim injection to `createVSCodeAPI`.**
    Currently `global.__extensionHost` is the only way to pass an
    `IExtensionHost`. Add a `workerData` path so a worker bootstrap can pass
    the host without touching globals.

3.  **Add unit tests for the new code paths.** Verify that with `parentPort`
    wired, `WindowAPI.createTerminal` emits the expected IPC message, and
    without it, the existing mock behavior is preserved.

    **✅ Functional check**: All existing tests pass. No runtime behavior
    change — the new code paths are dormant.

### Phase 1: Server Worker + Agent Worker bootstrap (infrastructure, no traffic moved)

**Goal**: Build the Server Worker, `WorkerExtensionHost`, and Agent Worker
bootstrap — all compiled, tested, and ready — but route **zero** production
traffic through them yet. The extension still runs entirely on the main thread.

1.  **Create [`src/workers/server-worker.ts`](../src/workers/server-worker.ts)**
    – `ws.Server` on a dynamic port. Accept one WebSocket connection. Expose
    the port via `parentPort.postMessage`. Maintain a `Map<taskId, MessagePort>`
    for future Agent Worker routing (unused at this stage).

2.  **Create [`src/workers/worker-extension-host.ts`](../src/workers/worker-extension-host.ts)**
    – `WorkerExtensionHost` implementing `IExtensionHost`. Wired to a
    `MessagePort` (→ Server Worker) and `parentPort` (→ Main Thread).

3.  **Create [`src/workers/agent-worker.ts`](../src/workers/agent-worker.ts)**
    – Bootstrap that receives `taskId`, `cwd`, `serverPort` (MessagePort),
    and a settings snapshot. Intercepts `require("vscode")`, creates a
    `vscode-shim` with `WorkerExtensionHost`, loads `dist/extension.js`,
    calls `activate()`. Compiled and import-tested, not spawned yet.

4.  **Unit-test all three modules.** `ServerWorker` starts and accepts a
    WebSocket. `WorkerExtensionHost` routes messages correctly through both
    ports. `AgentWorker` bootstrap loads the extension bundle without errors.

    **✅ Functional check**: All existing tests pass. New worker modules are
    compiled and unit-tested. No runtime behavior change — the Server Worker
    is not spawned, the Webview has no WebSocket connection yet.

### Phase 2: First Agent Worker (single task)

**Goal**: Spawn the Server Worker, wire up the Webview WebSocket connection,
and move exactly **one** task into an Agent Worker. This is the first phase
where production traffic enters the worker path.

1.  **Spawn the Server Worker and wire the Webview.**
    [`ShoferProvider.resolveWebviewView()`](../src/core/webview/ShoferProvider.ts)
    spawns the Server Worker, receives the port, injects it into the webview
    HTML. The Webview opens a WebSocket to the Server Worker.

2.  **Limit to 1 concurrent Agent Worker** so the blast radius is minimal.

3.  **Wire user input routing through the Server Worker.**
    When the active task runs in a worker: Webview → WebSocket →
    Server Worker → MessageChannel → Agent Worker →
    `webviewMessage` event → `ShoferProvider.handleWebviewMessage`.

4.  **Wire UI streaming through the Server Worker.**
    `Task.say()` → `mockWebview.postMessage()` →
    `WorkerExtensionHost.emit("extensionWebviewMessage")` →
    `serverPort.postMessage()` → Server Worker → WebSocket → Webview.

5.  **Wire vscode API calls through `parentPort`.**
    Agent Worker's `WindowAPI.createTerminal` → `parentPort.postMessage()` →
    Main Thread → `vscode.window.createTerminal()` → stream output back.

    **✅ Functional check**: A single task executes in a worker. All tools
    work — file reads, grep, terminal commands, MCP calls, LLM streaming.
    Existing test suite passes.

### Phase 3: Replace `postStateToWebview` with Incremental Messaging

**Goal**: Stop serializing the full `ExtensionState` on every UI update.
This is a pure optimization that can be done independently — it benefits
both the worker path and the main-thread path.

1.  **Define incremental message types in `@shofer/types`.**
    `{ type: "assistant_text", taskId, text }`, `{ type: "tool_use", ... }`,
    `{ type: "tool_result", ... }`, `{ type: "task_state", ... }`,
    `{ type: "config_update", key, value }`,
    `{ type: "init", settings, ... }`.

2.  **Update `Task.say()` to emit incremental messages alongside full state.**
    During the transition, emit **both** the incremental message (via
    WebSocket or `shoferMessageAppended`) **and** the full state push. The
    Webview uses the incremental path when available, falling back to full
    state.

3.  **Update the Webview to accumulate state from incremental messages.**
    `ExtensionStateContext` listens for the new message types and builds
    state client-side. When a full state push arrives, it serves as a
    reconciliation checkpoint.

4.  **Remove full-state pushes once the Webview migration is complete.**
    `getStateToPostToWebview()`, `postStateToWebview()`, and all
    `postStateToWebviewWithout*` variants are deleted from the main thread.

    **✅ Functional check**: The UI is responsive at every step. During the
    dual-emit transition, the Webview can use either path. After cleanup,
    only incremental messages flow on both the worker and main-thread paths.

### Phase 4: Multi-Agent Concurrency

**Goal**: Run multiple Agent Workers in parallel.

1.  **Worker pool** — limit configured by the experimental setting
    `shofer.experimental.agentWorkerPoolSize` (default: **4**), read via
    `ContextProxy` and surfaced in **Settings → Experimental**. On
    `startNewTask`, spawn an Agent Worker if the pool has capacity.

2.  **Shared state broadcast** — when skills, MCP servers, or settings
    change, the Server Worker broadcasts to all connected Agent Workers.

3.  **Per-task focus management** — `TaskManager` tracks which worker
    currently owns focus. The focused worker's messages are routed to the
    Webview. Background workers continue running but their UI updates are
    buffered.

4.  **Worker lifecycle** — workers terminate on task completion or
    cancellation. Idle workers (no active task) can be kept warm or
    terminated based on a TTL.

    **✅ Functional check**: Multiple tasks run concurrently. Parent-child
    task relationships work. Task switching in the UI correctly routes
    messages to the focused worker.

---

## 5. What Does NOT Change

This approach has a uniquely small blast radius because the extension code
itself is not refactored:

| Unchanged                              | Why                                                                                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Task.ts` (7040 LOC)                   | Runs unchanged in Agent Worker. `vscode-shim` transparently routes its API calls.                                                                       |
| `ShoferProvider.ts` (5187 LOC)         | Runs unchanged in Agent Worker. Mock webview routes through `WorkerExtensionHost`.                                                                      |
| `webviewMessageHandler.ts` (4447 LOC)  | Runs unchanged in Agent Worker. Messages arrive via `webviewMessage` event from `WorkerExtensionHost`.                                                  |
| `McpHub.ts`, all providers             | LLM providers run unchanged in the worker. **`McpHub` is the exception** — a single shared instance on the main thread (§3.7); workers call it via RPC. |
| All tools (`*Tool.ts`)                 | Run unchanged. Pure-data tools use direct `fs.*`; vscode-dependent tools route through `parentPort`.                                                    |
| `CodeIndexManager` (query path)        | Single instance on the main thread (§3.7); workers query via `parentPort` RPC. Source unchanged, but not duplicated per worker.                         |
| `ApiHandler`, all LLM providers        | Run unchanged. HTTP calls are network I/O.                                                                                                              |
| `buildTools()`, prompt generation      | Run unchanged. Pure data computation.                                                                                                                   |
| `webview-ui` React app                 | Mostly unchanged. Swaps `window.addEventListener("message")` for WebSocket.                                                                             |
| Extension bundle (`dist/extension.js`) | Identical. Zero runtime gating.                                                                                                                         |

---

## 6. What DOES Change

| Change                                                                         | Location                                                            | Effort                                                                            |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| New `WorkerExtensionHost` (~80 LOC)                                            | `src/workers/worker-extension-host.ts`                              | Small                                                                             |
| New `ServerWorker` (~300 LOC)                                                  | `src/workers/server-worker.ts`                                      | Medium                                                                            |
| New `AgentWorker` bootstrap (~120 LOC)                                         | `src/workers/agent-worker.ts`                                       | Small                                                                             |
| vscode-shim: support `workerData` injection                                    | `packages/vscode-shim/src/`                                         | Small                                                                             |
| vscode-shim: add `"vscodeApi"` event routing in `WindowAPI`, `CommandsAPI`     | `packages/vscode-shim/src/api/`                                     | Medium (augment existing mock methods to optionally forward through `parentPort`) |
| `ShoferProvider`: spawn workers instead of creating `Task` instances           | `src/core/webview/ShoferProvider.ts`                                | Large (but deletion-heavy — remove state serialization, add worker management)    |
| `TaskManager`: track workers instead of in-process tasks                       | `src/services/task-manager/TaskManager.ts`                          | Medium                                                                            |
| Incremental message protocol                                                   | `@shofer/types`, webview, extension                                 | Medium                                                                            |
| Webview: WebSocket connection                                                  | `webview-ui/src/context/ExtensionStateContext.tsx`                  | Medium                                                                            |
| New experimental setting `shofer.experimental.agentWorkerPoolSize` (default 4) | `packages/types/src/global-settings.ts`, Settings → Experimental UI | Small                                                                             |
| Worker-side metric/telemetry forwarding shims (`parentPort`)                   | `src/workers/*`, `src/metrics/`, `packages/telemetry/`              | Medium                                                                            |

---

### 7.1 Webview Health Monitoring (simplified)

The current architecture has a three-layer webview health system documented in
[`docs/webview-refresh-and-monitor.md`](webview-refresh-and-monitor.md):

- **Layer 1** — `installWebviewCrashGuard()` IIFE: error listeners, unhandled
  rejection handler
- **Layer 2** — `ErrorBoundary` React component
- **Layer 3** — Heartbeat timer with ping/pong loop and 30-second liveness timeout

**What stays:** Layers 1 and 2, `fatal_error` path, `webviewDidLaunch`
handshake, Refresh Webview button, Reload Window button, `_resetWebview()`,
`refreshWebview()`.

**What goes:** Layer 3 (heartbeat timer, `_startHeartbeat()`, `_stopHeartbeat()`,
`_recordPong()`, `_lastPongTs`, `_pingSentTs`, `_heartbeatRttHistory`,
`_heartbeatTickCount`, `HEARTBEAT_INTERVAL_MS`, `LIVENESS_TIMEOUT_MS`), the
experimental feature flag, the `"ping"` / `"pong"` IPC message types, and
the deferred hardening plan (§15 in the webview doc). All dependent RTT
diagnostic logging is removed.

**Why:** The WebSocket connection between Webview and Server Worker provides
immediate liveness detection. If the renderer process dies, the TCP connection
drops and the Server Worker knows instantly — no 30-second polling window
needed. The heartbeat was a workaround for `postMessage` having no failure
notification when the renderer died silently.

**What replaces it:** `_onWebviewLaunched()` triggers the WebSocket connection
handshake instead of `_startHeartbeat()`. `clearWebviewResources()` cleans up
the WebSocket state. The Server Worker detects WebSocket disconnect and
notifies the main thread, which can trigger `_resetWebview()`.

## 7. Risks and Trade-offs

| Risk                                     | Mitigation                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **vscode API calls have IPC overhead**   | Only ~7 tool types need vscode API; MCP calls add one shared-hub RPC hop. All others (files, grep, LLM, git) run directly in the worker. The IPC volume is tiny compared to token streaming.                                                                                                                                                                          |
| **Worker crash takes down one agent**    | Each agent is an isolated worker. Crash in Worker 1 doesn't affect Worker 2, the Server Worker, or the Main Thread.                                                                                                                                                                                                                                                   |
| **State synchronization across workers** | Persistent state is on-disk (JSON files). Workers read/write independently. Runtime-only state (skills, MCP list, settings) is replicated at spawn and broadcast on change.                                                                                                                                                                                           |
| **WebSocket port conflicts**             | Dynamic port allocation. Port regenerated on each activation.                                                                                                                                                                                                                                                                                                         |
| **Unauthenticated local control plane**  | The `ws://127.0.0.1:<port>` socket can drive an agent that executes arbitrary commands and reads the workspace. **Hard requirement (not an open question):** bind `127.0.0.1` only, require a per-session random token in the WS handshake, enforce a strict `Origin` allow-list, reject everything else. Mitigates local-process hijack and DNS-rebinding. See §9.1. |
| **Per-worker memory cost**               | Each worker heaps the full bundle + providers + tiktoken + tree-sitter WASM — potentially hundreds of MB at pool size 4. Measure the per-worker baseline in a Phase-1 spike before fixing the default `shofer.experimental.agentWorkerPoolSize`.                                                                                                                      |
| **Unbounded streaming backpressure**     | No native flow control on Worker → Server Worker → WS → Webview. Multiple workers streaming tokens can grow `MessageChannel`/WS buffers without bound. Coalesce rapid updates and apply a bounded queue (drop-oldest for non-critical UI updates).                                                                                                                    |
| **Webview CSP / `connect-src`**          | VS Code webviews run under strict CSP; connecting to `ws://localhost` from the `vscode-webview:` origin may be blocked. Validate `connect-src` in a Phase-1 spike before committing the Webview↔Server-Worker path. See §9.1.                                                                                                                                        |
| **Module resolution in workers**         | `worker_threads` support `require()`. The extension bundle is CJS. No `tsx` needed — the esbuild bundle runs directly.                                                                                                                                                                                                                                                |
| **Webview reconnect**                    | Webview reconnects to WebSocket on iframe reload. Server Worker replays current state.                                                                                                                                                                                                                                                                                |
| **Service initialization order**         | Extension bundle's `activate()` creates singletons per worker. Shared-by-design singletons (`McpHub`, `CodeIndexManager`, authoritative `ContextProxy`) must be **suppressed in the worker** and proxied to the main thread via RPC (§3.7) rather than instantiated locally. Global coordination (indexing, MCP server lifecycle) stays on the Main Thread.           |

---

## 8. Related Files

### Extension Bundle (runs unchanged in Agent Worker)

| File                                                                                        | Role                                             |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| [`src/extension.ts`](../src/extension.ts)                                                   | Extension activation, singleton creation         |
| [`src/core/webview/ShoferProvider.ts`](../src/core/webview/ShoferProvider.ts)               | Webview lifecycle, state management (5187 LOC)   |
| [`src/core/task/Task.ts`](../src/core/task/Task.ts)                                         | Agent loop, LLM streaming, ask system (7040 LOC) |
| [`src/core/webview/webviewMessageHandler.ts`](../src/core/webview/webviewMessageHandler.ts) | Webview→Host message dispatch (4447 LOC)         |
| [`src/api/index.ts`](../src/api/index.ts)                                                   | API handler factory                              |
| [`src/services/mcp/McpHub.ts`](../src/services/mcp/McpHub.ts)                               | MCP tool execution                               |
| [`src/services/code-index/manager.ts`](../src/services/code-index/manager.ts)               | Code indexing (query path)                       |

### New Worker Files

| File                                   | Role                                                                 |
| -------------------------------------- | -------------------------------------------------------------------- |
| `src/workers/worker-extension-host.ts` | `IExtensionHost` for Agent Workers (routes through `MessageChannel`) |
| `src/workers/agent-worker.ts`          | Agent Worker bootstrap: loads extension bundle, calls `activate()`   |
| `src/workers/server-worker.ts`         | Server Worker: WebSocket server + `MessageChannel` router            |

### Existing Precedent

| File                                                                                                                  | Role                                                                             |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [`apps/cli/src/agent/extension-host.ts`](../apps/cli/src/agent/extension-host.ts)                                     | CLI's `IExtensionHost` implementation (loads extension bundle, bridges to TUI)   |
| [`packages/vscode-shim/src/api/WindowAPI.ts`](../packages/vscode-shim/src/api/WindowAPI.ts)                           | Mock `window.*` API — `registerWebviewViewProvider`, `createTerminal`, etc.      |
| [`packages/vscode-shim/src/api/FileSystemAPI.ts`](../packages/vscode-shim/src/api/FileSystemAPI.ts)                   | Direct `fs.*` operations (works unchanged in workers)                            |
| [`packages/vscode-shim/src/interfaces/extension-host.ts`](../packages/vscode-shim/src/interfaces/extension-host.ts)   | `IExtensionHost` interface — the extension point                                 |
| [`packages/vscode-shim/src/api/create-vscode-api-mock.ts`](../packages/vscode-shim/src/api/create-vscode-api-mock.ts) | Factory that assembles the full vscode mock object                               |
| [`webview-ui/src/context/ExtensionStateContext.tsx`](../webview-ui/src/context/ExtensionStateContext.tsx)             | Webview state management                                                         |
| [`docs/headless.md`](headless.md)                                                                                     | CLI headless runtime documentation                                               |
| [`docs/public_api.md`](public_api.md)                                                                                 | `ShoferAPI` documentation — the control plane used by both CLI and Agent Workers |

## 9. Gaps & Open Questions

- **Interactive `task.ask()` in a worker**: The `ask()` system blocks the agent
  loop until the user clicks Accept/Reject in the webview. In the worker, this
  becomes: Agent Worker emits ask → Server Worker → WebSocket → Webview renders
  buttons → user clicks → WebSocket → Server Worker → Agent Worker → resolves
  the `ask()`. The existing `Task.ask()` implementation already works with a
  mock webview (proven by the CLI's auto-approval path). Interactive asks
  would follow the same message path.

- **`DiffViewProvider`**: Needs real VS Code editor API. The worker's
  `vscode-shim` would forward diff requests through `parentPort` → Main
  Thread, which opens the real diff view. Already a proven pattern from the
  CLI (which stubs diff views).

- **`TerminalRegistry`**: Terminal PTY management needs the VS Code Terminal
  API. The worker would forward terminal creation requests through
  `parentPort` → Main Thread. The CLI already proves the alternative
  (`execa` subprocess fallback in `ExecuteCommandTool.ts`).

- **Code index watchers**: `FileSystemWatcher` for `.gitignore` changes and
  file modifications must stay on the Main Thread. Index queries (the common
  case) run directly in the Agent Worker via `CodeIndexManager.search()`.

- **Multiple Agent Workers writing to the same task directory**: If two tasks
  share a parent-child relationship, they share a task directory on disk. The
  existing `TaskManager.persistVersions` (version-counter based latest-wins
  strategy) already handles concurrent writes.

- **esbuild entry points**: The current esbuild config produces a single CJS
  bundle. Workers need to `require()` the worker entry point separately. The
  simplest approach: add separate esbuild entry points for `agent-worker.js`
  and `server-worker.js`, or keep them as TypeScript files and use
  `worker_threads` with `tsx` in development.

- **Settings replication at spawn**: The Agent Worker needs a snapshot of
  current settings at spawn time (provider config, mode, auto-approval
  toggles). These can be serialized into `workerData`. On settings change,
  the Server Worker broadcasts a `config_update` message to all workers.

- **`ContextProxy` singleton conflict**: The extension's `ContextProxy` is a
  singleton. In a worker, it would need its own instance backed by the
  filesystem (same as the CLI's memento-based persistence). This is already
  solved by the CLI's `ExtensionContext` mock.

- **Telemetry (`TelemetryService` / PostHog)**: The current architecture has
  a single `TelemetryService` singleton on the main thread, with
  `ShoferProvider` as the `TelemetryPropertiesProvider`. In the multi-worker
  model:

    - **Agent Worker events**: `Task.ts`, tools, and providers running in Agent
      Workers emit telemetry events (task lifecycle, LLM completions, tool usage,
      errors). These must reach the main-thread `TelemetryService`.
    - **`vscode.env.machineId`**: Used by `PostHogTelemetryClient` as the
      distinct ID. Unavailable in workers.
    - **`vscode.workspace.getConfiguration("telemetry.telemetryLevel")`**: Used
      for the VSCode-global telemetry gate. Unavailable in workers.

    **Approach**: Telemetry events from Agent Workers are forwarded via
    `parentPort` as fire-and-forget messages to the main thread. The main thread
    relays them to `TelemetryService.instance`. The distinct ID and telemetry
    gate are resolved once on the main thread and included in the `workerData`
    snapshot at spawn. Worker-side code calls a thin `captureEvent()` wrapper
    that posts through `parentPort` instead of calling `TelemetryService`
    directly. No worker-side `posthog-node` instantiation.

    - **Webview-side telemetry** (`posthog-js`): Unaffected — runs in the
      browser context of the Webview iframe. Uses its own PostHog instance and
      `vscode` webview API for machine ID.

    See [`docs/telemetry.md`](telemetry.md) for the full telemetry architecture.

- **Prometheus / operational metrics**: The `prom-client`-backed metrics
  registry ([`src/metrics/registry.ts`](../src/metrics/registry.ts)) and HTTP
  server ([`src/metrics/server.ts`](../src/metrics/server.ts)) run on the main
  thread. **Correction:** although `worker_threads` live in the same OS
  process, each is a **separate V8 isolate with its own `prom-client` module
  instance** (§1.2) — a worker **cannot** write to the main-thread registry
  in-process. All worker-side metric writes are forwarded over `parentPort` to
  the main thread, which owns the single registry and the scrape endpoint.

    - **Counters and histograms**: `shofer_llm_calls_total`,
      `shofer_tool_duration_ms`, etc. are written via a thin worker-side shim
      that posts `{ metric, op, value, labels }` over `parentPort`; the main
      thread applies them to the single registry. There is no shared
      `prom-client` instance and no cross-isolate "thread-safe" registry.
    - **Memory gauges**: `process.memoryUsage()` in a worker returns that
      worker's V8 isolate memory, not the main thread's. Add per-worker memory
      gauges (`shofer_worker_heap_used_bytes{workerId}`) pushed from workers
      via `parentPort`. The on-scrape collector on the main thread continues to
      report the main thread's memory.
    - **GC monitoring**: GC events are per-isolate. Each worker installs its own
      `PerformanceObserver` and pushes GC duration samples to the shared
      histogram (or a per-worker variant).
    - **Event listener count**: The main-thread `ShoferProvider.listenerCount()`
      becomes meaningless when most work runs in workers. Replace with
      `shofer_workers_active` (Gauge, pushed from workers) and
      `shofer_workers_total` (Counter, incremented on spawn).

    See [`docs/prometheus.md`](prometheus.md) for the full metrics specification.

### 9.1 Resolved Decisions

The following former open questions now have committed answers (reflected in
§3.7 Ownership Table):

- **MCP ownership → single shared `McpHub` on the main thread.** Workers call
  tools via `parentPort` RPC. Justification: MCP calls are async I/O and the hub
  is a lightweight pass-through, so one instance avoids N duplicate stdio server
  processes. Revisit only if a tool performs heavy CPU work _inside_ the hub
  thread (a blocking hub would favor per-worker instances).
- **Code index → single instance on the main thread**, queried by workers via
  RPC; index build + watchers stay on the main thread.
- **Settings authority → main-thread `ContextProxy` is the single writer.**
  Workers receive a read replica at spawn (`workerData`) plus broadcast updates;
  worker-originated writes go back via `parentPort` RPC. Keeps the repo's
  single-source-of-truth / single-writer invariant intact.
- **File writes → worker-local `fs.*`, tracking in-worker.** Workers write
  directly (keeping the hot path off the main thread — essential once agents run
  remotely against a shared FS layer, where per-write RPC is too expensive).
  `Task.fileContextTracker` runs in the same worker and performs the
  `captureOriginal`/`trackFileContext` snapshotting that drives the
  `FileChangesPanel` (surfaced via the normal worker→webview stream). **No
  custom editor reconciliation is needed:** VS Code auto-reloads open non-dirty
  editors through its own file watching, and dirty-file conflicts are a
  pre-existing condition that exists identically in today's single-threaded
  mode. The only write-related main-thread dependency is
  `FileContextTracker`'s user-edit `createFileSystemWatcher` (covered by the
  general watcher rule), whose events route back into the owning worker.
- **Worker pool size → configurable.** New experimental setting
  `shofer.experimental.agentWorkerPoolSize` (default **4**), added to
  `globalSettingsSchema` and surfaced in **Settings → Experimental**. The Phase 4
  pool limit reads this value via `ContextProxy` rather than a hard-coded constant.
- **WebSocket security → hard requirement.** Bind `127.0.0.1`, per-session random
  token in the handshake, strict `Origin` allow-list, reject all else. An
  OWASP-class concern, not an optional hardening.
- **Webview CSP feasibility → Phase-1 spike.** VS Code webviews run under a
  strict CSP; connecting to `ws://localhost` from the `vscode-webview:` origin
  must be validated (correct `connect-src`) before the Webview↔Server-Worker
  path is committed — the whole UI path depends on it.
- **Command registration in workers → no-op.** Each worker's `activate()` hits
  the shim's `CommandsAPI.registerCommand`; worker-side registration must be a
  no-op (or routed to the main thread) to avoid duplicate-registration
  conflicts with the real `vscode.commands`.
- **Multiple webview connections.** The Server Worker must handle sidebar +
  editor webviews and reload-mid-stream reconnects with state replay — not a
  single fixed connection.
