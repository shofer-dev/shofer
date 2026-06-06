# Shofer Headless (CLI) Guide

How to build, configure, and use the Shofer CLI — the headless runtime that
runs the full Shofer agent from the terminal without VSCode.

## Overview

The Shofer CLI (`apps/cli/`) runs the **same extension code** as the VSCode
desktop experience. It loads the esbuild-bundled `extension.js` inside a
Node.js process, intercepting `require("vscode")` to return a mock API layer
(`@shofer/vscode-shim`) that makes the extension think it's running inside
VSCode.

```
┌─────────────────┐
│   CLI Entry     │
│   (index.ts)    │  commander argument parsing
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  ExtensionHost  │  ─ creates vscode-shim mock
│  (extension-    │  ─ writes on-disk vscode-mock.js
│   host.ts)      │  ─ hooks Module._resolveFilename
└────────┬────────┘
         │
    ┌────┴────┐
    │         │
    ▼         ▼
┌───────┐  ┌──────────┐
│vscode │  │Extension │  ─ require("./dist/extension.js")
│-shim  │  │ Bundle   │  ─ activate(vscode.context)
└───────┘  └──────────┘
```

The `vscode-shim` layer provides:

- **File system access** — `workspace.fs` backed by real `fs.readFileSync` /
  `fs.writeFileSync` ([`FileSystemAPI.ts`](../packages/vscode-shim/src/api/FileSystemAPI.ts))
- **Workspace state** — `workspaceState` / `globalState` mementos persisted as
  JSON files under `~/.vscode-mock/`
- **Secret storage** — `secrets` backed by `~/.vscode-mock/secrets.json`
- **Webview bridge** — mock webview that pipes `postMessage` through
  `window.__extensionHost.emit("extensionWebviewMessage", message)`
- **Command execution** — routes to `execa` subprocesses instead of VSCode
  Terminal ([`ExecuteCommandTool.ts:207`](../src/core/tools/ExecuteCommandTool.ts:207))
- **MCP** — full McpHub support, auto-approved in non-interactive mode

The extension source has zero `ROO_CLI_RUNTIME` gating — every tool (edit,
read, MCP, browser, execute) runs identically to the VSCode experience.

## Building

### Prerequisites

- Node.js 20 or higher
- pnpm (workspace manager)

### From the monorepo root

```bash
# 1. Build the extension bundle (one-time, or after extension source changes)
pnpm --filter shofer bundle

# 2. The CLI runs via tsx (TypeScript execute) — no separate build required
#    for development. For production, build the CLI:
pnpm --filter @shofer/cli build
```

The extension bundle is output to [`src/dist/extension.js`](../src/dist/extension.js) (esbuild, CJS format,
~700K+ lines). The CLI loads it via `require()` at runtime.

## Three Operating Modes

### 1. Interactive TUI (default)

Launches an Ink (React-for-terminals) interactive UI with auto-approval enabled
for all tool categories.

```bash
export OPENROUTER_API_KEY=sk-or-v1-...

pnpm --filter @shofer/cli dev -w ~/Projects/my-project "What does this project do?"

# Without a prompt — enter it interactively
pnpm --filter @shofer/cli dev -w ~/Projects/my-project
```

**Auto-approval defaults in TUI mode:**

- Tools, commands, browser, and MCP actions: **auto-approved**
- Followup questions: **suggestions displayed with 60-second auto-select**
  timeout (first suggestion chosen)

### 2. Print Mode (`--print`)

Non-interactive, single-prompt execution. Outputs the response and exits.
Three output formats available:

```bash
# Text output (default)
pnpm --filter @shofer/cli dev --print "Summarize this repo"

# JSON output — single result object
pnpm --filter @shofer/cli dev --print --output-format json "What files are here?"

# Stream-json output — real-time events as NDJSON lines
pnpm --filter @shofer/cli dev --print --output-format stream-json "List files"
```

**Auto-approval in print mode:**
All tool categories are auto-approved (read, write, execute, MCP, browser,
subtasks, mode switches, protected files). This makes `--print` safe for
scripting — the agent never blocks waiting for user input.

