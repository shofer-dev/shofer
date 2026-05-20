# Shofer's Native Tools — What the AI Can Do

This guide explains the built-in tools Shofer uses to read, edit, and search your workspace, execute commands, manage tasks, and interact with external services.

## What are native tools?

Native tools are Shofer's "hands" — the actions it can take in your workspace without external plugins or MCP servers. When you ask Shofer to "find where authentication logic is defined" or "refactor this function," it uses these tools to read files, search code, apply edits, and run commands.

Everything Shofer does — from reading a single line to spawning background sub-tasks — goes through a native tool call. Understanding what's available helps you know what to expect.

## How Shofer chooses tools

Shofer doesn't use every tool in every conversation. Two things control which tools are available:

1. **Your current mode** — Each mode (Code, Architect, Ask, Debug, Orchestrator) allows a different set of tool categories. Code mode has the most access; Ask mode is read-only.
2. **Your auto-approval settings** — You can let Shofer auto-approve certain categories of tools so it doesn't ask permission every time, or keep them gated behind your explicit approval.

See [Tool Categories & Mode Access Control](tool-categories.md) for the full details.

<!-- XXX Screenshot: Chat view with a tool-use card expanded, showing a read_file call with the file path, line range, and the resulting file content displayed in the chat. The tool card should show the "Approved" badge indicating auto-approval was used. -->

## Tool overview by category

### File Operations

Tools for reading, creating, editing, and organizing files.

| Tool               | What it does                                                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `read_file`        | Reads one or more files with line numbers, supports two modes: **slice** (offset/limit) and **indentation** (semantic code blocks) |
| `write_to_file`    | Creates a new file or overwrites an existing one                                                                                   |
| `apply_diff`       | Applies precise search/replace edits to existing files                                                                             |
| `insert_edit`      | Inserts text at a specific line and column                                                                                         |
| `sed`              | Performs regex find-and-replace across a file                                                                                      |
| `file`             | Moves, renames, or deletes files and directories                                                                                   |
| `create_directory` | Creates a new directory (including parent directories)                                                                             |
| `rename_symbol`    | Renames a symbol (function, variable, class) across the entire codebase using the language server                                  |
| `view_image`       | Displays an image file in the chat                                                                                                 |

<!-- XXX Screenshot: Chat view showing a file change card (green/red diff) after Shofer applied an edit. The "Accept" and "Reject" buttons should be visible in the card header. -->

### Search & Discovery

Tools for finding code, exploring the project, and understanding the codebase.

| Tool                     | What it does                                                                           |
| ------------------------ | -------------------------------------------------------------------------------------- |
| `grep_search`            | Regex search across the workspace with configurable context lines                      |
| `find_files`             | Find files by glob pattern (e.g., `**/*.test.ts`)                                      |
| `list_files`             | List directory contents (optionally recursive)                                         |
| `lsp_search`             | Search for symbols (functions, classes, variables) using the language server           |
| `rag_search`             | Semantic search using AI embeddings — finds code by meaning, not exact text            |
| `git_search`             | Semantic search over git commit history to find relevant changes, authors, and context |
| `list_code_usages`       | Find all references to a symbol across the codebase                                    |
| `read_project_structure` | Get a tree view of the workspace directory layout                                      |
| `get_errors`             | Retrieve language server diagnostics (errors and warnings)                             |
| `get_project_setup_info` | Detect languages, frameworks, build systems, and package managers in the project       |
| `get_changed_files`      | List files Shofer has modified in the current task                                     |
| `ask_assistant_agent`    | Ask a background assistant agent that maintains long-term codebase knowledge           |

<!-- XXX Screenshot: Chat view showing a rag_search result card, with the query shown and a list of matching file paths with relevance scores and code snippets displayed below. -->

### Execution & System

Tools for running commands, fetching web content, and interacting with the system.

| Tool                  | What it does                                                                       |
| --------------------- | ---------------------------------------------------------------------------------- |
| `execute_command`     | Run a shell command in a VS Code terminal, with optional timeout                   |
| `read_command_output` | Retrieve output from a previously-run command (supports search, offset, and limit) |
| `fetch_web_page`      | Download and extract text content from web pages                                   |
| `sleep`               | Pause execution for a specified duration                                           |

