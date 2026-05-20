# MCP Server Integration — Test Scenarios

## Setup

Each scenario assumes Shofer is activated in a workspace with a writable
`.shofer/` directory. An MCP server fixture (`test-mcp-server`) exposes
two tools (`echo`, `slow_echo`) and one resource (`test://data`). The
fixture supports `stdio` and `streamable-http` transports.

## Scenarios

### 1. stdio server connects and tools are discovered

1. Create `.shofer/mcp.json` with a stdio server pointing to the test
   fixture.
2. Restart Shofer (or trigger config file change).
3. **Assert:** The output channel logs `Connected to MCP server: test-stdio`.
4. **Assert:** `getMcpServerTools()` returns tools named
   `mcp--test-stdio--echo` and `mcp--test-stdio--slow_echo`.
5. **Assert:** The webview receives an `"mcpServers"` message with
   `status: "connected"`, two tools, and one resource.

### 2. streamable-http server connects and tools are discovered

1. Start the test fixture in HTTP mode on `localhost:19876`.
2. Create `.shofer/mcp.json` with `type: "streamable-http"` and
   `url: "http://localhost:19876"`.
3. Restart Shofer.
4. **Assert:** Connection succeeds with no timeout.
5. **Assert:** Tools and resources are discovered identical to stdio
   transport.

### 3. LLM calls MCP tool via native `mcp--` prefix

1. Simulate an LLM response containing a tool call block with name
   `mcp--test-stdio--echo` and arguments `{ "message": "hello" }`.
2. **Assert:** `NativeToolCallParser.parseDynamicMcpTool()` extracts
   `serverName: "test-stdio"`, `toolName: "echo"`.
3. **Assert:** `presentAssistantMessage` routes the call through the
   `mcp_tool_use` case, creates a synthetic `ToolUse<"use_mcp_tool">`,
   and invokes `useMcpToolTool.handle()`.
4. **Assert:** `McpHub.callTool()` is called with the correct server,
   tool, arguments, and `task.taskId` as `conversationId`.
5. **Assert:** The tool result appears in chat as a `mcp_server_response`
   message with the echoed text.

### 4. LLM calls MCP tool via `use_mcp_tool` wrapper

1. Simulate an LLM `use_mcp_tool` call with `server_name: "test-stdio"`,
   `tool_name: "echo"`, `arguments: { "message": "hello" }`.
2. **Assert:** `UseMcpToolTool.execute()` validates parameters,
   resolves the tool via `validateMcpToolExists()`, and calls
   `runMcpToolCall()`.
3. **Assert:** The execution status sequence sent to the webview is
   `started → output → completed`.
4. **Assert:** The final `pushToolResult` contains the expected text.

### 5. Tool timeout is enforced

1. Configure the server with `timeout: 2` (2 seconds).
2. Call `slow_echo` (which takes 10 seconds server-side).
3. **Assert:** The call fails with a timeout error after ~2 seconds
   (plus network overhead).
4. **Assert:** The error message includes the server and tool name.

### 6. Server not found returns a helpful error

1. Call `use_mcp_tool` with `server_name: "nonexistent"`.
2. **Assert:** `validateMcpToolExists()` returns `{ isValid: false }`.
3. **Assert:** The error message lists all available server names.
4. **Assert:** `task.consecutiveMistakeCount` is incremented.

### 7. Tool not found returns a helpful error

1. Call `use_mcp_tool` with a valid server but `tool_name: "nonexistent"`.
2. **Assert:** The error message lists all available tools on that
   server.
3. **Assert:** Fuzzy matching (`toolNamesMatch`) handles hyphens vs
   underscores (e.g., `my_tool` matches `my-tool`).

### 8. Disabled tool is hidden from the LLM

1. Configure the server with `disabledTools: ["echo"]`.
2. **Assert:** `fetchToolsList()` sets `enabledForPrompt: false` on the
   `echo` tool.
3. **Assert:** `getMcpServerTools()` does NOT include
   `mcp--test-stdio--echo` in the generated tool list.
4. Call `use_mcp_tool` with the disabled tool.
5. **Assert:** `validateMcpToolExists()` rejects it, listing only
   enabled tools.

