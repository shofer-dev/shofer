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

**Key observation (resolved):** The CLI calls `activate()` which returns a
`ShoferAPI` instance typed as `ShoferAPI`. It is now used for ALL task operations
(`runTask()`, `resumeTask()`, `cancelTask()`, `sendMessage()`, `approveAction()`,
`rejectAction()`) as well as configuration, profile management, and task history.
See [`extension-host.ts`](../apps/cli/src/agent/extension-host.ts).

## Gap 1: Different Method Signatures for `startNewTask` ✅ RESOLVED

| Aspect            | CLI (now)                                                    | Public API (`ShoferAPI`)                                    |
| ----------------- | ------------------------------------------------------------ | ----------------------------------------------------------- |
| Message type      | `extensionAPI.startNewTask({ configuration, text, images })` | `api.startNewTask({ configuration, text, images, newTab })` |
| Returns           | `Promise<void>` (blocks via `waitForTaskCompletion()`)       | `Promise<string>` (returns task ID immediately)             |
| Settings          | `configuration` (partial `ShoferSettings`)                   | `configuration` (partial `ShoferSettings`)                  |
| `newTab`          | Not supported                                                | Supported                                                   |
| `taskId` override | Not exposed via ShoferAPI                                    | Not exposed                                                 |

**Resolution:** The CLI calls `extensionAPI.startNewTask()` instead of raw
`sendToExtension({ type: "newTask" })`. The `taskId` override field (formerly on
`WebviewMessage`) was dropped as it had no consumer; it can be added to the
`ShoferAPI` interface if a use case emerges.

## Gap 2: Different Event Systems ✅ PARTIALLY RESOLVED

The CLI and Public API have two event systems, but they are now **bridged** via
[`ExtensionHost.forwardShoferEvents()`](../apps/cli/src/agent/extension-host.ts:508).
The bridge subscribes to public `ShoferAPI` events and forwards them into the
CLI's `ExtensionClient` emitter.

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
webview protocol messages AND from the forwarded `ShoferAPI` events via
[`ExtensionHost.forwardShoferEvents()`](../apps/cli/src/agent/extension-host.ts:508).

All meaningful public API events are now bridged into `ClientEventMap`:

- `taskCreated`, `taskStarted`, `taskAborted`
- `taskPaused`, `taskUnpaused`, `taskSpawned`
- `message` (non-partial), `queuedMessagesUpdated`
- `modeChanged` (via `ShoferEventName.ModeChanged`)
- `tokenUsageUpdated`, `toolFailed`

Events that are already covered by the webview protocol (`taskCompleted`,
`taskModeSwitched`) are intentionally not double-emitted. Events that have no
obvious `ClientEventMap` consumer (`taskFocused`, `taskUnfocused`, `taskActive`,
`taskInteractive`, `taskResumable`, `taskIdle`, `taskError`, `taskDelegated`,
`taskDelegationCompleted`, `taskDelegationResumed`, `taskAskResponded`,
`taskUserMessage`, `providerProfileChanged`) are left as API-only — the webview
protocol already surfaces equivalent information through different paths
(`stateChange`, `waitingForInput`, extension-message handlers).

## Gap 3: The CLI's `extensionAPI` Is Now Used ✅ RESOLVED

```typescript
// extension-host.ts — now typed and used
private extensionAPI: ShoferAPI | null = null

// extension-host.ts — cast at activation
this.extensionAPI = (await this.extensionModule.activate(this.vscode.context)) as ShoferAPI

// extension-host.ts — used by ALL task operations
await this.extensionAPI.startNewTask({ configuration, text, images })
await this.extensionAPI.resumeTask(taskId)
await this.extensionAPI.cancelCurrentTask()
await this.extensionAPI.sendMessage(text, images)
await this.extensionAPI.pressPrimaryButton()
await this.extensionAPI.pressSecondaryButton()

// extension-host.ts — used by configuration & profile management
this.extensionAPI.getConfiguration()
this.extensionAPI.setConfiguration(values)
this.extensionAPI.getProfiles()
// ... all 8 profile CRUD methods
this.extensionAPI.deleteQueuedMessage(messageId)
```

## Gap 4: `sendMessage` ✅ RESOLVED

| Aspect          | CLI (now)                                                               | Public API                                                           |
| --------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Method          | `host.sendMessage(text, images)` → `api.sendMessage(text, images)`      | `api.sendMessage(message, images)`                                   |
| Routing         | Delegates to `ShoferAPI.sendMessage()`, which handles ask/queue routing | API always routes correctly — aware that webview may not be launched |
| Offline webview | Handled by API's `submitUserMessage()` headless fallback                | API has explicit headless fallback via `submitUserMessage()`         |

**Resolution:** [`ExtensionHost.sendMessage()`](../apps/cli/src/agent/extension-host.ts:656)
delegates to `this.extensionAPI.sendMessage(text, images)`. The `stdin-stream`
calls `host.sendMessage()`. Note: the [`AskDispatcher`](../apps/cli/src/agent/ask-dispatcher.ts:632)
still sends raw `askResponse` webview messages for approval/rejection — this is
by design, as the ask-dispatcher handles interactive approval UI routing.

