# Built-in Modes — Source of Truth

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
            ├── groups[] → TOOL_GROUPS → allowedTools
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
| `groups`             | `GroupEntry[]` | Symbolic tool-group names with optional file-regex scoping |
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

The `groups` field in each mode uses symbolic names. The actual tool membership
is defined in `TOOL_GROUPS` — a `Record<ToolGroup, ToolGroupConfig>`:

| Group           | Category              | Member Tools                                                                                                                                                                                                                                                       |
| --------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `read`          | Read-only data access | `read_file`, `grep_search`, `list_files`, `rag_search`, `find_files`, `read_project_structure`, `view_image`, `list_code_usages`, `get_errors`, `get_project_setup_info`, `get_changed_files`, `lsp_search`, `fetch_web_page`, `ask_assistant_agent`, `git_search` |
| `write`         | Content mutations     | `apply_diff`, `write_to_file`, `generate_image`, `insert_edit`, `rename_symbol`, `create_directory`, `create_new_workspace`, `file`, `sed` (+ `customTools`: `edit`, `search_replace`, `edit_file`, `apply_patch`)                                                 |
| `execute`       | System commands       | `execute_command`, `read_command_output`, `sleep`                                                                                                                                                                                                                  |
| `mcp`           | MCP protocol          | `use_mcp_tool`, `access_mcp_resource`, `call_mcp_tool_async`, `check_mcp_call_status`, `wait_for_mcp_call`                                                                                                                                                         |
| `mode`          | Mode switching        | `switch_mode`                                                                                                                                                                                                                                                      |
| `subtasks`      | Task orchestration    | `new_task`, `check_task_status`, `wait_for_task`, `list_background_tasks`, `cancel_tasks`, `answer_subtask_question`                                                                                                                                               |
| `questions`     | User interaction      | `ask_followup_question`                                                                                                                                                                                                                                            |
| `browser`       | Browser automation    | _(empty — browser tools are provided by the `browser-tools` MCP server)_                                                                                                                                                                                           |
| `uncategorized` | Fallback              | _(empty — for tools without explicit classification)_                                                                                                                                                                                                              |

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

| Tool                 | Purpose                                      |
| -------------------- | -------------------------------------------- |
| `attempt_completion` | Signal task completion with a rating         |
| `update_todo_list`   | Track and update the task todo list          |
| `run_slash_command`  | Execute built-in and custom slash commands   |
| `skills`             | Load skill instructions into task context    |
| `set_task_title`     | Set a descriptive title for the current task |
| `give_feedback`      | Send feedback to the Shofer developers       |

## 5. Tool List Assembly: `getToolsForMode()`

**File:** [`src/shared/modes.ts`](../src/shared/modes.ts:29-87)

Assembles the final tool name set from a mode's `groups`, `tools_allowed`, and
`tools_denied` fields. The resolution rules:

1. Iterate `groups[]` → look up each in `TOOL_GROUPS` → collect tools
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
    - `ask_assistant_agent` — removed if assistant agent is not available
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
field of the built-in mode. There is no partial merging of `groups` or
`customInstructions`.

Custom modes with new slugs (not matching any built-in mode) are appended after
the built-in modes in `getAllModes()`.

---

## 11. Mode Details

### 💻 Code (`code`)

**Groups:** `read`, `write`, `execute`, `mcp`, `mode`, `subtasks`, `questions`, `uncategorized`

**Role Definition:**

> You are Shofer, a highly skilled software engineer with extensive knowledge in
> many programming languages, frameworks, design patterns, and best practices.

**When To Use:**

> Use this mode when you need to write, modify, or refactor code. Ideal for
> implementing features, fixing bugs, creating new files, or making code
> improvements across any programming language or framework.

**Tool Access:** Maximum access — all 8 non-empty tool groups. The only
built-in mode with full `execute` (shell commands), `write` (file mutations),
`mode` (mode switching), and `subtasks` (background task delegation) simultaneously.

**Default Mode:** Yes — `code` is `modes[0]` and the ultimate fallback.

---

### 🏗️ Architect (`architect`)

**Groups:** `read`, `["write", { fileRegex: "\\.md$", description: "Markdown files only" }]`, `mcp`, `questions`

**Role Definition:**

> You are Shofer, an experienced technical leader who is inquisitive and an
> excellent planner. Your goal is to gather information and get context to create
> a detailed plan for accomplishing the user's task, which the user will review
> and approve before they switch into another mode to implement the solution.

**When To Use:**

> Use this mode when you need to plan, design, or strategize before implementation.
> Perfect for breaking down complex problems, creating technical specifications,
> designing system architecture, or brainstorming solutions before coding.

**Tool Access:**

- **Write restricted to `.md` files** — `fileRegex: "\\.md$"` on the `write` group.
  Any attempt to write to a non-`.md` file throws a `FileRestrictionError`.
