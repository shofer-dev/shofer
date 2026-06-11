# Tool Categories

**Status:** Implemented  
**Last Updated:** 2026-05-04

## Overview

Shofer uses a single unified ToolGroup system as the **single source of truth** for mode-based filtering, auto-approval classification, and grouping of external language model tools. Every tool — whether native, MCP, or registered by another extension — falls into exactly one category.

## The 9 Categories

| #   | Category        | Purpose                                              | Example tools                                                                                     |
| --- | --------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1   | `read`          | Read-only data access                                | `read_file`, `grep_search`, `list_files`, `rag_search`, `ide_file_read`, `ide_get_viewport_state` |
| 2   | `write`         | Content mutations — file creation, editing, patching | `apply_diff`, `write_to_file`, `insert_edit`, `rename_symbol`                                     |
| 3   | `execute`       | System command execution                             | `execute_command`, `read_command_output`, `sleep`, `ide_panel_open`, `ide_editor_goto_line`       |
| 4   | `browser`       | Browser automation and web page control              | `browser_navigate`, `browser_click`, `browser_screenshot`, `browser_read_page`                    |
| 5   | `mcp`           | MCP protocol tools                                   | `use_mcp_tool`, `access_mcp_resource`                                                             |
| 6   | `mode`          | Mode switching                                       | `switch_mode`                                                                                     |
| 7   | `subtasks`      | Background / delegated task management               | `check_task_status`, `wait_for_task`, `cancel_tasks`, `answer_subtask_question`                   |
| 8   | `questions`     | User-facing questions and follow-ups                 | `ask_followup_question`                                                                           |
| 9   | `uncategorized` | Fallback for tools without explicit classification   | (empty by default; MCP tools without a `group` field land here)                                   |

## Where Each Tool Gets Its Group

### 1. Shofer Native Tools — Declared in Code

