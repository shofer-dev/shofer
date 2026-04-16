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

---

## File Operations

| Tool                   | Group | Always Available | Status | Description                                    |
| ---------------------- | ----- | :--------------: | :----: | ---------------------------------------------- |
| `read_file`            | read  |        –         |   ✅   | Read file contents with line range             |
| `write_to_file`        | edit  |        –         |   ✅   | Create or overwrite a file                     |
| `apply_diff`           | edit  |        –         |   ✅   | Apply precise targeted modifications           |
| `create_directory`     | edit  |        –         |   ✅   | Create directory (mkdir -p)                    |
| `insert_edit`          | edit  |        –         |   ✅   | Insert text at a specific line:column position |
| `list_files`           | read  |        –         |   ✅   | List files and directories at a path           |
| `create_new_workspace` | modes |        ✅        |   ✅   | Create new workspace directory structure       |

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

| Tool                 | Group | Always Available | Status | Description                                       |
| -------------------- | ----- | :--------------: | :----: | ------------------------------------------------- |
| `search_files`       | read  |        –         |   ✅   | Regex search across files                         |
| `find_files`         | read  |        –         |   ✅   | Find files by glob pattern                        |
| `get_search_results` | read  |        –         |   ✅   | Text search with VS Code Search panel integration |
| `list_code_usages`   | read  |        –         |   ✅   | Find all symbol references (LSP)                  |
| `codebase_search`    | read  |        –         |   🔒   | Semantic code search (requires code index)        |

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

### `codebase_search`

🔒 Requires code index to be enabled, configured, and initialized.

| Param   | Type   | Required | Description                   |
| ------- | ------ | :------: | ----------------------------- |
| `query` | string |    ✅    | Natural language search query |
| `path`  | string |    –     | Directory scope               |

---

## Code Analysis & Refactoring

| Tool                     | Group | Always Available | Status | Description                                        |
| ------------------------ | ----- | :--------------: | :----: | -------------------------------------------------- |
| `get_errors`             | read  |        –         |   ✅   | Get compile/lint diagnostics                       |
| `get_project_setup_info` | read  |        –         |   ✅   | Detect project languages, frameworks, build system |
| `read_project_structure` | read  |        –         |   ✅   | ASCII tree of workspace structure                  |
| `rename_symbol`          | edit  |        –         |   ✅   | Rename symbol across codebase (LSP)                |
| `view_image`             | read  |        –         |   ✅   | View image file for visual analysis                |

### `get_errors`

Retrieves compile/lint errors and warnings from VS Code's language server diagnostics.

| Param       | Type             | Required | Description                       |
| ----------- | ---------------- | :------: | --------------------------------- |
| `filePaths` | string[] \| null |    ✅    | Files to check (null = all files) |

### `get_project_setup_info`

Analyzes workspace root for config files and detects languages, frameworks, build systems, and package managers.

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

| Tool                  | Group   | Always Available | Status | Description                            |
| --------------------- | ------- | :--------------: | :----: | -------------------------------------- |
| `execute_command`     | command |        –         |   ✅   | Execute a CLI command                  |
| `read_command_output` | command |        –         |   ✅   | Get full output of a truncated command |
| `fetch_web_page`      | modes   |        ✅        |   ✅   | Fetch and extract web page content     |

### `execute_command`

Execute a CLI command in the user's terminal.

| Param     | Type   | Required | Description        |
| --------- | ------ | :------: | ------------------ |
| `command` | string |    ✅    | Command to execute |
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

| Tool                    | Group | Always Available | Status | Description                |
| ----------------------- | ----- | :--------------: | :----: | -------------------------- |
| `ask_followup_question` | –     |        ✅        |   ✅   | Ask the user a question    |
| `attempt_completion`    | –     |        ✅        |   ✅   | Signal task completion     |
| `switch_mode`           | modes |        ✅        |   ✅   | Switch to a different mode |
| `new_task`              | modes |        ✅        |   ✅   | Spawn a new sub-task       |
| `update_todo_list`      | –     |        ✅        |   ✅   | Update the TODO list       |
| `skill`                 | –     |        ✅        |   ✅   | Load and execute a skill   |

---

## MCP (Model Context Protocol)

| Tool                  | Group | Always Available | Status | Description                                     |
| --------------------- | ----- | :--------------: | :----: | ----------------------------------------------- |
| `use_mcp_tool`        | mcp   |        –         |   ✅   | Call an MCP server tool                         |
| `access_mcp_resource` | mcp   |        –         |   🔒   | Access an MCP resource (requires MCP resources) |

