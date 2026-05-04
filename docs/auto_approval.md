# Roo Code Auto-Approval System

Complete reference for how tool auto-approval works in Roo Code. This document describes
the decision flow, the available categories/toggles, and which tools fall under each category.

Source: [`src/core/auto-approval/index.ts`](../src/core/auto-approval/index.ts)

---

## Decision Flow

Every user-facing ask (tool use, command execution, MCP access, follow-up question, mode
switch) passes through `checkAutoApproval()`. The decision order is:

1. **Non-blocking asks** — unconditionally approved (no UI interaction needed).
2. **`autoApprovalEnabled` gate** — if the master toggle is off, everything goes to the user.
3. **Per-category checks** — evaluated in a fixed order (followup → MCP → command → tool).
4. **Fallback** — anything not matched returns `{ decision: "ask" }`.

The possible decisions are:

| Decision  | Meaning                                                    |
| --------- | ---------------------------------------------------------- |
| `approve` | Tool runs immediately without user interaction.            |
| `deny`    | Tool is blocked without asking the user.                   |
| `ask`     | User is prompted for approval.                             |
| `timeout` | Auto-approve after a countdown (follow-up questions only). |

---

## Auto-Approval Categories (Toggles)

These are the boolean toggles exposed in the UI. Each controls a specific class of actions.

| Toggle (`alwaysAllow*`)        | Controls                           | Additional Options                                              |
| ------------------------------ | ---------------------------------- | --------------------------------------------------------------- |
| `alwaysAllowReadOnly`          | Tools in the `read` ToolGroup      | `alwaysAllowReadOnlyOutsideWorkspace`                           |
| `alwaysAllowWrite`             | Tools in the `write` ToolGroup     | `alwaysAllowWriteOutsideWorkspace`, `alwaysAllowWriteProtected` |
| `alwaysAllowBrowser`           | Tools in the `browser` ToolGroup   | –                                                               |
| `alwaysAllowMcp`               | MCP tool calls and resource access | `mcpServers` (per-tool `alwaysAllow` flag)                      |
| `alwaysAllowModeSwitch`        | `switch_mode` tool                 | –                                                               |
| `alwaysAllowSubtasks`          | `new_task` and `finishTask`        | –                                                               |
| `alwaysAllowExecute`           | Shell command execution            | `allowedCommands`, `deniedCommands`                             |
| `alwaysAllowFollowupQuestions` | Follow-up question suggestions     | `followupAutoApproveTimeoutMs`                                  |

> **Each toggle maps to a ToolGroup** (see [`tool-categories.md`](tool-categories.md)).
> Adding a new group to `TOOL_GROUPS` in [`packages/types/src/tool.ts`](../packages/types/src/tool.ts)
> automatically makes it available for auto-approval — a tool inherits the toggle of the group
> it belongs to.

---

## Unconditionally Auto-Approved Tools

These tools bypass **all** toggles and are always approved. The system considers them
either harmless meta-operations or purely informational queries against in-memory state.

### Meta-Operations

| Tool               | Rationale                                                       |
| ------------------ | --------------------------------------------------------------- |
| `update_todo_list` | Updates the task checklist — UI-only, no side effects.          |
| `skill`            | Loads pre-defined instructions — skills must be user-installed. |
| `set_task_title`   | Renames the task in UI and history — non-destructive.           |

### Background-Task Status Tools

These query **in-memory state** owned by the parent task. They never touch the filesystem
or network and mutate nothing:

| Tool                    | Description                                                                   |
| ----------------------- | ----------------------------------------------------------------------------- |
| `check_task_status`     | Check status/result of a background child task.                               |
| `wait_for_task`         | Block until one or more background tasks complete (event-driven, no polling). |
| `list_background_tasks` | List all background child tasks started by this task.                         |

> **Important distinction:** The _status_ tools are unconditionally approved, but
> **`new_task` itself is gated** behind `alwaysAllowSubtasks`. If that toggle is off,
> the model must ask permission before spawning a child task. This prevents uncontrolled
> task-tree growth while still letting the model inspect tasks it has already spawned.

### Lightweight Read-Only Tools

These tools query in-memory editor/LSP state, fetch public URLs, or list workspace
metadata. They cannot mutate user state and are unconditionally approved (independent
of `alwaysAllowReadOnly`):

| Tool                       | What it queries                                    |
| -------------------------- | -------------------------------------------------- |
| `fetch_web_page`           | Public web pages (HTTP GET only).                  |
| `find_files`               | File-name glob matching against workspace index.   |
| `view_image`               | Reads an image file for visual analysis.           |
| `get_errors`               | Language-server diagnostics for open files.        |
| `get_changed_files`        | Files modified during the current task session.    |
| `get_project_setup_info`   | Detected languages, frameworks, and build systems. |
| `get_search_results`       | VS Code text search (opens Search panel).          |
| `read_project_structure`   | Directory tree of the workspace.                   |
| `list_code_usages`         | LSP "find all references" for a symbol.            |
| `codebase_search_with_lsp` | LSP workspace symbol search.                       |

---

## Conditional Auto-Approval (Toggle-Gated)

### `alwaysAllowSubtasks`