Each native tool is assigned to a group in [`TOOL_GROUPS`](../packages/types/src/tool.ts#L141) in `packages/types/src/tool.ts`. This is the canonical source for all built-in tools.

```typescript
export const TOOL_GROUPS: Record<ToolGroup, ToolGroupConfig> = {
    read:        { tools: ["read_file", "grep_search", ...] },
    write:       { tools: ["apply_diff", "write_to_file", ...], customTools: [...] },
    execute:     { tools: ["execute_command", "read_command_output", "sleep"] },
    browser:     { tools: [] },  // external LM tools from browser-tools
    mcp:         { tools: ["use_mcp_tool", "access_mcp_resource", "call_mcp_tool_async", "check_mcp_call_status", "wait_for_mcp_call"] },
    mode:        { tools: ["switch_mode"] },
    subtasks:    { tools: ["new_task", "check_task_status", "wait_for_task", "cancel_tasks", "answer_subtask_question"] },
    questions:   { tools: ["ask_followup_question"] },
    uncategorized: { tools: [] },
}
```

### 2. External LM Tools — Declared by the Extension That Registers Them

Extensions that register language model tools via `vscode.lm.registerTool()` declare each tool's group in their **VS Code configuration** under a `toolGroups` property. Shofer reads this configuration at runtime via [`filterPrivateToolsForMode`](../src/core/prompts/tools/filter-tools-for-mode.ts) in `filter-tools-for-mode.ts`.

| Extension               | Config namespace                  | Tool prefix |
| ----------------------- | --------------------------------- | ----------- |
| `arkware-vscode-tools`  | `arkware.vscodeTools.toolGroups`  | `ide_`      |
| `arkware-browser-tools` | (MCP server — inferred by prefix) | `browser_`  |

**Example — vscode-tools** (`extensions/vscode-tools/package.json`):

```json
"arkware.vscodeTools.toolGroups": {
    "ide_file_read": "read",
    "ide_file_open": "execute",
    "ide_panel_focus": "execute",
    "ide_get_viewport_state": "read"
}
```

Browser tools (`browser_*`) are registered as an MCP server (not via a `toolGroups` config). Their group is inferred by the `browser_` prefix in [`getToolGroupForSayTool()`](../src/core/auto-approval/tools.ts), which maps `browser_*` → `"browser"` and `ide_*` → `"execute"` as a fallback.

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

**User-side override** (`~/.shofer/mcp.json` or `.shofer/mcp.json`):

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

| Default mode | Allowed groups                                                                      |
| ------------ | ----------------------------------------------------------------------------------- |
| architect    | `read`, `write` (`.md` only), `mcp`, `subtasks`, `questions`                        |
| code         | `read`, `write`, `execute`, `mcp`, `mode`, `subtasks`, `questions`, `uncategorized` |
| ask          | `read`, `mcp`                                                                       |
| debug        | `read`, `write`, `execute`, `mcp`, `subtasks`, `questions`, `uncategorized`         |
| reviewer     | `read`, `execute`, `mcp`, `subtasks`, `questions`                                   |
| orchestrator | (empty — delegates via `new_task`)                                                  |

### Always-available tools

These tools bypass mode filtering entirely, defined in the [`ALWAYS_AVAILABLE_TOOLS`](../packages/types/src/tool.ts) constant:

`attempt_completion`, `update_todo_list`, `run_slash_command`, `skills`, `set_task_title`, `give_feedback`, `list_background_tasks`, `send_message_to_task`

### MCP tools without group

Tools without an explicit `group` field continue to work — they default to `uncategorized` and are subject to each mode's `uncategorized` inclusion.

## Adding a New Extension's Tools

1. Add a `toolGroups` configuration contribution in the extension's `package.json` mapping each tool name to its group (see `arkware.vscodeTools.toolGroups` for the existing pattern)
2. Ensure the group exists as a valid [`ToolGroup`](../packages/types/src/tool.ts) value
3. For prefix-based automatic classification (used by browser tools), the `browser_` prefix maps to `"browser"` and `ide_` prefix maps to `"execute"` in [`getToolGroupForSayTool()`](../src/core/auto-approval/tools.ts)

## Gaps, Issues & Areas for Improvement

This section tracks known deficiencies in this document and in the tool-group system itself, discovered during verification against source.

### Document structure gaps

- **No coverage of `TOOL_ALIASES`**: The [`TOOL_ALIASES`](../packages/types/src/tool.ts) constant maps deprecated tool names to canonical ones (e.g., `write_file` → `write_to_file`, `search_and_replace` → `edit`). This document does not explain how aliases interact with tool groups — aliased tools inherit the group of their canonical form.
- **No coverage of `customTools`**: The `write` group has a `customTools` array (`["edit", "search_replace", "edit_file", "apply_patch"]`). These are legacy/alias edit tools that receive special handling in the parser. The document does not explain what `customTools` means or how they differ from regular `tools`.
- **No coverage of `filterPrivateToolsForMode`**: The document mentions `filterNativeToolsForMode` and `filterMcpToolsForMode` (implicitly), but the third filter — `filterPrivateToolsForMode` (for extension-registered private tools like `ide_*`) — is not discussed. All three filters live in [`filter-tools-for-mode.ts`](../src/core/prompts/tools/filter-tools-for-mode.ts).
- **No discussion of how `uncategorized` actually gates access**: The `uncategorized` group is listed as a fallback, but the document does not explain that a mode must explicitly include `"uncategorized"` in its `groups` array for uncategorized tools to be available. Currently only `code` and `debug` include it; `architect`, `ask`, and `orchestrator` do not.
- **Missing external-tool group resolution detail**: External LM tools (`ide_*` from `arkware-vscode-tools`) get their groups from `arkware.vscodeTools.toolGroups` in `package.json`, processed by `filterPrivateToolsForMode`. For auto-approval, `getToolGroupForSayTool()` in [`auto-approval/tools.ts`](../src/core/auto-approval/tools.ts) falls back to prefix-based inference (`ide_*` → `"execute"`, `browser_*` → `"browser"`). These two resolution paths are not documented on the same page.

### Source-of-truth risks

- **Fragile `#L141` line anchor**: The link to [`TOOL_GROUPS`](../packages/types/src/tool.ts#L141) points to line 141, but the constant is at line 175. Line-number anchors in documentation are inherently fragile. Consider linking to the symbol name only.
- **No version pin in the doc**: The doc says "Last Updated: 2026-05-04" but has no version number that can be correlated with the extension version that last changed `TOOL_GROUPS` or `DEFAULT_MODES`. Consider adding a `Version` field that matches the extension version at the time of last verification.

### Tool-group system design observations

- **`alwaysAvailable` is not a group-level property**: The old doc erroneously showed `alwaysAvailable: true` as a field on the `mode` group entry in `TOOL_GROUPS`. In reality, `ToolGroupConfig` has only `tools` and `customTools`; always-availability is a separate constant `ALWAYS_AVAILABLE_TOOLS` that is checked independently of groups.
- **`new_task` lives in `subtasks`, not `mode`**: Although `new_task` is about task lifecycle, it belongs to the `subtasks` group (alongside `check_task_status`, `wait_for_task`, etc.), not the `mode` group (which contains only `switch_mode`). The `subtasks` group is the correct home because `new_task` is a control-plane subtask tool that shares the `alwaysAllowSubtasks` auto-approval toggle.
- **`give_feedback` is always-available but not in any group**: [`give_feedback`](../packages/types/src/tool.ts) is in `ALWAYS_AVAILABLE_TOOLS` but does not appear in any `TOOL_GROUPS` entry. This is intentional — always-available tools are injected into every mode's tool set regardless of group membership.
- **browser group has zero native tools**: The `browser` group contains `tools: []` — all browser tools come from the `arkware-browser-tools` MCP server, classified by the `browser_` prefix. The group exists solely as a mode-filtering/auto-approval category for these external tools.

## References

- [ToolGroup Type Definitions](../packages/types/src/tool.ts)
- [Mode Configuration](../packages/types/src/mode.ts)
- [External Tool Resolution](../src/core/task/build-tools.ts)
- [MCP Hub — Tool Metadata](../src/services/mcp/McpHub.ts)
- [Auto-Approval Tool Group Inference](../src/core/auto-approval/tools.ts)
