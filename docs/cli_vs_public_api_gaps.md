# CLI vs Public API: Gap Analysis

This document analyzes the differences between the two ways of driving Shofer
programmatically: the **CLI** (headless runtime) and the **Public Extension API**
(for companion VSCode extensions). The goal is to identify asymmetries and
ultimately converge on a single, symmetric API.

## Communication Paths

Both paths ultimately create and execute tasks through
[`ShoferProvider.createTask()`](../src/core/webview/ShoferProvider.ts), but they
reach it through completely different entry points.

```
┌─────────────────────────────────────────────────────────────────┐
│                        ShoferProvider                           │
│                     .createTask(text, …)                        │
│                    .cancelTask()                                │
│                    .postStateToWebview()                        │
│                    .postMessageToWebview()                      │
└────────────▲──────────────────────────▲─────────────────────────┘
             │                          │
    ┌────────┴────────┐        ┌────────┴───────────┐
    │  Public API     │        │  WebviewMessage     │
    │  (api.ts)       │        │  Handler            │
    │                 │        │  (webviewMessage    │
    │  startNewTask() │        │   Handler.ts)       │
    │  cancelTask()   │        │                     │
    │  sendMessage()  │        │  type: "newTask"    │
    │  resumeTask()   │        │  type: "cancelTask" │
    └────────┬────────┘        │  type: "askResponse"│
             │                 └────────┬────────────┘
             │                          │
    ┌────────┴────────┐        ┌────────┴───────────┐
    │  Companion      │        │  vscode-shim       │
    │  Extensions     │        │  Webview Bridge    │
    │  (orchestrator) │        │                    │
    │                 │        │  Pipes WebviewMsg  │
    │  vscode.ext.    │        │  through Event-    │
    │  getExtension() │        │  Emitter to        │
    │  .exports       │        │  ShoferProvider    │
    └─────────────────┘        └────────┬───────────┘
                                        │
                               ┌────────┴───────────┐
                               │  CLI ExtensionHost  │
                               │                     │
                               │  sendToExtension()  │
                               │  → emit("webview    │
                               │    Message", msg)   │
                               └─────────────────────┘
```

**Key observation (now partially resolved):** The CLI calls `activate()` which
returns a `ShoferAPI` instance. Previously it was stored as `unknown` and never
used. Now it's typed as `ShoferAPI` and used for `runTask()` and `resumeTask()`.
See [`extension-host.ts`](../apps/cli/src/agent/extension-host.ts).

## Gap 1: Different Method Signatures for `startNewTask` ✅ PARTIALLY RESOLVED

| Aspect            | CLI (now)                                                                  | Public API (`ShoferAPI`)                                    |
| ----------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Message type      | `extensionAPI.startNewTask({ configuration, text, images })`               | `api.startNewTask({ configuration, text, images, newTab })` |
| Returns           | `Promise<void>` (blocks via `waitForTaskCompletion()`)                     | `Promise<string>` (returns task ID immediately)             |
| Settings          | `configuration` (partial `ShoferSettings`)                                 | `configuration` (partial `ShoferSettings`)                  |
| `newTab`          | Not supported                                                              | Supported                                                   |
| `taskId` override | Lost (was `taskId` field on WebviewMessage; now not exposed via ShoferAPI) | Not exposed                                                 |

**Resolution:** The CLI now calls `extensionAPI.startNewTask()` instead of raw
`sendToExtension({ type: "newTask" })`. The `taskId` override was lost in the
transition — if needed, it can be added to the `ShoferAPI` interface.

## Gap 2: Different Event Systems

The CLI and Public API have **completely separate event systems** with zero
overlap in event names or payload shapes.

### Public API Events (27 typed events)

Defined in [`ShoferEventName`](../packages/types/src/events.ts:12) and
[`ShoferEvents`](../packages/types/src/events.ts:65) (Zod schemas):

- `taskCreated`, `taskStarted`, `taskCompleted`, `taskAborted`, `taskError`
- `taskFocused`, `taskUnfocused`, `taskActive`, `taskInteractive`,
  `taskResumable`, `taskIdle`
- `taskPaused`, `taskUnpaused`, `taskSpawned`, `taskDelegated`,
  `taskDelegationCompleted`, `taskDelegationResumed`
- `message` (full `ShoferMessage` with `taskId`), `taskModeSwitched`,
  `taskAskResponded`, `taskUserMessage`, `queuedMessagesUpdated`
- `taskTokenUsageUpdated`, `taskToolFailed`
- `modeChanged`, `providerProfileChanged`

### CLI Events (ClientEventMap)

Defined in [`ClientEventMap`](../apps/cli/src/agent/events.ts:26):

