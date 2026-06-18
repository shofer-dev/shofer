# Logging System

## Overview

The Shofer logging system writes human-readable lines to the "Shofer" VS Code
Output Channel and optionally appends compact JSON-lines to a file on disk.
Every log line carries a **severity** (`debug`, `info`, `warn`, `error`,
`fatal`) and an optional **context tag** (e.g., `[Task]`, `[Git]`, `[MCP]`)
identifying which subsystem produced it.

Both severity threshold and category whitelist can be changed at runtime from
**Settings → Logging** without a reload.

Categories are **auto-discovered**: any `ctx` value that passes through the
transport is collected and surfaced to the Settings UI. A new subsystem added
via `getLogger().child({ ctx: "MyNew" })` appears in the checkbox list
automatically — no UI changes needed.

All logging in extension-host code goes through the shared `CompactTransport`.
This includes [`ShoferProvider.log()`](../src/core/webview/ShoferProvider.ts) and
[`ShoferProvider.debug()`](../src/core/webview/ShoferProvider.ts), which route
through the `Webview` subsystem logger — both respect the user's level and
category filter settings in **Settings → Logging**.

## Architecture

```
 Settings → Logging (LoggingSettings.tsx)
      │
      │  user changes logLevel / logCategories
      ▼
 webviewMessageHandler.ts
      │
      │  setLogLevel(level)  /  setLogCategories([...])
      ▼
 logging/index.ts  ──────────────────────────────────┐
      │                                                │
      │  bootstrapLogging(outputChannel)                │
      ▼                                                │
 CompactTransport (singleton)                         │
      │                                                │
      │  write() ── auto-discover ctx ── level filter ── category filter ── Output Channel
      │                                                │
      │  write() ── auto-discover ctx ───────── file (optional JSON-lines)
      │                                                │
      │  getKnownCategories() ──► ShoferProvider ──► webview (logCategoriesKnown)
      │                                                │
      ▲                                                │
 CompactLogger (root) ── child({ ctx }) ──► subsystem loggers  ◄── provider.log() / provider.debug()
                                               (subsystems.ts)           (via webviewLog)
```

**Note:** [`ShoferProvider.log()`](../src/core/webview/ShoferProvider.ts) and
[`ShoferProvider.debug()`](../src/core/webview/ShoferProvider.ts) route through
`webviewLog` (the `Webview` subsystem logger), so they respect level and category
filters. They no longer bypass the transport with direct `outputChannel.appendLine()`.

### Components

