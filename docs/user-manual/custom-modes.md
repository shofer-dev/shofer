# Custom Modes — Controlling Which Tools Each Mode Can Use

Every Shofer mode (Code, Architect, Debug, Reviewer, etc.) is defined by a
configuration that controls **which tools the AI can call** while operating in
that mode. You can create your own custom modes or override built-in ones by
writing a `.shofermodes` file.

This guide explains the three fields that govern tool access —
`groups`, `tools_allowed`, and `tools_denied` — and shows you how to combine
them to build safe, focused modes.

---

## Quick Start: Creating Your First Custom Mode

Create a `.shofermodes` file at the root of your project (or in your global
Shofer config directory). Here is the simplest possible custom mode — a
read-only reviewer that can only search and read files:

```yaml
customModes:
    - slug: my-reviewer
      name: 🔍 My Reviewer
      roleDefinition: You are a code reviewer. You read code, find issues, and
          propose fixes — but you never edit files.
      groups:
          - read
```

**XXX: Screenshot showing the ModeSelector dropdown in the chat input bar
with a custom mode entry visible (e.g. "🔍 My Reviewer" alongside the
built-in modes like "💻 Code", "🏗️ Architect").**

Save the file, reload your VS Code window, and your mode appears in the mode
dropdown. When you select it, the AI can only call tools from the `read` group
— things like `read_file`, `grep_search`, `list_files`, `lsp_search`, and
other read-only operations.

---

## The Three Tool-Access Fields

Every mode definition supports three fields that control tool access:

| Field           | Type            | What It Does                                                                                     |
| --------------- | --------------- | ------------------------------------------------------------------------------------------------ |
| `groups`        | list of strings | Grants access to broad **categories** of tools (e.g. `read`, `write`, `mcp`)                     |
| `tools_allowed` | list of strings | Grants access to **individual** tool IDs, independent of groups                                  |
| `tools_denied`  | list of strings | Unconditionally **blocks** specific tool IDs, even if groups or `tools_allowed` would grant them |

### How They Combine

When Shofer decides whether a tool is allowed in a mode, it applies this rule:

> **Allowed** = (tool is in `groups` **OR** tool is in `tools_allowed`) **AND** tool is **NOT** in `tools_denied`

In plain English:

- `groups` and `tools_allowed` are **additive** — both grant access, and a tool
  needs only one of them to pass.
- `tools_denied` is a **hard veto** — it always wins, no exceptions.

---

## Field-by-Field Reference

### `groups` — Broad Capability Categories

Groups are the primary way to assign tool access. Instead of listing dozens of
individual tool names, you grant a group and get all its tools.

Available groups and what they contain:

| Group           | What It Grants                                                                   |
| --------------- | -------------------------------------------------------------------------------- |
| `read`          | Read files, search code, list directories, inspect project structure, etc.       |
| `write`         | Modify files: create, edit, rename, delete, apply diffs, generate images.        |
| `execute`       | Run CLI commands (`execute_command`, `read_command_output`, `sleep`).            |
| `mcp`           | MCP protocol tools: call tools and access resources on connected MCP servers.    |
| `browser`       | Browser automation: navigate pages, click, type, extract content, screenshot.    |
| `mode`          | Mode switching (`switch_mode`).                                                  |
| `subtasks`      | Spawn and manage background child tasks (`new_task`, `check_task_status`, etc.). |
| `questions`     | Ask the user questions (`ask_followup_question`).                                |
| `uncategorized` | Fallback for tools without a specific group. Currently empty.                    |

**XXX: Screenshot showing a `.shofermodes` file open in the VS Code editor with
YAML syntax highlighting. The `groups:` list should be visible and a few group
names (`read`, `write`, `mcp`, `browser`) should be recognizable. Show the
YAML schema validation warning/error tooltip if VS Code flags an invalid
group name.**

#### Group Entry Forms

Each entry in the `groups` list can be written in three ways:

1. **Bare group name** — the simplest form. Grants all tools in that group:

    ```yaml
    groups:
        - read
        - mcp
    ```

2. **Tuple with options** — adds a `fileRegex` restriction (only for the
   `write` group currently):

    ```yaml
    groups:
        - - write
          - fileRegex: "\\.md$"
    ```

    This restricts write tools to only touch `.md` files. The AI can still
    read any file, but `write_to_file`, `apply_diff`, etc. will be rejected
    for files not matching the regex.

3. **Scoped group** — narrows a group to specific tools:

    ```yaml
    groups:
        - browser
        - mcp
        - read:
              allowed:
                  - mcp--arkware--web_search
    ```

    This gives the mode ALL `browser` and `mcp` tools, but from the `read`
    group it gets ONLY `mcp--arkware--web_search` — not `read_file`,
    `grep_search`, or any other read tool. You can also use `denied` to
    remove specific tools from a group:

    ```yaml
    groups:
        - write:
              denied:
                  - generate_image
    ```

### `tools_allowed` — Individual Tool Grants

Use `tools_allowed` to grant specific tools without pulling in an entire
group. This is useful for fine-grained control or for adding one extra tool on
top of groups:

```yaml
groups:
    - read
tools_allowed:
    - new_task
```

This mode has every tool from `read` **plus** `new_task` (which belongs to the
`subtasks` group, not `read`).

A mode can also declare access purely through `tools_allowed` and omit
`groups` entirely:

```yaml
tools_allowed:
    - read_file
    - grep_search
    - list_files
    - lsp_search
```

### `tools_denied` — Hard Veto List

Use `tools_denied` to subtract a tool from an otherwise broad permission set:

```yaml
groups:
    - read
    - write
    - execute
tools_denied:
    - execute_command
```

This mode can read, write, and run most command-line operations — but
`execute_command` is blocked. Even though it belongs to the `execute` group,
the deny list takes priority.

