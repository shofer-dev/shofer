# Shofer Auto-Approval System

Complete reference for how tool auto-approval works in Shofer. This document describes
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

| Toggle (`alwaysAllow*`)        | Controls                                                                       | Additional Options                                                       |
| ------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `alwaysAllowReadOnly`          | Tools in the `read` ToolGroup                                                  | `alwaysAllowReadOnlyOutsideWorkspace`                                    |
| `alwaysAllowWrite`             | Tools in the `write` ToolGroup                                                 | `alwaysAllowWriteOutsideWorkspace`, `alwaysAllowWriteProtected`          |
| `alwaysAllowBrowser`           | Tools in the `browser` ToolGroup                                               | –                                                                        |
| `alwaysAllowMcp`               | MCP tool calls and resource access                                             | `alwaysAllowUncategorized` (for tools without a `group` in `mcpServers`) |
| `alwaysAllowModeSwitch`        | `switch_mode` tool                                                             | –                                                                        |
| `alwaysAllowSubtasks`          | `new_task`, `finishTask`, `cancel_tasks`, `answer_subtask_question`            | –                                                                        |
| `alwaysAllowExecute`           | Shell command execution (gate — requires `allowedCommands` to have any effect) | `allowedCommands`, `deniedCommands`                                      |
| `alwaysAllowFollowupQuestions` | Follow-up question suggestions                                                 | `followupAutoApproveTimeoutMs`                                           |

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
| `skills`           | Loads pre-defined instructions — skills must be user-installed. |
| `set_task_title`   | Renames the task in UI and history — non-destructive.           |
| `give_feedback`    | Appends a feedback line to the extension output channel.        |

### Background-Task Status Tools

These query **in-memory state** owned by the parent task. They never touch the filesystem
or network and mutate nothing:

| Tool                    | Description                                                                   |
| ----------------------- | ----------------------------------------------------------------------------- |
| `check_task_status`     | Check status/result of a background child task.                               |
| `wait_for_task`         | Block until one or more background tasks complete (event-driven, no polling). |
| `list_background_tasks` | List all background child tasks started by this task.                         |

> **Important distinction:** The _status_ tools are unconditionally approved, but
> **`new_task`**, `cancel_tasks`, `finishTask`, and `answer_subtask_question` are
> all gated behind `alwaysAllowSubtasks`. If that toggle is off, the model must ask
> permission before spawning, cancelling, or completing a subtask. This prevents
> uncontrolled task-tree growth while still letting the model inspect tasks it has
> already spawned.

### Lightweight Read-Only Tools

These tools query in-memory editor/LSP state, fetch public URLs, or list workspace
metadata. They cannot mutate user state and are unconditionally approved (independent
of `alwaysAllowReadOnly`):

| Tool                     | What it queries                                    |
| ------------------------ | -------------------------------------------------- |
| `fetch_web_page`         | Public web pages (HTTP GET only).                  |
| `find_files`             | File-name glob matching against workspace index.   |
| `view_image`             | Reads an image file for visual analysis.           |
| `get_errors`             | Language-server diagnostics for open files.        |
| `get_changed_files`      | Files modified during the current task session.    |
| `get_project_setup_info` | Detected languages, frameworks, and build systems. |
| `read_project_structure` | Directory tree of the workspace.                   |
| `list_code_usages`       | LSP "find all references" for a symbol.            |
| `lsp_search`             | LSP workspace symbol search.                       |

### Async MCP Call Status Tools

These tools query in-memory state of async MCP calls. They mutate nothing and are
unconditionally approved:

| Tool                    | Description                                          |
| ----------------------- | ---------------------------------------------------- |
| `check_mcp_call_status` | Check status/result of an async MCP tool call.       |
| `wait_for_mcp_call`     | Block until async MCP calls complete (event-driven). |

---

## Conditional Auto-Approval (Toggle-Gated)

### `alwaysAllowSubtasks`

