# Shofer Native Tools Reference

Complete reference for all native tools available in Shofer, their mode availability, and current status.

## Mode Availability

| Mode            | Groups                                                             | Description                  |
| --------------- | ------------------------------------------------------------------ | ---------------------------- |
| 🏗️ Architect    | `read`, `write` (md only), `mcp`, `questions`                      | Plan and design              |
| 💻 Code         | `read`, `write`, `execute`, `mcp`, `mode`, `subtasks`, `questions` | Write and modify code        |
| ❓ Ask          | `read`, `mcp`                                                      | Get answers and explanations |
| 🪲 Debug        | `read`, `write`, `execute`, `mcp`, `subtasks`, `questions`         | Diagnose and fix issues      |
| 🪃 Orchestrator | varies                                                             | Delegates to other modes     |

**Always-available tools** bypass mode filtering entirely (see column below).

---

## Tool Status Legend

| Status | Meaning                                                      |
| ------ | ------------------------------------------------------------ |
| ✅     | Fully implemented, schema + handler                          |
| 🔒     | Feature-gated (requires experiment flag or external service) |
| 🔧     | Legacy/custom tool (alias-based, model-dependent)            |

### Origin

| Tag   | Meaning                                                 |
| ----- | ------------------------------------------------------- |
| 🆕 WS | Ported from `workspace-tools` extension in this session |
| 🔵 RC | Pre-existing Shofer tool                                |
| 🟣 AW | New Shofer.Dev tool (custom addition)                   |

---

## File Operations

| Tool                   | Origin | Group | Always Available | Status | Description                                    |
| ---------------------- | :----: | ----- | :--------------: | :----: | ---------------------------------------------- |
| `read_file`            | 🔵 RC  | read  |        –         |   ✅   | Read file contents with line range             |
| `write_to_file`        | 🔵 RC  | write |        –         |   ✅   | Create or overwrite a file                     |
| `apply_diff`           | 🔵 RC  | write |        –         |   ✅   | Apply precise targeted modifications           |
| `create_directory`     | 🆕 WS  | write |        –         |   ✅   | Create directory (mkdir -p)                    |
| `file`                 | 🟣 AW  | write |        –         |   ✅   | Filesystem ops (rm/mv) tracked as Shofer edits |
| `insert_edit`          | 🆕 WS  | write |        –         |   ✅   | Insert text at a specific line:column position |
| `list_files`           | 🔵 RC  | read  |        –         |   ✅   | List files and directories at a path           |
| `create_new_workspace` | 🆕 WS  | write |        –         |   ✅   | Create new workspace directory structure       |
| `sed`                  | 🟣 AW  | write |        –         |   ✅   | Regex find-and-replace on a workspace file     |

### `read_file`

Read a file's contents with two modes: slice (offset/limit) and indentation (semantic block extraction).

| Param                          | Type                                 | Required | Description                                                        |
| ------------------------------ | ------------------------------------ | :------: | ------------------------------------------------------------------ |
| `path`                         | string                               |    ✅    | File path relative to workspace                                    |
| `mode`                         | `"slice"` \| `"indentation"` \| null |    –     | Reading mode: `"slice"` (default) or `"indentation"`               |
| `offset`                       | number \| null                       |    –     | 1-based line to start reading from (slice mode, default: 1)        |
| `limit`                        | number \| null                       |    –     | Maximum lines to return (default: 2000)                            |
| `indentation`                  | object \| null                       |    –     | Indentation-mode options (only used when `mode === "indentation"`) |
| `indentation.anchor_line`      | number                               |    –     | 1-based line anchoring code block extraction                       |
| `indentation.max_levels`       | number \| null                       |    –     | Maximum indentation levels above anchor (0 = unlimited, default)   |
| `indentation.include_siblings` | boolean \| null                      |    –     | Include sibling blocks at same indentation (default: false)        |
| `indentation.include_header`   | boolean \| null                      |    –     | Include file header/imports (default: true)                        |
| `indentation.max_lines`        | number \| null                       |    –     | Hard cap on lines for indentation mode                             |

### `write_to_file`

Create a new file or overwrite an existing file with content.

| Param     | Type   | Required | Description                     |
| --------- | ------ | :------: | ------------------------------- |
| `path`    | string |    ✅    | File path relative to workspace |
| `content` | string |    ✅    | Full file content               |

### `apply_diff`

Apply precise, targeted modifications to an existing file using a diff format.

| Param  | Type   | Required | Description                             |
| ------ | ------ | :------: | --------------------------------------- |
| `path` | string |    ✅    | File path                               |
| `diff` | string |    ✅    | Diff content with search/replace blocks |

