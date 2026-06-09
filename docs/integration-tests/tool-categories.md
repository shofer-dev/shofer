# Tool Categories — Integration Test Scenarios

Tests for the tool-group classification system, mode-based filtering, and auto-approval category gating.

## Prerequisites

- Shofer extension running with at least one API profile configured.
- A workspace with a `.shofer/shofermodes` file for custom mode tests.
- An MCP server configured in `mcp.json` with tools assigned to different groups.

---

## Scenario 1: Mode correctly restricts available tools by group

**Goal:** Verify that each mode only receives tools from its declared groups.

1. Start a new task in **Code** mode.
2. Confirm the model can call `read_file` (from `read` group), `apply_diff` (from `write` group), `execute_command` (from `execute` group), and `switch_mode` (from `mode` group).
3. Start a new task in **Ask** mode.
4. Confirm the model can call `read_file` and `use_mcp_tool` but NOT `execute_command` or `apply_diff`.
5. Start a new task in **Architect** mode.
6. Confirm the model can call `read_file` and `write_to_file` (only for `.md` files) but NOT `execute_command`.
7. Start a new task in **Orchestrator** mode.
8. Confirm the model can only call always-available tools (`attempt_completion`, `new_task`, `update_todo_list`, etc.).

**Expected:** Each mode's tool availability matches the groups table in `tool-categories.md`.

---

## Scenario 2: Always-available tools bypass mode filtering

**Goal:** Verify that always-available tools work in every mode, including modes with no groups.

1. Start a task in **Orchestrator** mode (has `groups: []`).
2. Confirm the model can call `attempt_completion`, `new_task`, `update_todo_list`, `skills`, `set_task_title`, `give_feedback`, and `run_slash_command`.
3. Start a task in **Ask** mode.
4. Confirm all always-available tools are callable alongside the mode's `read` and `mcp` tools.

**Expected:** The 7 always-available tools are callable in every mode regardless of `groups`.

---

## Scenario 3: Custom mode with scoped write group

**Goal:** Verify that file-regex scoping on a group restricts tools correctly.

1. Create a `.shofer/shofermodes` file with a custom mode:
    ```json
    {
    	"customModes": [
    		{
    			"slug": "notes",
    			"name": "Notes",
    			"roleDefinition": "...",
    			"groups": ["read", ["write", { "fileRegex": "\\.md$" }]]
    		}
    	]
    }
    ```
2. Start a task in **Notes** mode.
3. Ask the model to read a `.ts` file → should succeed (read group).
4. Ask the model to edit a `.ts` file → should fail (write scoped to `.md` only).
5. Ask the model to edit a `.md` file → should succeed.

**Expected:** Write tools are available but only target `.md` files.

---

## Scenario 4: MCP tool group assignment in mcp.json

**Goal:** Verify that MCP tools inherit the group assigned in the user's `mcp.json` configuration.

1. Configure an MCP server in `mcp.json` with `toolGroups` mapping.
2. Start a task in **Ask** mode (groups: `read`, `mcp`).
3. Confirm that MCP tools assigned to `read` are callable.
4. Confirm that MCP tools assigned to `write` are NOT callable (Ask mode has no `write` group).
5. Switch to **Code** mode and confirm both `read` and `write` MCP tools are callable.

**Expected:** MCP tool availability respects `toolGroups` assignment × mode's allowed groups.

---

## Scenario 5: Unassigned MCP tools default to `uncategorized`

**Goal:** Verify that MCP tools without a `group` field are only available in modes that include `uncategorized`.

1. Add an MCP server where one tool has no `group` (or omit `toolGroups` entirely).
2. Start a task in **Ask** mode (does NOT include `uncategorized`).
3. Confirm the unassigned MCP tool is NOT available.
4. Start a task in **Code** mode (includes `uncategorized`).
5. Confirm the unassigned MCP tool IS available.

**Expected:** Unassigned tools land in `uncategorized` and are gated by the mode's `uncategorized` inclusion.

---

## Scenario 6: Auto-approval toggle maps to the correct group

**Goal:** Verify that each auto-approval toggle correctly gates the tools from its matching category.

1. Enable ONLY `alwaysAllowReadOnly` in AutoApproveDropdown.
2. Start a task and issue a `read_file` call → should be auto-approved.
3. Issue an `apply_diff` call → should require manual approval (write toggle is off).
4. Enable `alwaysAllowWrite`.
5. Issue another `apply_diff` → should be auto-approved.
6. Repeat for `alwaysAllowExecute`, `alwaysAllowBrowser`, `alwaysAllowMcp`, `alwaysAllowSubtasks`, `alwaysAllowModeSwitch`.

**Expected:** Each toggle gates exactly the tools in its corresponding group.

---

## Scenario 7: External LM tool groups (vscode-tools)

**Goal:** Verify that `ide_*` tools from `arkware-vscode-tools` respect their configured groups.

1. Ensure `arkware-vscode-tools` is installed and activated.
2. Start a task in **Code** mode.
3. Confirm `ide_file_read` (in `read` group) is available.
4. Confirm `ide_panel_open` (in `execute` group) is available.
5. Start a task in **Ask** mode (groups: `read`, `mcp`).
6. Confirm `ide_file_read` is available.
7. Confirm `ide_panel_open` is NOT available (Ask mode has no `execute` group).

**Expected:** External LM tool availability follows the `arkware.vscodeTools.toolGroups` config × mode groups.

---

## Scenario 8: Browser tools classification

**Goal:** Verify that `browser_*` tools are classified as `browser` and gated by the `browser` group in modes.

1. Ensure `arkware-browser-tools` is installed.
2. Start a task in **Ask** mode (groups: `read`, `mcp` — NO `browser`).
3. Confirm `browser_navigate` and `browser_click` are NOT available.
4. Start a task in **Code** mode (includes `browser` implicitly via `uncategorized`... verify that `browser` group must be explicitly included).
5. Confirm browser tools are correctly classified as `browser` group and only available when the mode allows `browser`.

**Expected:** Browser tools require the `browser` group in the mode's configuration.

---

## Scenario 9: Custom mode overrides with `tools_allowed` and `tools_denied`

**Goal:** Verify that `tools_allowed` can add individual tools beyond group membership and `tools_denied` can remove tools from a group.

1. Create a custom mode with `groups: ["read"], tools_allowed: ["execute_command"], tools_denied: ["grep_search"]`.
2. Start a task in this custom mode.
3. Confirm `read_file` is available (from `read` group).
4. Confirm `execute_command` is available (from `tools_allowed`).
5. Confirm `grep_search` is NOT available (blocked by `tools_denied` even though `read` group includes it).
6. Confirm `apply_diff` is NOT available (write group not included).

**Expected:** `tools_allowed` adds individual tools; `tools_denied` removes individual tools; both override group membership.

---

## Scenario 10: Renamed/deprecated group aliases

**Goal:** Verify that deprecated group names are auto-translated.

1. In a `.shofer/shofermodes` file, use the old group name `edit` instead of `write`.
2. Start a task and confirm that `apply_diff` is available (the mode should treat `edit` as `write`).
3. Similarly test `command` → `execute` and `modes` → `mode`.

**Expected:** The deprecated group names `edit`, `command`, `modes` are accepted and mapped to `write`, `execute`, `mode` respectively.