| Component          | File                                                                                                                  | Role                                                                                                                                                               |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CompactTransport` | [`src/utils/logging/CompactTransport.ts`](../src/utils/logging/CompactTransport.ts)                                   | Filters by level + categories, writes to Output Channel and optional file; also keeps the public ring buffer and per-task buffers for the Logs tab (see below)     |
| `CompactLogger`    | [`src/utils/logging/CompactLogger.ts`](../src/utils/logging/CompactLogger.ts)                                         | Variadic `ILogger` implementation with `child()` for subsystem scoping                                                                                             |
| `ILogger` / types  | [`src/utils/logging/types.ts`](../src/utils/logging/types.ts)                                                         | Interfaces and config types                                                                                                                                        |
| `index.ts`         | [`src/utils/logging/index.ts`](../src/utils/logging/index.ts)                                                         | `bootstrapLogging()`, `setLogLevel()`, `setLogCategories()`, `getLogger()`                                                                                         |
| Subsystem loggers  | [`src/utils/logging/subsystems.ts`](../src/utils/logging/subsystems.ts)                                               | Pre-scoped logger instances (Task, Webview, Git, Tools, …)                                                                                                         |
| LoggingSettings    | [`webview-ui/src/components/settings/LoggingSettings.tsx`](../webview-ui/src/components/settings/LoggingSettings.tsx) | Settings → Logging UI panel; renders checkboxes from live `logCategoriesKnown`                                                                                     |
| Settings schema    | [`packages/types/src/global-settings.ts`](../packages/types/src/global-settings.ts)                                   | `logLevel` and `logCategories` Zod schemas                                                                                                                         |
| ExtensionState     | [`packages/types/src/vscode-extension-host.ts`](../packages/types/src/vscode-extension-host.ts)                       | `ExtensionState` picks `logLevel`, `logCategories`, and `logCategoriesKnown`                                                                                       |
| Activation         | [`src/extension.ts`](../src/extension.ts)                                                                             | `bootstrapLogging()` at line 108, persistence restore at line 155                                                                                                  |
| Message handler    | [`src/core/webview/webviewMessageHandler.ts`](../src/core/webview/webviewMessageHandler.ts)                           | Wires `logLevel` and `logCategories` changes to live transport                                                                                                     |
| State plumbing     | [`src/core/webview/ShoferProvider.ts`](../src/core/webview/ShoferProvider.ts)                                         | `getState()` → `getStateToPostToWebview()` → webview state;<br>`provider.log()` and `provider.debug()` route through `webviewLog` → transport                      |
| Legacy compat      | [`src/utils/outputChannelLogger.ts`](../src/utils/outputChannelLogger.ts)                                             | `stringifyForLog` and `createOutputChannelLogger` retained;<br>`outputLog`/`outputWarn`/`outputError` removed                                                      |
| i18n               | [`webview-ui/src/i18n/locales/en/settings.json`](../webview-ui/src/i18n/locales/en/settings.json)                     | `logging` section with level labels (category checkboxes are labelled by their raw `ctx`, not a translated string)                                                 |
| Tests              | [`src/utils/logging/__tests__/`](../src/utils/logging/__tests__/)                                                     | `CompactLogger.spec.ts` (15 tests), `CompactTransport.spec.ts` (12 tests, incl. late channel-binding regression), `index.spec.ts` (3 tests, eager-init regression) |

## Log Levels

| Level   | Meaning                                                    | Default?   |
| ------- | ---------------------------------------------------------- | ---------- |
| `debug` | All messages including detailed diagnostics. Very verbose. |            |
| `info`  | Standard operational messages.                             | ✅ default |
| `warn`  | Warnings — things that may need attention.                 |            |
| `error` | Errors — failures that affect functionality.               |            |
| `fatal` | Fatal errors — the most severe failures.                   |            |

Entries below the configured level are silently dropped by the transport.

## Category Auto-Discovery

Categories are **not hardcoded**. The transport maintains a `Set<string>` of
every `ctx` value it has seen. A category is registered as soon as its
subsystem child logger is _created_ (`CompactLogger.child()` calls
`transport.registerCategory(ctx)`), so all subsystems in `subsystems.ts` are
known immediately at module load — not only after they have emitted their first
line. The set is also extended by any `ctx` seen on `write()`. It is exposed as
`logCategoriesKnown` on the `ExtensionState` and rendered dynamically by
`LoggingSettings.tsx`.

| Layer     | Mechanism                                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Transport | [`registerCategory(ctx)`](../src/utils/logging/CompactTransport.ts) on `child()` + `_knownCategories.add(entry.c)` on `write()` |
| Index     | [`getLogKnownCategories()`](../src/utils/logging/index.ts) returns sorted array                                                 |
| State     | [`ShoferProvider`](../src/core/webview/ShoferProvider.ts) pushes `logCategoriesKnown` to webview state                          |
| UI        | [`LoggingSettings.tsx`](../webview-ui/src/components/settings/LoggingSettings.tsx) renders one checkbox per category            |

Each checkbox is labelled by its raw `ctx` value (e.g. `CodeIndex`), so the
label always matches the `[CodeIndex]` tag shown in the Output Channel. There
is no separate translated-label layer that could drift out of sync, and a
brand-new subsystem appears immediately with its `ctx` as the label.

## Subsystem Categories

Each subsystem logger is created via `getLogger().child({ ctx: "Name" })`.
The `ctx` is the tag shown in the output channel.

| ctx           | Logger export    | Description                                                                                                                                                   |
| ------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Task`        | `taskLog`        | Core task engine — task lifecycle, tool execution, context condensing, and the agent loop.                                                                    |
| `Webview`     | `webviewLog`     | Webview ↔ extension-host IPC, the provider, and message routing.                                                                                             |
| `Git`         | `gitLog`         | Git index, the working-tree file watcher, and git history queries.                                                                                            |
| `CodeIndex`   | `codeIndexLog`   | Code (RAG) indexing, embeddings, and tree-sitter parsing.                                                                                                     |
| `LiveMemory`  | `liveMemoryLog`  | The live-memory subsystem that answers questions and drives clarifying prompts.                                                                               |
| `MCP`         | `mcpLog`         | MCP server lifecycle, transport, and tool discovery.                                                                                                          |
| `IPC`         | `ipcLog`         | The `@shofer/ipc` socket server/client used by the CLI / headless runtime and public API.                                                                     |
| `Checkpoints` | `checkpointLog`  | Checkpoint creation/restore via the shadow-git workspace snapshots.                                                                                           |
| `API`         | `apiLog`         | LLM API providers (Anthropic, OpenAI, Bedrock, …) — requests, streaming, and retries.                                                                         |
| `FS`          | `fsLog`          | File I/O utilities such as `safeWriteJson`, storage paths, and disk persistence.                                                                              |
| `Config`      | `configLog`      | Configuration, `ContextProxy` settings/secrets, and settings migration.                                                                                       |
| `Skills`      | `skillsLog`      | Skill discovery, loading, and invocation.                                                                                                                     |
| `Marketplace` | `marketplaceLog` | Marketplace browsing and the item installer.                                                                                                                  |
| `Metrics`     | `metricsLog`     | Metrics collection and the Prometheus exporter.                                                                                                               |
| `Workflow`    | `workflowLog`    | The `.slang` workflow engine — parsing, execution, and stake resolution.                                                                                      |
| `Tools`       | `toolsLog`       | Native tool execution — one line per call (start / finish / failure) from `BaseTool.handle`, covering `read_file`, `use_mcp_tool`, `attempt_completion`, etc. |
| `I18n`        | `i18nLog`        | Translation loading and locale resolution.                                                                                                                    |
| `Scroll`      | `scrollLog`      | Webview scroll-lifecycle diagnostics forwarded from the chat view to the host.                                                                                |
| `Utils`       | `utilLog`        | General-purpose utilities (token counting, path handling, perf timing, …).                                                                                    |