### `create_directory`

Creates a directory including parent directories (mkdir -p).

| Param  | Type   | Required | Description                          |
| ------ | ------ | :------: | ------------------------------------ |
| `path` | string |    ✅    | Directory path relative to workspace |

### `file`

Filesystem operations on workspace files. Use this instead of `execute_command` with `rm`/`mv` so the operation is captured in the FileChangesPanel and is reversible via per-file Revert/Redo.

Subcommands:

- `rm`: Delete a file (or directory tree when `recursive=true`).
- `mv`: Move/rename a file or directory. Destination must not already exist.

| Param         | Type             | Required | Description                                             |
| ------------- | ---------------- | :------: | ------------------------------------------------------- |
| `subcommand`  | `"rm"` \| `"mv"` |    ✅    | Operation to perform                                    |
| `path`        | string           |    ✅    | Source path relative to workspace                       |
| `destination` | string \| null   |    ✅    | Destination path for `mv` (required when `mv`)          |
| `recursive`   | boolean \| null  |    ✅    | For `rm`: recursive directory delete (default: `false`) |

Both endpoints of an `mv` are recorded in `FileContextTracker` as `shofer_edited`, so the panel shows the source as deleted (revertable) and the destination as created (revertable). For directories, every contained file is individually tracked.

### `insert_edit`

Inserts text at a specific position in a file using VS Code's WorkspaceEdit API.

| Param      | Type   | Required | Description                     |
| ---------- | ------ | :------: | ------------------------------- |
| `filePath` | string |    ✅    | File path relative to workspace |
| `line`     | number |    ✅    | 1-based line number             |
| `column`   | number |    ✅    | 1-based column number           |
| `text`     | string |    ✅    | Text to insert                  |

### `sed`

Performs regex find-and-replace on a workspace file, similar to `sed 's/pattern/replacement/g'`. Uses JavaScript RegExp syntax. Supports capture group backreferences ($1, $2, etc.).

| Param         | Type            | Required | Description                                |
| ------------- | --------------- | :------: | ------------------------------------------ |
| `path`        | string          |    ✅    | File path relative to workspace            |
| `pattern`     | string          |    ✅    | Regex pattern (JavaScript RegExp syntax)   |
| `replacement` | string          |    ✅    | Replacement string (supports $1, $2, etc.) |
| `global`      | boolean \| null |    ✅    | Replace all occurrences (default: true)    |

### `create_new_workspace`

Creates a new workspace/project directory structure with optional subdirectories.

| Param             | Type             | Required | Description                         |
| ----------------- | ---------------- | :------: | ----------------------------------- |
| `path`            | string           |    ✅    | Parent directory                    |
| `name`            | string           |    ✅    | Workspace/project name              |
| `folders`         | string[] \| null |    ✅    | Subdirectories to create            |
| `openInNewWindow` | boolean \| null  |    ✅    | Open in new window (default: false) |

---

## Search & Discovery

| Tool                  | Origin | Group | Always Available | Status | Description                                            |
| --------------------- | :----: | ----- | :--------------: | :----: | ------------------------------------------------------ |
| `grep_search`         | 🔵 RC  | read  |        –         |   ✅   | Regex/literal search across files with context         |
| `find_files`          | 🆕 WS  | read  |        –         |   ✅   | Find files by glob pattern                             |
| `list_code_usages`    | 🆕 WS  | read  |        –         |   ✅   | Find all symbol references (LSP)                       |
| `rag_search`          | 🔵 RC  | read  |        –         |   🔒   | Semantic code search (requires code index)             |
| `lsp_search`          | 🆕 WS  | read  |        –         |   ✅   | Symbol search via LSP + text fallback                  |
| `git_search`          | 🟣 AW  | read  |        –         |   ✅   | Search git history (commit messages only)              |
| `ask_assistant_agent` | 🆕 WS  | read  |        –         |   ✅   | Ask the persistent assistant agent a codebase question |

### `grep_search`

Unified search using VS Code's indexed `workspace.findTextInFiles` API. Supports both regex and literal text search, case-sensitive/whole-word matching, file type filtering, exclusion patterns, configurable context lines, and result capping. Replaces the former `get_search_results` tool.