---

## Feature-Gated Tools

| Tool                | Group | Always Available | Gate                          | Description         |
| ------------------- | ----- | :--------------: | ----------------------------- | ------------------- |
| `generate_image`    | edit  |        –         | `experiments.imageGeneration` | Generate images     |
| `run_slash_command` | –     |        ✅        | `experiments.runSlashCommand` | Run a slash command |

---

## Legacy/Alias Tools

These are alternative edit tool implementations selectable per-model. They map to canonical tools via `TOOL_ALIASES` or `customTools` in the edit group.

| Tool                 | Canonical    | Status | Description                 |
| -------------------- | ------------ | :----: | --------------------------- |
| `edit`               | (standalone) |   🔧   | Edit files (model-specific) |
| `search_replace`     | (standalone) |   🔧   | Single search-and-replace   |
| `edit_file`          | (standalone) |   🔧   | Edit via search-and-replace |
| `apply_patch`        | (standalone) |   🔧   | Apply unified diff patch    |
| `search_and_replace` | → `edit`     |   🔧   | Alias for `edit`            |

---

## Mode × Tool Availability Matrix

Checkmark (✓) means the tool is available in that mode by default.

| Tool                     | 🏗️ Architect | 💻 Code | ❓ Ask | 🪲 Debug | Always |
| ------------------------ | :----------: | :-----: | :----: | :------: | :----: |
| **Read group**           |
| `read_file`              |      ✓       |    ✓    |   ✓    |    ✓     |        |
| `search_files`           |      ✓       |    ✓    |   ✓    |    ✓     |        |
| `list_files`             |      ✓       |    ✓    |   ✓    |    ✓     |        |
| `find_files`             |      ✓       |    ✓    |   ✓    |    ✓     |        |
| `read_project_structure` |      ✓       |    ✓    |   ✓    |    ✓     |        |
| `view_image`             |      ✓       |    ✓    |   ✓    |    ✓     |        |
| `get_search_results`     |      ✓       |    ✓    |   ✓    |    ✓     |        |
| `list_code_usages`       |      ✓       |    ✓    |   ✓    |    ✓     |        |
| `get_errors`             |      ✓       |    ✓    |   ✓    |    ✓     |        |
| `get_project_setup_info` |      ✓       |    ✓    |   ✓    |    ✓     |        |
| `codebase_search`        |      ✓       |    ✓    |   ✓    |    ✓     |   🔒   |
| **Edit group**           |
| `apply_diff`             |    ✓ (md)    |    ✓    |        |    ✓     |        |
| `write_to_file`          |    ✓ (md)    |    ✓    |        |    ✓     |        |
| `insert_edit`            |    ✓ (md)    |    ✓    |        |    ✓     |        |
| `rename_symbol`          |    ✓ (md)    |    ✓    |        |    ✓     |        |
| `create_directory`       |    ✓ (md)    |    ✓    |        |    ✓     |        |
| `generate_image`         |    ✓ (md)    |    ✓    |        |    ✓     |   🔒   |
| **Command group**        |
| `execute_command`        |              |    ✓    |        |    ✓     |        |
| `read_command_output`    |              |    ✓    |        |    ✓     |        |
| **MCP group**            |
| `use_mcp_tool`           |      ✓       |    ✓    |   ✓    |    ✓     |        |
| `access_mcp_resource`    |      ✓       |    ✓    |   ✓    |    ✓     |   🔒   |
| **Always available**     |
| `ask_followup_question`  |      ✓       |    ✓    |   ✓    |    ✓     |   ✓    |
| `attempt_completion`     |      ✓       |    ✓    |   ✓    |    ✓     |   ✓    |
| `switch_mode`            |      ✓       |    ✓    |   ✓    |    ✓     |   ✓    |
| `new_task`               |      ✓       |    ✓    |   ✓    |    ✓     |   ✓    |
| `update_todo_list`       |      ✓       |    ✓    |   ✓    |    ✓     |   ✓    |
| `skill`                  |      ✓       |    ✓    |   ✓    |    ✓     |   ✓    |
| `run_slash_command`      |      ✓       |    ✓    |   ✓    |    ✓     |  ✓ 🔒  |
| `create_new_workspace`   |      ✓       |    ✓    |   ✓    |    ✓     |   ✓    |
| `fetch_web_page`         |      ✓       |    ✓    |   ✓    |    ✓     |   ✓    |

**Notes:**

- ✓ (md) = Architect mode restricts edit tools to markdown files only (`\.md$`)
- 🔒 = additionally gated by feature flag or external service
