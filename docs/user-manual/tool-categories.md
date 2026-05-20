# Tool Categories & Mode Access Control

This guide explains how Shofer's tool categories control which tools are available in each mode and how you can configure them.

## What are tool categories?

Every tool Shofer can use belongs to exactly one **category** (also called a **ToolGroup**). These categories determine two things:

1. **Which modes can use the tool** — each mode declares which categories it allows.
2. **Which auto-approval toggle controls the tool** — you can let Shofer auto-approve tools from specific categories without asking you each time.

There are 9 categories:

| Category        | What it controls                                       | Example tools                                             |
| --------------- | ------------------------------------------------------ | --------------------------------------------------------- |
| `read`          | Reading files, searching code, inspecting your project | `read_file`, `grep_search`, `rag_search`                  |
| `write`         | Creating and editing files                             | `apply_diff`, `write_to_file`, `insert_edit`              |
| `execute`       | Running terminal commands                              | `execute_command`, `sleep`                                |
| `browser`       | Controlling a web browser                              | `browser_navigate`, `browser_click`, `browser_screenshot` |
| `mcp`           | Talking to external MCP servers                        | `use_mcp_tool`, `access_mcp_resource`                     |
| `mode`          | Switching modes and managing tasks                     | `switch_mode`                                             |
| `subtasks`      | Delegating work to background tasks                    | `new_task`, `check_task_status`                           |
| `questions`     | Asking you questions                                   | `ask_followup_question`                                   |
| `uncategorized` | Catch-all for tools without a declared category        | (typically empty)                                         |

## How categories affect mode availability

Each mode declares which categories it allows. Here's what the built-in modes include:

<!-- XXX Screenshot: ModeSelector dropdown in the ChatTextArea, showing the mode picker with "Code" selected. The dropdown should be expanded showing all available modes. -->

| Default mode        | Categories available                                                                |
| ------------------- | ----------------------------------------------------------------------------------- |
| 💻 **Code**         | `read`, `write`, `execute`, `mcp`, `mode`, `subtasks`, `questions`, `uncategorized` |
| 🏗️ **Architect**    | `read`, `write` (.md files only), `mcp`, `questions`                                |
| ❓ **Ask**          | `read`, `mcp`                                                                       |
| 🪲 **Debug**        | `read`, `write`, `execute`, `mcp`, `subtasks`, `questions`, `uncategorized`         |
| 🪃 **Orchestrator** | (none — delegates work via `new_task`)                                              |

> **Key point:** The Code and Debug modes have the broadest tool access. Architect mode can read code and write markdown plans but can't run commands or edit source files. Ask mode is read-only plus MCP tools.

### Always-available tools

A small set of tools are available in **every** mode, regardless of category membership:

`attempt_completion`, `update_todo_list`, `run_slash_command`, `skills`, `set_task_title`, `give_feedback`

## How categories affect auto-approval

<!-- XXX Screenshot: AutoApproveDropdown expanded in the ChatTextArea, showing the toggle switches for: Read, Write, Execute, Browser, MCP, Mode, Subtasks, and Questions. Each toggle should be labeled with its category name. -->

Each category maps to an auto-approval toggle in the **AutoApproveDropdown** (the shield icon in the chat input bar):

| Toggle        | Category    | Description                                             |
| ------------- | ----------- | ------------------------------------------------------- |
| **Read**      | `read`      | Auto-approve file reads, searches, and code inspections |
| **Write**     | `write`     | Auto-approve file creation and edits                    |
| **Execute**   | `execute`   | Auto-approve terminal command execution                 |
| **Browser**   | `browser`   | Auto-approve browser automation                         |
| **MCP**       | `mcp`       | Auto-approve MCP tool calls                             |
| **Mode**      | `mode`      | Auto-approve mode switching                             |
| **Subtasks**  | `subtasks`  | Auto-approve spawning and managing background tasks     |
| **Questions** | `questions` | Auto-approve or auto-timeout follow-up questions        |

Toggle a category ON and Shofer will use those tools without asking you. Toggle it OFF and you'll be prompted to approve each use.

See [Auto-Approval](auto_approval.md) for the full auto-approval system reference.

## Configuring custom modes

When you define a custom mode in a `.shofermodes` file, you control which categories (and specific tools) the mode can use:

<!-- XXX Screenshot: SettingsView showing the Custom Modes section where a user is defining a new mode. The "Groups" field should be visible with category checkboxes. -->

```json
{
	"customModes": [
		{
			"slug": "reviewer",
			"name": "👀 Reviewer",
			"roleDefinition": "You are a code reviewer...",
			"groups": ["read"],
			"tools_allowed": ["ask_followup_question"],
			"tools_denied": ["execute_command"]
		}
	]
}
```

- **`groups`** — list of categories. The mode gets ALL tools from those categories.
- **`tools_allowed`** — additional individual tools to add, even if their category is not in `groups`.
- **`tools_denied`** — individual tools to remove, even if their category IS in `groups`.

You can also scope a category to specific file types (e.g., Architect's `write` is restricted to `.md` files):

```json
"groups": ["read", ["write", { "fileRegex": "\\.md$", "description": "Markdown files only" }], "mcp"]
```

For more details, see [Tool Access Control](tool_access.md).

## Assigning categories to MCP tools

When you add an MCP server in `mcp.json`, you can assign each tool to a category:

```json
{
	"mcpServers": {
		"github": {
			"command": "npx",
			"args": ["-y", "@modelcontextprotocol/server-github"],
			"toolGroups": {
				"get_pull_request": "read",
				"create_issue": "write",
				"merge_pull_request": "execute"
			}
		}
	}
}
```

This controls both mode availability and auto-approval behavior for each MCP tool.

If you don't assign a category, the tool defaults to `uncategorized` — which means it's only available in modes that explicitly include the `uncategorized` group (Code and Debug, by default).

## Quick reference

- **Want Shofer to edit files without asking?** → Enable the **Write** toggle in AutoApproveDropdown.
- **Want to limit Architect mode to reading only?** → It already is! Architect only has `read` + `write` for `.md`.
- **Added an MCP server but its tools don't appear?** → Check that your current mode includes the category you assigned (or `uncategorized`).
- **Creating a custom mode?** → Start with `groups: ["read", "mcp"]` for a safe read-only mode, then add categories as needed.
