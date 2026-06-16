# Command Execution Lifecycle

How `execute_command` and `read_command_output` work together — from invocation through output delivery, cancellation, and cleanup.

---

## 1. Architecture Overview

```
LLM calls execute_command(command, cwd?, timeout?)
        │
        ▼
┌─────────────────────────────────────────────────────┐
│  ExecuteCommandTool.execute()                       │
│  ├─ Validate command (non-empty, .shofer/shoferignore)     │
│  ├─ Ask user approval ("command" ask)               │
│  ├─ Resolve working directory                       │
│  └─ executeCommandInTerminal(task, options)         │
│       │                                             │
│       ├─ OutputInterceptor (head/tail buffer)       │
│       ├─ TerminalRegistry.getOrCreateTerminal()     │
│       ├─ terminal.runCommand(command, callbacks)    │
│       ├─ Dual-timeout race                          │
│       └─ Format response (inline or persisted)      │
└─────────────────────────────────────────────────────┘
        │
        ▼
  Tool result to LLM
  ├─ Output fits preview → inline output + exit code
  └─ Output exceeds preview → preview + artifact_id
                                │
                                ▼
                    LLM calls read_command_output(
                      artifact_id, search?, offset?, limit?
                    )
```

---

## 2. `execute_command` Parameters

| Parameter | Type             | Required | Behavior                                                                        |
| --------- | ---------------- | :------: | ------------------------------------------------------------------------------- |
| `command` | `string`         |    ✅    | Shell command to execute                                                        |
| `cwd`     | `string \| null` |    –     | Working directory; relative paths resolved from `task.cwd`; absent = `task.cwd` |
| `timeout` | `number \| null` |    –     | Agent-side soft timeout in **seconds** (see §4.2)                               |

**Schema definition:** [`src/core/prompts/tools/native-tools/execute_command.ts`](../src/core/prompts/tools/native-tools/execute_command.ts)
**Tool handler:** [`src/core/tools/ExecuteCommandTool.ts`](../src/core/tools/ExecuteCommandTool.ts)

### Prompt contract (what the LLM is told)

> `timeout` (optional) — When exceeded, the command continues running in the background and you receive the output so far. This allows you to proceed with your turn without waiting for the command to exit. You can monitor the process output by calling `execute_command` again (with no timeout) to get the latest output.

---

## 3. Output Delivery: Inline vs Persisted

### 3.1 Preview Threshold

Commands produce output that streams through an [`OutputInterceptor`](../src/integrations/terminal/OutputInterceptor.ts), which uses a **head/tail buffer** strategy:

```
Preview budget (per terminalOutputPreviewSize setting)
├── Head buffer: 50% — first N bytes (always preserved)
└── Tail buffer: 50% — last N bytes (rolling, drops old lines)
```

The preview size is controlled by the user setting `terminalOutputPreviewSize` (`"small"`, `"medium"` [default], or `"large"`) with byte thresholds defined in [`TERMINAL_PREVIEW_BYTES`](../packages/types/src/terminal.ts).

### 3.2 When Output Fits in Preview

The LLM receives the full output inline:

```
Command executed in terminal within working directory '/path/to/cwd'.
Exit code: 0
Output:
<full output>
```

### 3.3 When Output Exceeds Preview (Truncation)

The `OutputInterceptor` spills the **full lossless output** to disk at:

```
{globalStoragePath}/tasks/{taskId}/command-output/cmd-{executionId}.txt
```

The LLM receives a truncated response:

```
Command executed in '/path/to/cwd'. Exit code: 0

Output (1.5MB) persisted. Artifact ID: cmd-1780977431651.txt

Preview:
<head + [...N bytes omitted...] + tail>

Use read_command_output tool to view full output if needed.
```

---

## 4. Timeout System

Two independent timers race against the process. Both can be active simultaneously.

### 4.1 User-Configured Timeout (Hard Kill)

