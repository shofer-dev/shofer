# Tool Categories

**Status:** Implemented  
**Last Updated:** 2026-05-04

## Overview

Roo Code uses a single unified ToolGroup system as the **single source of truth** for mode-based filtering, auto-approval classification, and grouping of external language model tools. Every tool — whether native, MCP, or registered by another extension — falls into exactly one category.

## The 9 Categories

| #   | Category        | Purpose                                              | Example tools                                                                                                 |
| --- | --------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 1   | `read`          | Read-only data access                                | `read_file`, `search_files`, `list_files`, `codebase_search`, `vscode_file_read`, `vscode_get_viewport_state` |
| 2   | `write`         | Content mutations — file creation, editing, patching | `apply_diff`, `write_to_file`, `insert_edit`, `rename_symbol`                                                 |
| 3   | `execute`       | System command execution                             | `execute_command`, `read_command_output`, `sleep`, `vscode_panel_open`, `vscode_editor_goto_line`             |
| 4   | `browser`       | Browser automation and web page control              | `browser_navigate`, `browser_click`, `browser_screenshot`, `browser_read_page`                                |
| 5   | `mcp`           | MCP protocol tools                                   | `use_mcp_tool`, `access_mcp_resource`                                                                         |
| 6   | `mode`          | Mode switching and task lifecycle                    | `switch_mode`, `new_task`                                                                                     |
| 7   | `subtasks`      | Background / delegated task management               | `check_task_status`, `wait_for_task`, `list_background_tasks`                                                 |
| 8   | `questions`     | User-facing questions and follow-ups                 | `ask_followup_question`                                                                                       |
| 9   | `uncategorized` | Fallback for tools without explicit classification   | (empty by default; MCP tools without a `group` field land here)                                               |

## Where Each Tool Gets Its Group

### 1. RooCode Native Tools — Declared in Code

Each native tool is assigned to a group in [`TOOL_GROUPS`](../packages/types/src/tool.ts#L141) in `packages/types/src/tool.ts`. This is the canonical source for all built-in tools.

```typescript
export const TOOL_GROUPS: Record<ToolGroup, ToolGroupConfig> = {
    read:        { tools: ["read_file", "search_files", ...] },
    write:       { tools: ["apply_diff", "write_to_file", ...], customTools: [...] },
    execute:     { tools: ["execute_command", "read_command_output", "sleep"] },
    browser:     { tools: [] },  // external LM tools from browser-tools
    mcp:         { tools: ["use_mcp_tool", "access_mcp_resource"] },
    mode:        { tools: ["switch_mode", "new_task"], alwaysAvailable: true },
    subtasks:    { tools: ["check_task_status", "wait_for_task", "list_background_tasks"] },
    questions:   { tools: ["ask_followup_question"] },
    uncategorized: { tools: [] },
}
```

### 2. External LM Tools — Declared by the Extension That Registers Them

Extensions that register language model tools via `vscode.lm.registerTool()` declare each tool's group in their **VS Code configuration** under a `toolGroups` property. Roo Code reads this configuration at runtime via `resolveExternalLmToolGroup()` in [`build-tools.ts`](../src/core/task/build-tools.ts).

| Extension               | Config namespace                  | Tool prefix |
| ----------------------- | --------------------------------- | ----------- |
| `arkware-vscode-tools`  | `arkware.vscodeTools.toolGroups`  | `vscode_`   |
| `arkware-browser-tools` | `arkware.browserTools.toolGroups` | `browser_`  |

**Example — vscode-tools** (`extensions/vscode-tools/package.json`):

```json
"arkware.vscodeTools.toolGroups": {
    "vscode_file_read": "read",
    "vscode_file_open": "execute",
    "vscode_panel_focus": "execute",
    "vscode_get_viewport_state": "read"
}
```

**Example — browser-tools** (`extensions/browser-tools/package.json`):

```json
"arkware.browserTools.toolGroups": {
    "browser_navigate": "browser",
    "browser_click": "browser",
    "browser_screenshot": "browser",
    ...
}
```

### 3. MCP Tools — Server Declaration + User Override

MCP tools are classified via a three-tier priority system (highest first):

1. **User Configuration** — `toolGroups` map in `mcp.json`
2. **Server Declaration** — `group` field in the server's tool definition
3. **Default Fallback** — `uncategorized`

**Server-side declaration:**

```json
{
  "tools": [
    { "name": "get_pull_request", "description": "...", "inputSchema": {...}, "group": "read" },
    { "name": "create_issue", "description": "...", "inputSchema": {...}, "group": "write" },
    { "name": "run_workflow", "description": "...", "inputSchema": {...}, "group": "execute" }
  ]
}
```

**User-side override** (`~/.roo/mcp.json` or `.roo/mcp.json`):

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

## Mode-Based Filtering

When a mode requests tools, each tool's group is checked against the mode's allowed groups. The `mcp` group itself is a **gateway** — the `use_mcp_tool` and `access_mcp_resource` gateway tools live in the `mcp` group, but individual MCP tools use their own assigned groups. This means a mode with `groups: ["read", "mcp"]` gets `use_mcp_tool` + all MCP tools classified as `read`.

| Default mode | Allowed groups                      |
| ------------ | ----------------------------------- |
| architect    | `read`, `write` (`.md` only), `mcp` |
| code         | `read`, `write`, `execute`, `mcp`   |
| ask          | `read`, `mcp`                       |
| debug        | `read`, `write`, `execute`, `mcp`   |
| orchestrator | (empty — delegates via `new_task`)  |

### Always-available tools

These tools bypass mode filtering entirely:

`attempt_completion`, `update_todo_list`, `run_slash_command`, `skill`, `set_task_title`

## Backward Compatibility

### Renamed groups

Old group names in user config files are automatically remapped:

| Old name  | New name  |
| --------- | --------- |
| `edit`    | `write`   |
| `command` | `execute` |
| `modes`   | `mode`    |

The `browser` group was previously deprecated and stripped from configs; it is now a valid first-class group.

### MCP tools without group

Tools without an explicit `group` field continue to work — they default to `uncategorized` and are subject to each mode's `uncategorized` inclusion.

## Adding a New Extension's Tools

1. Add the extension's config namespace to [`resolveExternalLmToolGroup()`](../src/core/task/build-tools.ts) in `build-tools.ts`
2. Add a `toolGroups` configuration contribution in the extension's [`package.json`] mapping each tool name to its group
3. Ensure the group exists in the [`toolGroups` enum](../packages/types/src/tool.ts)

## References

- [ToolGroup Type Definitions](../packages/types/src/tool.ts)
- [Mode Configuration](../packages/types/src/mode.ts)
- [External Tool Resolution](../src/core/task/build-tools.ts)
- [MCP Hub — Tool Metadata](../src/services/mcp/McpHub.ts)