### 3. Stdin Stream Mode (`--stdin-prompt-stream`)

Programmatic control via bidirectional NDJSON over stdin/stdout. One process
handles multiple prompts.

```bash
printf '{"command":"start","requestId":"1","prompt":"1+1=?"}\n' \
  | pnpm --filter @shofer/cli dev --print --output-format stream-json --stdin-prompt-stream

# With a specific task/session ID
printf '{"command":"start","requestId":"1","taskId":"018f7fc8-...","prompt":"Fix bug"}\n' \
  | pnpm --filter @shofer/cli dev --print --output-format stream-json --stdin-prompt-stream
```

#### Stdin Commands

Defined in [`packages/types/src/cli.ts`](../packages/types/src/cli.ts):

| Command    | Fields                                         | Purpose                       |
| ---------- | ---------------------------------------------- | ----------------------------- |
| `start`    | `command, requestId, prompt, taskId?, images?` | Start a new task              |
| `message`  | `command, requestId, prompt, images?`          | Send follow-up to active task |
| `cancel`   | `command, requestId`                           | Cancel the current task       |
| `ping`     | `command, requestId`                           | Health check                  |
| `shutdown` | `command, requestId`                           | Graceful shutdown             |

#### Stream-JSON Output Events

| Type          | Purpose                                            |
| ------------- | -------------------------------------------------- |
| `system`      | Schema version, protocol, capabilities             |
| `control`     | `ack`/`done`/`error` per request                   |
| `queue`       | Current pending message queue state                |
| `assistant`   | LLM text responses                                 |
| `user`        | User messages                                      |
| `tool_use`    | Tool being called (`name` + `input`)               |
| `tool_result` | Tool result (`name` + `output`/`error`/`exitCode`) |
| `thinking`    | Reasoning/thinking content                         |
| `error`       | Runtime errors                                     |
| `result`      | Final result with success, content, cost, events   |

## CLI Options

| Option                                  | Description                                                           | Default                     |
| --------------------------------------- | --------------------------------------------------------------------- | --------------------------- |
| `[prompt]`                              | Positional prompt argument                                            | None                        |
| `--prompt-file <path>`                  | Read prompt from a file                                               | None                        |
| `-w, --workspace <path>`                | Workspace directory                                                   | Current directory           |
| `-p, --print`                           | Non-interactive output                                                | `false`                     |
| `--stdin-prompt-stream`                 | Read NDJSON commands from stdin (requires `--print`)                  | `false`                     |
| `--signal-only-exit`                    | Do not exit on completion; only SIGINT/SIGTERM (for stream harnesses) | `false`                     |
| `-e, --extension <path>`                | Path to extension bundle directory                                    | Auto-detected               |
| `-d, --debug`                           | Enable debug logging                                                  | `false`                     |
| `-a, --require-approval`                | Require manual approval before each action                            | `false`                     |
| `-k, --api-key <key>`                   | API key for the LLM provider                                          | From env var                |
| `--provider <provider>`                 | API provider (`shofer`, `openrouter`, `anthropic`, etc.)              | `openrouter`                |
| `-m, --model <model>`                   | Model to use                                                          | `anthropic/claude-opus-4.6` |
| `--mode <mode>`                         | Mode (`code`, `architect`, `ask`, `debug`, `review`)                  | `code`                      |
| `--base-url <url>`                      | Base URL for the provider (for custom/llm-router endpoints)           | None                        |
| `--terminal-shell <path>`               | Shell executable for inline terminal commands                         | Auto-detected               |
| `-r, --reasoning-effort <effort>`       | Reasoning effort (`unspecified`, `disabled`, `low`, `high`, etc.)     | `medium`                    |
| `--consecutive-mistake-limit <n>`       | Error/repetition limit before guidance prompt (`0` disables)          | `10`                        |
| `--exit-on-error`                       | Exit on API request errors instead of retrying                        | `false`                     |
| `--ephemeral`                           | Run without persisting state (uses temporary storage)                 | `false`                     |
| `--oneshot`                             | Exit upon task completion                                             | `false`                     |
| `--output-format <format>`              | Output format with `--print`: `text`, `json`, `stream-json`           | `text`                      |
| `--session-id <session-id>`             | Resume a specific task by session ID                                  | None                        |
| `--create-with-session-id <session-id>` | Create a new task with a specific session ID (UUID)                   | None                        |
| `-c, --continue`                        | Resume the most recent task in the current workspace                  | `false`                     |