- `stateChange` (derived high-level state), `message`, `messageUpdated`
- `waitingForInput`, `resumedRunning`, `streamingStarted`, `streamingEnded`
- `taskCompleted`, `taskCleared`, `modeChanged`, `error`

The CLI's `ExtensionClient` derives these events from the raw `ExtensionMessage`
webview protocol messages. They are a **subset** of what the public API exposes.

**Impact:** Code that listens for events on one path is completely incompatible
with the other. There is no mapping layer.

## Gap 3: The CLI's `extensionAPI` Is Now Used ✅ RESOLVED

```typescript
// extension-host.ts — now typed and used
private extensionAPI: ShoferAPI | null = null

// extension-host.ts — cast at activation
this.extensionAPI = (await this.extensionModule.activate(this.vscode.context)) as ShoferAPI

// extension-host.ts — used by runTask() and resumeTask()
await this.extensionAPI.startNewTask({ configuration, text, images })
await this.extensionAPI.resumeTask(taskId)
```

## Gap 4: `sendMessage` Works Differently

| Aspect          | CLI                                                                                                                                                                                     | Public API                                                           |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Method          | `sendToExtension({ type: "askResponse", askResponse: "messageResponse", text, images })` (when ask is active), OR `sendToExtension({ type: "queueMessage", text, images })` (otherwise) | `api.sendMessage(message, images)`                                   |
| Routing         | CLI has to detect current ask type and decide whether to send as askResponse or queueMessage                                                                                            | API always routes correctly — aware that webview may not be launched |
| Offline webview | CLI doesn't handle this case                                                                                                                                                            | API has explicit headless fallback via `submitUserMessage()`         |

## Gap 5: `cancelCurrentTask` Works Differently

| Aspect            | CLI                                                               | Public API                                          |
| ----------------- | ----------------------------------------------------------------- | --------------------------------------------------- |
| Method            | `client.cancelTask()` → `sendToExtension({ type: "cancelTask" })` | `api.cancelCurrentTask()` → `provider.cancelTask()` |
| Post-cancel state | CLI has complex `CANCEL_RECOVERY_WAIT_TIMEOUT_MS` logic           | API is fire-and-forget                              |

## Gap 6: Task Resumption ✅ RESOLVED

| Aspect             | CLI (now)                            | Public API               |
| ------------------ | ------------------------------------ | ------------------------ |
| Method             | `extensionAPI.resumeTask(taskId)`    | `api.resumeTask(taskId)` |
| Blocks?            | Blocks via `waitForTaskCompletion()` | Returns `Promise<void>`  |
| Webview dependency | Works without webview                | Has headless fallback    |

## Gap 7: Approval/Rejection

| Aspect   | CLI                                                                                              | Public API                                                                                |
| -------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Approve  | `client.approve()` → `sendToExtension({ type: "askResponse", askResponse: "yesButtonClicked" })` | `api.pressPrimaryButton()` → `postMessageToWebview({ invoke: "primaryButtonClick" })`     |
| Reject   | `client.reject()` → `sendToExtension({ type: "askResponse", askResponse: "noButtonClicked" })`   | `api.pressSecondaryButton()` → `postMessageToWebview({ invoke: "secondaryButtonClick" })` |
| Headless | Works — routed through webviewMessageHandler                                                     | Has explicit `viewLaunched` check                                                         |

## Gap 8: CLI-Only Features (No Public API Equivalent)

| Feature                | Description                                                                                                                           | Location                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **stdin-stream mode**  | Bidirectional NDJSON protocol (`start`/`message`/`cancel`/`ping`/`shutdown`) with typed `ShoferCliStreamEvent` responses              | [`stdin-stream.ts`](../apps/cli/src/commands/cli/stdin-stream.ts)      |
| **Stream-JSON output** | Real-time NDJSON events (`system`, `control`, `queue`, `assistant`, `user`, `tool_use`, `tool_result`, `thinking`, `error`, `result`) | [`json-event-emitter.ts`](../apps/cli/src/agent/json-event-emitter.ts) |
| **ExtensionClient**    | High-level state machine (`AgentLoopState`) with typed events (`stateChange`, `waitingForInput`, `streamingStarted`, etc.)            | [`extension-client.ts`](../apps/cli/src/agent/extension-client.ts)     |
| **AskDispatcher**      | Auto-routing of ask types (idle, interactive, resumable, agent-running) with timeout-based auto-approval                              | [`ask-dispatcher.ts`](../apps/cli/src/agent/ask-dispatcher.ts)         |
| **TUI**                | Ink-based interactive terminal UI                                                                                                     | [`App.tsx`](../apps/cli/src/ui/App.tsx)                                |
| **Command-line flags** | `--mode`, `--model`, `--provider`, `--api-key`, `--require-approval`, `--ephemeral`, `--oneshot`, etc.                                | [`headless.md`](headless.md)                                           |
| **Subcommands**        | `list commands`, `list modes`, `list models`, `list sessions`, `auth login`, `upgrade`                                                | [`headless.md`](headless.md)                                           |

