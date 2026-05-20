# Migrating from Roo-Code to Shofer

Roo-Code is [sunsetting its VS Code Extension, Cloud, and Router services on May 15, 2026](https://github.com/RooCodeInc/Roo-Code). Shofer is a major improvement over Roo-Code, with a significant architectural overhaul and dozens of new features.

This guide helps Roo-Code users understand what changed and how to use the new capabilities. If you are new to both tools, start with the [README](../README.md).

## Quick Differences at a Glance

| Area                     | Roo-Code                              | Shofer                                                   |
| ------------------------ | ------------------------------------- | -------------------------------------------------------- |
| **Tasks**                | One task at a time                    | Multiple concurrent tasks in parallel                    |
| **Sub-tasks**            | Blocks parent until done              | Background tasks run independently; parent polls results |
| **Default mode**         | Architect                             | Code                                                     |
| **Auto-approval label**  | "BRRR" (YOLO)                         | "All"                                                    |
| **File change tracking** | Git shadow-repo                       | Working-directory snapshots (no git dependency)          |
| **Message queuing**      | Messages lost while busy              | Queue with Send Now button                               |
| **Checkpoints**          | Disabled with nested repos            | Works everywhere via `GIT_DIR` isolation                 |
| **Worktrees**            | Separate VS Code window per worktree  | Embedded worktree management in one window               |
| **Drag & Drop**          | Alt-key based (unreliable on Desktop) | Dedicated drop zone with removable tags                  |
| **Skills loading**       | Manual, forgets on switch             | Persisted per-task, auto-rehydrated                      |

---

## Parallel Tasks

<!-- XXX screenshot: TaskSelector dropdown showing 4 tasks — one running (green pulse), one paused (orange), one completed (green checkmark), one errored (red) — with parent-child indentation visible -->

Shofer supports multiple independent conversations running at the same time. Each task has its own LLM conversation, tool approvals, mode, and history — just like having multiple Copilot sessions open.

**What this means for you:**

- Start a new task without losing your current one. The current task moves to the background.
- Switch between tasks freely from the **TaskSelector** dropdown at the top of the chat. Background tasks keep running.
- Each task shows a colored state badge: green (running), orange (paused), blue (waiting), green checkmark (completed), red (error).
- When a background task needs your approval or finishes, you get a notification.

---

## Background (Async) Sub-tasks

The LLM can now delegate work to background children that run concurrently. The parent continues its own work and polls results via `wait_for_task` or `check_task_status`.

<!-- XXX screenshot: chat row showing a wait_for_task result with 3 subtask status badges (2 completed green, 1 running with spinner) -->

**Key tools:**

- **`new_task`** with `is_background: true` — spawns a child that runs independently
- **`check_task_status`** — query a child's current state without blocking
- **`wait_for_task`** — block until one or more children finish (supports `all` / `any` strategies)
- **`list_background_tasks`** — list all running children
- **`cancel_tasks`** — stop one or more children early

Canceling a parent automatically cancels all its background children.

---

## TaskSelector & Task Management

<!-- XXX screenshot: TaskSelector panel showing the parent-child tree with pinned task at top, archive toggle expanded, and state badges visible on every row -->

The TaskSelector (visible when no task is active) lets you organize your work:

| Action      | Description                                        |
| ----------- | -------------------------------------------------- |
| **Pin**     | Keep a task at the top of the list                 |
| **Archive** | Hide from main list (accessible via filter toggle) |
| **Export**  | Download as Markdown (`.md`) or JSON (`.json`)     |

> See also: [Task Export Format](../task-export.md)

---

## Message Queue & Send Now

When a task is busy processing an LLM response, typing another message no longer loses it. Instead, the message enters a FIFO queue.

<!-- XXX screenshot: QueuedMessages section visible above the chat input, showing "2 messages queued" with a Send Now button -->

- **Queue** — Messages typed while busy are enqueued and shown in a collapsible "Queued Messages" section.
- **Send Now** — Forces the current turn to cancel and immediately restarts with the queued message. The canceled output is preserved in chat history.
- **Per-task drafts** — Unsent text in the chat input is saved per task. Switching tasks restores that task's draft. New tasks start with a clean slate.

---

## File Changes Panel

<!-- XXX screenshot: FileChangesPanel expanded showing 3 modified files with Accept/Revert buttons per file and Accept All/Revert All at the top -->

Shofer tracks every file your task modifies. The **File Changes Panel** (collapsible, below the chat) shows all modified files with:

- **Accept** — promote the change to the persistent baseline
- **Revert** — restore the original content

There is no git shadow-repository dependency. File changes are stored as snapshots in the extension's storage directory, so nested repos, worktrees, and submodules never cause conflicts.

---

## Drag & Drop Context Files

<!-- XXX screenshot: chat input area with 3 file tags ("src/auth.ts", "README.md", "package.json") shown above the text input, each with an X button to remove -->

Drag files from your file explorer into the dedicated drop zone. They appear as removable tags above the chat input and are prepended as `@mentions` when sent, making file context explicit for the LLM.

---

## Auto-Approval & Tool Categories

Every tool belongs to exactly one of 9 categories: **read**, **write**, **execute**, **browser**, **mcp**, **mode**, **subtasks**, **questions**, or **uncategorized**.

<!-- XXX screenshot: AutoApproveDropdown expanded showing toggle switches for read, write, execute, browser, mcp — with read and mcp toggled on, the rest off -->

The **AutoApproveDropdown** in the chat input bar shows toggle switches for each category relevant to your current mode. Toggle a category on, and the LLM can use those tools without asking for approval.

> See also: [Tool Categories](../tool-categories.md), [Auto Approval](../auto_approval.md)

---

## Skills System

<!-- XXX screenshot: SkillsButton popover showing 4 loaded skills with descriptions ("eauction-search — Search properties on eauction.gr"), each with an "Open SKILL.md" button, plus an "Available Skills" section below -->

Skills provide domain-specific instructions to the LLM. Access them via the **Skills** button (🎓) in the chat input bar.

- **Commands** and **Skills** buttons open popovers listing all available options.
- Loaded skills are persisted in task history. When you switch back to a task, its skills are re-loaded automatically.
- The SkillsButton shows which skills are currently active.

> See also: [Skills Architecture](../skills.md)

---

## Modes & Tool Access

<!-- XXX screenshot: ModeSelector dropdown showing all 9 modes (Code, Architect, Ask, Debug, Reviewer, Search, Opinion, Browser, Orchestrator) with Code selected -->

Choose a mode from the **ModeSelector** dropdown in the chat input bar. Each mode controls which tool groups are available and the LLM's role definition.

- Each task has its own mode, sticky for its lifetime.
- Switching tasks restores that task's mode.
- Custom modes can be defined via `.shofermodes` files (project-level or global).

> See also: [Tool Access Control](../tool_access.md)

---

## Native Worktrees

Worktrees are managed within the same Shofer session — no need for separate VS Code windows.

<!-- XXX screenshot: WorktreeIndicator chip in the chat input bar showing branch name "feature/new-api", green "clean" status, and ahead/behind counts -->

A chip in the chat input bar shows the current worktree branch name and git status (dirty/clean, commits ahead/behind). Click it to open worktree management.

> See also: [Worktree Architecture](../worktrees.md)

---

## Task Export

Export any task in two formats from the TaskActions menu:

<!-- XXX screenshot: TaskActions dropdown showing "Export as Markdown" and "Export as JSON" options -->

| Format               | Use case                                                    |
| -------------------- | ----------------------------------------------------------- |
| **Markdown** (`.md`) | Readable transcript with tool calls, results, and reasoning |
| **JSON** (`.json`)   | Machine-readable trace for programmatic analysis or replay  |

> See also: [Task Export Formats](../task-export.md)

---

## Cost Tracking & Limits

<!-- XXX screenshot: TaskHeader showing "$0.42 / $5.00 limit" with a green ContextWindowProgress bar at 35% -->

Every API call's token usage and USD cost are tracked and shown in the **TaskHeader**. You can set a per-task USD spend cap. When reached, the task is automatically paused (asking you to raise the limit) or aborted.

Parent tasks show the cumulative cost of all descendant sub-tasks, not just their own API calls.

> See also: [Cost Calculation & Limits](../cost-calculation-and-limits.md)

---

## Provider Improvements

### Reasoning / Thinking Blocks

<!-- XXX screenshot: collapsible ReasoningBlock in chat showing "Thinking…" header, expanded to reveal model reasoning text -->

Models that support reasoning/thinking (including GitHub Copilot models via the VS Code LM API) now surface their reasoning as collapsible blocks in chat.

### Tool Preparing Progress

<!-- XXX screenshot: ProgressIndicator spinner row in chat showing "Preparing apply_diff… 1.2 KB" while arguments stream in -->

While the LLM streams tool call arguments, an inline progress row shows the tool name and byte count. You know something is happening before the tool executes.

---

## Cancellation Flow

The Stop button is always responsive — even during streaming, reasoning, or tool execution. Stop propagates end-to-end: from the webview through the task loop, API handler, and all the way to MCP server tool executions, aborting them immediately.

---

## Submodule & Nested Git Support

Checkpoints work transparently in repositories with submodules or nested `.git` directories. Shofer uses `GIT_DIR` environment variable isolation instead of requiring a single top-level `.git` directory. The "nested git detected" warnings from Roo-Code are gone.

> See also: [Submodule Support](../submodule-support.md)

---

## UI/UX Changes from Roo-Code Defaults

| Change                                    | Why                                                            |
| ----------------------------------------- | -------------------------------------------------------------- |
| **Default mode: Architect → Code**        | Code mode is the primary use case                              |
| **BRRR → All auto-approval label**        | Clearer, more professional naming                              |
| **Background editing enabled by default** | Background diffs are now the standard editing experience       |
| **API request row auto-hides**            | Reduces chat clutter; only persists on errors or cancellations |

---

## External LM Tool Providers

Shofer supports tools from companion VS Code extensions (like `arkware-vscode-tools` and `arkware-browser-tools`). These tools are discovered dynamically, participate in the auto-approval system, and render in chat with the same visual treatment as native tools.

> See also: [Tool Registration Interface](../tool-registration-interface.md)

---

## Where to Go Next

- [Complete Native Tools Reference](../native_tools.md) — all 50+ tools with parameters
- [Configuration Reference](../configuration.md) — VS Code settings
- [Skills System](../skills.md) — creating and using skills
- [Message Queue Design](../message_queue.md) — queue, Send Now, and drafts in detail
- [CHANGELOG](../CHANGELOG.md) — complete release history including bug fixes