## Subcommands

```bash
# List available resources
shofer list commands     # Slash commands
shofer list modes        # Available modes
shofer list models       # Available models
shofer list sessions     # Task sessions in current workspace

# Shofer Cloud authentication
shofer auth login        # Log in (opens browser)
shofer auth status       # Check authentication
shofer auth logout       # Clear credentials

# Self-upgrade
shofer upgrade           # Update to latest version
```

## Environment Variables

| Variable                    | Purpose                                                                                                                                                                             | Used by CLI? |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `OPENROUTER_API_KEY`        | Default for `--provider openrouter`                                                                                                                                                 | ✅ yes       |
| `ANTHROPIC_API_KEY`         | Default for `--provider anthropic`                                                                                                                                                  | ✅ yes       |
| `OPENAI_API_KEY`            | Default for `--provider openai-native`                                                                                                                                              | ✅ yes       |
| `GOOGLE_API_KEY`            | Default for `--provider gemini`                                                                                                                                                     | ✅ yes       |
| `VERCEL_AI_GATEWAY_API_KEY` | Default for `--provider vercel-ai-gateway`                                                                                                                                          | ✅ yes       |
| `SHOFER_API_KEY`            | Default for `--provider shofer` (passed as Bearer token to llm-router)                                                                                                              | ✅ yes       |
| `SHOFER_PROVIDER_URL`       | Shofer cloud proxy URL. **Note:** consumed by the Go `llm-provider` companion extension, NOT the JS handler. The CLI does not use this. Use `--provider shofer --base-url` instead. | ❌ no        |
| `SHOFER_API_URL`            | Marketplace API base URL. Used by `RemoteConfigLoader` to fetch modes and MCP catalog entries from Shofer Cloud. Has no effect on LLM calls.                                        | ❌ no        |
| `SHOFER_SDK_BASE_URL`       | Shofer Cloud SDK base URL. Declared in `apps/cli/src/types/constants.ts` but **not consumed** by any CLI code. Reserved for future SDK integration.                                 | ❌ no        |
| `TELEMETRY_ENABLED`         | Set to `"true"` to enable telemetry                                                                                                                                                 | ✅ yes       |
| `SHOFER_NERD_FONT`          | Set to `"0"` to use ASCII fallback icons in TUI                                                                                                                                     | ✅ yes       |

### Example `SHOFER_PROVIDER_URL`

```bash
SHOFER_PROVIDER_URL=https://api.shofer.dev/proxy
```

This is the default used by the `dev` script in `package.json`. It points to Shofer's cloud proxy
which routes requests to upstream providers. It is **not** used when `--provider shofer` is
selected — that provider uses `--base-url` directly.

## Provider Configuration

### Standard providers (OpenRouter, Anthropic, etc.)

```bash
pnpm --filter @shofer/cli dev \
  --provider openrouter \
  --api-key sk-or-v1-... \
  --model deepseek/deepseek-chat \
  -w . \
  "Your prompt"
```

### Shofer Router provider (local llm-router)

The `shofer` provider ([`src/api/providers/shofer.ts`](../src/api/providers/shofer.ts)) is designed for
connecting to a locally-running llm-router instance. It wraps the OpenRouter
handler and auto-injects a UUID v7 `conversation_id` into every request body
(llm-router requires this field).

```bash
# Using the dev:local-router convenience script:
pnpm --filter @shofer/cli dev:local-router -w . --print "Hello"

# Equivalent full command:
pnpm --filter @shofer/cli dev \
  --provider shofer \
  --api-key x \
  --base-url http://localhost:30081/v1 \
  --model arkware/deepseek_deepseek-v4-pro \
  -w . \
  --print "Hello"
```

The `shofer` provider maps CLI flags to settings:

