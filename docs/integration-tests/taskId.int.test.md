# Conversation ID Injection — Integration Test Scenarios

## Setup

Each scenario assumes Shofer is activated with an MCP server connected and
the full pipeline operational: `McpHub.callTool()` → `mcp-server` →
`tools-backend`. A test MCP server fixture (`test-mcp-server`) exposes a
tool that echoes the received `conversation_id` back in its response body.

## Feature Under Test

Shofer injects `task.taskId` (UUID v7) as `conversationId` into MCP
`tools/call` requests via `_meta["vscode.conversationId"]`. Downstream
services (`mcp-server`, `tools-backend`) extract and propagate it for
logging, metrics, and distributed tracing. See
[`docs/conversationId.md`](../docs/conversationId.md).

## Scenarios

### 1. conversationId is injected into sync `use_mcp_tool` calls

1. Start a Shofer task and trigger `use_mcp_tool` with a known
   `task.taskId`.
2. **Assert:** `McpHub.callTool()` is invoked with `conversationId ===
task.taskId`.
3. **Assert:** The MCP request params include
   `_meta["vscode.conversationId"]` equal to `task.taskId`.
4. **Assert:** `mcp-server` receives and extracts the value from
   `params._meta["vscode.conversationId"]`.
5. **Assert:** `tools-backend` receives `conversation_id` in the request
   body matching the original `task.taskId`.

### 2. conversationId is injected into async MCP calls

1. Trigger `call_mcp_tool_async` from a Shofer task.
2. **Assert:** The async path (`CallMcpToolAsyncTool` → `runMcpToolCall`)
   also passes `task.taskId` as the `conversationId` parameter.
3. **Assert:** The same `_meta` injection and downstream propagation hold
   as in scenario 1.

### 3. mcp-server rejects calls missing conversationId

1. Send a `tools/call` request to `mcp-server` with `_meta` absent or
   `vscode.conversationId` missing/empty.
2. **Assert:** `mcp-server` returns HTTP 400 with error
   `"vscode.conversationId is required in _meta"`.
3. **Assert:** The Shofer task surfaces the error as a tool failure.

### 4. conversationId survives serialize/deserialize round-trip

1. Serialize the MCP `tools/call` request to JSON (as it traverses the
   JSON-RPC transport).
2. Deserialize on the `mcp-server` side.
3. **Assert:** `params._meta["vscode.conversationId"]` is preserved
   faithfully (same UUID string, no case change, no truncation).

### 5. conversationId is stable across multiple tool calls in the same task

1. Trigger two sequential `use_mcp_tool` calls in the same task.
2. **Assert:** Both calls use the identical `conversationId` value
   (`task.taskId` does not change across the task lifecycle).
3. **Assert:** `tools-backend` logs show a single `conversation_id` for
   both calls, enabling per-conversation correlation.

### 6. conversationId differs between concurrent tasks

1. Start two parallel Shofer tasks (task A and task B).
2. Trigger a `use_mcp_tool` call from each.
3. **Assert:** Task A's `conversationId` ≠ task B's `conversationId`.
4. **Assert:** Both are valid UUID v7 strings.
5. **Assert:** `tools-backend` can distinguish the two conversations.

### 7. conversationId survives task resume after restart

1. Start a task, trigger an MCP call, note the `conversationId`.
2. Restart Shofer (simulating VS Code restart).
3. Resume the task from history and trigger another MCP call.
4. **Assert:** The resumed task's `conversationId` is the same
   `task.taskId` persisted in `history_item.json`.
5. **Assert:** Downstream services see the same `conversation_id` before
   and after restart.

### 8. Access MCP resource also passes conversationId

1. Trigger `access_mcp_resource` from a Shofer task.
2. **Assert:** The `McpHub.readResource()` call (or equivalent shared
   path) includes `task.taskId` as `conversationId`.
3. **Assert:** The `resources/read` request to `mcp-server` carries the
   `_meta["vscode.conversationId"]`.

### 9. Standalone mode: conversationId still required

1. Run `mcp-server` in standalone mode (`STANDALONE_MODE=true`).
2. Send a `tools/call` request with valid `vscode.conversationId` in
   `_meta`.
3. **Assert:** The call succeeds; `workspaceId` is optional in standalone
   mode but `conversationId` is still mandatory.
4. Send a request without `conversationId`.
5. **Assert:** Still returns 400 — standalone mode relaxes
   `workspaceId` but not `conversationId`.

### 10. Third-party MCP servers ignore \_meta silently

1. Connect a third-party MCP server that uses `additionalProperties:
false` on its tool input schema.
2. Trigger a `use_mcp_tool` call to that server.
3. **Assert:** The server receives the `_meta` field but ignores it
   (no schema validation error, no unexpected parameter rejection).
4. **Assert:** The Shofer call succeeds normally; `conversationId`
   in `_meta` does not break interop.