| Param            | Type            | Required | Description                                                 |
| ---------------- | --------------- | :------: | ----------------------------------------------------------- |
| `path`           | string          |    ✅    | Directory to search recursively, relative to workspace      |
| `query`          | string          |    ✅    | Search pattern (regex or literal text)                      |
| `fileTypes`      | string \| null  |    ✅    | Glob to filter files (e.g., `*.ts`, `**/*.go`). null = all. |
| `excludePattern` | string \| null  |    ✅    | Glob to exclude files (e.g., `**/node_modules/**`)          |
| `isRegex`        | boolean \| null |    ✅    | Whether query is a regex (default: true)                    |
| `caseSensitive`  | boolean \| null |    ✅    | Case-sensitive matching (default: false)                    |
| `wholeWord`      | boolean \| null |    ✅    | Match whole words only (default: false)                     |
| `maxResults`     | number \| null  |    ✅    | Maximum total results (default: 100)                        |
| `contextBefore`  | number \| null  |    ✅    | Lines of context before each match (default: 1)             |
| `contextAfter`   | number \| null  |    ✅    | Lines of context after each match (default: 1)              |

### `find_files`

Find files matching a glob pattern using VS Code's `workspace.findFiles`.

| Param        | Type   | Required | Description                    |
| ------------ | ------ | :------: | ------------------------------ |
| `pattern`    | string |    ✅    | Glob pattern (e.g., `**/*.ts`) |
| `maxResults` | number |    –     | Max results (default: 100)     |

### `list_code_usages`

Finds all references of a symbol using VS Code's LSP reference provider.

| Param      | Type   | Required | Description                |
| ---------- | ------ | :------: | -------------------------- |
| `filePath` | string |    ✅    | File containing the symbol |
| `line`     | number |    ✅    | 1-based line number        |
| `column`   | number |    ✅    | 1-based column number      |

### `lsp_search`

Searches the codebase using the LSP workspace symbol provider. Falls back to word-level text search when no language server is available. Requires no external infrastructure.

| Param        | Type           | Required | Description                         |
| ------------ | -------------- | :------: | ----------------------------------- |
| `query`      | string         |    ✅    | Symbol name or text to search for   |
| `maxResults` | number \| null |    ✅    | Max results to return (default: 20) |

### `git_search`

Semantic search over git commit history (commit messages only — not diffs, not file contents). Uses embedding-based cosine similarity against a Qdrant collection of indexed commit messages. Requires the git index to be enabled and initialized.

| Param        | Type           | Required | Description                         |
| ------------ | -------------- | :------: | ----------------------------------- |
| `query`      | string         |    ✅    | Text to search for in git history   |
| `maxResults` | number \| null |    ✅    | Max results to return (default: 20) |

### `rag_search`

🔒 Requires code index to be enabled, configured, and initialized.

| Param        | Type           | Required | Description                                   |
| ------------ | -------------- | :------: | --------------------------------------------- |
| `query`      | string         |    ✅    | Natural language search query                 |
| `path`       | string \| null |    –     | Directory scope (relative to workspace)       |
| `maxResults` | number \| null |    –     | Maximum code snippets to return (default: 10) |

### `ask_assistant_agent`

Ask a question to the persistent **assistant agent** — a separate, cost-optimized tool-using agent that maintains long-term context about the codebase across questions. Use this for codebase-knowledge questions that don't require the calling task's full conversation context to be loaded.

The tool is synchronous: the calling task blocks until the assistant returns an answer, the `timeoutMs` hard limit is reached, or the assistant is cancelled. The assistant agent runs its own tool loop using the read-only native tools (`read_file`, `grep_search`, `find_files`, …) under its own model configuration.

| Param              | Type             | Required | Description                                                                                                                                                           |
| ------------------ | ---------------- | :------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `question`         | string           |    ✅    | The question to ask the assistant agent.                                                                                                                              |
| `contextFiles`     | string[] \| null |    –     | File paths the assistant should preload into its context window for this question.                                                                                    |
| `timeoutMs`        | number \| null   |    –     | **Hard** maximum wall time in milliseconds (default: 300000 = 5 minutes). On timeout the assistant is aborted and a timeout error is returned.                        |
| `softTimeoutSec`   | number \| null   |    –     | Soft recommendation (in seconds) for how long the assistant should spend on the question (default: 60). Embedded as prompt guidance; not enforced via cancellation.   |
| `softResultLength` | number \| null   |    –     | Soft recommendation (in characters) for the maximum length of the assistant's final answer (default: 2000). Embedded as prompt guidance; not enforced via truncation. |

---

## Code Analysis & Refactoring