Controls **task creation, completion, cancellation, and subtask question answering**.
The background-task status tools (`check_task_status`, `wait_for_task`,
`list_background_tasks`) are **not** gated by this toggle (see
[Unconditionally Auto-Approved](#unconditionally-auto-approved-tools)).

| Tool                      | Toggle ON                 | Toggle OFF            |
| ------------------------- | ------------------------- | --------------------- |
| `new_task`                | `{ decision: "approve" }` | `{ decision: "ask" }` |
| `finishTask`              | `{ decision: "approve" }` | `{ decision: "ask" }` |
| `cancel_tasks`            | `{ decision: "approve" }` | `{ decision: "ask" }` |
| `answer_subtask_question` | `{ decision: "approve" }` | `{ decision: "ask" }` |

### `alwaysAllowModeSwitch`

Controls the `switch_mode` tool only.

### `alwaysAllowReadOnly`

Controls the read-only tool actions as classified by `isReadOnlyToolAction()`:

| Tool                     |
| ------------------------ |
| `read_file`              |
| `list_files`             |
| `grep_search`            |
| `rag_search`             |
| `lsp_search`             |
| `find_files`             |
| `view_image`             |
| `get_errors`             |
| `get_changed_files`      |
| `get_project_setup_info` |
| `list_code_usages`       |
| `fetch_web_page`         |
| `git_search`             |
| `ask_assistant_agent`    |

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

Controls shell command execution. **This toggle is a gate — it does NOT auto-approve any
command on its own.** Turning it ON merely enables the allowlist/denylist evaluation
pipeline; without entries in `allowedCommands`, every command still prompts the user.

When enabled, each command is first parsed into sub-commands (split by `&&`, `||`, `;`,
`|`, `&`, and newlines), then each sub-command is evaluated against `allowedCommands` and
`deniedCommands` using prefix-matching with a "longest match wins" rule:

| allowedCommands          | deniedCommands | Command              | Result                            |
| ------------------------ | -------------- | -------------------- | --------------------------------- |
| `["git"]`                | `[]`           | `git status`         | `auto_approve`                    |
| `["git"]`                | `["git push"]` | `git push origin`    | `auto_deny` (denylist longer)     |
| `["git push --dry-run"]` | `["git push"]` | `git push --dry-run` | `auto_approve` (allowlist longer) |
| `["*"]`                  | `["rm"]`       | `rm -rf /`           | `auto_deny`                       |
| `["*"]`                  | `[]`           | `echo hello`         | `auto_approve`                    |
| `["git"]`                | `[]`           | `npm install`        | `ask_user` (no match)             |
| `[]` (empty)             | `[]`           | `anything`           | `ask_user` (nothing matches)      |

**Decision logic per sub-command:**

- If only an allowlist match → `auto_approve`
- If only a denylist match → `auto_deny`
- If both match → longer prefix wins
- If neither matches → `ask_user`

**Aggregation across sub-commands:** If **any** sub-command is denied, the whole command
chain is `auto_deny`. Only when **all** sub-commands are approved does the chain get
`auto_approve`.

**Wildcard `*`** in `allowedCommands` matches any command, but denylist entries can still
block specific commands via longer-prefix-match.

**Dangerous substitution patterns** are **never** auto-approved — even with `allowedCommands = ["*"]`.
These always force an explicit user prompt:

- `${var@P}` — Prompt string expansion (executes embedded commands)
- `${var@Q}`, `${var@E}`, `${var@A}`, `${var@a}` — Parameter expansion operators
- `${!var}` — Indirect variable references
- `<<<$(...)` or `<<<\`...\`` — Here-strings with command substitution
- `=(...)` — Zsh process substitution (except array assignments like `var=(...)`)
- `*(e:...:)`, `?(e:...:)` — Zsh glob qualifiers with code execution

If `alwaysAllowExecute` is **OFF**, every shell command always prompts the user for
approval, regardless of `allowedCommands` or `deniedCommands` configuration.

### `alwaysAllowMcp`

Controls MCP tool calls and resource access. For `use_mcp_tool`, the tool must be
categorized into a tool group (via its `group` field in MCP server configuration).
Tools without an explicit group default to `"uncategorized"` and require the
additional `alwaysAllowUncategorized` toggle. For `access_mcp_resource`, the
`alwaysAllowMcp` toggle alone is sufficient.

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
`send_message_to_task` (sync mode) is always available but still requires the
`alwaysAllowSubtasks` toggle for auto-approval. Conversely, `fetch_web_page` is
auto-approved unconditionally but is **not** in `ALWAYS_AVAILABLE_TOOLS` — it's
available through the mode's `read` group.

---

## Cost & Request Limits

In addition to per-tool approval, the [`AutoApprovalHandler`](../src/core/auto-approval/AutoApprovalHandler.ts)
tracks consecutive API requests and cumulative cost (`allowedMaxRequests`, `allowedMaxCost`).
When either limit is exceeded, the user is prompted regardless of per-tool toggle state.

---

## Related Files

| File                                                                                                | Purpose                                                 |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| [`src/core/auto-approval/index.ts`](../src/core/auto-approval/index.ts)                             | Main decision logic                                     |
| [`src/core/auto-approval/tools.ts`](../src/core/auto-approval/tools.ts)                             | `isReadOnlyToolAction` / `isWriteToolAction`            |
| [`src/core/auto-approval/mcp.ts`](../src/core/auto-approval/mcp.ts)                                 | Uncategorized MCP tool check (`isMcpToolUncategorized`) |
| [`src/core/auto-approval/commands.ts`](../src/core/auto-approval/commands.ts)                       | Command allowlist/denylist evaluation                   |
| [`src/core/auto-approval/AutoApprovalHandler.ts`](../src/core/auto-approval/AutoApprovalHandler.ts) | Cost & request limit tracking                           |
| [`packages/types/src/tool.ts`](../packages/types/src/tool.ts)                                       | `ALWAYS_AVAILABLE_TOOLS`, tool groups                   |

---

## Gaps, Issues & Improvement Areas

_Discovered during the 2026-05-20 verification review against source at [`index.ts`](../src/core/auto-approval/index.ts) (rev ffde35c) and
[`tools.ts`](../src/core/auto-approval/tools.ts)._

### Documentation Gaps (Corrected)

1. **Missing unconditionally-approved tools** — `give_feedback`, `check_mcp_call_status`, and `wait_for_mcp_call`
   were unconditionally approved in code but absent from the doc. Added as Meta-Operations and
   Async MCP Call Status Tools respectively.

2. **Missing `cancel_tasks` / `answer_subtask_question` from `alwaysAllowSubtasks`** — the doc claimed
   the toggle controlled only `new_task` and `finishTask`. The actual gate covers all four
   control-plane subtask tools. Expanded the toggles table, subtasks table, and callout.

3. **Missing `alwaysAllowUncategorized` toggle** — defined as an `AutoApprovalState`
   variant in code but absent from the toggles table. Added as additional option for `alwaysAllowMcp`.

4. **Missing `git_search` and `ask_assistant_agent`** from the `alwaysAllowReadOnly` tool table.
   Both are in `TOOL_GROUPS.read` and therefore gated by this toggle.

5. **Incorrect `run_slash_command` in `alwaysAllowReadOnly` table** — `run_slash_command` is
   NOT in `TOOL_GROUPS.read` (it lives in `ALWAYS_AVAILABLE_TOOLS` only). Removing it from
   the gated table was correct; the old listing would mislead readers into thinking the
   toggle gates the tool.

### Factual Errors (Corrected)

6. **`skill` / `skills` name mismatch** — the doc used the canonical tool name `skill`; the
   code uses the SayTool name `skills`. Changed to match code.

7. **MCP per-tool `alwaysAllow` flag** — the `McpTool` type has no `alwaysAllow` field
   (only `name`, `description`, `inputSchema`, `enabledForPrompt`, `group`). Rewrote the MCP
   section to describe the actual mechanism (group-based gating + `alwaysAllowUncategorized`).

8. **`rag_search` not unconditionally auto-approved** — the doc's `ALWAYS_AVAILABLE_TOOLS` vs
   Auto-Approval section used `rag_search` as an example of unconditional auto-approval, but
   it's actually gated by `alwaysAllowReadOnly`. Replaced with `fetch_web_page` which IS
   unconditionally approved.

### Structural / Completeness Issues (Open)

9. **No mention of `call_mcp_tool_async` routing** — `call_mcp_tool_async` goes through the
   `use_mcp_server` ask gate (not the `tool` ask path) and therefore falls under `alwaysAllowMcp`.
   The `check_mcp_call_status` / `wait_for_mcp_call` pair goes through the `tool` ask path and
   is unconditionally approved. This asymmetry is not documented.

10. **"Non-blocking asks" terminology ambiguous** — step 1 of the Decision Flow says "Non-blocking
    asks" but the actual code calls `isAutoApprovableAsk()`. Today this is only `command_output`,
    which is indeed non-blocking, but the underlying concept is "auto-approvable at the ask level"
    rather than "non-blocking." The two may diverge if additional asks are added to `autoApprovableAsks`.

11. **No test coverage reference** — the auto-approval system has tests (e.g.,
    [`auto-approval/__tests__/`](../src/core/auto-approval/__tests__/) if it exists) but the
    doc doesn't link to them. Adding test references would help developers verify behavior.

12. **Multiple independent lists of unconditionally-approved tools** — the `index.ts` code
    has four separate `if` blocks that unconditionally approve different tool sets
    (meta-operations, subtask status, async MCP status, lightweight read-only). These are
    conceptually related but not labelled in code. A consolidated comment or helper function
    would reduce the risk of the next tool being added to the wrong block.

13. **`mcp.ts` purpose description in Related Files is stale** — the table says "MCP per-tool
    `alwaysAllow` check" but the function `isMcpToolUncategorized` checks the `group` field,
    not `alwaysAllow`. The description should read "uncategorized MCP tool check" or similar.