- **No `execute` group** — cannot run shell commands.
- **No `subtasks` group** — cannot delegate work to sub-tasks.

**Custom Instructions:** (abbreviated — see source for full text)
A 7-step workflow guiding the LLM to: gather context, ask clarifying questions,
create actionable todo lists (`update_todo_list`), iterate on the plan with the
user, and use `switch_mode` to hand off to `code` mode for implementation.

**Critical Constraints:**

- Plans are saved to the `/plans` directory
- Time estimates (hours, days, weeks) are explicitly forbidden
- Todo lists are preferred over lengthy markdown documents

---

### 🪲 Debug (`debug`)

**Groups:** `read`, `write`, `execute`, `mcp`, `subtasks`, `questions`, `uncategorized`

**Role Definition:**

> You are Shofer, an expert software debugger specializing in systematic problem
> diagnosis and resolution.

**When To Use:**

> Use this mode when you're troubleshooting issues, investigating errors, or
> diagnosing problems. Specialized in systematic debugging, adding logging,
> analyzing stack traces, and identifying root causes before applying fixes.

**Tool Access:** Near-full access — same as `code` except missing `mode`.
Cannot switch modes autonomously.

**Custom Instructions:**
A structured debugging workflow:

1. Reflect on 5–7 different possible sources of the problem
2. Distill to 1–2 most likely sources
3. Add logs to validate assumptions
4. Explicitly ask the user to confirm the diagnosis **before** fixing

---

### 🔎 Code Search (`code-search`)

**Groups:** `read`, `execute`, `mcp`, `questions`

**Role Definition:**

> You are a fast, focused codebase search agent. Your purpose is to quickly find
> relevant code, files, patterns, and context within the repository and return
> concise, actionable results to the caller. You search broadly across the codebase
> using all available tools — semantic search, text search, file listing, and
> command-line utilities. You do not edit any files; you are purely a retrieval engine.

**When To Use:**

> Use this mode when you need to quickly search the codebase for specific
> information — find where a function is defined, locate all usages of a symbol,
> discover patterns, or gather context about how something works. Ideal for use
> as a sub-task via `new_task` to parallelize codebase exploration.

**Tool Access:**

- **Read + Execute + MCP** — can read files, run grep/find commands, and query MCP tools.
- **No `write` group** — cannot modify any workspace files.
- **No `subtasks` group** — cannot delegate; focused purely on retrieval.

**Custom Instructions:**
A 9-step search workflow: semantic search first, then regex/text patterns,
directory exploration, CLI tools (`grep`, `rg`, `fd`), symbol references, and a
structured results summary. File editing is explicitly prohibited.

---

### 🌐 Web Search (`web-search`)

**Groups:** `browser`, `questions`, `mcp`

**Role Definition:**

> You are a web browsing agent. Your purpose is to use the browser to research,
> extract, and interact with web content to accomplish tasks. You navigate to web
> pages, search for information, extract text and structured data, fill forms,
> take screenshots, and interact with web applications. You do not modify any
> code or files in the workspace.

**When To Use:**

> Use this mode when you need to use a web browser to find information, research
> topics, interact with web applications, extract data from websites, replay a
> saved browser workflow, or capture a new repeatable browser skill.

**Tool Access:**

- **Browser group** — all `browser_*` tools from the `browser-tools` MCP server.
- **Questions + MCP** — can ask the user clarifying questions and use MCP tools.
- **No `read` group** — cannot read workspace files directly.
- **No `write` group** — cannot modify any workspace files.

**Custom Instructions:**
Browser interaction primitives (tabs, navigation, page reading, screenshots,
interactions) and guidance on asking the user when pages are ambiguous. Explicitly
prohibits file modifications outside of the browser.

---

### 👀 Reviewer (`reviewer`)

**Groups:** `read`, `execute`, `mcp`, `questions`

**Role Definition:**

> You are a senior software engineer performing code review. You analyze existing
> code for bugs, security vulnerabilities, design issues, performance problems,
> and adherence to best practices. You propose specific, actionable fixes — but
> you NEVER implement them. Your output is diagnostic and advisory only. You read
> code, run analysis tools, and query observability data to inform your review.

**When To Use:**

> Use this mode when you need a thorough code review, want to identify potential
> issues, or need recommendations for improvements without making changes to the
> codebase.

**Tool Access:**

- **Read + Execute + MCP** — can read files, run lint/analysis tools, and query
  observability data (Loki, Mimir, Tempo).
- **No `write` group** — cannot modify any workspace files. Diagnostic only.
- **No `subtasks` group** — focused on providing a single review report.

**Custom Instructions:**
A 5-step review process: read files thoroughly, run static analysis, query
observability data, present findings with specific locations and proposed fixes,
and never edit any files.

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
