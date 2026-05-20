# Terminology Integration Test Scenarios

Tests that verify the canonical terminology, naming, and concepts described in [`docs/terminology.md`](../docs/terminology.md) behave correctly end-to-end.

---

## Mode System

### M1 — Built-in Modes Load Correctly

- **Setup**: Fresh workspace, no `.shofermodes` file.
- **Action**: Open Shofer. Click the **Mode Selector**.
- **Assert**: All 9 built-in modes appear with correct slugs, display names, and icons as listed in §11 of terminology.md: `code`, `architect`, `ask`, `debug`, `reviewer`, `search`, `opinion`, `browser`, `orchestrator`.

### M2 — Sticky Mode Survives Task Switch

- **Setup**: Task A started in **Code** mode, Task B started in **Ask** mode.
- **Action**: Switch from Task A → Task B → Task A.
- **Assert**: Task A restores to **Code** mode, Task B restores to **Ask** mode.

### M3 — Custom Mode from `.shofermodes` Overrides Built-In

- **Setup**: Create a `.shofermodes` file defining a custom `code` mode with a different `roleDefinition` and `customInstructions`.
- **Action**: Open Shofer. Switch to **Code** mode. Send a message.
- **Assert**: The system prompt includes the custom `roleDefinition` and `customInstructions`, not the built-in defaults.

### M4 — Custom Mode with Tool Group Restrictions

- **Setup**: `.shofermodes` defines a mode `docs-only` with `groups: ["read"]` and `tools_allowed: ["write_to_file"]` with `fileRegex: "\\.md$"`.
- **Action**: Select **docs-only** mode. Ask Shofer to edit `src/app.ts`.
- **Assert**: Shofer refuses or is blocked by `FileRestrictionError`. Ask Shofer to edit `docs/README.md` — it succeeds.

### M5 — Always-Available Tools Cannot Be Disabled

- **Setup**: `.shofermodes` defines a mode with `tools_denied: ["attempt_completion", "update_todo_list"]`.
- **Action**: Select that mode. Run a task to completion.
- **Assert**: `attempt_completion` and `update_todo_list` are still available despite being denied (they are in `ALWAYS_AVAILABLE_TOOLS`).

---

## Task States & Lifecycle

### TS1 — State Indicator Colors Match Terminology

- **Setup**: Create tasks and transition them through states.
- **Action**: Observe the colored dot for each state.
- **Assert**:
    - `idle` → gray dot
    - `running` → green dot with pulse animation
    - `waiting_input` → yellow dot with pulse animation
    - `waiting` → yellow dot with pulse animation
    - `paused` → orange dot (no pulse)
    - `completed` → green checkmark icon
    - `error` → red warning icon

### TS2 — `waiting` Lifecycle Appears During `wait_for_task`

- **Setup**: Spawn a long-running background subtask via `new_task` with `is_background=true`.
- **Action**: Call `wait_for_task` from the parent. Observe the parent's state dot.
- **Assert**: The parent transitions to yellow `waiting` state (not `idle` and not `running`). When the child completes, the parent resumes to `running`.

### TS3 — Rating Overlay Appears After Completion

- **Setup**: Start a task and let it call `attempt_completion` with `rating: "well"`.
- **Action**: Observe the task in **Task Selector** and **History View**.
- **Assert**: The task shows `completed` lifecycle with the rating overlay. The `CompletionRating` is one of `"poor"`, `"well"`, or `"excellent"`.

---

## Tool System

### TL1 — All `toolNames` Canonical Names Are Recognized

- **Setup**: Send a message that asks Shofer to use each tool name listed in §9 of terminology.md.
- **Action**: Verify the tool call is parsed and executed (or properly rejected with a meaningful error, not "missing nativeArgs").
- **Assert**: Every `ToolName` listed in `toolNames` const has a valid parser case in `NativeToolCallParser`, a handler class, and a `ToolGroup` assignment.

### TL2 — Deprecated Tool Names Are Auto-Translated

- **Setup**: Send a message instructing Shofer to call `skill_load`, `write_file`, or `search_and_replace`.
- **Action**: Observe the tool call.
- **Assert**: The deprecated names are mapped to `skills`, `write_to_file`, and `edit` respectively via `TOOL_ALIASES` or `NativeToolCallParser`.

### TL3 — Tool Group Assignment Is Consistent

- **Setup**: Check the `TOOL_GROUPS` mapping in source.
- **Action**: Verify each tool appears in exactly one group.
- **Assert**: No tool appears in 0 groups (orphan) or 2+ groups (ambiguous). The `uncategorized` group is empty.

### TL4 — Auto-Approve Toggles Gate the Correct Groups

- **Setup**: Enable only `alwaysAllowReadOnly`. Disable all other auto-approval toggles.
- **Action**: Ask Shofer to `read_file` (read group) and `apply_diff` (write group).
- **Assert**: `read_file` runs without approval prompt. `apply_diff` shows an approval dialog.

### TL5 — Async MCP Tools Work Correctly

