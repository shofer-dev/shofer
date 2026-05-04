# Roo-Code Native Tools Reference

Complete reference for all native tools available in Roo-Code, their mode availability, and current status.

## Mode Availability

| Mode            | Groups                           | Description                  |
| --------------- | -------------------------------- | ---------------------------- |
| 🏗️ Architect    | `read`, `edit` (md only), `mcp`  | Plan and design              |
| 💻 Code         | `read`, `edit`, `command`, `mcp` | Write and modify code        |
| ❓ Ask          | `read`, `mcp`                    | Get answers and explanations |
| 🪲 Debug        | `read`, `edit`, `command`, `mcp` | Diagnose and fix issues      |
| 🪃 Orchestrator | varies                           | Delegates to other modes     |

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
| 🔵 RC | Pre-existing RooCode tool                               |
| 🟣 AW | New Arkware tool (custom addition)                      |

---

## File Operations

| Tool                   | Origin | Group | Always Available | Status | Description                                    |
| ---------------------- | :----: | ----- | :--------------: | :----: | ---------------------------------------------- |
| `read_file`            | 🔵 RC  | read  |        –         |   ✅   | Read file contents with line range             |
| `write_to_file`        | 🔵 RC  | write |        –         |   ✅   | Create or overwrite a file                     |
| `apply_diff`           | 🔵 RC  | write |        –         |   ✅   | Apply precise targeted modifications           |
| `create_directory`     | 🆕 WS  | write |        –         |   ✅   | Create directory (mkdir -p)                    |
| `insert_edit`          | 🆕 WS  | write |        –         |   ✅   | Insert text at a specific line:column position |
| `list_files`           | 🔵 RC  | read  |        –         |   ✅   | List files and directories at a path           |
| `create_new_workspace` | 🆕 WS  | write |        –         |   ✅   | Create new workspace directory structure       |

### `read_file`

Read a file's contents, optionally restricted to a line range.

| Param        | Type   | Required | Description                     |
| ------------ | ------ | :------: | ------------------------------- |
| `path`       | string |    ✅    | File path relative to workspace |
| `start_line` | number |    –     | 1-based start line              |
| `end_line`   | number |    –     | 1-based end line                |

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

### `insert_edit`

Inserts text at a specific position in a file using VS Code's WorkspaceEdit API.

| Param      | Type   | Required | Description                     |
| ---------- | ------ | :------: | ------------------------------- |
| `filePath` | string |    ✅    | File path relative to workspace |
| `line`     | number |    ✅    | 1-based line number             |
| `column`   | number |    ✅    | 1-based column number           |
| `text`     | string |    ✅    | Text to insert                  |

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

| Tool                       | Origin | Group | Always Available | Status | Description                                       |
| -------------------------- | :----: | ----- | :--------------: | :----: | ------------------------------------------------- |
| `search_files`             | 🔵 RC  | read  |        –         |   ✅   | Regex search across files                         |
| `find_files`               | 🆕 WS  | read  |        –         |   ✅   | Find files by glob pattern                        |
| `get_search_results`       | 🆕 WS  | read  |        –         |   ✅   | Text search with VS Code Search panel integration |
| `list_code_usages`         | 🆕 WS  | read  |        –         |   ✅   | Find all symbol references (LSP)                  |
| `codebase_search`          | 🔵 RC  | read  |        –         |   🔒   | Semantic code search (requires code index)        |
| `codebase_search_with_lsp` | 🆕 WS  | read  |        –         |   ✅   | Symbol search via LSP + text fallback             |

### `search_files`

Perform regex search across files in the workspace.

| Param          | Type   | Required | Description                |
| -------------- | ------ | :------: | -------------------------- |
| `path`         | string |    ✅    | Directory to search in     |
| `regex`        | string |    ✅    | Regular expression pattern |
| `file_pattern` | string |    –     | Glob to filter files       |

### `find_files`

Find files matching a glob pattern using VS Code's `workspace.findFiles`.

| Param        | Type   | Required | Description                    |
| ------------ | ------ | :------: | ------------------------------ |
| `pattern`    | string |    ✅    | Glob pattern (e.g., `**/*.ts`) |
| `maxResults` | number |    –     | Max results (default: 100)     |

