# Built-in Modes

This document describes the Source-of-Truth (SoT) chain for the six built-in modes
in the Shofer VS Code extension. It covers where each mode is defined, how tool
access is resolved, and how custom modes override built-in modes at runtime.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Primary Definition: `DEFAULT_MODES`](#2-primary-definition-default_modes)
3. [Tool Groups: `TOOL_GROUPS`](#3-tool-groups-tool_groups)
4. [Always-Available Tools](#4-always-available-tools)
5. [Tool List Assembly: `getToolsForMode()`](#5-tool-list-assembly-gettoolsformode)
6. [Re-export Chain](#6-re-export-chain)
7. [Runtime Resolution: `getFullModeDetails()`](#7-runtime-resolution-getfullmodedetails)
8. [Mode × Tool Filtering: `filterNativeToolsForMode()`](#8-mode--tool-filtering-filternativetoolsformode)
9. [Execution-Time Validation: `validateToolUse()`](#9-execution-time-validation-validatetooluse)
10. [Custom Mode Override Precedence](#10-custom-mode-override-precedence)
11. [Mode Details](#11-mode-details)
12. [File Index](#12-file-index)

---

## 1. Overview

The SoT chain for built-in modes is a clean, linear pipeline with well-defined
override semantics at each stage:

```
DEFAULT_MODES (packages/types/src/mode.ts:199)
    │
    └── modes = DEFAULT_MODES (src/shared/modes.ts:90)
            │
            ├── tools[] → TOOL_GROUPS → allowedTools
            │     (src/shared/tools.ts → packages/types/src/tool.ts:175)
            │
            └── getModeBySlug(slug, customModes)
                    │
                    ├── custom mode found? → use it
                    └── else → modes.find(slug) || modes[0]
                            │
                            ├── filterNativeToolsForMode()
                            │   (removes feature-gated tools, applies model customization)
                            │
                            └── getFullModeDetails()
                                (merges prompt overrides + file-loaded rules)
```

## 2. Primary Definition: `DEFAULT_MODES`

**File:** [`packages/types/src/mode.ts`](../packages/types/src/mode.ts:199-270)

The single source of truth for all built-in modes. It is a `readonly ModeConfig[]`
exported from the `@shofer/types` package. Each mode entry contains:

| Field                | Type           | Purpose                                                    |
| -------------------- | -------------- | ---------------------------------------------------------- |
| `slug`               | `string`       | Machine-readable identifier (regex: `/^[a-zA-Z0-9-]+$/`)   |
| `name`               | `string`       | Human-readable display name (shown in Mode Selector)       |
| `roleDefinition`     | `string`       | The system-prompt role for the LLM agent                   |
| `whenToUse`          | `string`       | Guidance text shown in the mode selector tooltip           |
| `description`        | `string`       | Short description for mode picker UI                       |
| `tools`              | `GroupEntry[]` | Symbolic tool-group names with optional file-regex scoping |
| `customInstructions` | `string`       | Default custom instructions for the mode                   |

The six built-in modes:

| #   | `slug`        | Name           | Role                                  |
| --- | ------------- | -------------- | ------------------------------------- |
| 1   | `code`        | 💻 Code        | Write, modify, and refactor code      |
| 2   | `architect`   | 🏗️ Architect   | Plan and design before implementation |
| 3   | `debug`       | 🪲 Debug       | Diagnose and fix software issues      |
| 4   | `code-search` | 🔎 Code Search | Search and explore the codebase       |
| 5   | `web-search`  | 🌐 Web Search  | Browse and extract web content        |
| 6   | `reviewer`    | 👀 Reviewer    | Review code and identify issues       |

The first mode (`code`) is also the **default mode** — used as fallback when
a mode slug cannot be resolved to any known mode.

## 3. Tool Groups: `TOOL_GROUPS`

**File:** [`packages/types/src/tool.ts`](../packages/types/src/tool.ts:175-246)

The `tools` field in each mode uses symbolic names. The actual tool membership
is defined in `TOOL_GROUPS` — a `Record<ToolGroup, ToolGroupConfig>`:

| Group           | Category              | Member Tools                                                                                                                                                                                                                                                   |
| --------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read`          | Read-only data access | `read_file`, `grep_search`, `list_files`, `rag_search`, `find_files`, `read_project_structure`, `view_image`, `list_code_usages`, `get_errors`, `get_project_setup_info`, `get_changed_files`, `lsp_search`, `fetch_web_page`, `ask_live_memory`, `git_search` |
| `write`         | Content mutations     | `apply_diff`, `write_to_file`, `generate_image`, `insert_edit`, `rename_symbol`, `create_directory`, `create_new_workspace`, `file`, `sed` (+ `customTools`: `edit`, `search_replace`, `edit_file`, `apply_patch`)                                             |
| `execute`       | System commands       | `execute_command`, `read_command_output`, `sleep`                                                                                                                                                                                                              |
| `mcp`           | MCP protocol          | `use_mcp_tool`, `access_mcp_resource`, `call_mcp_tool_async`, `check_mcp_call_status`, `wait_for_mcp_call`                                                                                                                                                     |
| `mode`          | Mode switching        | `switch_mode`                                                                                                                                                                                                                                                  |
| `subtasks`      | Task orchestration    | `new_task`, `check_task_status`, `wait_for_task`, `cancel_tasks`, `answer_subtask_question`                                                                                                                                                                    |
| `questions`     | User interaction      | `ask_followup_question`                                                                                                                                                                                                                                        |
| `browser`       | Browser automation    | _(empty — browser tools are provided by the `browser-tools` MCP server)_                                                                                                                                                                                       |
| `uncategorized` | Fallback              | _(empty — for tools without explicit classification)_                                                                                                                                                                                                          |

**Note:** The `customTools` array (currently only on `write`) lists tools that are
**opt-in only** — they are not included automatically by group membership. They
only become available when explicitly included via the model's `includedTools`
configuration.

**Tool Group Count:** There are exactly 9 groups as defined in
[`packages/types/src/tool.ts`](../packages/types/src/tool.ts:16-26). Adding a 10th
group is a coordinated change affecting `toolGroups` const, `TOOL_GROUPS` object,
`toolGroupsSchema`, mode definitions, auto-approval, and documentation.

## 4. Always-Available Tools

**File:** [`packages/types/src/tool.ts`](../packages/types/src/tool.ts:248-259)

These tools are always available across all modes — unless explicitly disabled
via the `disabledTools` setting or excluded by `tools_denied`:

| Tool                    | Purpose                                      |
| ----------------------- | -------------------------------------------- |
| `attempt_completion`    | Signal task completion with a rating         |
| `update_todo_list`      | Track and update the task todo list          |
| `run_slash_command`     | Execute built-in and custom slash commands   |
| `skills`                | Load skill instructions into task context    |
| `set_task_title`        | Set a descriptive title for the current task |
| `give_feedback`         | Send feedback to the Shofer developers       |
| `list_background_tasks` | List background tasks (children or peers)    |
| `send_message_to_task`  | Send async/sync messages to peer tasks       |

## 5. Tool List Assembly: `getToolsForMode()`

**File:** [`src/shared/modes.ts`](../src/shared/modes.ts:29-87)

Assembles the final tool name set from a mode's `tools`, `tools_allowed`, and
`tools_denied` fields. The resolution rules:

1. Iterate `tools[]` → look up each in `TOOL_GROUPS` → collect tools
2. **Scoped group entries** (`{ "groupName": { allowed: [...], denied: [...] } }`) narrow the tool set:
    - `allowed`: exclusive list — only these tools from that group
    - `denied`: removes the listed tools from the group's normal set
3. **File-regex tuples** (`["write", { fileRegex: "\\.md$" }]`) restrict write
   operations to matching files at _execution time_ (not at tool-collection time —
   the tool is still listed but validated with `doesFileMatchRegex()` in `isToolAllowedForMode`)
4. Add explicitly whitelisted tools from `tools_allowed`
5. Remove explicitly denied tools from `tools_denied`
6. Add `ALWAYS_AVAILABLE_TOOLS`
7. Re-apply `tools_denied` to always-available tools (**denial always wins**)

## 6. Re-export Chain

| File                                                              | What It Does                                                          |
| ----------------------------------------------------------------- | --------------------------------------------------------------------- |
| [`packages/types/src/mode.ts`](../packages/types/src/mode.ts:199) | Defines `DEFAULT_MODES` — the canonical source                        |
| [`src/shared/modes.ts`](../src/shared/modes.ts:90)                | `export const modes = DEFAULT_MODES` — pass-through re-export         |
| [`src/shared/modes.ts`](../src/shared/modes.ts:93)                | `export const defaultModeSlug = modes[0].slug` — resolves to `"code"` |

The `modes` re-export from `src/shared/modes.ts` is what the rest of the
codebase consumes. It must remain a direct passthrough of `DEFAULT_MODES` to
avoid drift.

## 7. Runtime Resolution: `getFullModeDetails()`

**File:** [`src/core/modes/getFullModeDetails.ts`](../src/core/modes/getFullModeDetails.ts:16-57)

This is the **host-only** function that resolves a mode slug to its full
prompt-time configuration. It lives under `src/core/modes/` (not `src/shared/`)
because it transitively imports `fs/promises`, `path`, and `os` via
`addCustomInstructions()` — modules the webview bundler cannot resolve.

Resolution order:

1. **`getModeBySlug(modeSlug, customModes)`** — custom modes take precedence by slug
2. **Fallback to built-in** — `modes.find(m => m.slug === modeSlug)`
3. **Ultimate fallback** — `modes[0]` (i.e., `code` mode) if the slug matches nothing
4. **Prompt component overrides** — `customModePrompts[modeSlug]` from settings can
   override `roleDefinition`, `whenToUse`, `description`, and `customInstructions`
5. **File-loaded rules** — `addCustomInstructions()` merges in:
    - `.shofer/rules-<mode>/*.md` files
    - Global custom instructions from settings
    - Language-specific instruction files

## 8. Mode × Tool Filtering: `filterNativeToolsForMode()`

**File:** [`src/core/prompts/tools/filter-tools-for-mode.ts`](../src/core/prompts/tools/filter-tools-for-mode.ts:225-339)

This function produces the actual tool catalog sent to the LLM. It applies
runtime filters on top of the mode's group-based tool set:

1. Resolve mode slug → mode config (fallback to `defaultModeSlug` if missing)
2. Call `getToolsForMode()` to get the base allowed tool set
3. Apply `isToolAllowedForMode()` permission checks
4. Apply model-specific tool customization (`applyModelToolCustomization()`)
5. **Feature gates** — conditionally remove tools that aren't configured:
    - `rag_search` — removed if code indexer is not initialized
    - `git_search` — removed if git indexer is not initialized
    - `ask_live_memory` — removed if live memory is not available
    - `update_todo_list` — removed if `todoListEnabled === false`
    - `generate_image` — removed if `imageGeneration` experiment is off
    - `run_slash_command` — removed if `runSlashCommand` experiment is off
    - `access_mcp_resource` — removed if MCP has no resources
6. Apply `disabledTools` — globally disabled tools are removed
7. Apply alias renames (e.g., `search_and_replace` → `edit`)

## 9. Execution-Time Validation: `validateToolUse()`

**File:** [`src/core/tools/validateToolUse.ts`](../src/core/tools/validateToolUse.ts:50-101)

Even after `filterNativeToolsForMode()` removes tools from the LLM's catalog,
execution-time validation provides a defense-in-depth layer. The validation chain:

1. **Is the tool name known?** — `isValidToolName()` checks against `toolNames`,
   MCP tools (`mcp_*` prefix), custom tools, and private provider tools.
2. **Is the tool disabled by user?** — `disabledTools` check (distinct error
   message so the LLM knows not to retry).
3. **Is the tool allowed for this mode?** — `isToolAllowedForMode()` re-checks
   group membership, file-regex scoping, always-available tools, experiment
   gating, and private-tool provider gating.
4. **If denied** → throws an error that surfaces to the LLM.

## 10. Custom Mode Override Precedence

Custom modes from `.shofer/shofermodes` files (project-level) and
`~/.shofer/shofermodes` (global) override built-in modes with the same slug:

| Priority    | Source                         | Scope                  |
| ----------- | ------------------------------ | ---------------------- |
| 1 (highest) | Project `.shofer/shofermodes`  | Current workspace      |
| 2           | Global `~/.shofer/shofermodes` | All workspaces         |
| 3           | Built-in `DEFAULT_MODES`       | Shipped with extension |

The override is **complete** — a custom mode with the same slug replaces every
field of the built-in mode. There is no partial merging of `tools` or
`customInstructions`.

Custom modes with new slugs (not matching any built-in mode) are appended after
the built-in modes in `getAllModes()`.

---

## 11. Mode Details

The six built-in modes are defined in [`DEFAULT_MODES`](../packages/types/src/mode.ts:199-270).
This section summarizes their key structural properties; for the full
definitions (role, group assignments, custom instructions) see the source.

| #   | Slug          | Name           | Groups                                                                                         | Default |
| --- | ------------- | -------------- | ---------------------------------------------------------------------------------------------- | ------- |
| 1   | `code`        | 💻 Code        | `read`, `write`, `execute`, `browser`, `mcp`, `mode`, `subtasks`, `questions`, `uncategorized` | Yes     |
| 2   | `architect`   | 🏗️ Architect   | `read`, `["write", { fileRegex: "\\.md$" }]`, `browser`, `mcp`, `subtasks`, `questions`        | —       |
| 3   | `debug`       | 🪲 Debug       | `read`, `write`, `execute`, `browser`, `mcp`, `subtasks`, `questions`, `uncategorized`         | —       |
| 4   | `code-search` | 🔎 Code Search | `read`, `execute`, `browser`, `mcp`, `questions`                                               | —       |
| 5   | `web-search`  | 🌐 Web Search  | `browser`, `questions`, `mcp`                                                                  | —       |
| 6   | `reviewer`    | 👀 Reviewer    | `read`, `execute`, `browser`, `mcp`, `subtasks`, `questions`                                   | —       |

**Key structural notes:**

- **`code`** is the default mode (`modes[0]`) and the ultimate fallback. It is
  the only mode with all five write/execute/mode/subtasks groups simultaneously.
- **`architect`** restricts the `write` group to `.md` files only via a
  `fileRegex` tuple — any attempt to write to a non-`.md` file throws a
  `FileRestrictionError`. Note it has **no `mode` group**, so `switch_mode` is
  not in its catalog (`switch_mode` lives only in `TOOL_GROUPS.mode`, which only
  `code` carries, and is not in `ALWAYS_AVAILABLE_TOOLS`). Architect therefore
  hands off by _asking the user_ to switch to an implementation mode (it has the
  `questions` group) — its `customInstructions` must not instruct it to call
  `switch_mode`, which it cannot.
- **`debug`** has near-full access (same as `code` minus `mode`).
- **`code-search`** has no `write`, no `mode`, and no `subtasks`. **`architect`**
  and **`reviewer`** have `write` restricted to `.md` files and no `write`
  respectively, no `mode`, but include `subtasks`.
- **`web-search`** is the only mode with the `browser` group and has no `read`.
- All tool group assignments and role text are in
  [`DEFAULT_MODES`](../packages/types/src/mode.ts:199-270); this table is
  a convenience summary that must stay in sync with the source.

---

## 12. File Index

| File                                                                                                    | Role                                                                                                           |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [`packages/types/src/mode.ts`](../packages/types/src/mode.ts)                                           | `DEFAULT_MODES` definition, `ModeConfig` type + schema                                                         |
| [`packages/types/src/tool.ts`](../packages/types/src/tool.ts)                                           | `TOOL_GROUPS`, `ALWAYS_AVAILABLE_TOOLS`, `TOOL_ALIASES`, `toolNames`, `TOOL_DISPLAY_NAMES`                     |
| [`src/shared/modes.ts`](../src/shared/modes.ts)                                                         | `modes` re-export, `getModeBySlug()`, `getToolsForMode()`, `getAllModes()`, helper functions                   |
| [`src/shared/tools.ts`](../src/shared/tools.ts)                                                         | Re-exports tool metadata from `@shofer/types`                                                                  |
| [`src/core/modes/getFullModeDetails.ts`](../src/core/modes/getFullModeDetails.ts)                       | Host-only full mode resolution with prompt overrides + file-loaded rules                                       |
| [`src/core/prompts/tools/filter-tools-for-mode.ts`](../src/core/prompts/tools/filter-tools-for-mode.ts) | LLM tool catalog filtering (`filterNativeToolsForMode`)                                                        |
| [`src/core/tools/validateToolUse.ts`](../src/core/tools/validateToolUse.ts)                             | Execution-time tool access validation (`validateToolUse`, `isToolAllowedForMode`)                              |
| [`src/core/task/build-tools.ts`](../src/core/task/build-tools.ts)                                       | Tool catalog assembly (calls `filterNativeToolsForMode`, `filterMcpToolsForMode`, `filterPrivateToolsForMode`) |