| Setting                   | Source                                   | Default | Behavior                                                                                                                                                                                                                                                    |
| ------------------------- | ---------------------------------------- | :-----: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commandExecutionTimeout` | VS Code config (`seconds`, 0 = disabled) |   `0`   | **Aborts the command** via `terminalProcess.abort()` (SIGINT for shell-integration terminals, SIGKILL + process tree for execa). LLM receives: "The command was terminated after exceeding a user-configured Ns timeout. Do not try to re-run the command." |

Commands whose prefix matches `commandTimeoutAllowlist` are **exempt** from the user timeout.

### 4.2 Agent `timeout` Parameter (Soft — Background Mode)

When the LLM supplies a `timeout` value (in seconds), and the command hasn't completed by that time:

1. The agent timeout fires
2. The command is **not killed** — it continues running in the terminal
3. `process.continue()` is called so the process is unblocked
4. The LLM receives the output collected so far, wrapped in a `user_feedback` message if the user sent one
5. The LLM can monitor the process on subsequent `execute_command` calls (without a timeout)

This is the mechanism for running dev servers, file watchers, or any long-lived process.

### 4.3 Timeout Resolution

```typescript
// In executeCommandInTerminal:
const racers: Promise<void>[] = [process]

if (agentTimeout > 0) {
	racers.push(/* background timer: runInBackground=true, process.continue() */)
}
if (commandExecutionTimeout > 0) {
	racers.push(/* abort timer: terminalProcess.abort(), reject */)
}