## Gap 5: `cancelCurrentTask` ✅ RESOLVED

| Aspect            | CLI (now)                                               | Public API                                          |
| ----------------- | ------------------------------------------------------- | --------------------------------------------------- |
| Method            | `host.cancelTask()` → `api.cancelCurrentTask()`         | `api.cancelCurrentTask()` → `provider.cancelTask()` |
| Post-cancel state | CLI has complex `CANCEL_RECOVERY_WAIT_TIMEOUT_MS` logic | API is fire-and-forget                              |

**Resolution:** [`ExtensionHost.cancelTask()`](../apps/cli/src/agent/extension-host.ts:647)
delegates to `this.extensionAPI.cancelCurrentTask()`. Both `stdin-stream` and the
shutdown path use `host.cancelTask()`. The TUI escape-key handler
([`useGlobalInput.ts`](../apps/cli/src/ui/hooks/useGlobalInput.ts:136)) still
sends raw `{ type: "cancelTask" }` via `sendToExtension` — a minor inconsistency
that could be migrated to `host.cancelTask()`.

## Gap 6: Task Resumption ✅ RESOLVED

| Aspect             | CLI (now)                            | Public API               |
| ------------------ | ------------------------------------ | ------------------------ |
| Method             | `extensionAPI.resumeTask(taskId)`    | `api.resumeTask(taskId)` |
| Blocks?            | Blocks via `waitForTaskCompletion()` | Returns `Promise<void>`  |
| Webview dependency | Works without webview                | Has headless fallback    |

## Gap 7: Approval/Rejection ✅ RESOLVED

| Aspect   | CLI (now)                                                 | Public API                                                                                |
| -------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Approve  | `host.approveAction()` → `api.pressPrimaryButton()`       | `api.pressPrimaryButton()` → `postMessageToWebview({ invoke: "primaryButtonClick" })`     |
| Reject   | `host.rejectAction()` → `api.pressSecondaryButton()`      | `api.pressSecondaryButton()` → `postMessageToWebview({ invoke: "secondaryButtonClick" })` |
| Headless | Works — `pressPrimaryButton()` / `pressSecondaryButton()` | Has explicit `viewLaunched` check                                                         |

**Resolution:** [`ExtensionHost.approveAction()`](../apps/cli/src/agent/extension-host.ts:665)
and [`rejectAction()`](../apps/cli/src/agent/extension-host.ts:674) delegate to
the corresponding `ShoferAPI` methods. Note: the
[`AskDispatcher`](../apps/cli/src/agent/ask-dispatcher.ts:632-643) still sends
raw `askResponse` webview messages for its internal approval routing — this is by
design, as it handles the interactive approval UI flow.

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

## Gap 9: Public API-Only Features ✅ RESOLVED

| Feature                   | CLI (now)                              | Public API                                                                                                                                   |
| ------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Profile CRUD**          | 8 methods on `ExtensionHost`           | `getProfiles`, `getProfileEntry`, `createProfile`, `updateProfile`, `upsertProfile`, `deleteProfile`, `getActiveProfile`, `setActiveProfile` |
| **Global configuration**  | `getConfiguration`, `setConfiguration` | `getConfiguration`, `setConfiguration`                                                                                                       |
| **`clearCurrentTask`**    | `clearCurrentTask(lastMessage?)`       | `clearCurrentTask(lastMessage?)`                                                                                                             |
| **`isTaskInHistory`**     | `isTaskInHistory(taskId)`              | `isTaskInHistory(taskId)`                                                                                                                    |
| **`getCurrentTaskStack`** | `getCurrentTaskStack()`                | `getCurrentTaskStack()`                                                                                                                      |
| **`isReady`**             | `isReady()`                            | `isReady()`                                                                                                                                  |
| **`deleteQueuedMessage`** | `deleteQueuedMessage(messageId)`       | `deleteQueuedMessage(messageId)`                                                                                                             |
| **`newTab` option**       | Not supported                          | Open task in a new VS Code tab                                                                                                               |

**Resolution:** All profile CRUD, configuration management, task history queries,
and `deleteQueuedMessage` are now exposed as thin wrappers on `ExtensionHost`
that delegate directly to the corresponding `ShoferAPI` methods. See
[`extension-host.ts`](../apps/cli/src/agent/extension-host.ts:683-786).

## Gap 10: The IPC Protocol Is Yet a Third API

When `SHOFER_IPC_SOCKET_PATH` is set, the extension creates an `IpcServer` that
speaks a binary protocol with `TaskCommandName` commands
([`ipc.ts`](../packages/types/src/ipc.ts:43)):

- `StartNewTask`, `CancelTask`, `CloseTask`, `ResumeTask`, `SendMessage`,
  `GetCommands`, `GetModes`, `GetModels`, `DeleteQueuedMessage`,
  `ShowTaskWithId`, `RenameTask`, `ArchiveTask`, `UnarchiveTask`, `PinTask`,
  `UnpinTask`, `DeleteTask`, `GetTaskMarkdownExport`, `GetTaskJsonExport`,
  `ExportConfiguration`, `ImportConfiguration`