| Tool                     | Origin | Group | Always Available | Status | Description                                        |
| ------------------------ | :----: | ----- | :--------------: | :----: | -------------------------------------------------- |
| `get_errors`             | 🆕 WS  | read  |        –         |   ✅   | Get compile/lint diagnostics                       |
| `get_project_setup_info` | 🆕 WS  | read  |        –         |   ✅   | Detect project languages, frameworks, build system |
| `get_changed_files`      | 🟣 AW  | read  |        –         |   ✅   | List files changed in current task with line stats |
| `read_project_structure` | 🆕 WS  | read  |        –         |   ✅   | ASCII tree of workspace structure                  |
| `rename_symbol`          | 🆕 WS  | write |        –         |   ✅   | Rename symbol across codebase (LSP)                |
| `view_image`             | 🆕 WS  | read  |        –         |   ✅   | View image file for visual analysis                |

### `get_errors`

Retrieves compile/lint errors and warnings from VS Code's language server diagnostics.

| Param       | Type             | Required | Description                       |
| ----------- | ---------------- | :------: | --------------------------------- |
| `filePaths` | string[] \| null |    ✅    | Files to check (null = all files) |

### `get_project_setup_info`

Analyzes workspace root for config files and detects languages, frameworks, build systems, and package managers.

**Parameters:** None.

### `get_changed_files`

Returns the files Shofer edited in the current task with per-file net-state annotations (+insertions / −deletions). Backed by the working-directory `ChangedFilesService` — each edited file has a `base/` copy captured at first edit and a `final/` copy captured after every `shofer_edited`. Diff stats are computed via unified diff against the base content. No git dependency.

No approval prompt — read-only meta-operation.

**Parameters:** None.

### `read_project_structure`

Returns an ASCII tree of the directory structure, skipping noise directories (node_modules, .git, bazel-\*, etc.).

| Param           | Type            | Required | Description                       |
| --------------- | --------------- | :------: | --------------------------------- |
| `maxDepth`      | number \| null  |    ✅    | Maximum depth (default: 3)        |
| `includeHidden` | boolean \| null |    ✅    | Include dotfiles (default: false) |

### `rename_symbol`

Renames a symbol and all references across the codebase using VS Code's LSP rename provider.

| Param      | Type   | Required | Description                |
| ---------- | ------ | :------: | -------------------------- |
| `filePath` | string |    ✅    | File containing the symbol |
| `line`     | number |    ✅    | 1-based line number        |
| `column`   | number |    ✅    | 1-based column number      |
| `newName`  | string |    ✅    | New name for the symbol    |

### `view_image`

Reads an image file and returns base64-encoded data for visual analysis.

| Param      | Type   | Required | Description        |
| ---------- | ------ | :------: | ------------------ |
| `filePath` | string |    ✅    | Path to image file |

Supported formats: PNG, JPG, JPEG, GIF, BMP, SVG, WEBP.

---

## Execution & System

| Tool                  | Origin | Group   | Always Available | Status | Description                            |
| --------------------- | :----: | ------- | :--------------: | :----: | -------------------------------------- |
| `execute_command`     | 🔵 RC  | execute |        –         |   ✅   | Execute a CLI command                  |
| `read_command_output` | 🔵 RC  | execute |        –         |   ✅   | Get full output of a truncated command |
| `sleep`               | 🟣 AW  | execute |        –         |   ✅   | Pause execution for N seconds          |
| `fetch_web_page`      | 🆕 WS  | read    |        –         |   ✅   | Fetch and extract web page content     |

### `execute_command`

Execute a CLI command in the user's terminal.

| Param     | Type           | Required | Description        |
| --------- | -------------- | :------: | ------------------ |
| `command` | string         |    ✅    | Command to execute |
| `cwd`     | string \| null |    –     | Working directory  |
| `timeout` | number \| null |    –     | Timeout in seconds |

### `read_command_output`

Retrieve the full output from a previously truncated command execution. Supports search filtering and pagination.

| Param         | Type           | Required | Description                                                          |
| ------------- | -------------- | :------: | -------------------------------------------------------------------- |
| `artifact_id` | string         |    ✅    | The artifact ID from the truncated command                           |
| `search`      | string \| null |    –     | Optional regex or literal pattern to filter lines (case-insensitive) |
| `offset`      | number \| null |    –     | Byte offset to start reading from (default: 0)                       |
| `limit`       | number \| null |    –     | Maximum bytes to return (default: 40KB)                              |

### `fetch_web_page`

Fetches web pages, strips HTML, and returns extracted text content. Supports query-based filtering.

| Param   | Type           | Required | Description                        |
| ------- | -------------- | :------: | ---------------------------------- |
| `urls`  | string[]       |    ✅    | URLs to fetch                      |
| `query` | string \| null |    ✅    | Filter query for extracted content |