- `--base-url` → `shoferBaseUrl` → `openRouterBaseUrl`
- `--api-key` → `shoferApiKey` → `openRouterApiKey`
- `--model` → `shoferModelId` → `openRouterModelId`

## Common Recipes

```bash
# Refactor in a specific workspace
pnpm --filter @shofer/cli dev -w /path/to/project "Refactor the auth module"

# Different model and mode
pnpm --filter @shofer/cli dev -m anthropic/claude-sonnet-4.5 --mode architect "Design REST API"

# Resume previous tasks
pnpm --filter @shofer/cli dev -c -w .                    # most recent
pnpm --filter @shofer/cli dev --session-id <uuid> -w .   # specific

# Require manual approval
pnpm --filter @shofer/cli dev --require-approval "Delete all .log files"

# Ephemeral — no persisted state
pnpm --filter @shofer/cli dev --ephemeral --print "What's the current git branch?"

# Read prompt from file
pnpm --filter @shofer/cli dev --prompt-file ./task-description.md

# Exit on task completion (no interactive follow-up)
pnpm --filter @shofer/cli dev --oneshot -w . "Fix the lint errors"

# Connect to local llm-router
pnpm --filter @shofer/cli dev:local-router -w . --print "Hello"
```

## Architecture Details

### CLI Uses `ShoferAPI` as the Control Plane

The CLI's [`ExtensionHost`](../apps/cli/src/agent/extension-host.ts) calls `activate()`
which returns a `ShoferAPI` instance. This is the **same `ShoferAPI`** used by companion
extensions (see [`public_api.md`](public_api.md)). All task management, configuration,
profile operations, and events route through it:

| CLI Method             | Delegates To   | ShoferAPI Method                                |
| ---------------------- | -------------- | ----------------------------------------------- |
| `runTask(prompt, …)`   | `extensionAPI` | `startNewTask({ configuration, text, images })` |
| `resumeTask(taskId)`   | `extensionAPI` | `resumeTask(taskId)`                            |
| `cancelTask()`         | `extensionAPI` | `cancelCurrentTask()`                           |
| `sendMessage(text, …)` | `extensionAPI` | `sendMessage(text, images)`                     |
| `approveAction()`      | `extensionAPI` | `pressPrimaryButton()`                          |
| `rejectAction()`       | `extensionAPI` | `pressSecondaryButton()`                        |
| `getConfiguration()`   | `extensionAPI` | `getConfiguration()`                            |
| `getProfiles()`        | `extensionAPI` | `getProfiles()`                                 |
| … (all 22 methods)     | `extensionAPI` | full `ShoferAPI` surface                        |

Events from `ShoferAPI` (`taskStarted`, `taskCompleted`, `message`, `modeChanged`,
etc.) are bridged into the CLI's `ExtensionClient` event system via `forwardShoferEvents()`.

### VSCode Shim Layer

Located in [`packages/vscode-shim/src/`](../packages/vscode-shim/src/). Files of note:

| File                                                                                     | Role                                                                                       |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [`Additional.ts`](../packages/vscode-shim/src/classes/Additional.ts)                     | `TreeItem`, `FileSystemError`, `CodeActionKind`, theme stubs                               |
| [`create-vscode-api-mock.ts`](../packages/vscode-shim/src/api/create-vscode-api-mock.ts) | Factory that assembles the full mock object                                                |
| [`FileSystemAPI.ts`](../packages/vscode-shim/src/api/FileSystemAPI.ts)                   | `readFile`/`writeFile`/`delete`/`createDirectory` → `fs.*`                                 |
| [`WorkspaceAPI.ts`](../packages/vscode-shim/src/api/WorkspaceAPI.ts)                     | `applyEdit()`, `openTextDocument()`, workspace state                                       |
| [`WindowAPI.ts`](../packages/vscode-shim/src/api/WindowAPI.ts)                           | `createTerminal()`, `createOutputChannel()`, `registerWebviewViewProvider()`, editor stubs |
| [`ExtensionContext.ts`](../packages/vscode-shim/src/context/ExtensionContext.ts)         | Memento-based global/workspace state, `FileSecretStorage`                                  |
| [`WorkspaceConfiguration.ts`](../packages/vscode-shim/src/api/WorkspaceConfiguration.ts) | Settings with runtime-config overlay (CLI flags take precedence)                           |