Controls **task creation and completion only**. The background-task status tools
(`check_task_status`, `wait_for_task`, `list_background_tasks`) are **not** gated
by this toggle (see [Unconditionally Auto-Approved](#unconditionally-auto-approved-tools)).

| Tool         | Toggle ON                 | Toggle OFF            |
| ------------ | ------------------------- | --------------------- |
| `new_task`   | `{ decision: "approve" }` | `{ decision: "ask" }` |
| `finishTask` | `{ decision: "approve" }` | `{ decision: "ask" }` |

### `alwaysAllowModeSwitch`

Controls the `switch_mode` tool only.

### `alwaysAllowReadOnly`

Controls the read-only tool actions as classified by `isReadOnlyToolAction()`:

| Tool                       |
| -------------------------- |
| `read_file`                |
| `list_files`               |
| `search_files`             |
| `codebase_search`          |
| `codebase_search_with_lsp` |
| `run_slash_command`        |
| `find_files`               |
| `view_image`               |
| `get_errors`               |
| `get_changed_files`        |
| `get_project_setup_info`   |
| `get_search_results`       |
| `read_project_structure`   |
| `list_code_usages`         |
| `fetch_web_page`           |

> **Note:** Some tools appear both here and in the unconditionally-approved list.
> The unconditional path takes precedence — these tools are approved before the
> `alwaysAllowReadOnly` check runs.

When a tool operates **outside the workspace**, `alwaysAllowReadOnlyOutsideWorkspace`
must also be `true` for auto-approval.

### `alwaysAllowWrite`

Controls the write tool actions as classified by `isWriteToolAction()`:

| Tool                 |
| -------------------- |
| `editedExistingFile` |
| `appliedDiff`        |
| `newFileCreated`     |
| `generate_image`     |

Additional constraints:

- **Outside workspace:** requires `alwaysAllowWriteOutsideWorkspace`.
- **Protected files:** requires `alwaysAllowWriteProtected`.

### `alwaysAllowExecute`

Controls shell command execution. When enabled, each command is evaluated against
`allowedCommands` and `deniedCommands` using prefix-matching with a "longest match wins"
rule:

- If only an allowlist match → `auto_approve`
- If only a denylist match → `auto_deny`
- If both match → longer prefix wins
- If neither matches → `ask_user`
- Wildcard `*` in allowlist matches any command
- Dangerous substitution patterns (`$(…)`, `` `…` ``, `${!var}`, zsh `=(…)`, zsh glob qualifiers) force `ask_user` regardless of allowlist

### `alwaysAllowMcp`

Controls MCP tool calls and resource access. For `use_mcp_tool`, the tool must also have
its per-tool `alwaysAllow` flag set in the MCP server configuration. For
`access_mcp_resource`, the toggle alone is sufficient.

### `alwaysAllowFollowupQuestions`

When ON and a `followupAutoApproveTimeoutMs` is configured, follow-up question suggestions
auto-select after a countdown. Without a timeout, the toggle alone does not auto-approve
— the user is still asked.

---

## `ALWAYS_AVAILABLE_TOOLS` vs Auto-Approval

These are **separate concepts**:

| Concept                  | Defined in                                                              | What it controls                                     |
| ------------------------ | ----------------------------------------------------------------------- | ---------------------------------------------------- |
| `ALWAYS_AVAILABLE_TOOLS` | [`packages/types/src/tool.ts`](../packages/types/src/tool.ts)           | Which tools the model can _see and use_ in any mode  |
| Auto-approval            | [`src/core/auto-approval/index.ts`](../src/core/auto-approval/index.ts) | Whether a tool invocation requires user confirmation |

A tool being in `ALWAYS_AVAILABLE_TOOLS` does **not** mean it's auto-approved. For example,
`new_task` is always available but still requires the `alwaysAllowSubtasks` toggle for
auto-approval. Conversely, `codebase_search` is auto-approved unconditionally but is
**not** in `ALWAYS_AVAILABLE_TOOLS` — it's available through the mode's `read` group.

---

## Cost & Request Limits

In addition to per-tool approval, the [`AutoApprovalHandler`](../src/core/auto-approval/AutoApprovalHandler.ts)
tracks consecutive API requests and cumulative cost (`allowedMaxRequests`, `allowedMaxCost`).
When either limit is exceeded, the user is prompted regardless of per-tool toggle state.

---

## Related Files

| File                                                                                                | Purpose                                      |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| [`src/core/auto-approval/index.ts`](../src/core/auto-approval/index.ts)                             | Main decision logic                          |
| [`src/core/auto-approval/tools.ts`](../src/core/auto-approval/tools.ts)                             | `isReadOnlyToolAction` / `isWriteToolAction` |
| [`src/core/auto-approval/mcp.ts`](../src/core/auto-approval/mcp.ts)                                 | MCP per-tool `alwaysAllow` check             |
| [`src/core/auto-approval/commands.ts`](../src/core/auto-approval/commands.ts)                       | Command allowlist/denylist evaluation        |
| [`src/core/auto-approval/AutoApprovalHandler.ts`](../src/core/auto-approval/AutoApprovalHandler.ts) | Cost & request limit tracking                |
| [`packages/types/src/tool.ts`](../packages/types/src/tool.ts)                                       | `ALWAYS_AVAILABLE_TOOLS`, tool groups        |