- **Setup**: An MCP server is connected with a slow tool.
- **Action**: Call `call_mcp_tool_async`. Then call `check_mcp_call_status` with the returned `call_id`. Then call `wait_for_mcp_call`.
- **Assert**:
    - `call_mcp_tool_async` returns immediately with a `call_id`.
    - `check_mcp_call_status` returns `running` initially, then eventually `completed` with the result.
    - `wait_for_mcp_call` blocks until the call completes and returns the result.

---

## Special Files

### SF1 — `.shoferignore` Filters Files from Tools

- **Setup**: Create a `.shoferignore` with `*.secret` and a file `test.secret` in the workspace.
- **Action**: Ask Shofer to `list_files` and `read_file test.secret`.
- **Assert**: `test.secret` does not appear in `list_files`. `read_file` fails with a protected/ignored error.

### SF2 — `.shoferprotected` Requires Approval for Protected Files

- **Setup**: Create a `.shoferprotected` that protects `config.json`.
- **Action**: Ask Shofer to modify `config.json`.
- **Assert**: Shofer shows an approval dialog with the shield (🛡️) indicator before proceeding.

### SF3 — `.shofer/rules/` Rules Are Injected into System Prompt

- **Setup**: Create `.shofer/rules/my-rule.md` with a custom instruction.
- **Action**: Start a new task and inspect the system prompt.
- **Assert**: The content from `my-rule.md` appears in the system prompt.

---

## IPC Protocol

### IPC1 — Webview → Host Message Types Match

- **Setup**: Interact with various UI elements.
- **Action**: Monitor the `WebviewMessage.type` values sent.
- **Assert**: All types match the `WebviewMessage["type"]` union in `vscode-extension-host.ts`. No ad-hoc types are sent.

### IPC2 — Host → Webview Message Types Match

- **Setup**: Trigger various host-side events (task start, task complete, indexing update, file changes).
- **Action**: Monitor the `ExtensionMessage.type` values received by the webview.
- **Assert**: All types match the `ExtensionMessage["type"]` union in `vscode-extension-host.ts`.

### IPC3 — `changedFiles/update` Payload Structure

- **Setup**: Use `apply_diff` to modify a file.
- **Action**: Observe the `changedFiles/update` message.
- **Assert**: The payload matches `ChangedFilesPayload`: `{ taskId: string, entries: ChangedFileEntry[], backend: "working" | "none" }`. Each entry has `path`, `insertions`, `deletions`, `binary`, `state`, `source: "working"`, `hasOriginalContent`, `hasFinalContent`.

### IPC4 — Message Queue Drain

- **Setup**: Start a long-running task. While it's running, type 3 messages.
- **Action**: Wait for the task to finish processing each message.
- **Assert**: All 3 queued messages appear in the **Queued Messages** section. They are processed in FIFO order. Clicking **Send Now** cancels the current turn and immediately processes the first queued message.

---

## API Provider Profiles

### AP1 — Sticky Profile Survives Task Switch

- **Setup**: Task A uses profile "openrouter", Task B uses profile "deepseek".
- **Action**: Switch from Task A → Task B → Task A.
- **Assert**: Task A restores to "openrouter" profile, Task B restores to "deepseek" profile.

### AP2 — Context Window Bar Reflects Correct Model Limit

- **Setup**: Select a model with a known context window (e.g., 128K).
- **Action**: Send progressively longer conversations.
- **Assert**: The **Context Window Bar** in the **Task Header** fills up proportionally. The tooltip or label shows the correct max token count for the selected model.

---

## UI Component Mapping

### UI1 — All Chat Input Bar Controls Are Present

- **Action**: Open Shofer with a new task.
- **Assert**: The Chat Input Bar contains: **Mode Selector**, **API Config Selector**, **Auto-Approve Dropdown**, **Commands Button**, **Skills Button**, **Worktree Indicator**, **Indexing Badge**, text input, Send button.

### UI2 — Task Selector Shows Hierarchy

- **Setup**: Create a parent task that spawns a child via `new_task`.
- **Action**: Open the **Task Selector** dropdown.
- **Assert**: The child task appears indented under the parent with a hierarchy indicator.

### UI3 — File Changes Panel Accept / Revert

- **Setup**: Use `apply_diff` to modify 2 files.
- **Action**: Click **Accept** on one file, **Revert** on the other.
- **Assert**: The accepted change persists. The reverted change is undone. Accept All / Revert All buttons work correctly.

---

## Cost Limits

### CL1 — Budget Action Triggers Correctly

- **Setup**: Set a `CostLimit` of `{ maxUsd: 0.01, action: "pause" }`.
- **Action**: Run a task that will exceed $0.01.
- **Assert**: The task pauses with a budget-limit notification. The user can increase the limit.

### CL2 — Kill Action Terminates Immediately

- **Setup**: Set a `CostLimit` of `{ maxUsd: 0.01, action: "kill" }`.
- **Action**: Run a task that will exceed $0.01.
- **Assert**: The task terminates immediately without showing a pause dialog.
