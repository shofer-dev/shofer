# MCP (Model Context Protocol) in Shofer

How Shofer discovers, connects to, and calls MCP servers.

---

## Table of Contents

1. [Overview](#overview)
2. [Configuration](#configuration)
3. [Server Lifecycle](#server-lifecycle)
4. [Tool Exposure to the LLM](#tool-exposure-to-the-llm)
5. [Execution Flow](#execution-flow)
6. [Resource Access](#resource-access)
7. [Tool Group Assignment & Auto-Approval](#tool-group-assignment--auto-approval)
8. [Webview Communication](#webview-communication)
9. [Key Files](#key-files)

---

## Overview

Shofer implements the [Model Context Protocol](https://modelcontextprotocol.io/) to let the LLM call tools and access resources provided by external MCP servers. MCP servers can run locally (via `stdio`) or remotely (via `sse` or `streamable-http`).

A singleton [`McpHub`](../src/services/mcp/McpHub.ts) manages all connections. Tools discovered from MCP servers are exposed to the LLM as native tool schemas alongside Shofer's built-in tools.

---

## Configuration

### File Locations

| Scope   | Path                                   | Format |
| ------- | -------------------------------------- | ------ |
| Project | `.shofer/mcp.json`                     | JSON   |
| Global  | VS Code settings (`shofer.mcpServers`) | JSON   |

Project config takes priority over global config when the same server name appears in both.

### Server Schema

Each server entry is validated by [`ServerConfigSchema`](../src/services/mcp/McpHub.ts) (line 148). Three transport types are supported:

| Transport         | Description                                                     |
| ----------------- | --------------------------------------------------------------- |
| `stdio`           | Spawns a child process, communicates via stdin/stdout.          |
| `sse`             | Server-Sent Events with `ReconnectingEventSource` (auto-retry). |
| `streamable-http` | HTTP streaming with timeouts.                                   |

| Config Field    | Type                                        | Default    | Description                                            |
| --------------- | ------------------------------------------- | ---------- | ------------------------------------------------------ |
| `type`          | `"stdio"` \| `"sse"` \| `"streamable-http"` | (inferred) | Transport. Inferred from `command` (→ stdio) or `url`. |
| `command`       | string                                      | –          | **stdio only.** Executable to spawn.                   |
| `args`          | string[]                                    | `[]`       | **stdio only.** Arguments to the command.              |
| `cwd`           | string                                      | workspace  | **stdio only.** Working directory.                     |
| `env`           | Record<string,string>                       | `{}`       | **stdio only.** Extra environment variables.           |
| `url`           | string (URL)                                | –          | **sse / streamable-http.** Server endpoint.            |
| `headers`       | Record<string,string>                       | `{}`       | **sse / streamable-http.** HTTP headers.               |
| `disabled`      | boolean                                     | `false`    | Skip this server on startup.                           |
| `timeout`       | number (1–3600)                             | `60`       | Per-tool-call timeout in seconds.                      |
| `disabledTools` | string[]                                    | `[]`       | Tool names to hide from the LLM (but still connected). |
| `toolGroups`    | Record<string,ToolGroup>                    | `{}`       | Per-tool group override for auto-approval (see §7).    |

#### Example: stdio

```json
{
	"my-server": {
		"type": "stdio",
		"command": "node",
		"args": ["path/to/server.js"],
		"cwd": "/optional/working/dir",
		"env": { "KEY": "value" },
		"timeout": 60,
		"disabled": false,
		"disabledTools": [],
		"toolGroups": {}
	}
}
```

On Windows, non-`.exe` commands (like `npx.ps1`) are automatically wrapped with `cmd.exe /c`.

#### Example: streamable-http

```json
{
	"arkware": {
		"type": "streamable-http",
		"url": "http://localhost:30089",
		"disabled": false
	}
}
```

### Variable Injection

Before connection, [`injectVariables()`](../src/utils/config.ts) expands `${env:KEY}` and `${workspaceFolder}` references in the config, allowing environment-aware and workspace-relative paths.

---

## Server Lifecycle

### Startup

1. [`McpServerManager.getInstance()`](../src/services/mcp/McpServerManager.ts) (line 21) is called during provider activation. It creates a single [`McpHub`](../src/services/mcp/McpHub.ts) (line 174) and waits for [`waitUntilReady()`](../src/services/mcp/McpHub.ts) (line 197).

2. `McpHub` constructor:

    - Reads global MCP settings and project `.shofer/mcp.json`.
    - For each enabled server, calls [`connectToServer()`](../src/services/mcp/McpHub.ts) (line 703).

3. [`connectToServer()`](../src/services/mcp/McpHub.ts) (line 703):
    - Creates an MCP SDK [`Client`](https://github.com/modelcontextprotocol/typescript-sdk) with name `"Shofer"`.
    - Builds the appropriate transport (`StdioClientTransport`, `SSEClientTransport`, or `StreamableHTTPClientTransport`).
    - For `stdio`: starts the child process and pipes `stderr` for error logging.
    - For `sse` / `streamable-http`: applies a 10-second connect timeout to prevent indefinite blocking.
    - Registers `onerror` and `onclose` handlers that update `server.status` to `"disconnected"` and notify the webview.
    - Calls `client.connect(transport)`.
    - On success, fetches `tools/list` and `resources/list` (line 961).

### File Watching

- Global and project config files are watched via `chokidar`. Changes trigger a debounced (500ms) reconnect.
- Per-server `watchPaths` (optional) can list files/directories whose changes restart that specific server.

### Shutdown

[`McpHub.dispose()`](../src/services/mcp/McpHub.ts) closes all transports and clears watchers. `McpServerManager.cleanup()` handles the global state key.

---

## Tool Exposure to the LLM

### Native Mode (Primary)

[`getMcpServerTools()`](../src/core/prompts/tools/native-tools/mcp_server.ts) (line 14) enumerates every connected server and generates an OpenAI `ChatCompletionTool` for each enabled tool.

**Naming convention:** `mcp--{sanitizedServer}--{sanitizedTool}`

Built by [`buildMcpToolName()`](../src/utils/mcp-name.ts) (line 127). Names are:

- Sanitized (alphanumeric, `_`, `-` only).
- Capped at 64 characters (Gemini constraint).
- Deduplicated across servers (project wins over global).

The LLM receives these alongside Shofer's native tools. When the LLM calls `mcp--server--tool`, the [`NativeToolCallParser`](../src/core/assistant-message/NativeToolCallParser.ts) (`parseToolCall()`, line 960) recognizes the prefix and routes execution to the MCP tool handler.

**Hyphen normalization:** Some models convert `--` to `__` in function names. [`normalizeMcpToolName()`](../src/utils/mcp-name.ts) (line 44) handles this by converting `mcp__server__tool` back to `mcp--server--tool`.

### Wrapper Mode (Fallback)

When `use_mcp_tool` appears in the tool list, it serves as an explicit wrapper. The LLM provides `server_name`, `tool_name`, and `arguments` as structured parameters. The handler in [`UseMcpToolTool`](../src/core/tools/UseMcpToolTool.ts) validates and routes identically to the native path.

### Tool Discovery on the Wire

[`fetchToolsList()`](../src/services/mcp/McpHub.ts) (line 1057) sends the MCP `tools/list` request and annotates each tool with:

- `enabledForPrompt`: `false` if the tool name is in `disabledTools`.
- `group`: resolved from user override → server-declared → default `"uncategorized"`.

### Per-Group Visibility Filtering

MCP tool visibility is controlled by **two layers** that must both pass:

1. **`mcp` gateway** — the mode must include the `mcp` group in its `tools[]` array. If it doesn't, no MCP tools are exposed at all (the gateway tools `use_mcp_tool`, `access_mcp_resource`, etc. are also hidden).

2. **Per-tool group** — once the gateway is open, each MCP tool's resolved group (user override in `mcp.json` → server-declared → default `"uncategorized"`) must also be in the mode's declared groups. The `mcp` gateway **implies** the `uncategorized` group, so ungrouped tools always pass; explicitly-grouped tools need their group declared too.

This mirrors the per-group control applied to native tools. For example:

| Mode `tools[]`                                         | Visible MCP tools                                                          |
| ------------------------------------------------------ | -------------------------------------------------------------------------- |
| `["read", "mcp"]`                                      | MCP tools classified as `read` + ungrouped tools (default `uncategorized`) |
| `["browser", "mcp"]`                                   | MCP tools classified as `browser` + ungrouped tools                        |
| `["mcp"]`                                              | Only ungrouped tools (`uncategorized`, implied by the gateway)             |
| `["read", "write", "browser", "uncategorized", "mcp"]` | All MCP tools                                                              |

**Default group:** Tools without an explicit group assignment default to `"uncategorized"`. The `mcp` gateway implies `uncategorized` for **visibility**, so ungrouped MCP tools remain visible in any mode that has the gateway (backward compatible). However their **auto-approval** is still gated by `alwaysAllowUncategorized` (on top of `alwaysAllowMcp`) — visibility is not auto-execution. Only tools explicitly reassigned to a different group (e.g. `"browser"`, `"read"`, `"write"`) are gated by that group's inclusion in the mode.

The filtering is performed by [`filterMcpToolsForMode()`](../src/core/prompts/tools/filter-tools-for-mode.ts) at catalog-assembly time. See [`tool-categories.md`](tool-categories.md) §"Mode-Based Filtering" for the full mode × group matrix.

> **Note:** Execution-time validation in [`isToolAllowedForMode`](../src/core/tools/validateToolUse.ts) still gates MCP tools on the `mcp` group only (defense-in-depth). The per-group visibility gate is authoritative at the catalog level — if a tool isn't in the catalog, the model never sees it.

### Schema Normalization

MCP tool `inputSchema` is normalized by [`normalizeToolSchema()`](../src/utils/json-schema.ts) to convert JSON Schema 2020-12 constructs (type arrays → `anyOf`) into a form all LLM providers accept. If no schema is provided, `{ type: "object", additionalProperties: false }` is used.

---

## Execution Flow

```
LLM calls:  mcp--arkware--web_search
                │
                ▼
NativeToolCallParser                   ← recognizes "mcp--" / "mcp__" prefix
  └─ Parses server + tool name via parseMcpToolName()
                │
                ▼
presentAssistantMessage.ts:135         ← "mcp_tool_use" case
  └─ Creates synthetic ToolUse<"use_mcp_tool"> block
     preserving the original tool name for API history
                │
                ▼
UseMcpToolTool.execute()               ← validates params, server, tool
  ├─ validateParams()                  ← server_name + tool_name required
  ├─ validateMcpToolExists()           ← checks server existence, tool name,
  │                                      disabled status (fuzzy matching)
  └─ task.ask("use_mcp_server", ...)   ← user approval prompt
                │
                ▼
McpHub.callTool(                       ← line 1820
  serverName, toolName,
  arguments, source,
  conversationId,                      ← injected into _meta for tracing
  abortSignal                          ← from Task for cancellation
)
  └─ connection.client.request({
       method: "tools/call",
       params: { name, arguments, _meta }
     }, CallToolResultSchema, { timeout })
                │
                ▼
processMcpToolContent()               ← handles text, resource, image types
  └─ task.say("mcp_server_response", ...)
```

### Key Details

- **Timeout:** Each server's `timeout` config (default 60s) governs `client.request()`.
- **Cancellation:** The task's `AbortSignal` is passed through, so stopping a task cancels in-flight MCP calls.
- **Fuzzy tool matching:** [`toolNamesMatch()`](../src/utils/mcp-name.ts) (line 188) treats `-` and `_` as equivalent so that model mangling of hyphens doesn't cause "tool not found" errors.

### Result Processing

[`processMcpToolContent()`](../src/core/tools/mcp/use-mcp-shared.ts) (line 130) handles MCP content types:

| MCP Type   | Handling                                                 |
| ---------- | -------------------------------------------------------- |
| `text`     | Concatenated with `\n\n` separators.                     |
| `resource` | JSON-stringified (blobs stripped).                       |
| `image`    | Converted to data URL (`data:{mimeType};base64,{data}`). |

Execution status (`started`, `output`, `completed`, `error`) is streamed to the webview via [`sendExecutionStatus()`](../src/core/tools/mcp/use-mcp-shared.ts) (line 242).

### Error Handling

| Condition                         | Response                                      |
| --------------------------------- | --------------------------------------------- |
| Missing `server_name`/`tool_name` | `sayAndCreateMissingParamError` → tool error. |
| Server not found                  | Lists available servers.                      |
| Server has no tools               | "No tools available" error.                   |
| Tool not found on server          | Lists available tools on that server.         |
| Tool is disabled                  | Lists enabled tools only.                     |
| Invalid arguments (not an object) | `formatResponse.invalidMcpToolArgumentError`. |
| Connection failure                | `"No connection found"` error with guidance.  |

All validation failures increment `task.consecutiveMistakeCount` and set `task.didToolFailInCurrentTurn = true`.

---

## Resource Access

MCP resources are accessed via the [`access_mcp_resource`](../src/core/prompts/tools/native-tools/access_mcp_resource.ts) tool. The flow:

```
LLM calls: access_mcp_resource({ server_name, uri })
                │
                ▼
McpHub.readResource(serverName, uri, source, signal)    ← line 1795
  └─ connection.client.request({
       method: "resources/read",
       params: { uri }
     }, ReadResourceResultSchema)
```

Resources are also listed at connect time via [`fetchResourcesList()`](../src/services/mcp/McpHub.ts) (line 1127) and resource templates via [`fetchResourceTemplatesList()`](../src/services/mcp/McpHub.ts) (line 1141). Both are stored on the `McpServer` object and pushed to the webview.

---

## Tool Group Assignment & Auto-Approval

### Group Resolution Priority

For each MCP tool, the group is resolved by [`fetchToolsList()`](../src/services/mcp/McpHub.ts):

1. **User override** — `toolGroups[toolName]` in the server config (project or global).
2. **Server-declared** — `tool.group` from the server's tool definition.
3. **Default** — `"uncategorized"`.

### Auto-Approval

MCP tool calls arrive at [`checkAutoApproval()`](../src/core/auto-approval/index.ts) through the `ask === "use_mcp_server"` path (distinct from the `ask === "tool"` path used by native tools). They are gated in two stages:

- **Master gate:** `alwaysAllowMcp` must be enabled for **any** MCP tool to be auto-approved. If it is off, the call always prompts.
- **Per-group gate:** With the master gate on, the tool's resolved group (via [`getMcpToolGroup()`](../src/core/auto-approval/mcp.ts)) is mapped through `MCP_GROUP_APPROVAL_GATE` to a dedicated toggle that must **also** be enabled. This mirrors the per-group control that mode filtering and native tools already apply, so an MCP-served browser tool honors `alwaysAllowBrowser` rather than being approved by `alwaysAllowMcp` alone:

    | Resolved group  | Required toggle (in addition to `alwaysAllowMcp`) |
    | --------------- | ------------------------------------------------- |
    | `read`          | `alwaysAllowReadOnly`                             |
    | `write`         | `alwaysAllowWrite`                                |
    | `execute`       | `alwaysAllowExecute`                              |
    | `browser`       | `alwaysAllowBrowser`                              |
    | `mode`          | `alwaysAllowModeSwitch`                           |
    | `subtasks`      | `alwaysAllowSubtasks`                             |
    | `questions`     | `alwaysAllowFollowupQuestions`                    |
    | `uncategorized` | `alwaysAllowUncategorized`                        |

    Groups not in the map (e.g. the generic `mcp` protocol group) are approved by `alwaysAllowMcp` alone. `access_mcp_resource` calls are gated by `alwaysAllowMcp` only (no per-group stage).

> **Note:** Before this gate was added, the MCP path only checked `alwaysAllowMcp` plus an `"uncategorized"` special case, so `alwaysAllowBrowser` was effectively dead for browser tools served over MCP — they auto-approved as soon as `alwaysAllowMcp` was on. The group→toggle mapping above closes that gap.

---

## Webview Communication

### Server State Push

When server state changes, [`setNotifyAllProviders()`](../src/services/mcp/McpHub.ts) (line 189) broadcasts an `"mcpServers"` message to all registered webviews via the injected callback, with the full server list (including tools, resources, status, and error history).

### Execution Status Streaming

MCP tool execution sends real-time status updates:

| Status      | When                          |
| ----------- | ----------------------------- |
| `started`   | Tool call begins.             |
| `output`    | Streaming response text.      |
| `completed` | Tool call succeeded.          |
| `error`     | Tool call returned `isError`. |

### UI Components

| Component                  | File                 | Description                         |
| -------------------------- | -------------------- | ----------------------------------- |
| **McpToolApproval**        | (auto-approval flow) | Shows tool name, server, arguments. |
| **McpServerStatus**        | (settings view)      | Connection status indicators.       |
| **McpServerConfiguration** | (settings view)      | Add/edit/remove MCP servers.        |

---

## Key Files

| File                                                                                     | Role                                                  |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| [`McpHub.ts`](../src/services/mcp/McpHub.ts)                                             | Central hub: connections, tool discovery, execution   |
| [`McpServerManager.ts`](../src/services/mcp/McpServerManager.ts)                         | Singleton lifecycle, provider notification            |
| [`mcpLogger.ts`](../src/services/mcp/mcpLogger.ts)                                       | Output-channel logger                                 |
| [`UseMcpToolTool.ts`](../src/core/tools/UseMcpToolTool.ts)                               | `use_mcp_tool` handler and native MCP tool executor   |
| [`accessMcpResourceTool.ts`](../src/core/tools/accessMcpResourceTool.ts)                 | `access_mcp_resource` handler                         |
| [`mcp_server.ts`](../src/core/prompts/tools/native-tools/mcp_server.ts)                  | Generates LLM tool schemas from connected servers     |
| [`mcp-name.ts`](../src/utils/mcp-name.ts)                                                | Name sanitization, parsing, fuzzy matching            |
| [`NativeToolCallParser.ts`](../src/core/assistant-message/NativeToolCallParser.ts)       | Parses `mcp--` prefixed tool calls from LLM           |
| [`presentAssistantMessage.ts`](../src/core/assistant-message/presentAssistantMessage.ts) | Routes `mcp_tool_use` blocks to handler               |
| [`build-tools.ts`](../src/core/task/build-tools.ts)                                      | Assembles the final tool list sent to the LLM         |
| [`auto-approval/index.ts`](../src/core/auto-approval/index.ts)                           | Decides auto-approval for MCP tool calls              |
| [`auto-approval/mcp.ts`](../src/core/auto-approval/mcp.ts)                               | Uncategorized tool detection                          |
| [`use-mcp-shared.ts`](../src/core/tools/mcp/use-mcp-shared.ts)                           | Shared helpers for both sync and async MCP tool paths |

---

## Gaps, Issues & Improvement Areas

_This section captures deficiencies discovered during doc verification. Address these items in future work._

1. **Missing Key File entry** — [`use-mcp-shared.ts`](../src/core/tools/mcp/use-mcp-shared.ts) was absent from the Key Files table. Added during this review. It contains the shared `validateMcpToolExists()`, `processMcpToolContent()`, `runMcpToolCall()`, and `sendExecutionStatus()` helpers used by both `use_mcp_tool` and `call_mcp_tool_async` paths.

2. **Missing line numbers for lifecycle methods** — [`McpHub.dispose()`](../src/services/mcp/McpHub.ts) (line 2033) and [`McpServerManager.cleanup()`](../src/services/mcp/McpServerManager.ts) (line 80) are referenced in §"Server Lifecycle → Shutdown" without line numbers. Add these for consistency with other references.

3. **UI Components table lacks file paths** — The three UI components (`McpToolApproval`, `McpServerStatus`, `McpServerConfiguration`) list only conceptual locations ("auto-approval flow", "settings view") instead of actual source file paths. This makes them undiscoverable for agents and developers.

4. **Config schema doesn't document `watchPaths`** — The Server Schema table (§Configuration) lists 13 config fields but omits `watchPaths` (per-server file/directory watch list for auto-restart). It is mentioned only in prose under §File Watching.

5. **Webview communication uses callback injection, not direct method** — The doc originally referenced a non-existent `notifyWebviewOfServerChanges()`. The actual pattern is:[`McpServerManager`](../src/services/mcp/McpServerManager.ts) injects a `notifyAllProvidersFn` callback into [`McpHub`](../src/services/mcp/McpHub.ts) via [`setNotifyAllProviders()`](../src/services/mcp/McpHub.ts) (line 189), which broadcasts an `"mcpServers"` `ExtensionMessage` to all registered webview providers. This indirection avoids a circular import between `McpHub` and `McpServerManager`. Verified and corrected during this review.

6. **No doc coverage for `call_mcp_tool_async` flow** — The async MCP path (`call_mcp_tool_async`, `check_mcp_call_status`, `wait_for_mcp_call`) shares the same `runMcpToolCall()` + `processMcpToolContent()` + `sendExecutionStatus()` helpers as the synchronous path, but this is not documented. The async path also passes `AbortSignal` through for cooperative cancellation.

7. **Line numbers are drift-prone** — This review corrected 18 line-number references. Every future refactoring of `McpHub.ts` (2080 lines) or `NativeToolCallParser.ts` (1640 lines) will invalidate these anchors again. Consider whether line numbers add enough value to justify the maintenance burden, or whether function-name-only references (without line numbers) would be more stable.