### Module Resolution

The CLI writes a real `vscode-mock.js` file to disk and hooks
`Module._resolveFilename` to redirect `require("vscode")` to it
([`extension-host.ts:392-418`](../apps/cli/src/agent/extension-host.ts:392-418)). The on-disk approach is
necessary because `tsx`'s ESM loader intercepts resolution before in-memory
`Module._load` patches take effect.

### Ask Dispatcher

In non-interactive (print/stdin-stream) mode, the [`AskDispatcher`](../apps/cli/src/agent/ask-dispatcher.ts)
auto-approves all interactive asks (tool, command, MCP, followup). In
`--require-approval` mode, it prompts for y/n confirmation via readline.

### File Change Tracking

Command execution in CLI mode uses `execa` subprocesses
([`ExecuteCommandTool.ts:207`](../src/core/tools/ExecuteCommandTool.ts:207))
instead of VSCode Terminal. File edits go through the real filesystem via
`vscode-shim`'s `FileSystemAPI` and `WorkspaceAPI.applyEdit()`.

## Key Files Reference

| File                                                                                                                  | Purpose                                                   |
| --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| [`apps/cli/src/index.ts`](../apps/cli/src/index.ts)                                                                   | CLI entry point, commander argument parsing               |
| [`apps/cli/src/agent/extension-host.ts`](../apps/cli/src/agent/extension-host.ts)                                     | Extension lifecycle, vscode mock setup, module resolution |
| [`apps/cli/src/agent/extension-client.ts`](../apps/cli/src/agent/extension-client.ts)                                 | Agent state tracking, message processing                  |
| [`apps/cli/src/agent/ask-dispatcher.ts`](../apps/cli/src/agent/ask-dispatcher.ts)                                     | Routes asks to handlers (tool, command, MCP, followup)    |
| [`apps/cli/src/agent/json-event-emitter.ts`](../apps/cli/src/agent/json-event-emitter.ts)                             | stream-json output event emitter                          |
| [`apps/cli/src/commands/cli/run.ts`](../apps/cli/src/commands/cli/run.ts)                                             | Main `run` command, TUI/print/stdin-stream dispatch       |
| [`apps/cli/src/commands/cli/stdin-stream.ts`](../apps/cli/src/commands/cli/stdin-stream.ts)                           | NDJSON stdin command parsing and dispatching              |
| [`apps/cli/src/lib/utils/provider.ts`](../apps/cli/src/lib/utils/provider.ts)                                         | Maps CLI provider flags to ShoferSettings                 |
| [`apps/cli/src/ui/App.tsx`](../apps/cli/src/ui/App.tsx)                                                               | Ink-based TUI application component                       |
| [`src/api/providers/shofer.ts`](../src/api/providers/shofer.ts)                                                       | Shofer Router provider (conversation_id injection)        |
| [`packages/types/src/cli.ts`](../packages/types/src/cli.ts)                                                           | Stdin command and stream-json event schemas               |
| [`packages/vscode-shim/src/api/create-vscode-api-mock.ts`](../packages/vscode-shim/src/api/create-vscode-api-mock.ts) | vscode mock factory                                       |
| [`src/core/tools/ExecuteCommandTool.ts`](../src/core/tools/ExecuteCommandTool.ts)                                     | Command execution (fallback to execa in CLI)              |

## Known Gaps

- **Terminal integration**: `execa` is used instead of VSCode Terminal; output
  is captured line-by-line rather than via PTY
- **File watchers**: `createFileSystemWatcher` returns a no-op stub — the CLI
  doesn't react to file changes
- **Browser tools**: Browser automation (`mcp--browser-tools`) may work in CLI
  mode but hasn't been tested extensively
- **`SHOFER_PROVIDER_URL`**: This environment variable is set by the `dev`
  script in `package.json` to `https://api.shofer.dev/proxy`. It is consumed by
  the Go `llm-provider` companion extension, not the JS handler. The CLI does
  not use it — use `--provider shofer --base-url` instead.