await Promise.race(racers)
```

Both timers are cleaned up in the `finally` block regardless of which won the race.

---

## 5. Cancellation & Process Kill Paths

There are **four independent mechanisms** that can kill a running command:

### 5.1 Per-Command OctagonX Button (UI)

**Source:** [`CommandExecution.tsx`](../webview-ui/src/components/chat/CommandExecution.tsx:170-186)

When a command is running (`status === "started"`), the UI renders an **⏹ stop button** next to the PID. Clicking it posts:

```
{ type: "terminalOperation", terminalOperation: "abort" }
```

This flows through:

| Step          | File                                                                                                                                                                           | Line              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| UI click      | [`CommandExecution.tsx`](../webview-ui/src/components/chat/CommandExecution.tsx)                                                                                               | 178-181           |
| IPC handler   | [`webviewMessageHandler.ts`](../src/core/webview/webviewMessageHandler.ts)                                                                                                     | 939-941           |
| Task dispatch | [`Task.ts`](../src/core/task/Task.ts)                                                                                                                                          | 2611-2616         |
| Terminal kill | [`TerminalProcess.ts`](../src/integrations/terminal/TerminalProcess.ts) (VS Code) or [`ExecaTerminalProcess.ts`](../src/integrations/terminal/ExecaTerminalProcess.ts) (execa) | 259-263 / 163-219 |

**Kill mechanism:**

- **VS Code shell integration:** Sends `Ctrl+C` (`\x03`) via `terminal.sendText("\x03")`
- **Execa fallback:** `SIGKILL` on subprocess + stored PID + `psTree` walk for child processes

### 5.2 Reject Button on `command_output` Ask (UI)

**Source:** [`ChatView.tsx`](../webview-ui/src/components/chat/ChatView.tsx:1303-1305) and [`WorkflowView.tsx`](../webview-ui/src/components/chat/WorkflowView.tsx:1278-1280)

When the LLM is in a `command_output` ask (the "Kill Command" secondary button), clicking it posts `{ type: "terminalOperation", terminalOperation: "abort" }`, routing through the same path as §5.1.

### 5.3 Global Stop Button

**Source:** [`Task.ts`](../src/core/task/Task.ts:3555-3558)

When the user clicks the global **Stop** button:

1. [`ShoferProvider.cancelTask()`](../src/core/webview/ShoferProvider.ts:4311) → `_cancelTaskInner()`
2. Cancels the LLM HTTP request via `task.cancelCurrentRequest()`
3. Calls `task.abortTask()` which:
    - Sets `this.abort = true`
    - Fires `_taskAbortController.abort()` (cancels MCP calls, etc.)
    - **Calls `this.terminalProcess?.abort()`** — kills the running command
    - Calls `dispose()` → `TerminalRegistry.releaseTerminalsForTask()` (disassociates the terminal)
    - Cleans up command output artifacts via `OutputInterceptor.cleanup()`

### 5.4 User-Configured Timeout (Automatic)

Described in §4.1 — automatic kill after `commandExecutionTimeout` seconds.

### 5.5 Summary Table

| Action                         | Kills process? | Mechanism                                                    |
| ------------------------------ | :------------: | ------------------------------------------------------------ |
| Per-command OctagonX button    |       ⚠️       | `terminalProcess.abort()` → SIGINT or SIGKILL + process tree |
| Reject on `command_output` ask |       ⚠️       | Same path as OctagonX                                        |
| **Global Stop button**         |       ✅       | `task.terminalProcess?.abort()` inside `abortTask()`         |
| User `commandExecutionTimeout` |       ✅       | Automatic SIGINT/SIGKILL after timeout                       |
| Agent `timeout` parameter      |       ❌       | Backgrounds process — keeps running, LLM can monitor later   |

> ⚠️ **Known gap (§5.6):** The OctagonX button and Reject button are ineffective for backgrounded commands because `task.terminalProcess` is cleared unconditionally in the `finally` block and `TerminalProcess.abort()` is guarded by `isListening` (which is `false` after backgrounding). See the fix design below.

---

### 5.6 Known Gap: Premature Termination of Backgrounded Commands

The OctagonX stop button in [`CommandExecution.tsx`](../webview-ui/src/components/chat/CommandExecution.tsx:170-186) is designed to let users kill a running command at any time. However, the button is **only functional** before the `execute_command` tool returns. Once the tool exits — whether the command completes, the agent timeout fires, or the user clicks "Proceed While Running" — the kill path breaks in two independent ways.

#### Root Cause Analysis

**Bug 1: `task.terminalProcess` is unconditionally cleared.**

Source: [`ExecuteCommandTool.ts`](../src/core/tools/ExecuteCommandTool.ts:494-498)

```typescript
} finally {
    clearTimeout(agentTimeoutId)
    clearTimeout(userTimeoutId)
    clearTimeout(pendingCommandOutputEmitTimer)
    task.terminalProcess = undefined  // ← cleared even for backgrounded commands
}
```

The `finally` block runs after the `Promise.race` resolves — which happens in three scenarios:

1. The process exits naturally (`process` promise resolves)
2. The agent timeout fires (`runInBackground = true`, `process.continue()`, racer resolves)
3. The user timeout fires (reject, caught by `catch`)

In scenario 2, the command is still alive in the terminal, but `task.terminalProcess` is set to `undefined`. Any subsequent `handleTerminalOperation("abort")` call is a no-op:

```typescript
// Task.ts:2935-2941
async handleTerminalOperation(terminalOperation: "continue" | "abort") {
    if (terminalOperation === "continue") {
        this.terminalProcess?.continue()   // ← undefined?.continue() → no-op
    } else if (terminalOperation === "abort") {
        this.terminalProcess?.abort()      // ← undefined?.abort() → no-op
    }
}
```

**Bug 2: `TerminalProcess.abort()` is guarded by `isListening`.**

Source: [`TerminalProcess.ts`](../src/integrations/terminal/TerminalProcess.ts:259-264)

```typescript
public override abort() {
    if (this.isListening) {            // ← IS FALSE AFTER backgrounding
        this.terminal.terminal.sendText("\x03")
    }
}
```

When the command is backgrounded (agent timeout or "Proceed While Running"), several things happen:

```typescript
// TerminalProcess.ts:252-257
public override continue() {
    this.emitRemainingBufferIfListening()
    this.isListening = false           // ← DISABLED
    this.removeAllListeners("line")
    this.emit("continue")
}
```

After `continue()`, `isListening` is `false`, so even if `task.terminalProcess` were preserved, `abort()` would silently return without doing anything.

> **Note:** [`ExecaTerminalProcess.abort()`](../src/integrations/terminal/ExecaTerminalProcess.ts:163-219) does NOT have the `isListening` guard — it always kills the subprocess. This bug is specific to the VS Code shell-integration backend.

**Bug 3: The OctagonX button disappears after backgrounding.**

Source: [`CommandExecution.tsx`](../webview-ui/src/components/chat/CommandExecution.tsx:170-171)

```tsx
{status?.status === "started" && (
    // OctagonX button...
)}
```

The button is only visible when `status === "started"`. After backgrounding, the UI receives `"output"` status updates (not `"started"`), so the button disappears — the user has no UI affordance to kill the command even if the backend plumbing were functioning.

#### Fix Design

The fix spans three layers:

##### Layer 1: Webview — Keep the Button Visible for All Non-Terminal States

**File:** [`CommandExecution.tsx`](../webview-ui/src/components/chat/CommandExecution.tsx)

Change the visibility condition from `status?.status === "started"` to a non-terminal check:

```tsx
const isCommandAlive =
	status !== null && status.status !== "exited" && status.status !== "fallback" && status.status !== "timeout"

