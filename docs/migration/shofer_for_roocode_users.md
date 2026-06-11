# Shofer Features and Opinionated Changes for Roo-Code Users

Shofer is a major improvement over Roo-Code, with a significant architectural overhaul and dozens of new features.

This document catalogues every **user-facing feature** and **opinionated change** introduced in Shofer versus its predecessor, Roo-Code. Bug fixes are excluded — see [`CHANGELOG.md`](../../CHANGELOG.md) for the complete picture including all defect corrections.

**Context**: Roo-Code has announced that it is sunsetting its VS Code Extension, Cloud, and Router services on May 15, 2026. The team is pivoting away from IDE-based tools to focus on their new cloud-based agent, Roomote.

> **Quick Start**: Run the `/migrate-from-roocode` slash command to automatically rename your legacy Roo-Code configuration files (`.rooignore`, `.roomodes`, `.roorules*`, `.clinerules*`, `cline_mcp_settings.json`) to Shofer equivalents. See [`shofer_special_files.md`](../shofer_special_files.md) for the full migration reference.

---

## Table of Contents

1. [Parallel Task Architecture](#1-parallel-task-architecture)
2. [Async / Background Tasks](#2-async--background-tasks)
3. [Background Subtask Control](#3-background-subtask-control)
4. [Async MCP Tool Calling](#4-async-mcp-tool-calling)
5. [TaskSelector UX](#5-taskselector-ux)
6. [Message Queue, Send Now & Per-Task Drafts](#6-message-queue-send-now--per-task-drafts)
7. [Task Export (JSON + Markdown)](#7-task-export-json--markdown)
8. [Drag & Drop Workaround](#8-drag--drop-workaround)
9. [New Native Tools](#9-new-native-tools)
10. [File Changes System](#10-file-changes-system)
11. [Auto-Approval & Tool Categories](#11-auto-approval--tool-categories)
12. [Skills System Overhaul](#12-skills-system-overhaul)
13. [Modes & Tool Access Control](#13-modes--tool-access-control)
14. [External LM Tool Providers](#14-external-lm-tool-providers)
15. [Native Worktree Support](#15-native-worktree-support)
16. [Cancellation Flow](#16-cancellation-flow)
17. [Submodule & Nested Git Support](#17-submodule--nested-git-support)
18. [Code Indexer & Semantic Search](#18-code-indexer--semantic-search)
19. [Cost Calculation & Limits](#19-cost-calculation--limits)
20. [Cloud removal and marketplace/telemetry feature flags](#20-cloud-removal-and-marketplacetelemetry-feature-flags)
21. [UI/UX Opinionated Changes](#21-uiux-opinionated-changes)
22. [Assistant Agent](#22-assistant-agent)
23. [LSP-Powered Symbol Refactoring](#23-lsp-powered-symbol-refactoring)

---

## 1. Parallel Task Architecture

**The single largest architectural change.** Shofer supports a multi-task architecture enabling multiple concurrent, independent conversations — similar to GitHub Copilot's multi-conversation model.

Previously, the codebase supported only one task at a time — starting a new task meant abandoning the current one. The `new_task` tool could spawn a child, but the parent blocked until the child completed.

### What Was Built

| Capability                    | Description                                                                                                                                                                                                                                                 |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Multiple concurrent tasks** | Each task runs independently with its own LLM conversation, state, tool approvals, and history. Users can switch between tasks freely — they continue running in the background.                                                                            |
| **Task state indicators**     | Every task has a visible state, shown as a colored dot in the TaskSelector. Core user-facing states include _running_, _paused_, _waiting_, _completed_, and _error_. See [`task_states.md`](../task_states.md) for the full 7-value `TaskLifecycle` model. |
| **Task notifications**        | When a background task requires approval or completes, a webview notification alerts the user. Existing notifications are delivered when the webview launches.                                                                                              |
| **Per-task isolation**        | Mode, drafts, scroll position, and queued messages are scoped per-task. Switching tasks never leaks state.                                                                                                                                                  |

### Architecture

- [`new_task`](../../src/core/tools/NewTaskTool.ts) creates an independent `Task` instance.
- Each task runs its own `_runTaskLoop`, making independent API calls to the LLM.
- The [`TaskManager`](../../src/services/task-manager/TaskManager.ts) orchestrates lifecycle: create, pause, resume, abort, rehydrate.
- Task state is persisted to disk so tasks survive extension reloads and VS Code restarts.

<!-- 📸 TODO: screenshot of TaskSelector showing multiple tasks with different state badges (running, paused, waiting, completed) -->

---

## 2. Async / Background Tasks

Building on the parallel architecture, background tasks let the LLM fan out work without blocking the parent task.

Previously, `new_task` only spawned synchronous children — the parent waited until the child finished. There was no way to spawn multiple children in parallel.

### What Was Built

| Feature                                                                    | Description                                                                                                                          |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **`is_background` parameter**                                              | `new_task` accepts `is_background: true`. The child runs concurrently; the parent continues immediately.                             |
| [`check_task_status`](../../src/core/tools/CheckTaskStatusTool.ts)         | Query the current status of any background task by its task ID.                                                                      |
| [`wait_for_task`](../../src/core/tools/WaitForTaskTool.ts)                 | Block until one or more background tasks reach a terminal state. Supports `all`/`any` wait strategies and multiple task IDs.         |
| [`list_background_tasks`](../../src/core/tools/ListBackgroundTasksTool.ts) | List all background child tasks with their current status.                                                                           |
| **Abort propagation**                                                      | Canceling a parent task propagates abort to all background children.                                                                 |
| **Parent mode inheritance**                                                | Background children inherit the parent's mode unless explicitly overridden.                                                          |
| **UI rows**                                                                | Async tool calls (`wait_for_task`, `check_task_status`, `list_background_tasks`) render as descriptive chat rows with status badges. |

### Example Orchestration Pattern

```
Parent task delegates to 3 background children:
  ├── Child A: "Research the API documentation"  [background]
  ├── Child B: "Write unit tests"                [background]
  └── Child C: "Refactor the database layer"     [background]

Parent calls wait_for_task([A, B, C], wait="all") — resumes when all complete.
```

<!-- 📸 TODO: screenshot of chat showing `wait_for_task` row with status badges for multiple background children -->

---

## 3. Background Subtask Control

Background child tasks can now be managed mid-flight — the parent can answer the child's questions directly, cancel children, and inspect their live activity.

Previously, `ask_followup_question` from a background child was escalated to the user, and there was no way to cancel specific children without aborting the entire parent task.

### What Was Built

| Feature                                                                        | Description                                                                                                                                                               |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Subtask question routing to parent**                                         | `ask_followup_question` from background children is routed to the **parent task** instead of the user. The parent surfaces pending questions through `check_task_status`. |
| [`answer_subtask_question`](../../src/core/tools/AnswerSubtaskQuestionTool.ts) | Answer a pending question from a background child. The parent evaluates and provides a response, unblocking the child.                                                    |
| [`cancel_tasks`](../../src/core/tools/CancelTasksTool.ts)                      | Stop one or more background children by task ID. Already-completed children are unaffected.                                                                               |
| **`include_activity` parameter**                                               | `check_task_status` now accepts `include_activity: true` to return the child's most recent tool calls and messages — showing what it's currently working on.              |
| **Abort on parent completion**                                                 | Background children are automatically aborted when the parent task completes, preventing orphaned runaway tasks.                                                          |
| **Dedicated `alwaysAllowSubtasks` toggle**                                     | `cancel_tasks` and `answer_subtask_question` share the `alwaysAllowSubtasks` auto-approval toggle alongside `new_task` and `attempt_completion`.                          |
| **Waiting lifecycle**                                                          | Tasks blocked inside `wait_for_task` transition to a distinct `waiting` state — visible in the TaskSelector, separate from both `idle` and `running`.                     |

<!-- 📸 TODO: screenshot of `check_task_status` row showing pending question from a background child -->

---

## 4. Async MCP Tool Calling

MCP tools can now be invoked asynchronously, enabling true parallelism — fan out multiple MCP calls and collect results when they're ready.

Previously, all MCP tool calls were synchronous and blocking. The agent had to wait for each call to complete before the next one could be dispatched.

### What Was Built

| Feature                                                                       | Description                                                                                                                                               |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[`call_mcp_tool_async`](../../src/core/tools/CallMcpToolAsyncTool.ts)**     | Fire-and-forget MCP tool invocation. Returns immediately with a `call_id`.                                                                                |
| **[`check_mcp_call_status`](../../src/core/tools/CheckMcpCallStatusTool.ts)** | Non-blocking status check for a previously-started async call. Returns `running`, `completed`, `error`, or `cancelled`.                                   |
| **[`wait_for_mcp_call`](../../src/core/tools/WaitForMcpCallTool.ts)**         | Block until one or more async calls complete. Supports `all`/`any` wait strategies like `wait_for_task`.                                                  |
| **Async badge in ChatRow**                                                    | Async MCP calls display a distinctive **async badge** in the chat UI, making it clear which calls are in-flight vs completed.                             |
| **Delete-on-read trimming**                                                   | Completed async call results are automatically trimmed from the API history after being read by the LLM, preventing context bloat from large MCP results. |
| **Waiting lifecycle for MCP wait**                                            | When the task calls `wait_for_mcp_call`, it transitions to the `waiting` state — visible in the TaskSelector alongside `wait_for_task`.                   |
| **Telemetry for async MCP**                                                   | Async MCP usage is tracked separately from synchronous MCP calls, with dedicated telemetry events for call initiation, completion, and errors.            |

<!-- 📸 TODO: screenshot of ChatRow showing async MCP badge and completion state -->

---

## 5. TaskSelector UX

The TaskSelector (visible when no task is active) was redesigned to handle multiple concurrent tasks with rich organizational features.

### What Was Built

| Feature                    | Description                                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Parent-child hierarchy** | Tasks are rendered as a collapsible tree. Children indent under parents; subtask relationships are visible at a glance.                                |
| **Archive**                | Tasks can be archived — hidden from the main list but preserved. Archived tasks are accessible via a filter toggle.                                    |
| **Pin**                    | Tasks can be pinned to stay at the top of the list regardless of creation time. Useful for keeping reference tasks accessible.                         |
| **State badges**           | Each task entry shows its state: _running_ (spinner), _paused_, _completed_ (checkmark), _error_ (warning). See [`task_states.md`](../task_states.md). |

<!-- 📸 TODO: screenshot of TaskSelector showing parent-child tree, pinned tasks at top, and state badges -->

---

## 6. Message Queue, Send Now & Per-Task Drafts

A complete message buffering system that lets users type ahead while the LLM is working, with per-task draft isolation.

See [`message_queue.md`](../message_queue.md) for the full design document.

### What Was Built

| Feature                   | Description                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Message queue**         | When a task is busy processing, new user messages are queued instead of being lost. The queue is FIFO-ordered.                       |
| **Send Now**              | Forces the current turn to cancel and immediately resumes with the queued message. The user's message appears in chat history.       |
| **Per-task input drafts** | Unsent text in the chat input is preserved per task. Switching tasks restores that task's draft. New tasks start with a clean slate. |
| **Queue isolation**       | Queued messages are scoped to their task. Switching tasks or starting a new task never leaks stale messages.                         |
| **Collapsible UI**        | The Queued Messages section and File Changes panel are collapsible, keeping the chat interface clean.                                |

<!-- 📸 TODO: screenshot of chat showing queued messages indicator and Send Now button -->

---

## 7. Task Export (JSON + Markdown)

Tasks can be exported in two formats for sharing, archival, or analysis.

See [`task-export.md`](../task-export.md) for the full format reference.

### What Was Built

| Format               | Description                                                                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Markdown** (`.md`) | Human-readable conversation transcript with tool calls, tool results, and reasoning blocks.                                                              |
| **JSON** (`.json`)   | Structured machine-readable trace of the full message exchange — tool calls, results, reasoning, metadata. Suitable for programmatic analysis or replay. |

<!-- 📸 TODO: screenshot of export dropdown showing both Markdown and JSON options -->

---

## 8. Drag & Drop Workaround

Roo's Drag & Drop system was hard to use on the Desktop (Alt key didn't work for me), so Shofer introduces a workaround, with a dedicated drop zone in the sidebar. Dropped files appear as removable tags. Dropped files are prepended as `@mentions` in the message text when sent, making file context explicit.

See [`drag_n_drop.md`](../drag_n_drop.md) for the full design.

<!-- 📸 TODO: screenshot of drag-and-drop in action — file tags above the chat input -->

---

## 9. New Native Tools

Twenty native tools are listed below — see [`native_tools.md`](../native_tools.md) for the complete reference of all 50+ tools.

| Tool                                                                       | Description                                                                                                                                                                                     |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`lsp_search`](../../src/core/tools/LspSearchTool.ts)                      | Search the codebase for symbols (functions, classes, variables) using VS Code's Language Server Protocol workspace symbol provider. Falls back to text search when no LSP is available.         |
| [`create_new_workspace`](../../src/core/tools/CreateNewWorkspaceTool.ts)   | Create a new workspace/project directory with optional subdirectories.                                                                                                                          |
| [`fetch_web_page`](../../src/core/tools/FetchWebPageTool.ts)               | Download and extract text content from web pages, with optional content filtering.                                                                                                              |
| [`execute_command`](../../src/core/tools/ExecuteCommandTool.ts)            | Run CLI commands with configurable working directory and timeout.                                                                                                                               |
| [`list_files`](../../src/core/tools/ListFilesTool.ts)                      | List directory contents with recursive option.                                                                                                                                                  |
| [`grep_search`](../../src/core/tools/GrepSearchTool.ts)                    | Regex/literal search across files with context display (using VS Code's native search API). See [`grep_search-tool.md`](../grep_search-tool.md).                                                |
| **[`rag_search`](../../src/core/tools/RagSearchTool.ts)**                  | Semantic code search using embedded vectors. Finds files by meaning rather than exact text matches. See §18.                                                                                    |
| **[`git_search`](../../src/core/tools/GitSearchTool.ts)**                  | Semantic search over git commit history — discover _why_ and _when_ changes were made. See §18.                                                                                                 |
| [`read_file`](../../src/core/tools/ReadFileTool.ts)                        | Read file contents with offset/limit and indentation-based extraction modes.                                                                                                                    |
| [`write_to_file`](../../src/core/tools/WriteToFileTool.ts)                 | Write complete file content, with automatic directory creation.                                                                                                                                 |
| [`apply_diff`](../../src/core/tools/ApplyDiffTool.ts)                      | Apply precise, targeted modifications using search/replace blocks.                                                                                                                              |
| [`insert_edit`](../../src/core/tools/InsertEditTool.ts)                    | Insert text at a specific line/column position.                                                                                                                                                 |
| [`rename_symbol`](../../src/core/tools/RenameSymbolTool.ts)                | Rename a symbol and all its references via LSP.                                                                                                                                                 |
| [`list_code_usages`](../../src/core/tools/ListCodeUsagesTool.ts)           | Find all references/usages of a symbol via LSP.                                                                                                                                                 |
| **[`read_command_output`](../../src/core/tools/ReadCommandOutputTool.ts)** | Retrieve full output from commands that were truncated in the chat. Supports read mode (offset/limit) and search mode (grep-like filtering).                                                    |
| **[`sed`](../../src/core/tools/SedTool.ts)**                               | Regex find-and-replace on workspace files with capture group backreferences. Fully integrated with file change tracking.                                                                        |
| **[`file`](../../src/core/tools/FileTool.ts)**                             | Filesystem operations: `rm` (delete file/directory) and `mv` (move/rename). Integrated with file change tracking. Approval labels show subcommand-specific names ("Remove File" / "Move File"). |
| **[`set_task_title`](../../src/core/tools/SetTaskTitleTool.ts)**           | Allows the model to set a descriptive, human-readable title for the current task. Displayed in the TaskSelector and task header.                                                                |
| [`skills`](../../src/core/tools/SkillsTool.ts)                             | Load a skill by name into the task context. Integrated with mention-based loading (`/skill-name`) and loaded-skills tracking.                                                                   |
| **[`give_feedback`](../../src/core/tools/GiveFeedbackTool.ts)**            | Promoted to a **native always-available tool** — accessible regardless of mode settings.                                                                                                        |

<!-- 📸 TODO: screenshot of `lsp_search` results in chat -->

---

## 10. File Changes System

The file changes tracking infrastructure was built from the ground up.

See [`file-change-tracking.md`](../file-change-tracking.md) for the complete tracking specification.

Removed the git-dependent shadow-repository backend in favor of a **working-directory snapshot system**. This eliminates all git-related edge cases (nested repos, worktrees, submodules, custom git configs) and makes the system more robust and universally compatible.

| Feature                         | Description                                                                                                                                                                                                |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Working-directory backend**   | File changes are tracked via snapshots in the extension's storage directory. **No git dependency.** This eliminates conflicts with nested repos, worktrees, submodules, and custom git configurations.     |
| **Two-action workflow**         | **Accept** promotes content to persisted baseline. **Revert** restores the original content.                                                                                                               |
| **Comprehensive tool tracking** | Every disk-modifying tool is tracked: `write_to_file`, `apply_diff`, `insert_edit`, `sed`, `file` (rm/mv), `rename_symbol`. The tracker captures original content before mutation and final content after. |

<!-- 📸 TODO: screenshot of File Changes panel showing tracked files with Accept/Revert buttons -->

---

## 11. Auto-Approval & Tool Categories

The auto-approval system was refactored to be driven by a unified set of tool categories, replacing the previous ad-hoc toggle system. Additional categories were added, included `uncategorized` as a catch-all. MCP servers can now voluntarily categorize their tools, instead of all falling into one category, the `MCP` bucket. MCP servers that don't support this feature can still have their tools properly categorized with Shofer-side configuration.

See [`auto_approval.md`](../auto_approval.md) and [`tool-categories.md`](../tool-categories.md) for the full reference.

### What Was Built

| Feature                               | Description                                                                                                                                                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ToolGroup-driven auto-approval**    | Auto-approval toggles now correspond to 9 canonical tool categories (`read`, `write`, `execute`, `browser`, `mcp`, `mode`, `subtasks`, `questions`, `uncategorized`) — a single source of truth.                    |
| **Unified 9 categories**              | Every tool — native, MCP, or registered by another extension — falls into exactly one category. Mode-based filtering and auto-approval both use the same groups. See [`tool-categories.md`](../tool-categories.md). |
| **Scoped auto-approve trigger badge** | The auto-approve badge in the chat header is scoped to the current mode, showing only relevant toggles.                                                                                                             |

<!-- 📸 TODO: screenshot of auto-approval toolbar in chat header showing category toggles -->

---

## 12. Skills System Overhaul

The skills system was redesigned for discoverability, state management, and persistence.

See [`skills.md`](../skills.md) and [`command-skill-buttons.md`](../command-skill-buttons.md) for the full design.

### What Was Built

| Feature                       | Description                                                                                                                               |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Quick-access buttons**      | Dedicated **Commands** and **Skills** buttons in the chat input bar. One click opens a popover listing all available commands and skills. |
| **Loaded skills tracking**    | Skills are tracked as "loaded" in the IPC layer. The SkillsButton shows which skills are currently active.                                |
| **Persistence & rehydration** | Loaded skills are persisted in the task history. When a task is restored, skills are re-loaded automatically.                             |

<!-- 📸 TODO: screenshot of Skills popover showing loaded skills with descriptions and open-file buttons -->

---

## 13. Modes & Tool Access Control

The mode system was extended with scoped tool groups, per-task mode binding, and a new default mode.

### What Was Built

| Feature                                                                    | Description                                                                                                                                                                                                             |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Scoped group entries**                                                   | Mode groups now support `allowed`/`denied` lists per group, enabling fine-grained control. Example: a mode can allow `read` group tools but deny `grep_search` specifically. See [`tool_access.md`](../tool_access.md). |
| **Per-task mode binding**                                                  | Each task has its own mode, sticky for its lifetime. Switching tasks restores that task's mode. Starting a new task lets you choose a different mode without affecting running tasks.                                   |
| **Sticky mode across focus switches**                                      | Re-focusing a task restores its mode. The mode selector always reflects the active task's mode.                                                                                                                         |
| **[`switch_mode`](../../src/core/tools/SwitchModeTool.ts) scoped to task** | Mode switching via `switch_mode` is now isolated to the calling task — it never leaks across concurrent tasks. Each task's mode is independently scoped and persisted.                                                  |

<!-- 📸 TODO: screenshot of mode selector dropdown showing scoped group configuration -->

---

## 14. External LM Tool Providers

A generic interface for discovering and invoking tools from other VS Code extensions, replacing the tight coupling to `vscode.lm.tools`.

See [`tool-registration-interface.md`](../tool-registration-interface.md) for the provider API specification.

### What Was Built

| Feature                        | Description                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| **Generic provider interface** | Extensions register as tool providers via a well-defined interface. Shofer dynamically discovers and invokes their tools.       |
| **MCP-style chat rows**        | External LM tool calls are surfaced in the chat UI with the same visual treatment as MCP tools — name, arguments, and result.   |
| **Auto-approval integration**  | External tools participate in the ToolGroup-driven auto-approval system. Users can configure which external tools auto-approve. |

This enables companion extensions to seamlessly contribute tools to Shofer's tool palette without Shofer needing to know about them at compile time.

<!-- 📸 TODO: screenshot of an external LM tool call rendered as an MCP-style chat row -->

---

## 15. Native Worktree Support

No need to maintain separate VS Code windows per worktree anymore.

See [`worktrees.md`](../worktrees.md) for the full architecture.

### What Was Built

| Feature                       | Description                                                                                                                                           |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Embedded worktree model**   | Worktrees are managed within the same Shofer session.                                                                                                 |
| **Worktree status indicator** | A chip in the chat input bar shows the current worktree branch name and git status (dirty/clean/ahead/behind). Clicking it opens worktree management. |

<!-- 📸 TODO: screenshot of worktree status indicator chip in the chat input bar -->

---

## 16. Cancellation Flow

A complete end-to-end cancellation pipeline that immediately aborts long-running MCP tool calls and resource reads when the user clicks Stop.

See [`cancellation.md`](../cancellation.md) for the full cancellation architecture.

### What Was Built

| Feature                        | Description                                                                                                                                         |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **End-to-end abort**           | Stop propagates from the webview through the task loop, API handler, and all the way down to MCP server tool executions, aborting them immediately. |
| **HTTP stream abort on pause** | When a task is paused, the HTTP stream is immediately aborted, preventing resource leaks.                                                           |
| **Always-available Stop**      | The Stop button is always responsive, even during streaming, reasoning, or tool execution phases.                                                   |

---

## 17. Submodule & Nested Git Support

Checkpoints now work in repositories that contain submodules or nested `.git` directories.

See [`submodule-support.md`](../submodule-support.md) for the full design.

### What Was Built

| Feature                                  | Description                                                                                                                                                                                        |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`GIT_DIR` isolation**                  | Checkpoints use `GIT_DIR` environment variable isolation instead of requiring a single top-level `.git` directory. This allows nested git repos and submodules to coexist with Shofer checkpoints. |
| **No more "nested git detected" errors** | Previously, Shofer would disable checkpoints and show a warning when nested git repositories were detected. Now checkpoints work transparently.                                                    |

---

## 18. Code Indexer & Semantic Search

Shofer includes a RAG-powered code indexing pipeline that enables semantic code search and powers several tools with codebase-aware context.

The indexer processes workspace files through tree-sitter parsing and embedding, storing vectors in a Qdrant instance. On large workspaces, startup reconciliation and re-indexing are **near-instant** — only files that actually changed are re-processed, using a layered strategy: `stat()`-only mtime+size comparison skips unchanged files without even reading them, git-aware narrowing diffs from the last indexed commit, and per-segment hashing ensures that within a changed file only the modified code blocks are re-embedded.

The pipeline was substantially hardened in the Shofer fork to handle edge cases, submodules, and git-ignored files correctly.

> See [`rag_indexing.md`](../rag_indexing.md) and [`git_search-tool.md`](../git_search-tool.md) for the full design.

### What Was Built

| Feature                                                   | Description                                                                                                                                                                                                                                                |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[`rag_search`](../../src/core/tools/RagSearchTool.ts)** | Semantic code search using embedded vectors. Finds files by meaning rather than exact text matches.                                                                                                                                                        |
| **[`git_search`](../../src/core/tools/GitSearchTool.ts)** | Semantic search over git commit history (commit messages only). Discover _why_ and _when_ changes were made, not just _what_.                                                                                                                              |
| **`GitIgnoreFilter` oracle**                              | Replaced flat `.gitignore` parsing with `git ls-files -z --cached --others --exclude-standard`, honoring nested `.gitignore` files, `.git/info/exclude`, and global `core.excludesfile`. A file watcher auto-refreshes the filter on `.gitignore` changes. |
| **Submodule-aware scanning**                              | Both the code-index file scanner and git-history watcher descend into submodules declared in `.gitmodules`, ensuring files inside nested repos are indexed.                                                                                                |
| **Per-segment deduplication**                             | Incremental indexing uses `deletePointsByIds` at the segment level, preventing duplicate embeddings when files are re-indexed.                                                                                                                             |
| **Stat-only fast-path**                                   | Startup reconciliation uses `stat()`-only mtime+size comparison for a fast path, dramatically reducing indexer startup on large workspaces.                                                                                                                |
| **Per-provider concurrency lane**                         | Embedder providers share a module-scoped concurrency limiter keyed by `(provider, endpoint)`, preventing N-workspace reindex storms from tripping rate limits.                                                                                             |
| **Cumulative diagnostics**                                | Settings panel surfaces cumulative file/commit counts and last-indexed diagnostics, giving users visibility into indexer state.                                                                                                                            |
| **Branch-aware git indexing**                             | `git_search` can be scoped to a specific branch via the `codebaseIndexGitBranch` setting; the watcher reports the live branch for the working tree.                                                                                                        |

<!-- 📸 TODO: screenshot of RAG Indexer settings panel showing file/commit counts and diagnostics -->

---

## 19. Cost Calculation & Limits

A per-root-task cost tracking and capping system that aggregates subtask costs and enforces user-configured spend limits.

See [`cost-calculation-and-limits.md`](../cost-calculation-and-limits.md) for the full system design.

### What Was Built

| Feature                      | Description                                                                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Per-task cost tracking**   | Every API call's token usage and USD cost are tracked and displayed in the task header.                                                |
| **Subtask cost aggregation** | Parent tasks show the cumulative cost of all descendant subtasks, not just their own API calls.                                        |
| **Configurable cost limit**  | Users can set a USD spend cap per root task. When reached, the task is automatically paused or aborted.                                |
| **Post-stream gate**         | The cost limit check fires after every stream completion, even when providers only report `totalCost` without individual token counts. |

<!-- 📸 TODO: screenshot of task header showing aggregated cost with subtask breakdown -->

---

## 20. Cloud removal and marketplace/telemetry feature flags

Given that Shofer runs entirely locally with no server-side dependencies, other than your LLM provider, the extension was decoupled from all cloud-related features and dependencies. Additionally, marketplace and telemetry features were disabled.

---

## 21. UI/UX Opinionated Changes

These are deliberate design decisions that changed the default behavior or appearance of the application.

| Change                                    | Rationale                                                                                                                                                                                                                               |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Default mode: Architect → Code**        | Code mode is the primary use case. Architect is still available but no longer the default.                                                                                                                                              |
| **BRRR → All auto-approval label**        | "BRRR" (from "YOLO") was rebranded to "All" for clarity and professionalism.                                                                                                                                                            |
| **Background editing enabled by default** | The experiment graduated — background diffs are now the standard editing experience.                                                                                                                                                    |
| **API request started row auto-hides**    | The "API request started" indicator row now hides on success, reducing chat clutter. Only persists on errors or cancellations.                                                                                                          |
| **Hero logo animation redesigned**        | The welcome screen hero animation was changed from a bouncing kangaroo to a road/parallax wheel-roll theme for a cleaner, more professional look.                                                                                       |
| **GFM table rendering in chat**           | Assistant agent responses and markdown blocks now render GitHub-flavored markdown tables using the standard table component, improving readability of tabular data.                                                                     |
| **Expandable tool input/output**          | Tool calls in chat now render expandable/collapsible input and output sections (gated behind an experimental flag). Tool result output is size-capped and suppressed entirely for tools with dedicated inline UI, keeping chat concise. |

---

## 22. Assistant Agent

The **Assistant Agent** is a persistent, long-lived, read-only LLM companion that accumulates codebase knowledge across tasks — surviving task completion and VS Code restarts. It runs on a **separate, cost-optimized model with a large context window**, and is exposed to tasks via the [`ask_assistant_agent`](../../src/core/tools/AskAssistantAgentTool.ts) native tool.

Previously, every task had to load its own context from scratch. There was no mechanism for sharing codebase knowledge between tasks, and repetitive file reads burned tokens.

### What Was Built

| Feature                            | Description                                                                                                                                                                                                                                           |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Persistent conversation**        | The agent's full conversation survives task termination and VS Code restarts. Uses a versioned JSON snapshot (`globalStorage`) with SHA-256 file-context validation.                                                                                  |
| **Separate, cheap model**          | User selects a low-cost, large-context model (e.g., Gemini Flash, GPT-4o-mini, Claude Haiku) via a linked API Configuration profile.                                                                                                                  |
| **Read-only tool set**             | The assistant agent is **strictly read-only** — [`tool-executor.ts`](../../src/services/assistant-agent/tool-executor.ts) restricts it to `TOOL_GROUPS.read` only (file reading, search, LSP lookups). No write, execute, MCP, or task-control tools. |
| **KV-cache-preserving context**    | Context is append-only; files modified by tasks are NOT evicted. Instead a "recently modified" notification is attached to the next question, keeping the LLM provider's attention cache warm.                                                        |
| **Question queue + timeout**       | Questions are serialized via a bounded FIFO queue. The hard `timeoutMs` covers queue wait + LLM processing. Soft `softTimeoutSec` / `softResultLength` hints guide the agent's response.                                                              |
| **Context window truncation**      | No summarization — oldest messages are dropped when the budget is exceeded. Oldest file contexts (by `lastReferencedAt`) are evicted first, then oldest conversation turns.                                                                           |
| **Directory tree injection**       | A `find .`-style workspace directory tree (capped at ~10% of context window) is injected into the system prompt, giving immediate project structure awareness.                                                                                        |
| **File watcher + tool hooks**      | Detects external file changes (VSCode `FileSystemWatcher`) and task-initiated edits (tool execution hooks). Stale files are lazily re-read on next reference.                                                                                         |
| **Toolbar badge + dedicated chat** | Status badge in the chat-input toolbar shows agent state, context fill %, and cost. Popover provides Start/Stop/Clear Context actions. A dedicated read-only chat panel streams live Q&A.                                                             |
| **Subtask question routing**       | Questions from `ask_assistant_agent` in background subtasks route to the calling task synchronously — the task blocks until the answer or timeout.                                                                                                    |

<!-- 📸 TODO: screenshot of Assistant Agent toolbar badge and popover showing state, context fill, and cost -->

---

## 23. LSP-Powered Symbol Refactoring

Shofer gives the agent direct access to the Language Server Protocol for automated, project-wide refactoring — a capability absent in Roo-Code.

Previously, Roo-Code relied on the user manually executing standard IDE-level renames or structural refactors inside the editor. The agent had no way to invoke the LSP to perform symbol-level refactoring.

### What Was Built

| Feature                                                              | Description                                                                                                                                                 |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[`rename_symbol`](../../src/core/tools/RenameSymbolTool.ts)**      | Rename a symbol and all its references across the entire dependency graph via LSP. The agent can systematically refactor without manual editor interaction. |
| **[`list_code_usages`](../../src/core/tools/ListCodeUsagesTool.ts)** | Find all references/usages of a symbol at a specific position via LSP, enabling the agent to understand impact before refactoring.                          |

---

See also: [`CHANGELOG.md`](../../CHANGELOG.md) — complete release history including all bug fixes.