### `get_search_results`

Text search with VS Code Search panel integration and fallback to manual scan.

| Param            | Type            | Required | Description                     |
| ---------------- | --------------- | :------: | ------------------------------- |
| `query`          | string          |    ✅    | Search query text               |
| `isRegex`        | boolean \| null |    ✅    | Treat as regex (default: false) |
| `includePattern` | string \| null  |    ✅    | Glob to limit files searched    |
| `maxResults`     | number \| null  |    ✅    | Max results (default: 100)      |

### `list_code_usages`

Finds all references of a symbol using VS Code's LSP reference provider.

| Param      | Type   | Required | Description                |
| ---------- | ------ | :------: | -------------------------- |
| `filePath` | string |    ✅    | File containing the symbol |
| `line`     | number |    ✅    | 1-based line number        |
| `column`   | number |    ✅    | 1-based column number      |

### `codebase_search_with_lsp`

Searches the codebase using the LSP workspace symbol provider. Falls back to word-level text search when no language server is available. Requires no external infrastructure.

| Param        | Type           | Required | Description                         |
| ------------ | -------------- | :------: | ----------------------------------- |
| `query`      | string         |    ✅    | Symbol name or text to search for   |
| `maxResults` | number \| null |    ✅    | Max results to return (default: 20) |

### `codebase_search`

🔒 Requires code index to be enabled, configured, and initialized.

| Param   | Type   | Required | Description                   |
| ------- | ------ | :------: | ----------------------------- |
| `query` | string |    ✅    | Natural language search query |
| `path`  | string |    –     | Directory scope               |

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

Returns the files changed during the current task. Reports two **independent** sources in a single response so the model can detect conflicts between cumulative state and recent activity:

