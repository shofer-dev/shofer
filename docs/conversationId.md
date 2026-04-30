# Conversation ID Injection for MCP Tool Calls

## Purpose

When Roo Code makes MCP `tools/call` requests, it injects a `conversationId` into the MCP protocol's `_meta` field so that downstream services (mcp-server, tools-backend) can correlate tool calls with the originating conversation for logging, metrics, and distributed tracing.

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

Roo Code does not use VS Code's chat participant API (it renders its own webview), so VS Code's native `request.sessionId` is not available. Instead, Roo Code uses [`task.taskId`](../src/core/task/Task.ts:543) — a UUID v7 generated per conversation — as the `conversationId`. This provides the same conversation-scoped correlation that VS Code's native MCP client would provide via `vscode.conversationId`.

### Key holding `vscode.conversationId`

The key name `vscode.conversationId` is used to match VS Code's established convention. VS Code's built-in MCP client already injects this key into `_meta` on every tool call. Using the same key ensures:

- Consistency with VS Code's own behavior
- Compatibility with any mcp-server that expects this key
- No confusion with other metadata conventions

## Component Reference

| Component          | File                                                                                           | Role                                                             |
| ------------------ | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| UseMcpToolTool     | [`src/core/tools/UseMcpToolTool.ts`](../src/core/tools/UseMcpToolTool.ts:311)                  | Passes `task.taskId` to `callTool()`                             |
| McpHub             | [`src/services/mcp/McpHub.ts`](../src/services/mcp/McpHub.ts:1781)                             | Injects `_meta["vscode.conversationId"]` into MCP request params |
| mcp-server handler | [`mcp-server/internal/handlers/mcp.go`](../../mcp-server/internal/handlers/mcp.go:258)         | Extracts and validates `conversationId` from `_meta`             |
| mcp-server backend | [`mcp-server/internal/services/backend.go`](../../mcp-server/internal/services/backend.go:178) | Forwards as `conversation_id` to tools-backend                   |
| IDs documentation  | [`docs/IDs.md`](../../docs/IDs.md)                                                             | System-wide ID architecture overview                             |

## Compatibility

All compliant MCP servers accept the `_meta` field per the MCP specification. Servers that don't use it silently ignore it. This approach is analogous to an HTTP proxy adding an `X-Request-Id` header — compliant servers ignore what they don't need.
