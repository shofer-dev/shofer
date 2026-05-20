# Conversation ID Injection for MCP Tool Calls

## Purpose

When Shofer makes MCP `tools/call` requests, it injects a `conversationId` into the MCP protocol's `_meta` field so that downstream services (mcp-server, tools-backend) can correlate tool calls with the originating conversation for logging, metrics, and distributed tracing.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                          VS Code Extension Host                                │
│                                                                                │
│  UseMcpToolTool.ts                  McpHub.ts                                  │
│  ─────────────────                  ─────────                                  │
│                                                                                │
│  task.taskId ──────► callTool(serverName, toolName, args, source, conversationId)
│  (UUID v7)                         │                                           │
│                                    ▼                                           │
│                          MCP "tools/call" request                              │
│                          {                                                     │
│                            method: "tools/call",                               │
│                            params: {                                           │
│                              name: "...",                                      │
│                              arguments: {...},                                 │
│                              _meta: {                                          │
│                                "vscode.conversationId": "<taskId>"             │
│                              }                                                 │
│                            }                                                   │
│                          }                                                     │
│                                    │                                           │
└────────────────────────────────────┼───────────────────────────────────────────┘
                                     │
                                     ▼
┌────────────────────────────────────────────────────────────────────────────────┐
│                            mcp-server                                           │
│  ──────────────                                                                 │
│                                                                                │
│  1. Extracts conversationId from params._meta["vscode.conversationId"]         │
│  2. Validates it is present (returns 400 if missing)                           │
│  3. Passes it to tools-backend as "conversation_id"                            │
│                                    │                                           │
└────────────────────────────────────┼───────────────────────────────────────────┘
                                     │
                                     ▼
┌────────────────────────────────────────────────────────────────────────────────┐
│                          tools-backend                                          │
│  ────────────────                                                               │
│                                                                                │
│  Receives conversation_id in request body for:                                 │
│  - Structured logging                                                          │
│  - Prometheus metrics labels                                                   │
│  - OpenTelemetry trace attributes                                              │
│                                                                                │
└────────────────────────────────────────────────────────────────────────────────┘
```

## Design Rationale

### Why `_meta`?

The MCP protocol's `_meta` field is the standard mechanism for passing contextual metadata in `tools/call` requests. Per the MCP specification, `_meta` is an optional object that "MAY contain arbitrary metadata."

Using `_meta` avoids:

- **Argument pollution** — Extra fields in tool arguments would break third-party MCP servers that validate against strict schemas.
- **Custom headers** — MCP is a JSON-RPC protocol; metadata belongs inside the message, not in transport headers (which vary between stdio, SSE, and streamable HTTP transports).

### Why not modify tool arguments?

Third-party MCP servers define their own input schemas with `additionalProperties: false`. Injecting extra fields like `conversationId` into the `arguments` object would cause schema validation failures. The `_meta` field is explicitly designed for this purpose and is silently ignored by servers that don't need it.

### Why `task.taskId`?

Shofer does not use VS Code's chat participant API (it renders its own webview), so VS Code's native `request.sessionId` is not available. Instead, Shofer uses [`task.taskId`](../src/core/task/Task.ts:195) — a UUID v7 generated per conversation — as the `conversationId`. This provides the same conversation-scoped correlation that VS Code's native MCP client would provide via `vscode.conversationId`.

### Key holding `vscode.conversationId`

The key name `vscode.conversationId` is used to match VS Code's established convention. VS Code's built-in MCP client already injects this key into `_meta` on every tool call. Using the same key ensures:

- Consistency with VS Code's own behavior
- Compatibility with any mcp-server that expects this key
- No confusion with other metadata conventions

## Component Reference

| Component               | File                                                                                                                                                                | Role                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| UseMcpToolTool / shared | [`src/core/tools/UseMcpToolTool.ts`](../src/core/tools/UseMcpToolTool.ts) and [`src/core/tools/mcp/use-mcp-shared.ts`](../src/core/tools/mcp/use-mcp-shared.ts:199) | Passes `task.taskId` to `McpHub.callTool()` via `runMcpToolCall`         |
| McpHub                  | [`src/services/mcp/McpHub.ts`](../src/services/mcp/McpHub.ts:1853)                                                                                                  | Injects `_meta["vscode.conversationId"]` into MCP request params         |
| mcp-server handler      | [`mcp-server/internal/handlers/mcp.go`](../../mcp-server/internal/handlers/mcp.go:344)                                                                              | Extracts and validates `conversationId` from `_meta` in `handleToolCall` |
| mcp-server backend      | [`mcp-server/internal/services/backend.go`](../../mcp-server/internal/services/backend.go:178)                                                                      | Forwards as `conversation_id` to tools-backend                           |
| IDs documentation       | [`docs/IDs.md`](../../docs/IDs.md)                                                                                                                                  | System-wide ID architecture overview                                     |

## Compatibility

All compliant MCP servers accept the `_meta` field per the MCP specification. Servers that don't use it silently ignore it. This approach is analogous to an HTTP proxy adding an `X-Request-Id` header — compliant servers ignore what they don't need.

## Gaps & Improvement Areas

### Cross-document inconsistency with `IDs.md`

[`docs/IDs.md`](../../docs/IDs.md) states that `conversationId` comes from "VS Code's internal session ID, available as `request.sessionId`" and is "Generated by: VS Code chat framework". This is incorrect — Shofer does not use VS Code's chat participant API (it renders its own webview). Shofer uses [`task.taskId`](../src/core/task/Task.ts:195) instead. `IDs.md` needs a separate audit to reflect the actual Shofer-specific architecture.

### Architecture diagram label

The architecture diagram at line 13 labels the two extension-host boxes as `UseMcpToolTool.ts` and `McpHub.ts`. The actual `callTool` invocation with `task.taskId` happens in [`use-mcp-shared.ts`](../src/core/tools/mcp/use-mcp-shared.ts:199) (called by `UseMcpToolTool`). The diagram could be updated to show `runMcpToolCall` (in `use-mcp-shared.ts`) instead of `UseMcpToolTool.ts` to accurately reflect the call chain.

### Async MCP path not covered

The async MCP path (`call_mcp_tool_async` → `check_mcp_call_status` / `wait_for_mcp_call`) also passes `task.taskId` as `conversationId` to `McpHub.callTool()`. This document only covers the synchronous `use_mcp_tool` path. A future update could include coverage of the async path's `conversationId` flow.

### No telemetry integration

The `conversationId` is injected into `_meta` and forwarded as `conversation_id` to tools-backend, but there is no documentation of whether/how this ID surfaces in telemetry events (`TelemetryService.captureMcp*`). If the telemetry events for MCP tool calls include the `taskId`/`conversationId`, that should be documented here for completeness.

### `mcp-server` standalone mode

In standalone mode, the `workspaceId` field is optional and the `workspace_id` field in the tools-backend request body is populated from the `DEFAULT_WORKSPACE_ID` environment variable instead of the MCP request params. This mode is not documented in the current flow description. The document should clarify how `conversationId` propagation works in standalone mode vs. normal mode.