<!-- XXX Screenshot: Chat view showing an execute_command card expanded, with the command shown and terminal output displayed below. A "Running..." indicator should be visible if captured mid-execution. -->

### Task & Workflow Management

Tools for organizing work across multiple parallel tasks.

| Tool                      | What it does                                                    |
| ------------------------- | --------------------------------------------------------------- |
| `new_task`                | Spawn a new child task (synchronous or background) in any mode  |
| `check_task_status`       | Check progress of a background child task                       |
| `wait_for_task`           | Wait for one or more background tasks to complete               |
| `cancel_tasks`            | Stop running background tasks                                   |
| `answer_subtask_question` | Answer a question a background child asked                      |
| `list_background_tasks`   | List all background tasks spawned by the current task           |
| `set_task_title`          | Set a descriptive title for the current conversation            |
| `give_feedback`           | Send feedback to the Shofer.Dev team                            |
| `attempt_completion`      | Mark the task as complete and present the final result          |
| `update_todo_list`        | Update the checklist tracking progress through the task         |
| `skills`                  | Load and execute a skill — a packaged workflow for common tasks |
| `switch_mode`             | Switch to a different mode mid-task                             |

<!-- XXX Screenshot: TaskSelector sidebar panel showing a parent task with two child tasks indented underneath. The parent should show "waiting" state and one child should show "running" with a title. -->

### <fc:underline>MCP (Model Context Protocol)</fc:underline>

Tools for interacting with external MCP servers. (Requires configured MCP servers.)

| Tool                    | What it does                                                                   |
| ----------------------- | ------------------------------------------------------------------------------ |
| `access_mcp_resource`   | Read a resource (file, API response, system info) from an MCP server           |
| `call_mcp_tool_async`   | Call an MCP server tool without blocking — returns a call ID for later polling |
| `check_mcp_call_status` | Check the status of a pending async MCP call                                   |
| `wait_for_mcp_call`     | Wait for one or more async MCP calls to complete                               |

<!-- XXX Screenshot: Chat view showing an MCP tool result card, with the server name, tool name, and response content visible. The card header should show the MCP server icon. -->

### Other

| Tool                    | What it does                                                          |
| ----------------------- | --------------------------------------------------------------------- |
| `create_new_workspace`  | Create a new workspace/project directory with optional subdirectories |
| `ask_followup_question` | Ask you a clarifying question when it needs more information          |

## Feature-gated tools

Some tools depend on external services or configuration to work:

| Tool                  | Requirement                                              |
| --------------------- | -------------------------------------------------------- |
| `rag_search`          | Codebase index must be configured and built              |
| `git_search`          | Git-index settings must be configured                    |
| `access_mcp_resource` | At least one MCP server must expose resources            |
| `run_slash_command`   | Workspace must have `.shofer/slash-commands/` configured |

If a feature-gated tool doesn't work, check that the corresponding service is enabled in Settings.

## Always-available tools

A small set of tools work in every mode regardless of category restrictions:

`attempt_completion`, `update_todo_list`, `skills`, `set_task_title`, `give_feedback`, `ask_followup_question`

These are the tools Shofer uses to end tasks, track progress, and communicate with you — they're always available because they're essential for every workflow.

## Seeing available tools

<!-- XXX Screenshot: ChatTextArea with the mode selector dropdown expanded, showing the current mode ("💻 Code") and below it a collapsible "Available tools in this mode" section listing tool names grouped by category. -->

The set of tools Shofer can use depends on your current mode. To see exactly which tools are available:

1. Open the mode selector dropdown in the chat input bar
2. Look for the available-tools summary below each mode name
3. Switch modes to see how the tool list changes

Alternatively, consult the [Native Tools Reference](../native_tools.md) for the complete technical reference including every parameter, return value, and the full Mode × Tool Availability Matrix.

## Next steps

- [Tool Categories & Mode Access Control](tool-categories.md) — Control which tools Shofer can use in each mode
- [Native Tools Reference](../native_tools.md) — Complete technical reference with every parameter and mode-matrix
- [Auto-Approval](auto_approval.md) — Let Shofer auto-approve tools so it works without constant interruptions
