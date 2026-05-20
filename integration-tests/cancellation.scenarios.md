# Integration Tests: Stop Button Cancellation

> Feature doc: [`docs/cancellation.md`](../docs/cancellation.md)
> User manual: [`docs/user-manual/stop-button.md`](../docs/user-manual/stop-button.md)
> Implementation: [`Task.ts`](../src/core/task/Task.ts) (abortTask, cancelAndProcessQueuedMessages, \_taskAbortController),
> [`ChatView.tsx`](../webview-ui/src/components/chat/ChatView.tsx) (canStop, handleStopTask),
> [`McpHub.ts`](../src/services/mcp/McpHub.ts) (callTool, readResource with signal),
> [`mcp-server/mcp.go`](../../mcp-server/internal/handlers/mcp.go) (in-flight registry, handleCancelledNotification)

## Scenarios

### 1. Stop during active streaming response

**Given** a task is in `running` state with an API stream producing visible output
**When** the user clicks the Stop button
**Then** `ChatView.handleStopTask` posts `{ type: "cancelTask" }` to the extension host
**And** `webviewMessageHandler` calls `task.abortTask()`
**And** `this.abort = true` is set before `_taskAbortController.abort()`
**And** the stream catch block detects `this.abort === true` and calls `abortTask()`
**And** the task emits `TaskAborted` event with `reason: "user_cancelled"`
**And** `canStop` flips to `false` after the task transitions to idle

**Verification**: Assert `task.abort` is `true`. Assert `task.state.lifecycle === "idle"`. Assert the Stop button is no longer rendered in the webview. Assert the `TaskAborted` event payload contains `reason: "user_cancelled"`.

### 2. Stop during auto-approved MCP tool execution (no streaming, no ask)

**Given** a task has just auto-approved an MCP tool call (e.g., `browser_navigate`)
**And** `shoferAsk` is `undefined` (the tool was auto-approved, no user prompt pending)
**And** `currentTaskRuntimeState?.lifecycle === "running"`
**When** the user clicks the Stop button
**Then** `canStop` returns `true` (covers the auto-approved tool execution window)
**And** `task.abortTask()` fires `_taskAbortController.abort()`
**And** the `AbortSignal` previously passed to `McpHub.callTool()` fires
**And** the MCP SDK rejects the `client.request()` promise with an `AbortError`
**And** the SDK sends `notifications/cancelled` to `mcp-server`
**And** `mcp-server`'s `cancelInFlight` fires the matching `context.CancelFunc`
**And** the upstream `tools-backend` HTTP call returns immediately

**Verification**: Assert `canStop` was `true` at the time the user clicked Stop. Assert that the MCP tool call promise rejected with an `AbortError`. Assert `mcp-server` logs contain `Cancellation notification processed cancelled=true`. Assert the `tools-backend` request did NOT run to its full timeout.

### 3. Stop when no work is in flight (idle task)

**Given** a task is `idle` (no streaming, no ask, no running lifecycle)
**When** the webview evaluates `canStop`
**Then** `canStop` returns `false` (no stop button shown)
**And** the webview does not render a Stop button

**Verification**: Assert Stop button is not in the DOM. Assert `handleStopTask` is not callable.

### 4. Stop is not available for completion_result, resume_task, resume_completed_task

**Given** the current `shoferAsk` is `"completion_result"`, `"resume_task"`, or `"resume_completed_task"`
**When** the webview evaluates `canStop`
**Then** `canStop` returns `false`
**And** the user sees task-specific action buttons instead of Stop

**Verification**: Assert `canStop` is `false` for each of these three ask types, regardless of streaming state.

### 5. Stop preserves abort-ordering invariant

**Given** a task is running
**When** `abortTask()` is called
**Then** `this.abort = true` is set FIRST
**And** `_taskAbortController.abort()` is called SECOND (only if not already aborted)
**And** synchronous code checking `task.abort` after `abortTask()` sees `true`

