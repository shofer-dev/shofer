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
 CompactLogger (root) ── child({ ctx }) ──► subsystem loggers
                                              (subsystems.ts)
```

### Components

| Component          | File                                                                                                                  | Role                                                                                                                                                               |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CompactTransport` | [`src/utils/logging/CompactTransport.ts`](../src/utils/logging/CompactTransport.ts)                                   | Filters by level + categories, writes to Output Channel and optional file                                                                                          |
| `CompactLogger`    | [`src/utils/logging/CompactLogger.ts`](../src/utils/logging/CompactLogger.ts)                                         | Variadic `ILogger` implementation with `child()` for subsystem scoping                                                                                             |
| `ILogger` / types  | [`src/utils/logging/types.ts`](../src/utils/logging/types.ts)                                                         | Interfaces and config types                                                                                                                                        |
| `index.ts`         | [`src/utils/logging/index.ts`](../src/utils/logging/index.ts)                                                         | `bootstrapLogging()`, `setLogLevel()`, `setLogCategories()`, `getLogger()`                                                                                         |
| Subsystem loggers  | [`src/utils/logging/subsystems.ts`](../src/utils/logging/subsystems.ts)                                               | 16 pre-scoped logger instances (Task, Webview, Git, …)                                                                                                             |
| LoggingSettings    | [`webview-ui/src/components/settings/LoggingSettings.tsx`](../webview-ui/src/components/settings/LoggingSettings.tsx) | Settings → Logging UI panel; renders checkboxes from live `logCategoriesKnown`                                                                                     |
| Settings schema    | [`packages/types/src/global-settings.ts`](../packages/types/src/global-settings.ts)                                   | `logLevel` and `logCategories` Zod schemas                                                                                                                         |
| ExtensionState     | [`packages/types/src/vscode-extension-host.ts`](../packages/types/src/vscode-extension-host.ts)                       | `ExtensionState` picks `logLevel`, `logCategories`, and `logCategoriesKnown`                                                                                       |
| Activation         | [`src/extension.ts`](../src/extension.ts)                                                                             | `bootstrapLogging()` at line 108, persistence restore at line 155                                                                                                  |
| Message handler    | [`src/core/webview/webviewMessageHandler.ts`](../src/core/webview/webviewMessageHandler.ts)                           | Wires `logLevel` and `logCategories` changes to live transport                                                                                                     |
| State plumbing     | [`src/core/webview/ShoferProvider.ts`](../src/core/webview/ShoferProvider.ts)                                         | `getState()` → `getStateToPostToWebview()` → webview state                                                                                                         |
| Legacy compat      | [`src/utils/outputChannelLogger.ts`](../src/utils/outputChannelLogger.ts)                                             | `stringifyForLog` and `createOutputChannelLogger` retained;<br>`outputLog`/`outputWarn`/`outputError` removed                                                      |
| i18n               | [`webview-ui/src/i18n/locales/en/settings.json`](../webview-ui/src/i18n/locales/en/settings.json)                     | `logging` section with level labels and 16 category names                                                                                                          |
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
every `ctx` value it has ever seen in any `CompactLogEntry`. This set is
exposed as `logCategoriesKnown` on the `ExtensionState` and rendered
dynamically by `LoggingSettings.tsx`.

| Layer     | Mechanism                                                                                                            |
| --------- | -------------------------------------------------------------------------------------------------------------------- |
| Transport | [`_knownCategories.add(entry.c)`](../src/utils/logging/CompactTransport.ts) on every `write()`                       |
| Index     | [`getLogKnownCategories()`](../src/utils/logging/index.ts) returns sorted array                                      |
| State     | [`ShoferProvider`](../src/core/webview/ShoferProvider.ts) pushes `logCategoriesKnown` to webview state               |
| UI        | [`LoggingSettings.tsx`](../webview-ui/src/components/settings/LoggingSettings.tsx) renders one checkbox per category |

For categories with a matching i18n key (`settings:logging.categories.<lowercase>`),
a translated label is shown. Unknown categories fall back to displaying the
raw `ctx` string directly, so a brand-new subsystem appears immediately.

## Subsystem Categories

Each subsystem logger is created via `getLogger().child({ ctx: "Name" })`.
The `ctx` is the tag shown in the output channel.

| ctx              | Logger export       | Description                                       |
| ---------------- | ------------------- | ------------------------------------------------- |
| `Task`           | `taskLog`           | Core task engine (Task, BaseTool, condense, etc.) |
| `Webview`        | `webviewLog`        | Webview / provider / IPC layer                    |
| `Git`            | `gitLog`            | Git index, file watcher, git history              |
| `CodeIndex`      | `codeIndexLog`      | Code index (RAG) and tree-sitter                  |
| `AssistantAgent` | `assistantAgentLog` | Assistant agent subsystem                         |
| `MCP`            | `mcpLog`            | MCP servers and transport                         |
| `Checkpoints`    | `checkpointLog`     | Checkpoints / shadow git                          |
| `API`            | `apiLog`            | API providers (Anthropic, OpenAI, Bedrock, etc.)  |
| `FS`             | `fsLog`             | File I/O utilities (safeWriteJson, storage, etc.) |
| `Config`         | `configLog`         | Configuration, ContextProxy, settings migration   |
| `Skills`         | `skillsLog`         | Skills subsystem                                  |
| `Marketplace`    | `marketplaceLog`    | Marketplace / installer                           |
| `Metrics`        | `metricsLog`        | Metrics / Prometheus                              |
| `Workflow`       | `workflowLog`       | Workflow engine (.slang)                          |
| `I18n`           | `i18nLog`           | Translations                                      |
| `Utils`          | `utilLog`           | General utilities (countTokens, path, perf, etc.) |

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

The category will appear automatically in Settings → Logging as "MyNew".
To add a human-readable label, add a key to
[`settings.json`](../webview-ui/src/i18n/locales/en/settings.json) under
`"logging.categories"`:

```json
"myNew": "My New Subsystem"
```

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