### `sleep`

Pauses agent execution for the given number of seconds. Useful for polling external resources where a small back-off is needed between checks.

| Param     | Type   | Required | Description                  |
| --------- | ------ | :------: | ---------------------------- |
| `seconds` | number |    ✅    | How long to wait, in seconds |

---

## Task & Workflow Management

| Tool                      | Origin | Group | Always Available | Status | Description                                                 |
| ------------------------- | :----: | ----- | :--------------: | :----: | ----------------------------------------------------------- |
| `ask_followup_question`   | 🔵 RC  | –     |        ✅        |   ✅   | Ask the user a question                                     |
| `attempt_completion`      | 🔵 RC  | –     |        ✅        |   ✅   | Signal task completion                                      |
| `switch_mode`             | 🔵 RC  | mode  |        ✅        |   ✅   | Switch to a different mode                                  |
| `new_task`                | 🔵 RC  | mode  |        ✅        |   ✅   | Spawn a sub-task (sync or background)                       |
| `check_task_status`       | 🟣 AW  | –     |        ✅        |   ✅   | Check status/result of a background child task              |
| `wait_for_task`           | 🟣 AW  | –     |        ✅        |   ✅   | Block until one or more background tasks complete (all/any) |
| `cancel_tasks`            | 🟣 AW  | –     |        ✅        |   ✅   | Cancel one or more running background child tasks           |
| `answer_subtask_question` | 🟣 AW  | –     |        ✅        |   ✅   | Answer a question asked by a background child task          |
| `list_background_tasks`   | 🟣 AW  | –     |        ✅        |   ✅   | List all background child tasks started by this task        |
| `update_todo_list`        | 🔵 RC  | –     |        ✅        |   ✅   | Update the TODO list                                        |
| `skills`                  | 🔵 RC  | –     |        ✅        |   ✅   | Load and execute a skill                                    |
| `set_task_title`          | 🟣 AW  | –     |        ✅        |   ✅   | Set descriptive title for the task                          |
| `give_feedback`           | 🟣 AW  | –     |        ✅        |   ✅   | Send feedback to the Shofer.Dev developers                  |

### `new_task`

Create a new task instance in the chosen mode. Supports two execution models:

- **Synchronous (default):** The parent blocks until the child completes. Must be called alone — no other tools in the same turn.
- **Background (`is_background=true`):** The child starts immediately and runs concurrently. The parent receives the child's `task_id` and continues without blocking. Use `check_task_status` or `wait_for_task` to retrieve results later.

| Param              | Type            | Required | Description                                                                                                                |
| ------------------ | --------------- | :------: | -------------------------------------------------------------------------------------------------------------------------- |
| `mode`             | string          |    ✅    | Mode slug (e.g., `code`, `debug`)                                                                                          |
| `message`          | string          |    ✅    | Initial instructions for the child task                                                                                    |
| `todos`            | string \| null  |    –     | Initial markdown checklist for the child                                                                                   |
| `is_background`    | boolean \| null |    –     | When `true`, run child concurrently and return `task_id` immediately (default: `false`)                                    |
| `softResultLength` | number \| null  |    –     | Soft suggestion for max characters of the subtask's completion result (default: 2000). Hard safety cap: 100000 characters. |
| `softTimeoutSec`   | number \| null  |    –     | Soft guidance in seconds for how long the parent expects to wait (default: 300). Informational only — not enforced.        |

### `check_task_status`

Check the current status of a background child task started with `new_task` using `is_background=true`. Returns the task's status and, if it has completed/errored/cancelled, its result or error message. If the child is blocked waiting for clarification from the parent (it called `ask_followup_question`), the pending question is surfaced here so the parent can answer it via `answer_subtask_question`. Set `include_activity` to `true` to also see what the child is currently doing.

| Param              | Type            | Required | Description                                                                    |
| ------------------ | --------------- | :------: | ------------------------------------------------------------------------------ |
| `task_id`          | string          |    ✅    | The task ID returned when the background task started                          |
| `include_activity` | boolean \| null |    ✅    | When `true`, include the child's most recent tool calls and messages in output |

### `wait_for_task`

Block until one or more background child tasks (started with `is_background=true`) reach a terminal state, then return their results. Event-driven — does not poll. Supports `wait=all` (default) to wait for every listed task, or `wait=any` to return as soon as the first one completes.