And the server re-emits `TaskEvent`s back to clients. This IPC protocol maps
`TaskCommandName` → `ShoferAPI` methods (see [`api.ts`](../src/extension/api.ts)
IPC switch block), so it _is_ a thin wrapper around the public API.

## Recommendation

The ideal end state is a **single `ShoferAPI` interface** that both the CLI and
companion extensions consume. The concrete steps:

1. ~~**Cast `extensionAPI` to `ShoferAPI` in the CLI**~~ ✅ Done.
2. ~~**Unify `startNewTask`**~~ ✅ Done — `runTask()` calls `extensionAPI.startNewTask()`.
3. ~~**Unify `sendMessage`**~~ ✅ Done — `ExtensionHost.sendMessage()` delegates to `api.sendMessage()`.
4. ~~**Unify `cancelCurrentTask`**~~ ✅ Done — `ExtensionHost.cancelTask()` delegates to `api.cancelCurrentTask()`.
5. ~~**Unify approve/reject**~~ ✅ Done — `ExtensionHost.approveAction()`/`rejectAction()` delegate to `api.pressPrimaryButton()`/`pressSecondaryButton()`.
6. ~~**Add `deleteQueuedMessage` to `ShoferAPI`**~~ ✅ Done.
7. ~~**Add profile management and configuration to CLI**~~ ✅ Done — all 8 profile CRUD methods, `getConfiguration`, `setConfiguration`, `isTaskInHistory`, `getCurrentTaskStack`, `clearCurrentTask`, `isReady`, `deleteQueuedMessage` exposed on `ExtensionHost`.
8. ~~**Unify event systems**~~ ✅ Done — `forwardShoferEvents()` now bridges all
   meaningful `ShoferAPI` events into `ClientEventMap`. Events already covered by
   the webview protocol are intentionally not double-emitted.
9. **Expose `ExtensionClient` as a reusable library** — The
   `ExtensionClient` + `MessageProcessor` + `StateStore` stack is the most
   sophisticated consumer SDK Shofer has.
10. ~~**Make stdin-stream a thin wrapper**~~ ✅ Done — stdin-stream routes
    `start` → `host.runTask()`, `message` → `host.sendMessage()`, `cancel` →
    `host.cancelTask()`. Approval/rejection is handled by the `AskDispatcher`
    (which correctly routes through ask-response protocol for interactive asks).
11. ~~**Migrate TUI escape-key cancel**~~ ✅ Done — [`useGlobalInput.ts`](../apps/cli/src/ui/hooks/useGlobalInput.ts:136)
    now calls `cancelTask()` which delegates to `host.cancelTask()` →
    `api.cancelCurrentTask()`, consistent with stdin-stream and IPC consumers.

## Summary Table

| Capability            | Public API (`ShoferAPI`)                                                | CLI (current)                                            | Status           |
| --------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------- | ---------------- |
| Start task            | `startNewTask(...)` → `Promise<string>`                                 | `extensionAPI.startNewTask()`                            | ✅ Resolved      |
| Send follow-up        | `sendMessage(text, images)`                                             | `host.sendMessage()` → `api.sendMessage()`               | ✅ Resolved      |
| Cancel task           | `cancelCurrentTask()`                                                   | `host.cancelTask()` → `api.cancelCurrentTask()`          | ✅ Resolved      |
| Resume task           | `resumeTask(taskId)`                                                    | `extensionAPI.resumeTask()`                              | ✅ Resolved      |
| Approve               | `pressPrimaryButton()`                                                  | `host.approveAction()` → `api.pressPrimaryButton()`      | ✅ Resolved      |
| Reject                | `pressSecondaryButton()`                                                | `host.rejectAction()` → `api.pressSecondaryButton()`     | ✅ Resolved      |
| Events                | 27 typed `ShoferEventName` events                                       | `ClientEventMap` (11 native + 10 bridged events)         | ✅ Fully bridged |
| Profiles              | 8 CRUD methods                                                          | 8 wrapper methods on `ExtensionHost`                     | ✅ Resolved      |
| Config                | `getConfiguration`/`setConfiguration`                                   | 2 wrapper methods on `ExtensionHost`                     | ✅ Resolved      |
| Task history queries  | `isTaskInHistory`, `getCurrentTaskStack`, `clearCurrentTask`, `isReady` | 4 wrapper methods on `ExtensionHost`                     | ✅ Resolved      |
| `deleteQueuedMessage` | ✅ Declared in type interface                                           | Wrapper on `ExtensionHost`                               | ✅ Resolved      |
| stdin-stream          | ❌ None                                                                 | `start`/`message`/`cancel`/`ping`/`shutdown` over NDJSON | N/A              |
| Stream-JSON output    | ❌ None                                                                 | 10 event types over NDJSON                               | N/A              |
| TUI                   | ❌ None                                                                 | Ink-based terminal UI                                    | N/A              |
| ExtensionClient       | ❌ None                                                                 | State machine + typed events                             | N/A              |