### 9. Disabled server is skipped entirely

1. Configure the server with `disabled: true`.
2. Restart Shofer.
3. **Assert:** `connectToServer()` is NOT called for this server.
4. **Assert:** The server does NOT appear in `getMcpServerTools()`.

### 10. File watching triggers reconnect on config change

1. Start with a working MCP config.
2. Modify `.shofer/mcp.json` (e.g., change `timeout` from 60 to 30).
3. **Assert:** Within 500ms (debounce), `connectToServer()` is called
   again.
4. **Assert:** The new timeout value takes effect on the next tool call.

### 11. Server error transitions state to disconnected

1. Connect to a stdio server, then kill the child process.
2. **Assert:** The `onerror` or `onclose` handler fires.
3. **Assert:** `server.status` transitions to `"disconnected"`.
4. **Assert:** The webview receives an updated `"mcpServers"` message
   with the error details.

### 12. Access MCP resource via `access_mcp_resource`

1. Call `access_mcp_resource` with `server_name: "test-stdio"` and
   `uri: "test://data"`.
2. **Assert:** `McpHub.readResource()` sends `resources/read` to the
   server.
3. **Assert:** The resource content is returned and displayed in chat.

### 13. Resource templates are discovered at connect time

1. Connect to a server that declares resource templates.
2. **Assert:** `fetchResourceTemplatesList()` populates
   `server.resourceTemplates`.
3. **Assert:** The templates are included in the `"mcpServers"` webview
   message.

### 14. Cancellation stops in-flight MCP calls

1. Start a `slow_echo` call (10s server-side delay).
2. Cancel the task (click Stop) before the call completes.
3. **Assert:** The `AbortSignal` passed to `McpHub.callTool()` fires.
4. **Assert:** The MCP request is aborted.
5. **Assert:** No `mcp_server_response` message is emitted for the
   cancelled call.

### 15. Hyphen normalization handles model mangling

1. Simulate an LLM response with a tool named `mcp__test__stdio__echo`
   (double underscores instead of double hyphens).
2. **Assert:** `normalizeMcpToolName()` converts it to
   `mcp--test--stdio--echo`.
3. **Assert:** `parseDynamicMcpTool()` correctly extracts the server and
   tool name.
4. **Assert:** `toolNamesMatch("echo_tool", "echo-tool")` returns `true`.

### 16. Tool name is capped at 64 characters

1. Register a server with a very long name and a very long tool name.
2. **Assert:** `buildMcpToolName()` caps the result at 64 characters.
3. **Assert:** The truncated name still starts with `mcp--`.

### 17. Project config overrides global config

1. Define the same server name in both global settings and
   `.shofer/mcp.json` with different `timeout` values.
2. **Assert:** The project-level timeout is used.
3. **Assert:** Tools from the project config take priority (first in
   deduplication order).

### 18. `call_mcp_tool_async` and status-check loop

1. Call `call_mcp_tool_async` with a valid server/tool.
2. **Assert:** The call returns immediately with a `call_id`.
3. Call `check_mcp_call_status` with that `call_id`.
4. **Assert:** Status transitions from `"running"` to `"completed"`
   with the tool result.
5. Call `wait_for_mcp_call` with the same `call_id`.
6. **Assert:** It returns immediately (already completed).

### 19. `wait_for_mcp_call` with `wait: "all"` vs `wait: "any"`

1. Start two async MCP calls.
2. Call `wait_for_mcp_call` with both IDs and `wait: "all"`.
3. **Assert:** It blocks until both complete.
4. Repeat with `wait: "any"`.
5. **Assert:** It returns as soon as the faster one completes.

### 20. Config injection with `${env:KEY}` and `${workspaceFolder}`

1. Set `MY_PATH=/tmp/mcp` in the environment.
2. Configure a server with `command: "${env:MY_PATH}/server"` and
   `cwd: "${workspaceFolder}/data"`.
3. **Assert:** `injectVariables()` resolves the command to
   `/tmp/mcp/server`.
4. **Assert:** `injectVariables()` resolves `cwd` to the workspace path.