- **Cumulative changes since task start** — shadow git checkpoint diff (`git diff --numstat` against the task's base commit). Lists every modified file with insertions/deletions and binary detection, regardless of which actor (Roo, the user, or external tools) made the change.
- **Files Roo edited in this session** — entries from `FileContextTracker` with source `roo_edited` or `user_edited`. Available even when checkpoints are disabled. Files present here but missing from the cumulative diff are annotated `(not in checkpoint diff)` — typically indicating a Roo edit that was undone, externally reverted, or not yet committed to the shadow repo.

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
| `fetch_web_page`      | 🆕 WS  | read    |        –         |   ✅   | Fetch and extract web page content     |

### `execute_command`

Execute a CLI command in the user's terminal.

| Param     | Type   | Required | Description        |
| --------- | ------ | :------: | ------------------ |
| `execute` | string |    ✅    | Command to execute |
| `cwd`     | string |    –     | Working directory  |

### `read_command_output`

Retrieve the full output from a previously truncated command execution.

| Param         | Type   | Required | Description                                |
| ------------- | ------ | :------: | ------------------------------------------ |
| `artifact_id` | string |    ✅    | The artifact ID from the truncated command |

### `fetch_web_page`

Fetches web pages, strips HTML, and returns extracted text content. Supports query-based filtering.

| Param   | Type           | Required | Description                        |
| ------- | -------------- | :------: | ---------------------------------- |
| `urls`  | string[]       |    ✅    | URLs to fetch                      |
| `query` | string \| null |    ✅    | Filter query for extracted content |

---

## Task & Workflow Management

| Tool                    | Origin | Group | Always Available | Status | Description                                                 |
| ----------------------- | :----: | ----- | :--------------: | :----: | ----------------------------------------------------------- |
| `ask_followup_question` | 🔵 RC  | –     |        ✅        |   ✅   | Ask the user a question                                     |
| `attempt_completion`    | 🔵 RC  | –     |        ✅        |   ✅   | Signal task completion                                      |
| `switch_mode`           | 🔵 RC  | mode  |        ✅        |   ✅   | Switch to a different mode                                  |
| `new_task`              | 🔵 RC  | mode  |        ✅        |   ✅   | Spawn a sub-task (sync or background)                       |
| `check_task_status`     | 🟣 AW  | –     |        ✅        |   ✅   | Check status/result of a background child task              |
| `wait_for_task`         | 🟣 AW  | –     |        ✅        |   ✅   | Block until one or more background tasks complete (all/any) |
| `list_background_tasks` | 🟣 AW  | –     |        ✅        |   ✅   | List all background child tasks started by this task        |
| `update_todo_list`      | 🔵 RC  | –     |        ✅        |   ✅   | Update the TODO list                                        |
| `skill`                 | 🔵 RC  | –     |        ✅        |   ✅   | Load and execute a skill                                    |
| `set_task_title`        | 🟣 AW  | –     |        ✅        |   ✅   | Set descriptive title for the task                          |

### `new_task`

Create a new task instance in the chosen mode. Supports two execution models:

- **Synchronous (default):** The parent blocks until the child completes. Must be called alone — no other tools in the same turn.
- **Background (`is_background=true`):** The child starts immediately and runs concurrently. The parent receives the child's `task_id` and continues without blocking. Use `check_task_status` or `wait_for_task` to retrieve results later.

| Param           | Type    | Required | Description                                                          |
| --------------- | ------- | :------: | -------------------------------------------------------------------- |
| `mode`          | string  |    ✅    | Mode slug (e.g., `code`, `debug`)                                    |
| `message`       | string  |    ✅    | Initial instructions for the child task                              |
| `todos`         | string  |    –     | Initial markdown checklist for the child                             |
| `is_background` | boolean |    –     | When `true`, run child concurrently and return `task_id` immediately |

### `check_task_status`

Check the current status of a background child task started with `new_task` using `is_background=true`. Returns the task's status and, if it has completed or errored, its result or error message.

| Param     | Type   | Required | Description                                           |
| --------- | ------ | :------: | ----------------------------------------------------- |
| `task_id` | string |    ✅    | The task ID returned when the background task started |

### `wait_for_task`

Block until one or more background child tasks (started with `is_background=true`) reach a terminal state, then return their results. Event-driven — does not poll. Supports `wait=all` (default) to wait for every listed task, or `wait=any` to return as soon as the first one completes.

| Param      | Type               | Required | Description                                                                  |
| ---------- | ------------------ | :------: | ---------------------------------------------------------------------------- |
| `task_ids` | string[]           |    ✅    | One or more task IDs returned when the background tasks were started         |
| `wait`     | `"all"` \| `"any"` |    –     | `"all"` (default) — wait for all tasks; `"any"` — return on first completion |
| `timeout`  | number             |    –     | Max seconds to wait (default: 120). Returns current statuses if exceeded.    |

Returns: the completed task IDs plus per-task status and result/error text.

### `list_background_tasks`

List all background child tasks started by this task via `new_task` with `is_background=true`. Returns each task's ID, current status, and creation timestamp.

**Parameters:** None.

### `set_task_title`

Sets a short, descriptive title for the current task/conversation. Use this early in a conversation to replace the auto-generated title with something meaningful.

| Param   | Type   | Required | Description                            |
| ------- | ------ | :------: | -------------------------------------- |
| `title` | string |    ✅    | Short descriptive title (max 60 chars) |

No approval prompt needed — this is a non-destructive meta-operation.

---

## MCP (Model Context Protocol)

| Tool                  | Origin | Group | Always Available | Status | Description                                     |
| --------------------- | :----: | ----- | :--------------: | :----: | ----------------------------------------------- |
| `use_mcp_tool`        | 🔵 RC  | mcp   |        –         |   ✅   | Call an MCP server tool                         |
| `access_mcp_resource` | 🔵 RC  | mcp   |        –         |   🔒   | Access an MCP resource (requires MCP resources) |

---

## Feature-Gated Tools

| Tool                | Origin | Group | Always Available | Gate                          | Description         |
| ------------------- | :----: | ----- | :--------------: | ----------------------------- | ------------------- |
| `generate_image`    | 🔵 RC  | write |        –         | `experiments.imageGeneration` | Generate images     |
| `run_slash_command` | 🔵 RC  | –     |        ✅        | `experiments.runSlashCommand` | Run a slash command |

---

## Legacy/Alias Tools

These are alternative edit tool implementations selectable per-model. They map to canonical tools via `TOOL_ALIASES` or `customTools` in the edit group. All are pre-existing RooCode tools (🔵 RC).

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

| Tool                       | 🏗️ Architect | 💻 Code | ❓ Ask | 🪲 Debug | Always |
| -------------------------- | :----------: | :-----: | :----: | :------: | :----: |
| **Read group**             |
| `read_file`                |      ✓       |    ✓    |   ✓    |    ✓     |        |
| `search_files`             |      ✓       |    ✓    |   ✓    |    ✓     |        |
| `list_files`               |      ✓       |    ✓    |   ✓    |    ✓     |        |
| `find_files`               |      ✓       |    ✓    |   ✓    |    ✓     |        |
| `read_project_structure`   |      ✓       |    ✓    |   ✓    |    ✓     |        |
| `view_image`               |      ✓       |    ✓    |   ✓    |    ✓     |        |
| `get_search_results`       |      ✓       |    ✓    |   ✓    |    ✓     |        |
| `list_code_usages`         |      ✓       |    ✓    |   ✓    |    ✓     |        |
| `get_errors`               |      ✓       |    ✓    |   ✓    |    ✓     |        |
| `get_project_setup_info`   |      ✓       |    ✓    |   ✓    |    ✓     |        |
| `get_changed_files`        |      ✓       |    ✓    |   ✓    |    ✓     |        |
| `codebase_search`          |      ✓       |    ✓    |   ✓    |    ✓     |   🔒   |
| `codebase_search_with_lsp` |      ✓       |    ✓    |   ✓    |    ✓     |        |
| `fetch_web_page`           |      ✓       |    ✓    |   ✓    |    ✓     |        |
| **Write group**            |
| `apply_diff`               |    ✓ (md)    |    ✓    |        |    ✓     |        |
| `write_to_file`            |    ✓ (md)    |    ✓    |        |    ✓     |        |
| `insert_edit`              |    ✓ (md)    |    ✓    |        |    ✓     |        |
| `rename_symbol`            |    ✓ (md)    |    ✓    |        |    ✓     |        |
| `create_directory`         |    ✓ (md)    |    ✓    |        |    ✓     |        |
| `create_new_workspace`     |    ✓ (md)    |    ✓    |        |    ✓     |        |
| `generate_image`           |    ✓ (md)    |    ✓    |        |    ✓     |   🔒   |
| **Execute group**          |
| `execute_command`          |              |    ✓    |        |    ✓     |        |
| `read_command_output`      |              |    ✓    |        |    ✓     |        |
| **MCP group**              |
| `use_mcp_tool`             |      ✓       |    ✓    |   ✓    |    ✓     |        |
| `access_mcp_resource`      |      ✓       |    ✓    |   ✓    |    ✓     |   🔒   |
| **Always available**       |
| `ask_followup_question`    |      ✓       |    ✓    |   ✓    |    ✓     |   ✓    |
| `attempt_completion`       |      ✓       |    ✓    |   ✓    |    ✓     |   ✓    |
| `switch_mode`              |      ✓       |    ✓    |   ✓    |    ✓     |   ✓    |
| `new_task`                 |      ✓       |    ✓    |   ✓    |    ✓     |   ✓    |
| `update_todo_list`         |      ✓       |    ✓    |   ✓    |    ✓     |   ✓    |
| `check_task_status`        |      ✓       |    ✓    |   ✓    |    ✓     |   ✓    |
| `wait_for_task`            |      ✓       |    ✓    |   ✓    |    ✓     |   ✓    |
| `list_background_tasks`    |      ✓       |    ✓    |   ✓    |    ✓     |   ✓    |
| `skill`                    |      ✓       |    ✓    |   ✓    |    ✓     |   ✓    |
| `set_task_title`           |      ✓       |    ✓    |   ✓    |    ✓     |   ✓    |
| `run_slash_command`        |      ✓       |    ✓    |   ✓    |    ✓     |  ✓ 🔒  |

**Notes:**

- ✓ (md) = Architect mode restricts edit tools to markdown files only (`\.md$`)
- 🔒 = additionally gated by feature flag or external service