| Param      | Type               | Required | Description                                                                  |
| ---------- | ------------------ | :------: | ---------------------------------------------------------------------------- |
| `task_ids` | string[]           |    ✅    | One or more task IDs returned when the background tasks were started         |
| `wait`     | `"all"` \| `"any"` |    –     | `"all"` (default) — wait for all tasks; `"any"` — return on first completion |
| `timeout`  | number             |    –     | Max seconds to wait (default: 120). Returns current statuses if exceeded.    |

Returns: the completed task IDs plus per-task status and result/error text.

### `cancel_tasks`

Stop one or more background child tasks. Already-completed or errored tasks are unaffected. Use this to terminate redundant parallel work — e.g. when one search subtask found the answer and the others are no longer needed. Requires user approval (cancellation is destructive: the child's in-flight work is lost).

| Param      | Type     | Required | Description                                             |
| ---------- | -------- | :------: | ------------------------------------------------------- |
| `task_ids` | string[] |    ✅    | One or more task IDs of background child tasks to stop. |

### `answer_subtask_question`

Answer a question that a background child task asked via `ask_followup_question`. When a background child needs clarification, its question is routed to the parent (not to the user). The parent uses this tool to provide the answer and unblock the child.

| Param     | Type   | Required | Description                                                                         |
| --------- | ------ | :------: | ----------------------------------------------------------------------------------- |
| `task_id` | string |    ✅    | The task ID of the background child that asked the question.                        |
| `answer`  | string |    ✅    | The parent's answer. Be specific and actionable so the child can continue its work. |

### `list_background_tasks`

List all background child tasks started by this task via `new_task` with `is_background=true`. Returns each task's ID, current status, and creation timestamp.

**Parameters:** None.

### `set_task_title`

Sets a short, descriptive title for the current task/conversation. Use this early in a conversation to replace the auto-generated title with something meaningful.

| Param   | Type   | Required | Description                            |
| ------- | ------ | :------: | -------------------------------------- |
| `title` | string |    ✅    | Short descriptive title (max 60 chars) |

No approval prompt needed — this is a non-destructive meta-operation.

### `give_feedback`

Send feedback to the Shofer.Dev developers. The feedback message is appended to the Shofer extension output channel (auto-approved, harmless meta-operation).

| Param      | Type   | Required | Description                                     |
| ---------- | ------ | :------: | ----------------------------------------------- |
| `feedback` | string |    ✅    | The feedback message to send to Shofer.Dev devs |

No approval prompt needed — non-destructive, written only to the extension output channel.

### `attempt_completion`

Signal task completion to the user. Presents the final result and concludes the task.

| Param      | Type           | Required | Description                                                                                 |
| ---------- | -------------- | :------: | ------------------------------------------------------------------------------------------- |
| `result`   | string         |    ✅    | Final result message to deliver to the user                                                 |
| `rating`   | string         |    ✅    | Success rating: `"poor"`, `"well"`, or `"excellent"`                                        |
| `feedback` | string \| null |    ✅    | Optional feedback for Shofer engineers: what didn't work, ideas for improving tooling, etc. |

**IMPORTANT:** This tool cannot be used until all previous tool uses in the current turn have succeeded. If any tool failed, address the failure first.

The `rating` parameter provides a self-assessment of how well the task was completed:

- `"poor"` — poorly executed, significant issues or incomplete
- `"well"` — acceptable but with room for improvement
- `"excellent"` — task executed excellently, high quality result

The optional `feedback` parameter captures concrete observations about tooling or system prompt shortcomings encountered during the task. This feedback is routed to Shofer.Dev developers for continuous improvement.

### `skills`

Load and execute a skill by name. Skills provide specialized instructions for common tasks.

| Param   | Type           | Required | Description                                                                      |
| ------- | -------------- | :------: | -------------------------------------------------------------------------------- |
| `skill` | string         |    ✅    | Name of the skill to load (matches names in `available_skills` in system prompt) |
| `args`  | string \| null |    ✅    | Optional context or arguments to pass to the skill                               |

**Behavior:**

- Reads the full `SKILL.md` body from disk, parses YAML frontmatter, and returns formatted instructions.
- **Loaded skill tracking**: Each successfully loaded skill is recorded on the `Task` object (`loadedSkills: Map<name, path>`).
- **Reload is a no-op**: Calling `skills` for an already-loaded skill returns a no-op message without re-reading the file.
- **Cleared on condense**: All loaded skills are cleared when context summarization/truncation triggers (see [`skills.md`](skills.md#loaded-skill-tracking)).

---

## MCP (Model Context Protocol)

| Tool                    | Origin | Group | Always Available | Status | Description                                                                 |
| ----------------------- | :----: | ----- | :--------------: | :----: | --------------------------------------------------------------------------- |
| `use_mcp_tool`          | 🔵 RC  | mcp   |        –         |   ✅   | Call an MCP server tool synchronously                                       |
| `access_mcp_resource`   | 🔵 RC  | mcp   |        –         |   🔒   | Access an MCP resource (requires MCP resources)                             |
| `call_mcp_tool_async`   | 🟣 AW  | mcp   |        –         |   ✅   | Call an MCP server tool asynchronously (fire-and-forget, returns `call_id`) |
| `check_mcp_call_status` | 🟣 AW  | mcp   |        –         |   ✅   | Poll the status/result of an async MCP call by `call_id`                    |
| `wait_for_mcp_call`     | 🟣 AW  | mcp   |        –         |   ✅   | Block until one or more async MCP calls complete (all/any)                  |

### `call_mcp_tool_async`

Call an MCP server tool asynchronously. Returns immediately with a `call_id`; use `check_mcp_call_status` to poll or `wait_for_mcp_call` to block. Prefer this over `use_mcp_tool` for long-running calls or when fanning out multiple independent MCP calls in parallel.

| Param         | Type                            | Required | Description                                                                         |
| ------------- | ------------------------------- | :------: | ----------------------------------------------------------------------------------- |
| `server_name` | string                          |    ✅    | The name of the MCP server providing the tool                                       |
| `tool_name`   | string                          |    ✅    | The name of the tool to execute on the MCP server                                   |
| `arguments`   | object \| null                  |    ✅    | JSON object with the tool's input parameters; `null` if the tool takes no arguments |
| `source`      | `"global" \| "project" \| null` |    ✅    | Disambiguator when multiple servers share a name. `null` = default resolution       |

### `check_mcp_call_status`

Check the current status of an asynchronous MCP call started via `call_mcp_tool_async`. Returns the call's status and, if it has completed/errored, its result or error.

| Param     | Type   | Required | Description                                          |
| --------- | ------ | :------: | ---------------------------------------------------- |
| `call_id` | string |    ✅    | The call ID returned when the async MCP call started |

### `wait_for_mcp_call`

Block until one or more async MCP calls (started with `call_mcp_tool_async`) reach a terminal state, then return their results. Event-driven — does not poll. Supports `wait=all` (default) to wait for every listed call, or `wait=any` to return as soon as the first one completes.

| Param      | Type             | Required | Description                                                                  |
| ---------- | ---------------- | :------: | ---------------------------------------------------------------------------- |
| `call_ids` | string[]         |    ✅    | One or more call IDs returned when the async MCP calls were started          |
| `wait`     | `"all" \| "any"` |    –     | `"all"` (default) — wait for all calls; `"any"` — return on first completion |
| `timeout`  | number           |    –     | Max seconds to wait (default: 120). Returns current statuses if exceeded.    |

---

## Feature-Gated Tools

| Tool                | Origin | Group | Always Available | Gate                          | Description         |
| ------------------- | :----: | ----- | :--------------: | ----------------------------- | ------------------- |
| `generate_image`    | 🔵 RC  | write |        –         | `experiments.imageGeneration` | Generate images     |
| `run_slash_command` | 🔵 RC  | –     |        ✅        | `experiments.runSlashCommand` | Run a slash command |

---

## Legacy/Alias Tools

These are alternative edit tool implementations selectable per-model. They map to canonical tools via `TOOL_ALIASES` or `customTools` in the edit group. All are pre-existing Shofer tools (🔵 RC).

| Tool                 | Origin | Canonical    | Status | Description                 |
| -------------------- | :----: | ------------ | :----: | --------------------------- |
| `write`              | 🔵 RC  | (standalone) |   🔧   | Edit files (model-specific) |
| `search_replace`     | 🔵 RC  | (standalone) |   🔧   | Single search-and-replace   |
| `edit_file`          | 🔵 RC  | (standalone) |   🔧   | Edit via search-and-replace |
| `apply_patch`        | 🔵 RC  | (standalone) |   🔧   | Apply unified diff patch    |
| `search_and_replace` | 🔵 RC  | → `edit`     |   🔧   | Alias for `edit`            |

---

## Mode × Tool Availability Matrix

Checkmark (✓) means the tool is available in that mode by default.

| Tool                      | 🏗️ Architect | 💻 Code | ❓ Ask | 🪲 Debug | Always |
| ------------------------- | :----------: | :-----: | :----: | :------: | :----: |
| **Read group**            |
| `read_file`               |      ✓       |    ✓    |   ✓    |    ✓     |        |
| `grep_search`             |      ✓       |    ✓    |   ✓    |    ✓     |        |
| `list_files`              |      ✓       |    ✓    |   ✓    |    ✓     |        |
| `find_files`              |      ✓       |    ✓    |   ✓    |    ✓     |        |
| `read_project_structure`  |      ✓       |    ✓    |   ✓    |    ✓     |        |
| `view_image`              |      ✓       |    ✓    |   ✓    |    ✓     |        |
| `list_code_usages`        |      ✓       |    ✓    |   ✓    |    ✓     |        |
| `get_errors`              |      ✓       |    ✓    |   ✓    |    ✓     |        |
| `get_project_setup_info`  |      ✓       |    ✓    |   ✓    |    ✓     |        |
| `get_changed_files`       |      ✓       |    ✓    |   ✓    |    ✓     |        |
| `rag_search`              |      ✓       |    ✓    |   ✓    |    ✓     |   🔒   |
| `lsp_search`              |      ✓       |    ✓    |   ✓    |    ✓     |        |
| `git_search`              |      ✓       |    ✓    |   ✓    |    ✓     |        |
| `fetch_web_page`          |      ✓       |    ✓    |   ✓    |    ✓     |        |
| `ask_assistant_agent`     |      ✓       |    ✓    |   ✓    |    ✓     |        |
| **Write group**           |
| `apply_diff`              |    ✓ (md)    |    ✓    |        |    ✓     |        |
| `write_to_file`           |    ✓ (md)    |    ✓    |        |    ✓     |        |
| `insert_edit`             |    ✓ (md)    |    ✓    |        |    ✓     |        |
| `rename_symbol`           |    ✓ (md)    |    ✓    |        |    ✓     |        |
| `create_directory`        |    ✓ (md)    |    ✓    |        |    ✓     |        |
| `create_new_workspace`    |    ✓ (md)    |    ✓    |        |    ✓     |        |
| `sed`                     |    ✓ (md)    |    ✓    |        |    ✓     |        |
| `generate_image`          |    ✓ (md)    |    ✓    |        |    ✓     |   🔒   |
| **Execute group**         |
| `execute_command`         |              |    ✓    |        |    ✓     |        |
| `read_command_output`     |              |    ✓    |        |    ✓     |        |
| `sleep`                   |              |    ✓    |        |    ✓     |        |
| **MCP group**             |
| `use_mcp_tool`            |      ✓       |    ✓    |   ✓    |    ✓     |        |
| `access_mcp_resource`     |      ✓       |    ✓    |   ✓    |    ✓     |   🔒   |
| `call_mcp_tool_async`     |      ✓       |    ✓    |   ✓    |    ✓     |        |
| `check_mcp_call_status`   |      ✓       |    ✓    |   ✓    |    ✓     |        |
| `wait_for_mcp_call`       |      ✓       |    ✓    |   ✓    |    ✓     |        |
| **Always available**      |
| `ask_followup_question`   |      ✓       |    ✓    |   ✓    |    ✓     |   ✓    |
| `attempt_completion`      |      ✓       |    ✓    |   ✓    |    ✓     |   ✓    |
| `switch_mode`             |      ✓       |    ✓    |   ✓    |    ✓     |   ✓    |
| `new_task`                |      ✓       |    ✓    |   ✓    |    ✓     |   ✓    |
| `update_todo_list`        |      ✓       |    ✓    |   ✓    |    ✓     |   ✓    |
| `check_task_status`       |      ✓       |    ✓    |   ✓    |    ✓     |   ✓    |
| `wait_for_task`           |      ✓       |    ✓    |   ✓    |    ✓     |   ✓    |
| `cancel_tasks`            |      ✓       |    ✓    |   ✓    |    ✓     |   ✓    |
| `answer_subtask_question` |      ✓       |    ✓    |   ✓    |    ✓     |   ✓    |
| `list_background_tasks`   |      ✓       |    ✓    |   ✓    |    ✓     |   ✓    |
| `skills`                  |      ✓       |    ✓    |   ✓    |    ✓     |   ✓    |
| `set_task_title`          |      ✓       |    ✓    |   ✓    |    ✓     |   ✓    |
| `give_feedback`           |      ✓       |    ✓    |   ✓    |    ✓     |   ✓    |
| `run_slash_command`       |      ✓       |    ✓    |   ✓    |    ✓     |  ✓ 🔒  |

**Notes:**

- ✓ (md) = Architect mode restricts edit tools to markdown files only (`\.md$`)
- 🔒 = additionally gated by feature flag or external service