{
	isCommandAlive && (
		<div className="flex flex-row items-center gap-2 font-mono text-xs">
			{status?.status === "started" && status.pid && <div className="whitespace-nowrap">(PID: {status.pid})</div>}
			<StandardTooltip content={t("chat:commandExecution.abort")}>
				<Button
					variant="ghost"
					size="icon"
					onClick={() =>
						vscode.postMessage({
							type: "terminalOperation",
							terminalOperation: "abort",
							executionId,
						})
					}>
					<OctagonX className="size-4" />
				</Button>
			</StandardTooltip>
		</div>
	)
}
```

Key changes:

- ✅ Show PID only during `"started"` (it's not available after backgrounding)
- ✅ Show OctagonX button for any status that isn't terminal (`"exited"`, `"fallback"`, `"timeout"`)
- ✅ Include `executionId` in the `terminalOperation` message for future-proof routing

##### Layer 2: WebviewMessage — Add `executionId` to `terminalOperation`

**File:** [`packages/types/src/vscode-extension-host.ts`](../packages/types/src/vscode-extension-host.ts)

Extend the `terminalOperation` message variant:

```typescript
terminalOperation?: "continue" | "abort"
executionId?: string  // populated when abort originates from CommandExecution
```

##### Layer 3: Backend — Preserve `task.terminalProcess` and Fix `TerminalProcess.abort()`

**File A:** [`ExecuteCommandTool.ts`](../src/core/tools/ExecuteCommandTool.ts)

Guard the `task.terminalProcess = undefined` line so it only clears the reference when the command actually completed or was killed:

```typescript
} finally {
    clearTimeout(agentTimeoutId)
    clearTimeout(userTimeoutId)
    clearTimeout(pendingCommandOutputEmitTimer)
    // Only clear terminal process reference if the command finished or was killed.
    // Backgrounded commands continue running and need a live reference for UI abort.
    if (!runInBackground) {
        task.terminalProcess = undefined
    }
}
```

> **Corollary:** The global Stop button path (`abortTask()` → `this.terminalProcess?.abort()` → `dispose()` → `TerminalRegistry.releaseTerminalsForTask()`) still needs to work for backgrounded commands. Since `abortTask()` calls `terminalProcess?.abort()`, the process reference must be non-null. This is satisfied by the guard above — `task.terminalProcess` remains set for backgrounded commands.

**File B:** [`TerminalProcess.ts`](../src/integrations/terminal/TerminalProcess.ts)

Remove the `isListening` guard so `sendText("\x03")` is always issued:

```typescript
public override abort() {
    // Send SIGINT using CTRL+C regardless of isListening state.
    // Works for backgrounded commands where continue() set isListening=false.
    this.terminal.terminal.sendText("\x03")
}
```

The `sendText("\x03")` sends a literal `Ctrl+C` byte sequence to the VS Code terminal's stdin, which the shell interprets as SIGINT to the foreground process group. This works:

- ✅ While the command is actively running (`isListening = true`)
- ✅ After the command is backgrounded via `continue()` (`isListening = false`)
- ✅ Regardless of whether we're collecting output

If the terminal has no running foreground process, `\x03` is simply ignored by the shell — it's harmless.

##### Data Flow (After Fix)

```
User clicks OctagonX button on a backgrounded command
        │
        ▼
CommandExecution.tsx
  postMessage({ type: "terminalOperation", terminalOperation: "abort", executionId })
        │
        ▼
webviewMessageHandler.ts
  provider.getCurrentTask()?.handleTerminalOperation("abort")
        │
        ▼
Task.ts
  this.terminalProcess?.abort()      // ← reference is preserved (runInBackground guard)
        │
        ▼
TerminalProcess.ts / ExecaTerminalProcess.ts
  terminal.sendText("\x03")          // ← sends SIGINT regardless of isListening
  OR
  subprocess.kill("SIGKILL")        // ← execa path (no isListening guard)
        │
        ▼
Shell receives SIGINT → process terminates → onShellExecutionComplete fires
        │
        ▼