**Verification**: Inspect the execution order in `abortTask()` (line ~2909 for `this.abort = true`, line ~2914 for the `_taskAbortController.abort()` call). Use a spy/mock to assert the setter ran before the abort call. Confirm the stream catch block at line ~4197 correctly branches on `this.abort`.

### 6. Stop during Send Now soft-cancel does NOT destroy the task

**Given** a task is streaming and `cancelAndProcessQueuedMessages()` is called
**When** `_softCancelForQueuedMessage` is set to `true` and `_taskAbortController.abort()` fires
**And** the stream catch block in `recursivelyMakeShoferRequests` executes
**Then** the catch block detects `_softCancelForQueuedMessage === true` and `break`s
**And** `abortTask()` is NOT called
**And** `cancelAndProcessQueuedMessages` replaces `_taskAbortController` with a fresh controller
**And** the task loop restarts with the dequeued message

**Verification**: Assert `abortTask()` was NOT called during this flow. Assert `_taskAbortController` is a different `AbortController` instance after `cancelAndProcessQueuedMessages` completes. Assert the task loop restarts and processes the queued message.

### 7. Stop aborts background children and async MCP calls

**Given** a parent task has active background children and in-flight `mcpAsyncCalls`
**When** `abortTask()` is called
**Then** `abortBackgroundChildren()` is called first, cancelling all active children
**And** any `mcpAsyncCalls` with `status === "running"` have their `abortController.abort()` called
**And** `mcpAsyncCalls` are cleared
**And** telemetry `captureMcpAsyncCallCancelled` fires for each cancelled call

**Verification**: Assert `abortBackgroundChildren()` was called. Assert `mcpAsyncCalls.size === 0` after abort. Assert each running async call's status flipped to `"cancelled"`. Assert telemetry events fired with correct `serverName` and `toolName`.

### 8. mcp-server handles late cancellation notification (already-completed request)

**Given** an MCP tool call completed normally (result returned, `cleanup` ran)
**And** the `cleanup` function removed the `(sessionId, requestId)` entry from `inFlight`
**When** a `notifications/cancelled` message arrives for the now-completed request
**Then** `cancelInFlight` finds no matching entry
**And** `cancelInFlight` returns `false`
**And** `handleCancelledNotification` logs with `cancelled=false`
**And** no error is surfaced

**Verification**: Assert `cancelInFlight` returned `false`. Assert the log entry contains `cancelled=false`. Assert HTTP response is 202 Accepted per MCP spec.

### 9. Stop button appears when task lifecycle is "running" even with no shoferAsk

**Given** `shoferAsk` is `undefined` (no pending ask)
**And** `isStreaming` is `false`
**And** `currentTaskRuntimeState?.lifecycle === "running"` (task loop is executing)
**When** `canStop` is evaluated
**Then** `canStop` returns `true`
**And** Stop button is rendered

**Verification**: Simulate a task with `lifecycle === "running"` and `shoferAsk === undefined` and `isStreaming === false`. Assert `canStop === true`. This covers the auto-approved tool execution window.

### 10. Stop during resources/read MCP call

**Given** `AccessMcpResourceTool` has called `mcpHub.readResource()` with `task.abortSignal`
**And** the read is in progress
**When** the user clicks Stop
**Then** `task.abortSignal` fires
**And** `mcpHub.readResource`'s `RequestOptions.signal` propagates to the MCP SDK
**And** the SDK rejects the promise and sends `notifications/cancelled`
**And** `mcp-server`'s `handleResourcesRead` detects `ctx.Err() == context.Canceled`
**And** mcp-server logs `Resource read cancelled by client`

**Verification**: Assert the `readResource` promise rejected with an `AbortError`. Assert mcp-server log entry contains `Resource read cancelled by client`. Assert the response is `200 OK` with a structured JSON-RPC error (not a 5xx).
