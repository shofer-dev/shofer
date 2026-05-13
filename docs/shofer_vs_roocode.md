# Shofer Features & Opinionated Changes

This document catalogues every **user-facing feature** and **opinionated change** introduced in Shofer since its inception as a distinct project.

Bug fixes are excluded — see [`CHANGELOG.md`](../CHANGELOG.md) for the complete picture including all defect corrections.

> **Image placeholders**: Sections marked with `> 📸 TODO: screenshot` need screenshots. Search for `📸 TODO` to find them all.

---

## Table of Contents

1. [Parallel Task Architecture](#1-parallel-task-architecture)
2. [Async / Background Tasks](#2-async--background-tasks)
3. [TaskSelector UX](#3-taskselector-ux)
4. [Message Queue, Send Now & Per-Task Drafts](#4-message-queue-send-now--per-task-drafts)
5. [Task Export (JSON + Markdown)](#5-task-export-json--markdown)
6. [Drag & Drop System](#6-drag--drop-system)
7. [New Native Tools](#7-new-native-tools)
8. [File Changes System](#8-file-changes-system)
9. [Auto-Approval & Tool Categories](#9-auto-approval--tool-categories)
10. [Skills System Overhaul](#10-skills-system-overhaul)
11. [Modes & Tool Access Control](#11-modes--tool-access-control)
12. [External LM Tool Providers](#12-external-lm-tool-providers)
13. [Worktree Support](#13-worktree-support)
14. [Cancellation Flow](#14-cancellation-flow)
15. [Submodule & Nested Git Support](#15-submodule--nested-git-support)
16. [Cost Calculation & Limits](#16-cost-calculation--limits)
17. [Branding & Platform Changes](#17-branding--platform-changes)
18. [Provider Improvements](#18-provider-improvements)
19. [UI/UX Opinionated Changes](#19-uiux-opinionated-changes)

---

## 1. Parallel Task Architecture

**The single largest architectural change.** Shofer supports a multi-task architecture enabling multiple concurrent, independent conversations — similar to GitHub Copilot's multi-conversation model.

Previously, the codebase supported only one task at a time — starting a new task meant abandoning the current one. The `new_task` tool could spawn a child, but the parent blocked until the child completed.

### What Was Built

| Capability                    | Description                                                                                                                                                                                                             |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Multiple concurrent tasks** | Each task runs independently with its own LLM conversation, state, tool approvals, and history. Users can switch between tasks freely — they continue running in the background.                                        |
| **Task state indicators**     | Every task has a visible state: _running_, _paused_, _completed_, _error_. The state is reflected in the TaskSelector, task header, and notifications. See [`task_states.md`](task_states.md) for the full state model. |
| **Task notifications**        | When a background task requires approval or completes, a webview notification alerts the user. Existing notifications are delivered when the webview launches.                                                          |
| **Per-task isolation**        | Mode, drafts, scroll position, and queued messages are scoped per-task. Switching tasks never leaks state.                                                                                                              |

### Architecture

- [`new_task`](../src/core/task/tools/NewTaskTool.ts) creates an independent `Task` instance.
- Each task runs its own `_runTaskLoop`, making independent API calls to the LLM.
- The [`TaskManager`](../src/core/task/TaskManager.ts) orchestrates lifecycle: create, pause, resume, abort, rehydrate.
- Task state is persisted to disk so tasks survive extension reloads and VS Code restarts.

> 📸 TODO: screenshot of TaskSelector showing multiple tasks with different state badges (running, paused, completed)

> **Opinionated change**: This moves Shofer from a single-threaded assistant model to a multi-agent platform.

---

## 2. Async / Background Tasks

Building on the parallel architecture, background tasks let the LLM fan out work without blocking the parent task.

Previously, `new_task` only spawned synchronous children — the parent waited until the child finished. There was no way to spawn multiple children in parallel.

### What Was Built

| Feature                                                                      | Description                                                                                                                          |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **`is_background` parameter**                                                | `new_task` accepts `is_background: true`. The child runs concurrently; the parent continues immediately.                             |
| [`check_task_status`](../src/core/task/tools/CheckTaskStatusTool.ts)         | Query the current status of any background task by its task ID.                                                                      |
| [`wait_for_task`](../src/core/task/tools/WaitForTaskTool.ts)                 | Block until one or more background tasks reach a terminal state. Supports `all`/`any` wait strategies and multiple task IDs.         |
| [`list_background_tasks`](../src/core/task/tools/ListBackgroundTasksTool.ts) | List all background child tasks with their current status.                                                                           |
| **Abort propagation**                                                        | Canceling a parent task propagates abort to all background children.                                                                 |
| **Parent mode inheritance**                                                  | Background children inherit the parent's mode unless explicitly overridden.                                                          |
| **UI rows**                                                                  | Async tool calls (`wait_for_task`, `check_task_status`, `list_background_tasks`) render as descriptive chat rows with status badges. |

### Example Orchestration Pattern

```
Parent task delegates to 3 background children:
  ├── Child A: "Research the API documentation"  [background]
  ├── Child B: "Write unit tests"                [background]
  └── Child C: "Refactor the database layer"     [background]

Parent calls wait_for_task([A, B, C], wait="all") — resumes when all complete.
```

> 📸 TODO: screenshot of chat showing `wait_for_task` row with status badges for multiple background children

> **Opinionated change**: Removed `task_id` from the `new_task` schema. The extension assigns IDs internally; the LLM references tasks by title (set via [`set_task_title`](../src/core/task/tools/SetTaskTitleTool.ts)), making the UX more human-friendly.

---

## 3. TaskSelector UX

The TaskSelector (visible when no task is active) was redesigned to handle multiple concurrent tasks with rich organizational features.

### What Was Built

| Feature                    | Description                                                                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Parent-child hierarchy** | Tasks are rendered as a collapsible tree. Children indent under parents; subtask relationships are visible at a glance.                             |
| **Archive**                | Tasks can be archived — hidden from the main list but preserved. Archived tasks are accessible via a filter toggle.                                 |
| **Pin**                    | Tasks can be pinned to stay at the top of the list regardless of creation time. Useful for keeping reference tasks accessible.                      |
| **State badges**           | Each task entry shows its state: _running_ (spinner), _paused_, _completed_ (checkmark), _error_ (warning). See [`task_states.md`](task_states.md). |
| **Simplified controls**    | Pause/play buttons and the current-task tick indicator were removed for a cleaner UI. Task management happens via the task header.                  |

> 📸 TODO: screenshot of TaskSelector showing parent-child tree, pinned tasks at top, and state badges

> **Opinionated change**: Removed pause/play buttons from TaskSelector. They were redundant with the task header controls and added visual noise. The "current task" tick was also removed — the active task is obvious from context.

---

## 4. Message Queue, Send Now & Per-Task Drafts

A complete message buffering system that lets users type ahead while the LLM is working, with per-task draft isolation.

See [`message_queue.md`](message_queue.md) for the full design document.

### What Was Built

| Feature                   | Description                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Message queue**         | When a task is busy processing, new user messages are queued instead of being lost. The queue is FIFO-ordered.                       |
| **Send Now**              | Forces the current turn to cancel and immediately resumes with the queued message. The user's message appears in chat history.       |
| **Per-task input drafts** | Unsent text in the chat input is preserved per task. Switching tasks restores that task's draft. New tasks start with a clean slate. |
| **Queue isolation**       | Queued messages are scoped to their task. Switching tasks or starting a new task never leaks stale messages.                         |
| **Collapsible UI**        | The Queued Messages section and File Changes panel are collapsible, keeping the chat interface clean.                                |

> 📸 TODO: screenshot of chat showing queued messages indicator and Send Now button

> **Opinionated change**: Decoupling user input from the LLM's processing loop makes Shofer feel more responsive. You can queue up the next instruction while Shofer is still working on the current one.

---

## 5. Task Export (JSON + Markdown)

Tasks can be exported in two formats for sharing, archival, or analysis.

See [`task-export.md`](task-export.md) for the full format reference.

### What Was Built

| Format               | Description                                                                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Markdown** (`.md`) | Human-readable conversation transcript with tool calls, tool results, and reasoning blocks.                                                              |
| **JSON** (`.json`)   | Structured machine-readable trace of the full message exchange — tool calls, results, reasoning, metadata. Suitable for programmatic analysis or replay. |

> 📸 TODO: screenshot of export dropdown showing both Markdown and JSON options

---

## 6. Drag & Drop System

Files and folders can be dropped into Shofer to add them as `@mentions` in the chat context.

See [`drag_n_drop.md`](drag_n_drop.md) for the full design.

### What Was Built

| Feature                           | Description                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Native TreeView drop zone**     | A dedicated drag-and-drop target in the Shofer sidebar panel. Dropped files appear as removable tags.   |
| **Inline webview textarea drops** | Files can also be dropped directly into the chat textarea.                                              |
| **MIME type logging**             | Extended MIME type detection for robust URI extraction from drag payloads.                              |
| **@mentions on send**             | Dropped files are prepended as `@mentions` in the message text when sent, making file context explicit. |

> 📸 TODO: screenshot of drag-and-drop in action — file tags above the chat input

> **Opinionated change**: Dropping files is the most natural way to provide context. The TreeView drop zone makes it discoverable; inline textarea drops make it convenient.

---

## 7. New Native Tools

Twelve native tools were ported from the companion `workspace-tools` extension, and several new tools were created from scratch.

See [`native_tools.md`](native_tools.md) for the complete tool reference.

### Tools Ported from workspace-tools

| Tool                                                                              | Description                                                                                                                                                                             |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`codebase_search_with_lsp`](../src/core/task/tools/CodebaseSearchWithLspTool.ts) | Search the codebase for symbols (functions, classes, variables) using VS Code's Language Server Protocol workspace symbol provider. Falls back to text search when no LSP is available. |
| [`create_new_workspace`](../src/core/task/tools/CreateNewWorkspaceTool.ts)        | Create a new workspace/project directory with optional subdirectories.                                                                                                                  |
| [`fetch_web_page`](../src/core/task/tools/FetchWebPageTool.ts)                    | Download and extract text content from web pages, with optional content filtering.                                                                                                      |
| [`execute_command`](../src/core/task/tools/ExecuteCommandTool.ts)                 | Run CLI commands with configurable working directory and timeout.                                                                                                                       |
| [`list_files`](../src/core/task/tools/ListFilesTool.ts)                           | List directory contents with recursive option.                                                                                                                                          |
| [`search_files`](../src/core/task/tools/SearchFilesTool.ts)                       | Regex/literal search across files with context display (later unified — see below). See [`search_files-tool.md`](search_files-tool.md).                                                 |
| [`read_file`](../src/core/task/tools/ReadFileTool.ts)                             | Read file contents with offset/limit and indentation-based extraction modes.                                                                                                            |
| [`write_to_file`](../src/core/task/tools/WriteToFileTool.ts)                      | Write complete file content, with automatic directory creation.                                                                                                                         |
| [`apply_diff`](../src/core/task/tools/ApplyDiffTool.ts)                           | Apply precise, targeted modifications using search/replace blocks.                                                                                                                      |
| [`insert_edit`](../src/core/task/tools/InsertEditTool.ts)                         | Insert text at a specific line/column position.                                                                                                                                         |
| [`rename_symbol`](../src/core/task/tools/RenameSymbolTool.ts)                     | Rename a symbol and all its references via LSP.                                                                                                                                         |
| [`list_code_usages`](../src/core/task/tools/ListCodeUsagesTool.ts)                | Find all references/usages of a symbol via LSP.                                                                                                                                         |

### New Tools Created

| Tool                                                               | Description                                                                                                                                                                                     |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[`sed`](../src/core/task/tools/SedTool.ts)**                     | Regex find-and-replace on workspace files with capture group backreferences. Fully integrated with file change tracking.                                                                        |
| **[`file`](../src/core/task/tools/FileTool.ts)**                   | Filesystem operations: `rm` (delete file/directory) and `mv` (move/rename). Integrated with file change tracking. Approval labels show subcommand-specific names ("Remove File" / "Move File"). |
| **[`set_task_title`](../src/core/task/tools/SetTaskTitleTool.ts)** | Allows the model to set a descriptive, human-readable title for the current task. Displayed in the TaskSelector and task header.                                                                |
| **[`give_feedback`](../src/core/task/tools/GiveFeedbackTool.ts)**  | Promoted to a **native always-available tool** — accessible regardless of mode settings.                                                                                                        |
| [`skill_load`](../src/core/task/tools/SkillLoadTool.ts)            | Load a skill by name (renamed from `skill`).                                                                                                                                                    |
| [`skill_save`](../src/core/task/tools/SkillSaveTool.ts)            | Create or update skills, with SKILL.md frontmatter validation.                                                                                                                                  |
| [`skill_delete`](../src/core/task/tools/SkillDeleteTool.ts)        | Delete an existing skill.                                                                                                                                                                       |

### Unified search_files Tool

The legacy `get_search_results` tool was **removed** and its functionality merged into `search_files`. The consolidated tool:

- Uses VS Code's [`workspace.findTextInFiles`](https://code.visualstudio.com/api/references/vscode-api#workspace.findTextInFiles) API as its sole backend (no more ripgrep dependency).
- Supports both regex and literal text search via the `isRegex` flag.
- Adds `caseSensitive`, `wholeWord`, and `excludePattern` parameters.
- Renames `regex` → `query` and `file_pattern` → `fileTypes` for clarity.

See [`search_files-tool.md`](search_files-tool.md) for the full tool specification.

> 📸 TODO: screenshot of `codebase_search_with_lsp` results in chat

> **Opinionated change**: Dropping ripgrep in favor of VS Code's native search API improves cross-platform consistency and reduces the extension's external dependencies. Having one consolidated search tool instead of two (`search_files` + `get_search_results`) simplifies the LLM's tool selection.

---

## 8. File Changes System

The file changes tracking infrastructure was built from the ground up, then iterated on to reach the current simplified design.

See [`file-change-tracking.md`](file-change-tracking.md) for the complete tracking specification.

### Evolution

**Phase 1 — Initial Build (May 4–5):** Created the `ChangedFilesService` and `FileContextTracker` with a full Accept / Revert / Redo workflow and a Reviewed section. The native [`file`](../src/core/task/tools/FileTool.ts) tool (rm/mv) was integrated from day one.

**Phase 2 — Simplification (May 9–10):** Removed the git-dependent shadow-repository backend in favor of a **working-directory snapshot system**. Eliminated the Reviewed section and Redo functionality. The final workflow has two actions: **Accept** (promotes content to the new baseline) or **Revert** (restores original content).

### Final Design

| Feature                         | Description                                                                                                                                                                                                |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Working-directory backend**   | File changes are tracked via snapshots in the extension's storage directory. **No git dependency.** This eliminates conflicts with nested repos, worktrees, submodules, and custom git configurations.     |
| **Two-action workflow**         | **Accept** promotes content to persisted baseline. **Revert** restores the original content. No intermediate Reviewed state, no Redo.                                                                      |
| **Comprehensive tool tracking** | Every disk-modifying tool is tracked: `write_to_file`, `apply_diff`, `insert_edit`, `sed`, `file` (rm/mv), `rename_symbol`. The tracker captures original content before mutation and final content after. |
| **Resilient Accept**            | Accept falls back to current disk content when a snapshot is unavailable (e.g., rapid edits during streaming), ensuring the button always works.                                                           |
| **Zero-change filtering**       | Entries with zero net change (+0/−0) are automatically dropped from the panel.                                                                                                                             |
| **Serialized updates**          | Panel state updates are serialized to prevent stale data from concurrent tool executions.                                                                                                                  |

> 📸 TODO: screenshot of File Changes panel showing tracked files with Accept/Revert buttons

> **Opinionated change**: Removing the Reviewed section and Redo button simplifies the mental model. You either keep the change (Accept) or discard it (Revert). Accepting promotes the latest content to the new baseline — there's no intermediate state to manage.

---

## 9. Auto-Approval & Tool Categories

The auto-approval system was refactored to be driven by a unified set of tool categories, replacing the previous ad-hoc toggle system.

See [`auto_approval.md`](auto_approval.md) and [`tool-categories.md`](tool-categories.md) for the full reference.

### What Was Built

| Feature                               | Description                                                                                                                                                                                                      |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ToolGroup-driven auto-approval**    | Auto-approval toggles now correspond to 9 canonical tool categories (read, write, edit, command, browser, mcp, modes, task, skills) — a single source of truth.                                                  |
| **Unified 9 categories**              | Every tool — native, MCP, or registered by another extension — falls into exactly one category. Mode-based filtering and auto-approval both use the same groups. See [`tool-categories.md`](tool-categories.md). |
| **Scoped auto-approve trigger badge** | The auto-approve badge in the chat header is scoped to the current mode, showing only relevant toggles.                                                                                                          |
| **BRRR → All**                        | The "BRRR" (from "YOLO") auto-approval label was renamed to "All" for clarity and professionalism.                                                                                                               |

> 📸 TODO: screenshot of auto-approval toolbar in chat header showing category toggles

---

## 10. Skills System Overhaul

The skills system was redesigned for discoverability, state management, and persistence.

See [`skills.md`](skills.md) and [`command-skill-buttons.md`](command-skill-buttons.md) for the full design.

### What Was Built

| Feature                       | Description                                                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Quick-access buttons**      | Dedicated **Commands** and **Skills** buttons in the chat input bar. One click opens a popover listing all available commands and skills.                                |
| **Wider popover**             | Redesigned popover with a wider layout, two-line entries (name + description), and open-file buttons for each skill's SKILL.md.                                          |
| **Refresh button**            | A refresh button in both popovers re-scans the filesystem for new/updated commands and skills.                                                                           |
| **Loaded skills tracking**    | Skills are tracked as "loaded" in the IPC layer. The SkillsButton shows which skills are currently active.                                                               |
| **Built-in slash commands**   | `/loaded` lists all loaded skills. `/search <query>` searches for skills matching a query.                                                                               |
| **Persistence & rehydration** | Loaded skills are persisted in the task history. When a task is restored, skills are re-loaded automatically.                                                            |
| **Tool renames**              | `skill` → `skill_load` (clearer intent). New `skill_delete` tool for removing skills. `skill_update` → `skill_save` with SKILL.md frontmatter validation before writing. |

> 📸 TODO: screenshot of Skills popover showing loaded skills with descriptions and open-file buttons

> **Opinionated change**: Skills are now a first-class UI concept, not hidden behind slash commands. The quick-access buttons make them discoverable for all users.

---

## 11. Modes & Tool Access Control

The mode system was extended with scoped tool groups, per-task mode binding, and a new default mode.

### What Was Built

| Feature                               | Description                                                                                                                                                                                                           |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Scoped group entries**              | Mode groups now support `allowed`/`denied` lists per group, enabling fine-grained control. Example: a mode can allow `read` group tools but deny `search_files` specifically. See [`tool_access.md`](tool_access.md). |
| **Per-task mode binding**             | Each task has its own mode, sticky for its lifetime. Switching tasks restores that task's mode. Starting a new task lets you choose a different mode without affecting running tasks.                                 |
| **Sticky mode across focus switches** | Re-focusing a task restores its mode. The mode selector always reflects the active task's mode.                                                                                                                       |
| **Default mode: Code**                | Changed from Architect to Code for new installations. Code mode is what most users want most of the time.                                                                                                             |
| **`give_feedback` always available**  | The feedback tool is now accessible regardless of mode settings.                                                                                                                                                      |

> 📸 TODO: screenshot of mode selector dropdown showing scoped group configuration

> **Opinionated change**: Changing the default mode to Code reflects real-world usage patterns. Architect mode is still available but no longer the first thing new users see.

---

## 12. External LM Tool Providers

A generic interface for discovering and invoking tools from other VS Code extensions, replacing the tight coupling to `vscode.lm.tools`.

See [`tool-registration-interface.md`](tool-registration-interface.md) for the provider API specification.

### What Was Built

| Feature                        | Description                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| **Generic provider interface** | Extensions register as tool providers via a well-defined interface. Shofer dynamically discovers and invokes their tools.       |
| **MCP-style chat rows**        | External LM tool calls are surfaced in the chat UI with the same visual treatment as MCP tools — name, arguments, and result.   |
| **Auto-approval integration**  | External tools participate in the ToolGroup-driven auto-approval system. Users can configure which external tools auto-approve. |
| **Tool prefix normalization**  | Tool prefixes were standardized from `vscode_` to `ide_` to be provider-agnostic.                                               |

This enables companion extensions to seamlessly contribute tools to Shofer's tool palette without Shofer needing to know about them at compile time.

> 📸 TODO: screenshot of an external LM tool call rendered as an MCP-style chat row

---

## 13. Worktree Support

Git worktrees were elevated to a first-class concept with an embedded UI and programmatic access.

See [`worktrees.md`](worktrees.md) for the full architecture.

### What Was Built

| Feature                         | Description                                                                                                                                           |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Embedded worktree model**     | Worktrees are managed within the same Shofer session. A separate-window approach was dropped in favor of in-process management.                       |
| **Worktree status indicator**   | A chip in the chat input bar shows the current worktree branch name and git status (dirty/clean/ahead/behind). Clicking it opens worktree management. |
| **Native worktree tool**        | The LLM can create, switch, and delete worktrees via a dedicated native tool.                                                                         |
| **Path convention enforcement** | Worktrees must be created under `.shofer/worktrees/` — a predictable location that keeps the workspace clean.                                         |
| **Unified indicator**           | Multiple worktree-related UI elements were consolidated into a single `WorktreeIndicator` chip.                                                       |

> 📸 TODO: screenshot of worktree status indicator chip in the chat input bar

> **Opinionated change**: Dropping the separate-window model simplifies the architecture. Worktrees feel like a natural extension of the task system rather than a different mode of operation.

---

## 14. Cancellation Flow

A complete end-to-end cancellation pipeline that immediately aborts long-running MCP tool calls and resource reads when the user clicks Stop.

See [`cancellation.md`](cancellation.md) for the full cancellation architecture.

### What Was Built

| Feature                        | Description                                                                                                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **End-to-end abort**           | Stop propagates from the webview through the task loop, API handler, and all the way down to MCP server tool executions, aborting them immediately.                  |
| **HTTP stream abort on pause** | When a task is paused, the HTTP stream is immediately aborted, preventing resource leaks.                                                                            |
| **Stop button semantics**      | Stop no longer transfers queued messages to a rehydrated task — it cleanly cancels the current turn. The "Send Now" flow (separate) handles sending queued messages. |
| **Always-available Stop**      | The Stop button is always responsive, even during streaming, reasoning, or tool execution phases.                                                                    |

> **Opinionated change**: Clear separation between "Stop" (cancel current work) and "Send Now" (cancel and immediately resume with queued input) gives users precise control over task interruption.

---

## 15. Submodule & Nested Git Support

Checkpoints now work in repositories that contain submodules or nested `.git` directories.

See [`submodule-support.md`](submodule-support.md) for the full design.

### What Was Built

| Feature                                  | Description                                                                                                                                                                                        |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`GIT_DIR` isolation**                  | Checkpoints use `GIT_DIR` environment variable isolation instead of requiring a single top-level `.git` directory. This allows nested git repos and submodules to coexist with Shofer checkpoints. |
| **No more "nested git detected" errors** | Previously, Shofer would disable checkpoints and show a warning when nested git repositories were detected. Now checkpoints work transparently.                                                    |

---

## 16. Cost Calculation & Limits

A per-root-task cost tracking and capping system that aggregates subtask costs and enforces user-configured spend limits.

See [`cost-calculation-and-limits.md`](cost-calculation-and-limits.md) for the full system design.

### What Was Built

| Feature                      | Description                                                                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Per-task cost tracking**   | Every API call's token usage and USD cost are tracked and displayed in the task header.                                                |
| **Subtask cost aggregation** | Parent tasks show the cumulative cost of all descendant subtasks, not just their own API calls.                                        |
| **Configurable cost limit**  | Users can set a USD spend cap per root task. When reached, the task is automatically paused or aborted.                                |
| **Post-stream gate**         | The cost limit check fires after every stream completion, even when providers only report `totalCost` without individual token counts. |

> 📸 TODO: screenshot of task header showing aggregated cost with subtask breakdown

---

## 17. Branding & Platform Changes

### Complete Rebrand

The entire codebase was rebranded from Roo-Code to Shofer.Dev:

| Change             | Description                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| **Name**           | Shofer.Dev (extension ID: `shofer.dev`)                                                                                   |
| **Publisher**      | `shofer`                                                                                                                  |
| **Repository**     | [`github.com/shofer-dev/shofer`](https://github.com/shofer-dev/shofer)                                                    |
| **Homepage**       | [`www.shofer.dev`](https://www.shofer.dev)                                                                                |
| **Tagline**        | "State-of-the-art open-source AI coding"                                                                                  |
| **Symbol renames** | All `roo_*` → `shofer_*` prefixes, all `RooCode`/`Roo`/`Cline` identifiers replaced throughout thousands of source files. |
| **Sidebar title**  | "Shofer - Drop Zone"                                                                                                      |
| **Version reset**  | Version numbering reset from `3.x` to `0.1.0` to mark the new project identity.                                           |

### Feature Flags

Shofer supports compile-time and environment-variable feature flags:

| Flag                  | Default                            | Controls                                                     |
| --------------------- | ---------------------------------- | ------------------------------------------------------------ |
| `MARKETPLACE_ENABLED` | `false`                            | Marketplace button visibility and all marketplace-related UI |
| `TELEMETRY_ENABLED`   | `false` (env: `TELEMETRY_ENABLED`) | PostHog telemetry and all telemetry-related UI sections      |

See also: [`configuration.md`](configuration.md) for all VS Code settings.

### Cloud Feature Removal

All Shofer Cloud / Shofer Router functionality was **removed entirely**:

- Cloud account creation and sign-in flow removed from the welcome screen.
- Shofer Router option removed from provider selection.
- Cloud icon and button removed from the top bar.
- `@shofer/cloud` package and all its types, services, and tests deleted.
- Welcome screen simplified from 3 screens to 2 screens (landing → configure provider).
- `CloudService`, `MdmService`, `ShoferHandler`, `AuthOrigin` type — all removed.

> 📸 TODO: screenshot of simplified welcome screen (2-step: landing → configure provider)

> **Opinionated change**: Shofer is now purely local-first. All configuration, API keys, and task history stay on the user's machine. The simplified welcome flow gets users to their first task faster.

---

## 18. Provider Improvements

### VS Code Language Model Provider

| Feature                         | Description                                                                                                                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Thinking/reasoning blocks**   | Streaming reasoning/thinking content is now surfaced in the chat UI as collapsible thinking blocks. Models using the VS Code LM API (including GitHub Copilot models) can show their reasoning process. |
| **MaxTokens from model config** | The provider now passes `maxTokens` from the model configuration to the LLM, respecting model-specific output limits.                                                                                   |
| **TaskId as conversationId**    | Each task's ID is passed as `conversationId` in model options for better conversation tracking and continuity.                                                                                          |

### Tool Preparing Progress

A new progress indicator appears in chat while the LLM streams tool call arguments. Previously, tool calls appeared abruptly — users now see that a tool invocation is in progress before it executes.

See [`tool-preparing-progress.md`](tool-preparing-progress.md) for the full design.

> 📸 TODO: screenshot of tool_preparing spinner row during a tool call argument stream

> **Opinionated change**: This addition significantly improves the perceived responsiveness and transparency of tool calls. Users know something is happening while arguments stream in.

---

## 19. UI/UX Opinionated Changes

These are deliberate design decisions that changed the default behavior or appearance of the application.

| Change                                           | Rationale                                                                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| **Pause/play buttons removed from TaskSelector** | Redundant with task header controls. TaskSelector is for navigation, not management.                                           |
| **Current-task tick removed**                    | The active task is obvious from context (it's the one you're looking at).                                                      |
| **Default mode: Architect → Code**               | Code mode is the primary use case. Architect is still available but no longer the default.                                     |
| **BRRR → All auto-approval label**               | "BRRR" (from "YOLO") was rebranded to "All" for clarity and professionalism.                                                   |
| **Background editing enabled by default**        | The experiment graduated — background diffs are now the standard editing experience.                                           |
| **Cloud icon removed from top bar**              | Part of the cloud feature removal. The top bar is cleaner with fewer icons.                                                    |
| **Welcome screen simplified**                    | 3-screen flow (landing → choose provider → configure) became 2 screens (landing → configure). Fewer decisions, faster setup.   |
| **API request started row auto-hides**           | The "API request started" indicator row now hides on success, reducing chat clutter. Only persists on errors or cancellations. |
| **File operation approval labels**               | "File Op" → "Remove File" / "Move File" — descriptive subcommand-specific labels.                                              |
| **Archive over delete**                          | Tasks are archived (hidden) rather than deleted. Data is preserved; nothing is lost.                                           |
| **Debug logging via outputChannel**              | All debug logging uses the proper VS Code output channel instead of `console.log`, keeping the developer console clean.        |
| **Tool prefixes: `vscode_` → `ide_`**            | Standardized to be provider-agnostic — tools come from the IDE, not specifically from VS Code.                                 |

---

## Summary

Shofer evolved from a single-threaded coding assistant into a **multi-agent platform** where:

- **Tasks are first-class entities** with independent state, history, mode, and lifecycle — users can run multiple conversations simultaneously.
- **The LLM can orchestrate work** — fanning out to background children, waiting for results, and aggregating findings.
- **User input is decoupled from LLM processing** — message queue, Send Now, and per-task drafts make the UX feel responsive even during long turns.
- **Tools are dynamically pluggable** — external extensions contribute tools via a generic provider interface; modes define fine-grained access control.
- **The UI scales to concurrency** — TaskSelector with hierarchy/archive/pin, state indicators, notifications, and per-task isolation make managing multiple tasks natural.
- **Drag-and-drop and export** make it easy to provide context and share results.
- **Opinionated defaults reduce friction** — Code mode, background editing, simplified workflows, and a streamlined welcome screen.
- **Local-first, no cloud dependency** — everything runs on the user's machine.

---

## Document Index

| Document                                                           | Topic                                            |
| ------------------------------------------------------------------ | ------------------------------------------------ |
| [`auto_approval.md`](auto_approval.md)                             | Auto-approval decision flow and category toggles |
| [`cancellation.md`](cancellation.md)                               | End-to-end Stop propagation                      |
| [`command-skill-buttons.md`](command-skill-buttons.md)             | Commands & Skills quick-access buttons design    |
| [`configuration.md`](configuration.md)                             | VS Code settings reference                       |
| [`cost-calculation-and-limits.md`](cost-calculation-and-limits.md) | Per-task cost tracking and USD cap               |
| [`drag_n_drop.md`](drag_n_drop.md)                                 | Drag-and-drop context files                      |
| [`file-change-tracking.md`](file-change-tracking.md)               | File changes panel and tracking specification    |
| [`message_queue.md`](message_queue.md)                             | Message queue, Send Now, and per-task drafts     |
| [`native_tools.md`](native_tools.md)                               | Complete native tools reference                  |
| [`search_files-tool.md`](search_files-tool.md)                     | Unified search_files tool specification          |
| [`shofer_special_files.md`](shofer_special_files.md)               | Special files and directories Shofer recognizes  |
| [`skills.md`](skills.md)                                           | Skills system architecture                       |
| [`submodule-support.md`](submodule-support.md)                     | Nested git / submodule checkpoint support        |
| [`task_states.md`](task_states.md)                                 | Task state model and visual indicators           |
| [`task-export.md`](task-export.md)                                 | Markdown and JSON export formats                 |
| [`tool-categories.md`](tool-categories.md)                         | 9 unified tool categories                        |
| [`tool-preparing-progress.md`](tool-preparing-progress.md)         | Tool call argument streaming indicator           |
| [`tool-registration-interface.md`](tool-registration-interface.md) | External LM tool provider API                    |
| [`tool_access.md`](tool_access.md)                                 | Mode-level tool access control                   |
| [`worktrees.md`](worktrees.md)                                     | Worktree architecture                            |

---

See also: [`CHANGELOG.md`](../CHANGELOG.md) — complete release history including all bug fixes.