## Output Format

### Output Channel (human-readable)

```
2026-06-04 18:00:00.123 INFO  [Git] polling for new commits
2026-06-04 18:00:01.456 WARN  [API] rate limit approaching {"remaining":5}
2026-06-04 18:00:02.789 ERROR [Task] tool execution failed
```

Format: `YYYY-MM-DD HH:MM:SS.mmm LEVEL [ctx] message {optional JSON data}`

### File (optional JSON-lines, delta timestamps)

```json
{"t":0,"l":"info","m":"Log session started","d":{"timestamp":"2026-06-04T09:00:00.000Z"}}
{"t":123,"l":"info","m":"polling for new commits","c":"Git"}
{"t":1333,"l":"warn","m":"rate limit approaching","c":"API","d":{"remaining":5}}
```

File output is disabled by default. Enable it via `CompactTransportConfig.fileOutput`.

## Per-Task Attribution & the Logs Tab

The webview **Logs tab** (in both the Task view / `ChatView` and the Workflow
view / `WorkflowView`) shows the log lines emitted _while a specific task or
workflow was executing_, scoped to that single instance — not the whole task
tree. It is a **consumer of the same `CompactTransport`**, not a separate
pipeline: every line still passes through `write()` and is gated by the same
level + category filters that feed the Output Channel. The Logs tab only adds
per-instance keying on top.