**Deny always wins.** Even if you list a tool in both `tools_allowed` and
`tools_denied`, it will be blocked:

```yaml
tools_allowed:
    - read_file
    - execute_command
tools_denied:
    - execute_command
```

Result: `read_file` is allowed, `execute_command` is denied.

---

## Choosing Your Strategy

| Goal                                           | Use This                                                             |
| ---------------------------------------------- | -------------------------------------------------------------------- |
| "Grant a broad set of capabilities"            | `groups: [read, write, mcp]`                                         |
| "Grant read + one specific extra tool"         | `groups: [read]` + `tools_allowed: [new_task]`                       |
| "Grant everything except one dangerous tool"   | `groups: [read, write, execute]` + `tools_denied: [execute_command]` |
| "Grant only a handful of specific tools"       | `tools_allowed: [read_file, grep_search, ...]` (no `groups`)         |
| "Allow write but only for documentation files" | `groups: [["write", { fileRegex: "\\.md$" }]]`                       |
| "Allow most read tools except web search"      | `groups: [{ read: { denied: [mcp--arkware--web_search] } }]`         |

---

## Real-World Examples

### Example: Safe Reviewer (Read + Execute, No Writes)

```yaml
- slug: reviewer
  name: 👀 Reviewer
  roleDefinition: You perform code review. You read code, run linting and
      tests, query logs and metrics — but you NEVER edit files.
  groups:
      - read
      - execute
      - mcp
      - questions
```

**XXX: Screenshot of the ChatView when the Reviewer mode is active. The
chat input bar should show "👀 Reviewer" in the ModeSelector. A chat message
from the AI should be visible showing review findings with file paths and
line numbers but no file edits.**

### Example: Docs-Only Editor (Write Scoped to Markdown)

```yaml
- slug: docs-editor
  name: 📝 Docs Editor
  roleDefinition: You write and edit documentation. You can only modify
      Markdown files.
  groups:
      - read
      - - write
        - fileRegex: "\\.(md|mdx)$"
```

If the AI tries to edit a `.ts` file in this mode, Shofer blocks it with an
error message.

**XXX: Screenshot of the ChatView showing an error/warning row that appears
when the AI attempts to write a file that doesn't match the fileRegex. The
message should say something like "Tool 'write_to_file' blocked — only files
matching \\.md$ are allowed in 📝 Docs Editor mode."**

### Example: Search Sub-Task (Bare Minimum)

Used as a sub-task spawned via `new_task` — no editing, no command execution,
just search and retrieval:

```yaml
- slug: search
  name: 🔎 Search
  roleDefinition: Fast codebase search and retrieval. You find things and
      return results — you never edit.
  groups:
      - read
      - questions
```

---

## Where to Put Your `.shofermodes` File

| Location                                 | Scope                                                    |
| ---------------------------------------- | -------------------------------------------------------- |
| `<project-root>/.shofermodes`            | Project-level — affects everyone working on this project |
| `~/.shofer/.shofermodes` (global config) | Global — available in all your projects                  |

**XXX: Screenshot showing the VS Code file explorer with a `.shofermodes` file
visible at the project root. The file should be highlighted to show its
location.**

Project-level modes override global modes with the same `slug`. This means
your team can ship a `.shofermodes` in the repo with safe defaults, and
individual developers can customize further in their global config.

---

## Validating Your Configuration

After saving `.shofermodes`:

1. Reload the VS Code window (`Developer: Reload Window` from the command palette).
2. Open the mode dropdown — your custom mode should appear.
3. Try using a tool that should be blocked — Shofer will tell the AI
   `"Tool X is not allowed in <mode> mode"`.

**XXX: Screenshot of the ChatView showing the validation error when the AI
tries to use a blocked tool. The error message row should be clearly visible**
— **show the exact error text: `Tool "write_to_file" is not allowed in reviewer
mode.`**

---

## Rules & Constraints

- **At least one allow-source required.** A mode must have `groups` or
  `tools_allowed` (or both). `tools_denied` alone is not sufficient.
- **Built-in modes can be overridden.** Create a custom mode with the same
  `slug` as a built-in mode (e.g. `code`, `ask`, `debug`) and your version
  wins within that project.
- **Duplicate group names are rejected.** You cannot list the same group twice
  in a mode's `groups` array.
- **Group names must be valid.** Only the nine groups listed above are
  recognized. Old names (`edit`, `command`, `modes`) are auto-translated to
  their canonical forms (`write`, `execute`, `mode`).
- **Tool names must exist.** Referencing a tool that doesn't exist (or was
  removed) will cause validation errors.

---

## Troubleshooting

| Symptom                                               | Likely Cause                                                      |
| ----------------------------------------------------- | ----------------------------------------------------------------- |
| Mode doesn't appear in the dropdown                   | YAML syntax error, or missing `slug`/`name`/`roleDefinition`      |
| AI says a tool is "not allowed" unexpectedly          | Check `tools_denied` — deny always wins                           |
| Write tools work on files that should be blocked      | `fileRegex` only applies to the `write` group; use scoped denied  |
| Custom mode takes effect but built-in still shows     | You overrode the slug correctly — the name changes but slug stays |
| "Either 'groups' or 'tools_allowed' must be provided" | Your mode has neither field; add at least one                     |

---

## See Also

- [`.shofermodes` JSON Schema reference](../schemas/shofermodes.json) — the
  machine-readable schema that enforces valid configuration.
- [Tool Access Control (developer reference)](../tool_access.md) — the
  detailed design doc covering schema, decision rule, and enforcement code.
- [Modes reference](../terminology.md#11-modes) — canonical list of built-in
  modes and their default group assignments.
- [Tool categories reference](../terminology.md#10-tool-groups-categories) —
  which tools belong to which group.