## Gap 9: Public API-Only Features (No CLI Equivalent)

| Feature                   | Description                                                                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Profile CRUD**          | `getProfiles`, `getProfileEntry`, `createProfile`, `updateProfile`, `upsertProfile`, `deleteProfile`, `getActiveProfile`, `setActiveProfile` |
| **Global configuration**  | `getConfiguration`, `setConfiguration`                                                                                                       |
| **`clearCurrentTask`**    | Dismiss current task from stack                                                                                                              |
| **`isTaskInHistory`**     | Check if a task ID exists                                                                                                                    |
| **`getCurrentTaskStack`** | Return array of task IDs                                                                                                                     |
| **`isReady`**             | Check if webview launched                                                                                                                    |
| **`newTab` option**       | Open task in a new VS Code tab                                                                                                               |

The CLI has rough equivalents for some of these — e.g., `client.hasActiveTask()`
instead of `isReady()`, and it can resume tasks by ID. But the typed interfaces
are completely different.

## Gap 10: The IPC Protocol Is Yet a Third API

When `SHOFER_IPC_SOCKET_PATH` is set, the extension creates an `IpcServer` that
speaks a binary protocol with `TaskCommandName` commands
([`ipc.ts`](../packages/types/src/ipc.ts:43)):

- `StartNewTask`, `CancelTask`, `CloseTask`, `ResumeTask`, `SendMessage`,
  `GetCommands`, `GetModes`, `GetModels`, `DeleteQueuedMessage`

And the server re-emits `TaskEvent`s back to clients. This IPC protocol maps
`TaskCommandName` → `ShoferAPI` methods (see `api.ts` lines 80–155), so it _is_
a thin wrapper around the public API.

## Recommendation

The ideal end state is a **single `ShoferAPI` interface** that both the CLI and
companion extensions consume. The concrete steps:

1. ~~**Cast `extensionAPI` to `ShoferAPI` in the CLI**~~ ✅ Done.
2. ~~**Unify `startNewTask`**~~ ✅ Done — `runTask()` calls `extensionAPI.startNewTask()`.
3. **Unify event systems** — The CLI's `ExtensionClient` should bridge
   `ShoferEvents` (from the public API) into its `ClientEventMap`.
4. **Expose `ExtensionClient` as a reusable library** — The
   `ExtensionClient` + `MessageProcessor` + `StateStore` stack is the most
   sophisticated consumer SDK Shofer has.
5. ~~**Add `deleteQueuedMessage` to `ShoferAPI`**~~ ✅ Done.
6. **Add missing methods to CLI** — Profile management and configuration.
7. **Make stdin-stream a thin wrapper** around `ShoferAPI` methods.

## Summary Table

| Capability            | Public API (`ShoferAPI`)                | CLI (current)                                             | Status          |
| --------------------- | --------------------------------------- | --------------------------------------------------------- | --------------- |
| Start task            | `startNewTask(...)` → `Promise<string>` | `extensionAPI.startNewTask()`                             | ✅ Resolved     |
| Send follow-up        | `sendMessage(text, images)`             | `sendToExtension({ type: "askResponse"/"queueMessage" })` | Not yet wired   |
| Cancel task           | `cancelCurrentTask()`                   | `client.cancelTask()` → `sendToExtension(...)`            | Not yet wired   |
| Resume task           | `resumeTask(taskId)`                    | `extensionAPI.resumeTask()`                               | ✅ Resolved     |
| Approve               | `pressPrimaryButton()`                  | `client.approve()` → `sendToExtension(...)`               | Not yet wired   |
| Reject                | `pressSecondaryButton()`                | `client.reject()` → `sendToExtension(...)`                | Not yet wired   |
| Events                | 27 typed `ShoferEventName` events       | `ClientEventMap` (11 events, different names/payloads)    | Not yet unified |
| Profiles              | 8 CRUD methods                          | ❌ None                                                   | Not yet exposed |
| Config                | `getConfiguration`/`setConfiguration`   | ❌ None                                                   | Not yet exposed |
| `deleteQueuedMessage` | ✅ Declared in type interface           | ❌ None                                                   | Not yet exposed |
| stdin-stream          | ❌ None                                 | `start`/`message`/`cancel`/`ping`/`shutdown` over NDJSON  | N/A             |
| Stream-JSON output    | ❌ None                                 | 10 event types over NDJSON                                | N/A             |
| TUI                   | ❌ None                                 | Ink-based terminal UI                                     | N/A             |
| ExtensionClient       | ❌ None                                 | State machine + typed events                              | N/A             |