Webview receives "exited" status → OctagonX button disappears, exit badge appears
```

##### File Change Summary

| File                                                                             | Change                                                           | Risk                                          |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------- |
| [`CommandExecution.tsx`](../webview-ui/src/components/chat/CommandExecution.tsx) | Show button for all alive states; pass `executionId`             | Low — UI-visibility change only               |
| [`vscode-extension-host.ts`](../packages/types/src/vscode-extension-host.ts)     | Add optional `executionId` field                                 | Low — optional, backward-compatible           |
| [`ExecuteCommandTool.ts`](../src/core/tools/ExecuteCommandTool.ts)               | Guard `task.terminalProcess = undefined` with `!runInBackground` | Medium — must not leak process references     |
| [`TerminalProcess.ts`](../src/integrations/terminal/TerminalProcess.ts)          | Remove `isListening` guard from `abort()`                        | Low — harmless no-op if no process is running |

##### Cleanup Considerations

When a backgrounded command exits naturally after the tool has returned, `onShellExecutionComplete` fires → `"exited"` status is posted to webview → the button disappears automatically. The process reference is still set on `task.terminalProcess` but the subsequent `handleTerminalOperation("abort")` call would be a no-op (the terminal has no running command). It's harmless.

When the task ends (user stops it, task completes), the global `abortTask()` path calls `this.terminalProcess?.abort()` then `dispose()` → `TerminalRegistry.releaseTerminalsForTask()` cleans up the terminal association. No orphaned references.

---

## 6. `read_command_output` — Retrieving Truncated Output

**Schema definition:** [`src/core/prompts/tools/native-tools/read_command_output.ts`](../src/core/prompts/tools/native-tools/read_command_output.ts)
**Tool handler:** [`src/core/tools/ReadCommandOutputTool.ts`](../src/core/tools/ReadCommandOutputTool.ts)

### 6.1 Parameters

| Parameter     | Type             | Required | Behavior                                                                                                                                                       |
| ------------- | ---------------- | :------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `artifact_id` | `string`         |    ✅    | Filename from the truncation notice (e.g., `"cmd-1706119234567.txt"`). Validated against `/^cmd-\d+\.txt$/` to block path traversal.                           |
| `search`      | `string \| null` |    –     | Case-insensitive regex pattern (like grep). Invalid regex is auto-escaped to literal. **Omit entirely if not searching** — do not pass `null` or empty string. |
| `offset`      | `number \| null` |    –     | Byte offset for pagination (default: 0).                                                                                                                       |
| `limit`       | `number \| null` |    –     | Maximum bytes to return (default: 40KB).                                                                                                                       |

### 6.2 Read Mode (no `search`)

1. Opens the artifact file handle
2. Reads `[offset, offset+limit]` bytes
3. Calculates correct line numbers by counting newlines before the offset (chunked 64KB reads — avoids allocating huge buffers)
4. Adds right-padded line numbers
5. Returns a metadata header + numbered content:

```
[Command Output: cmd-1706119234567.txt]
Total size: 52.0KB | Showing bytes 0-40960 | TRUNCATED

    1 | first line
    2 | second line
  ...
```

### 6.3 Search Mode (`search` provided)

1. Streams the file in 64KB chunks (bounded memory — safe for 100MB+ files)
2. Handles partial lines across chunk boundaries via a carry-over buffer
3. Tests each complete line against the case-insensitive regex
4. Stops accumulating when the byte limit is exceeded
5. Returns match metadata + numbered matching lines:

```
[Command Output: cmd-1706119234567.txt] (search: "error|failed")
Total matches: 42 | Showing first 42

   12 | Error: connection refused
   89 | test_foo: FAILED
  ...