Log entries carry only a subsystem `ctx`, never a task id, and the line is
emitted from deep utility code (API providers, MCP, git) that has no task
reference. To attribute without touching the 100+ call sites, an
[`AsyncLocalStorage`](../src/utils/logging/logContext.ts) **log context** is
installed around each task's run loop:

| Layer            | Mechanism                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Context install  | [`Task._runTaskLoop`](../src/core/task/Task.ts) and [`WorkflowTask.slangLoop`](../src/core/workflow/WorkflowTask.ts) wrap execution in `runWithLogTaskContext({ taskId, rootTaskId }, …)`. The store propagates across awaits, promise chains, and timers — so synchronous _and_ async work spawned by the loop is attributed. A nested task (e.g. a workflow's child agent) installs its own context, overriding the parent's for its subtree, so child logs are attributed to the child, not the tree. |
| Capture          | [`CompactTransport.captureForTask`](../src/utils/logging/CompactTransport.ts) runs alongside the ring-buffer push (after the level + category filters). It reads `getLogTaskContext()` and, when a task is active, appends a `TaskScopedLogLine` to that task's bounded ring (2000 lines/task, LRU-capped at 64 tasks) and notifies live listeners.                                                                                                                                                      |
| Snapshot (host)  | `getTaskLogs(taskId)` returns the buffered lines; `webviewMessageHandler` answers `requestTaskLogs` with a `taskLogs` snapshot.                                                                                                                                                                                                                                                                                                                                                                          |
| Live stream      | `ShoferProvider` registers a transport listener (`addTaskLogListener`) and streams new lines for the task the Logs tab is **watching** (set via `requestTaskLogs`). Lines are coalesced and flushed every 100 ms as a `taskLogAppended` batch (`taskLogLines[]`) so high-frequency debug logging cannot flood the IPC channel.                                                                                                                                                                           |
| Render (webview) | [`TaskLogsView`](../webview-ui/src/components/chat/TaskLogsView.tsx) requests a snapshot on mount and appends live batches; on unmount it clears the host-side watch so streaming stops.                                                                                                                                                                                                                                                                                                                 |

Because capture sits **after** the level + category filters, the Logs tab
honours Settings → Logging exactly: a category unchecked there (or a line below
the configured level) appears in neither the Output Channel nor the Logs tab.
A trivial task therefore shows mostly `[Task]` lines at `info` — the API/MCP/Git
subsystems emit little on a successful happy path; raising the level to `debug`
(and the `[Tools]`/`[MCP]` instrumentation above) surfaces more.

Buffers are **in-memory only** (like the public ring buffer) — they do not
survive a reload, and a task's lines persist until the LRU cap evicts them.

## Lifecycle

0. **Module load** ([`logging/index.ts`](../src/utils/logging/index.ts)):
    - The shared `CompactTransport` (channel-less) and root `CompactLogger`
      are created **eagerly** with `level: "debug"`, so subsystem loggers
      imported before activation bind to the real transport rather than a noop.
1. **Activation** ([`extension.ts`](../src/extension.ts)):
    - `bootstrapLogging(outputChannel)` attaches the Output Channel to the
      already-created transport via `setOutputChannel()` and emits the session
      marker.
2. **Persistence restore** ([`extension.ts`](../src/extension.ts)):
    - After `ContextProxy.getInstance(context)` is ready, saved `logLevel`
      and `logCategories` are read and applied to the live transport.
3. **Module loading**: Subsystem loggers in `subsystems.ts` call
   `getLogger().child({ ctx: "..." })` at module import time.
4. **Runtime**: `webviewMessageHandler.ts` calls `setLogLevel()` and
   `setLogCategories()` immediately when the user changes settings.

## Adding a New Subsystem Logger

1. Add an export to [`src/utils/logging/subsystems.ts`](../src/utils/logging/subsystems.ts):
    ```ts
    export const myLog = getLogger().child({ ctx: "MyNew" })
    ```
2. Import and use in the new subsystem's files.

The category appears automatically in Settings → Logging as `MyNew` (the raw
`ctx`) as soon as the module is loaded — no i18n key or UI change is needed.
Choose a concise, recognizable `ctx` since it is shown verbatim both in the
Output Channel tag (`[MyNew]`) and on the Settings checkbox.

## Usage in Code

```ts
// Prefer subsystem loggers
import { taskLog } from "../../utils/logging/subsystems"
taskLog.info("task started", { taskId })
taskLog.error(error) // Error object → stack capture + message
taskLog.warn("unexpected value:", someVar) // extra args stringified

// Or create an ad-hoc scoped logger
import { getLogger } from "../../utils/logging"
const log = getLogger().child({ ctx: "MyFeature" })
log.info("initialized")
```

## Testing

- The logger is a **noop in tests** (`NODE_ENV === "test"`) — no output
  channel is needed.
- `MockTransport` in [`__tests__/MockTransport.ts`](../src/utils/logging/__tests__/MockTransport.ts)
  captures entries in-memory for assertion.

## Gaps & Areas for Improvement

- **No per-category level thresholds** — all categories share the same
  minimum level. A future enhancement could allow `"Git": "warn"` to
  suppress Git debug/info while keeping Task at `"debug"`.
- **No log rotation** — the optional file output appends indefinitely.
- **No structured export** — JSON-lines file output has no built-in
  query/filter tooling (the user would need `jq` or similar).
- **No MCP/log server integration** — logs are not forwarded to the
  observability stack (Loki/Mimir/Tempo).

### Resolved

- **`provider.log()` bypass (fixed)** — [`ShoferProvider.log()`](../src/core/webview/ShoferProvider.ts)
  and [`ShoferProvider.debug()`](../src/core/webview/ShoferProvider.ts)
  previously called `this.outputChannel.appendLine()` directly, bypassing
  the `CompactTransport` level and category filters entirely. Messages
  from all 102+ callers of `provider.log()` (via `webviewMessageHandler.ts`,
  `skillsMessageHandler.ts`, `Task.ts`, …) appeared unconditionally in the
  Output Channel regardless of the user's Settings → Logging checkboxes.
  Both methods now route through `webviewLog.info()` / `webviewLog.debug()`,
  gating output on the `[Webview]` category checkbox and log level.
- **Checkpoint dual-write (fixed)** — The `log` closure in
  [`checkpoints/index.ts`](../src/core/checkpoints/index.ts) dual-wrote
  every checkpoint message via BOTH `checkpointLog.info()` (filtered) AND
  `provider?.log()` (unfiltered, now routed through `webviewLog`). The
  `provider?.log()` call was removed, so checkpoint messages only appear
  under the `[Checkpoint]` category. Two ad-hoc `provider?.log()` calls in
  `checkpointRestore` and `checkpointDiff` error paths were similarly
  redirected to `checkpointLog.warn`.
- **Import-ordering noop binding (fixed)** — subsystem loggers in
  `subsystems.ts` are bound via `getLogger().child({ ctx })` at
  module-_import_ time, which runs before `activate()`. The shared transport
  and root logger are therefore created **eagerly** at `logging/index.ts`
  module load (channel-less), and `bootstrapLogging()` only attaches the
  Output Channel via `CompactTransport.setOutputChannel()`. Previously the
  transport/logger were created inside `bootstrapLogging()`, so every
  subsystem logger captured the `_noopLogger` (whose `child()` returns
  itself) and dropped all output forever, making the level/category filters
  appear to have no effect. Guarded by
  [`__tests__/index.spec.ts`](../src/utils/logging/__tests__/index.spec.ts),
  which asserts `getLogger()` is non-noop before `bootstrapLogging()` on the
  production path.
- **`getLogLevel()` typed accessor (fixed)** — `getLogLevel()` previously
  reached into `(_transport as any)._level`. `CompactTransport` now exposes a
  typed `getLevel(): LogLevel` getter (mirroring `getKnownCategories()`) and
  `getLogLevel()` delegates to it.