```

### 6.4 Artifact Storage & Cleanup

| Aspect            | Detail                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Storage path      | `{globalStoragePath}/tasks/{taskId}/command-output/cmd-{executionId}.txt`                                                                         |
| Created by        | [`OutputInterceptor.spillToDisk()`](../src/integrations/terminal/OutputInterceptor.ts:267)                                                        |
| Cleaned by        | [`OutputInterceptor.cleanup()`](../src/integrations/terminal/OutputInterceptor.ts:388) — deletes all `cmd-*.txt` (called during `Task.dispose()`) |
| Selective cleanup | [`OutputInterceptor.cleanupByIds()`](../src/integrations/terminal/OutputInterceptor.ts:417) — preserves specific execution IDs                    |

---

## 7. Terminal Backend Selection

The terminal provider is chosen based on the `terminalShellIntegrationDisabled` setting, with an automatic override for worktree-scoped tasks:

| Condition                          | Backend          | Execution                        | Kill mechanism                         |
| ---------------------------------- | ---------------- | -------------------------------- | -------------------------------------- |
| `false` (default), non-worktree    | VS Code Terminal | Shell integration via `sendText` | SIGINT via `\x03`                      |
| `true`, non-worktree               | Execa            | Subprocess via `execa`           | SIGKILL + `psTree` for child processes |
| Worktree task on **Linux**         | Execa (forced)   | Sandboxed via `shofer-sandbox`   | SIGKILL + `psTree` for child processes |
| Worktree task on **macOS/Windows** | User's setting   | Advisory warning in approval     | Per backend                            |

If the VS Code terminal throws a [`ShellIntegrationError`](../src/core/tools/ExecuteCommandTool.ts:25), the tool automatically retries with execa (without requiring the user to change settings).

### 7.1 Worktree Shell Sandboxing (Linux)

When a task runs inside an embedded worktree on Linux, `execute_command` prepends the `shofer-sandbox` wrapper binary ([`../sandbox/main.go`](../sandbox/main.go)) to the shell command. The wrapper:

1. Applies a **Landlock write-only sandbox** (kernel 5.13+) — writes are restricted to the worktree directory, `/tmp`, and `/dev/null`; reads remain unrestricted
2. Falls back to **bubblewrap** (`bwrap`) on older kernels — creates a private mount namespace with the worktree as the only writable location
3. **Forces the execa backend** — the VS Code terminal path cannot be sandboxed because VS Code owns the process lifecycle

The sandbox wrapper is the **outermost** process: `shofer-sandbox <worktree-dir> -- /bin/sh -c '<user-command>'`. This ensures the shell itself and all subprocesses inherit the Landlock ruleset. On macOS and Windows, no kernel sandbox is available — the advisory warning remains the only guard.

**Key files:** [`getWorktreeSandboxPrefix()`](../src/utils/worktreePathGuard.ts), [`sandbox/main.go`](../sandbox/main.go)

---

## 8. Key Files

| File                                                                                                                          | Role                                                                |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [`src/core/prompts/tools/native-tools/execute_command.ts`](../src/core/prompts/tools/native-tools/execute_command.ts)         | OpenAI function-calling schema for `execute_command`                |
| [`src/core/tools/ExecuteCommandTool.ts`](../src/core/tools/ExecuteCommandTool.ts)                                             | Tool handler: validation, approval, timeout, terminal orchestration |
| [`src/core/prompts/tools/native-tools/read_command_output.ts`](../src/core/prompts/tools/native-tools/read_command_output.ts) | OpenAI function-calling schema for `read_command_output`            |
| [`src/core/tools/ReadCommandOutputTool.ts`](../src/core/tools/ReadCommandOutputTool.ts)                                       | Tool handler: artifact reads, search, pagination                    |
| [`src/integrations/terminal/OutputInterceptor.ts`](../src/integrations/terminal/OutputInterceptor.ts)                         | Head/tail buffer, spill-to-disk, preview formatting                 |
| [`src/integrations/terminal/TerminalProcess.ts`](../src/integrations/terminal/TerminalProcess.ts)                             | VS Code shell-integration terminal process                          |
| [`src/integrations/terminal/ExecaTerminalProcess.ts`](../src/integrations/terminal/ExecaTerminalProcess.ts)                   | Execa fallback terminal process                                     |
| [`src/integrations/terminal/TerminalRegistry.ts`](../src/integrations/terminal/TerminalRegistry.ts)                           | Terminal lifecycle management                                       |
| [`src/utils/worktreePathGuard.ts`](../src/utils/worktreePathGuard.ts)                                                         | Worktree sandbox prefix resolution (`getWorktreeSandboxPrefix`)     |
| [`sandbox/main.go`](../sandbox/main.go)                                                                                       | Landlock/bwrap sandbox wrapper binary (Go, static-linked)           |
| [`src/core/task/Task.ts`](../src/core/task/Task.ts)                                                                           | Task-level abort (Stop button → `terminalProcess.abort()`)          |
| [`webview-ui/src/components/chat/CommandExecution.tsx`](../webview-ui/src/components/chat/CommandExecution.tsx)               | UI: command output display + OctagonX abort button                  |
| [`webview-ui/src/components/chat/ChatView.tsx`](../webview-ui/src/components/chat/ChatView.tsx)                               | UI: Reject button → terminal abort                                  |
| [`packages/types/src/terminal.ts`](../packages/types/src/terminal.ts)                                                         | `PersistedCommandOutput` type + `TERMINAL_PREVIEW_BYTES`            |
| [`packages/types/src/global-settings.ts`](../packages/types/src/global-settings.ts)                                           | `terminalOutputPreviewSize` setting                                 |

---

## 9. Related Documentation

- [`native_tools.md`](native_tools.md) — Full native tools reference with parameter tables and mode availability
- [`cancellation.md`](cancellation.md) — End-to-end Stop-button propagation through the task lifecycle
- [`configuration.md`](configuration.md) — User-facing configuration options including `commandExecutionTimeout` and `commandTimeoutAllowlist`
