# Shofer Special Files Reference

This document catalogs every file and directory that Shofer recognizes
and treats specially — either by loading its content into the system prompt,
enforcing access controls, or using it for configuration.

See also:

- [`configuration.md`](configuration.md) — VS Code settings reference
- [`tool_access.md`](tool_access.md) — mode-level tool access control
- [`settings_overlay.md`](settings_overlay.md) — settings merge order

---

## File Discovery Order

Shofer searches for rules and instructions in this order (project overrides global):

1. **Global** `~/.shofer/` (or `%USERPROFILE%\.shofer\` on Windows)
2. **Project-local** `<workspace>/.shofer/`
3. **Subfolder** `<workspace>/<subdir>/.shofer/` (alphabetically, when `shofer.enableSubfolderRules` is on)

The `.agents/` directory (Agent Skills standard) is also discovered at both levels.

---

## Workspace Root Files

### `.shofer/shoferignore`

| Property            | Details                            |
| ------------------- | ---------------------------------- |
| **Format**          | `.gitignore`-style patterns        |
| **Scope**           | Workspace root only                |
| **Watched**         | Yes — changes reload automatically |
| **Write-protected** | Yes                                |

Controls which files the LLM can access through its tools. Applies to:

- **Read tools**: `read_file`, `grep_search`, `list_files`, `find_files`
- **Write tools**: `write_to_file`, `edit_file`, `apply_diff`, `apply_patch`, `search_replace`, `sed`, `generate_image`
- **Execute tools**: `execute_command` (blocks file-reading commands like `cat`, `grep`, `head`, `tail`, `sed`, `awk`, `Get-Content`, `Select-String`, `gc`, `sls`, `type`, `less`, `more` that reference ignored files)
- **@-mentions**: Ignored files return `"(File is ignored by .shofer/shoferignore)"`; directory attachments filter or mark them with 🔒
- **Environment details**: Ignored files are excluded from the file listing injected into each user message

When a file is blocked by `.shofer/shoferignore`, read-tool results omit the file
and write/execute tools return an error indicating the path is ignored.
The exact wording varies by tool; the controller itself only exposes boolean
access checks and a formatted instructions block via
[`getInstructions()`](../src/core/ignore/ShoferIgnoreController.ts)
(surfaces `🔒`-badged entries for blocked files).

A UI setting ("Show .shofer/shoferignore'd files in lists and searches") controls
whether ignored files appear with a 🔒 badge or are hidden entirely from
file listings.

Implementation: [`ShoferIgnoreController`](../src/core/ignore/ShoferIgnoreController.ts)

---

### `.shofer/shofermodes`

| Property            | Details                                        |
| ------------------- | ---------------------------------------------- |
| **Format**          | YAML                                           |
| **Scope**           | Workspace root                                 |
| **Priority**        | Highest — overrides global `custom_modes.yaml` |
| **Watched**         | Yes — changes reload automatically             |
| **Write-protected** | Yes                                            |

Defines project-specific custom mode overrides. Example:

```yaml
customModes:
    - slug: "code"
      name: "💻 Code"
      roleDefinition: "You are Shofer, a custom code assistant..."
      customInstructions: |
          Use our team's code style guide...
      groups: ["read", "edit", "command", "mcp"]
      tools_allowed: ["update_todo_list"]
      tools_denied: ["execute_command"]
```

Modes defined here are tagged `source: "project"` and take precedence over
globally-defined modes with the same slug. The file is merged with the global
configuration by [`CustomModesManager`](../src/core/config/CustomModesManager.ts).

---

### `AGENTS.md` / `AGENT.md`

| Property            | Details                                        |
| ------------------- | ---------------------------------------------- |
| **Format**          | Markdown                                       |
| **Scope**           | Workspace root (and optionally subdirectories) |
| **Watched**         | No — read on task start and mode switch        |
| **Write-protected** | Yes                                            |
| **Feature flag**    | `shofer.useAgentRules` (default: `true`)       |

Implements the [Agent Rules](https://agent-rules.org/) standard. Content is
injected into the system prompt under the heading `# Agent Rules Standard (AGENTS.md):`.

Shofer supports `AGENTS.md` in:

- The workspace root
- Subdirectories containing a `.shofer/` folder (when `enableSubfolderRules` is on)

---

### `.vscode/**`

| Property            | Details                                                              |
| ------------------- | -------------------------------------------------------------------- |
| **Write-protected** | Yes                                                                  |
| **Readable**        | Yes (not blocked by `.shofer/shoferignore` unless explicitly listed) |

The `.vscode/` directory is write-protected — the LLM can read it but cannot
modify `settings.json`, `tasks.json`, `launch.json`, etc. without explicit approval.

---

### `*.code-workspace`

| Property            | Details |
| ------------------- | ------- |
| **Write-protected** | Yes     |

VS Code workspace files are write-protected.

---

## The `.shofer/` Directory (Project-Local)

```
<workspace>/
└── .shofer/
    ├── rules/                # Mode-agnostic rules
    ├── rules-<mode>/         # Mode-specific rules (e.g. rules-code/)
    ├── commands/             # Slash commands
    ├── skills/               # Project skills
    ├── skills-<mode>/        # Mode-specific skills
    ├── mcp.json              # Project MCP server configuration
    └── custom-instructions.md # Additional custom instructions
```

Everything under `.shofer/` is **write-protected**. The LLM must get explicit
approval to modify any file in this directory tree.

---

### `.shofer/rules/` — Mode-Agnostic Rules

| Property       | Details                                                      |
| -------------- | ------------------------------------------------------------ |
| **Format**     | Any text files (read recursively up to 5 levels)             |
| **Scope**      | Applies to ALL modes                                         |
| **Loaded**     | At task start and mode switch                                |
| **Load order** | Global rules first, then project rules, then subfolder rules |

All files in this directory are concatenated and injected into the system
prompt as:

```
# Rules from .shofer/rules/:

<file content>
---
# Rules from .shofer/rules/subdir/file.md:

<file content>
```

Symlinks are followed. Files are sorted alphabetically. Cache files
(matching `*.cache*`) are excluded.

---

### `.shofer/rules-{mode}/` — Mode-Specific Rules

| Property     | Details                                                         |
| ------------ | --------------------------------------------------------------- |
| **Format**   | Any text files (read recursively)                               |
| **Scope**    | Applies only when the specified mode is active                  |
| **Examples** | `rules-code/`, `rules-architect/`, `rules-debug/`, `rules-ask/` |

Example: `.shofer/rules-code/` rules only load in Code mode. When a
workspace `.shofer/rules-<mode>/` exists, it takes precedence over the
corresponding global directory.

**Legacy fallback (deprecated):**

- `.roorules-<mode>` (file) and `.clinerules-<mode>` (file) are still supported
  as fallbacks when `.shofer/rules-<mode>/` does not exist. These are
  deprecated and will be removed.

---

### `.shofer/commands/` — Slash Commands

| Property   | Details                                      |
| ---------- | -------------------------------------------- |
| **Format** | Markdown files (`.md`), one per command      |
| **Scope**  | Project only (global: `~/.shofer/commands/`) |
| **Loaded** | At task start                                |

Each `.md` file in this directory becomes a slash command available in the
chat interface. The filename (without extension) is the command name.

Files can include YAML front matter for metadata:

```markdown
---
description: "Deploy the current project to staging"
argumentHint: "environment name (staging|production)"
mode: "code"
---

# Deploy instructions...
```

The optional `mode` field in front matter causes the command to
automatically switch to that mode when invoked.

Symlinks are followed, allowing sharing of commands across projects.

---

### `.shofer/skills/` — Project Skills

| Property   | Details                                                           |
| ---------- | ----------------------------------------------------------------- |
| **Format** | Subdirectories, each containing `SKILL.md`                        |
| **Scope**  | Project only (global: `~/.shofer/skills/` or `~/.agents/skills/`) |

Each subdirectory under `skills/` represents a named skill. The skill name
is the directory name. The directory must contain a `SKILL.md` file with the
skill's instructions.

Both the `skills/` directory itself and individual skill subdirectories can
be symlinks.

Skills are presented to the LLM in the system prompt via `<available_skills>`
and are loaded on-demand via the `skills` tool.

---

### `.shofer/skills-{mode}/` — Mode-Specific Skills

| Property     | Details                                          |
| ------------ | ------------------------------------------------ |
| **Format**   | Same as `skills/`                                |
| **Scope**    | Only available when the specified mode is active |
| **Examples** | `skills-code/`, `skills-architect/`              |

Mode-specific skills take precedence over generic skills with the same name.

---

### `.shofer/mcp.json` — Project MCP Configuration

| Property            | Details                               |
| ------------------- | ------------------------------------- |
| **Format**          | JSON                                  |
| **Watched**         | Yes                                   |
| **Write-protected** | Yes                                   |
| **Git-ignored**     | Yes (contains env vars / credentials) |

Defines MCP servers for the project. This file is **automatically git-ignored**
by the Shofer extension to prevent accidental commits of server credentials.

Example:

```json
{
	"mcpServers": {
		"filesystem": {
			"command": "npx",
			"args": ["-y", "@anthropic/mcp-server-filesystem", "."],
			"disabled": false,
			"disabledTools": []
		}
	}
}
```

The global equivalent lives in the VS Code user settings directory
(typically `~/.config/Code/User/globalStorage/shofer.shofer/mcp_settings.json`).
It can also be managed through the Settings UI.

When installing MCP servers from the Shofer Marketplace, they are added
to `.shofer/mcp.json` for project-scoped installs.

---

### `.shofer/custom-instructions.md` — Custom Instructions

| Property   | Details                                   |
| ---------- | ----------------------------------------- |
| **Format** | Markdown                                  |
| **Scope**  | Applies to all modes (merged with global) |
| **Loaded** | At task start                             |

Additional custom instructions appended to the system prompt. The global
equivalent is `~/.shofer/custom-instructions.md`. Project content overrides
global content.

---

### `.shoferprotected`

| Property   | Details                 |
| ---------- | ----------------------- |
| **Format** | TBD                     |
| **Scope**  | Workspace root          |
| **Status** | Reserved for future use |

Reserved filename for future write-protection overrides. Currently defined in
the [`ShoferProtectedController`](../src/core/protect/ShoferProtectedController.ts)
protected patterns list but not yet loaded or used by any subsystem.

---

### `.shofer/worktrees/`

| Property           | Details                                                  |
| ------------------ | -------------------------------------------------------- |
| **Purpose**        | Internal — stores embedded worktree task state           |
| **Visible to LLM** | Yes (readable, but inside `.shofer/` so write-protected) |

Used by the checkpoint system to scope shadow git repos for worktree tasks.
Each embedded worktree gets a subdirectory here. Excluded from non-scoped
shadow git tracking so sibling worktrees don't contaminate each other.

---

## Global `~/.shofer/`

The global configuration directory at `~/.shofer/` (Linux/macOS) or
`%USERPROFILE%\.shofer\` (Windows) mirrors the project `.shofer/` structure:

```
~/.shofer/
├── rules/                # Global mode-agnostic rules
├── rules-<mode>/         # Global mode-specific rules
├── commands/             # Global slash commands
├── skills/               # Global skills
├── skills-<mode>/        # Global mode-specific skills
└── custom-instructions.md # Global custom instructions
```

Global paths are loaded **before** project paths, so project-level
configuration can override global settings.

---

## Global `~/.agents/`

The [Agent Skills](https://agentskills.io/) standard directory:

```
~/.agents/
└── skills/               # Cross-tool skill definitions
```

Shofer discovers skills from both `~/.shofer/skills/` and `~/.agents/skills/`,
with `.shofer/skills/` taking priority.

---

## Legacy Compatibility Files (Deprecated)

These legacy filenames are still supported but will be removed in a future
release. Users should migrate to the `.shofer/` equivalents.

| Legacy File               | Modern Equivalent       | Type             |
| ------------------------- | ----------------------- | ---------------- |
| `.rooignore`              | `.shofer/shoferignore`  | File             |
| `.roorules`               | `.shofer/rules/`        | File → Directory |
| `.roorules-<mode>`        | `.shofer/rules-<mode>/` | File → Directory |
| `.clinerules`             | `.shofer/rules/`        | File → Directory |
| `.clinerules-<mode>`      | `.shofer/rules-<mode>/` | File → Directory |
| `cline_mcp_settings.json` | `.shofer/mcp.json`      | File             |

**Fallback behavior**: Shofer checks the modern path first. If it doesn't
exist, it falls back to the legacy name(s). For rules, the directory form
(`.shofer/rules/`) takes priority over legacy file forms (`.roorules`,
`.clinerules`).

---

## Settings Export/Import

### `shofer-code-settings.json`

| Property        | Details                                       |
| --------------- | --------------------------------------------- |
| **Format**      | JSON                                          |
| **Purpose**     | Export/import of Shofer settings              |
| **Auto-import** | Supported via `shofer.autoImportSettingsPath` |

The settings export file bundles API provider configs, custom modes,
MCP server definitions, and other settings. The VS Code setting
`shofer.autoImportSettingsPath` can point to such a file for automatic
import on extension startup.

---

## Summary: Write-Protected Files

These files cannot be modified by the LLM without explicit user approval
(even when auto-approve is enabled):

| Pattern                | Examples                                                        |
| ---------------------- | --------------------------------------------------------------- |
| `.shofer/shoferignore` | `.shofer/shoferignore`                                          |
| `.shofer/shofermodes`  | `.shofer/shofermodes`                                           |
| `.shofer/**`           | `.shofer/rules/`, `.shofer/commands/`, `.shofer/mcp.json`, etc. |
| `.vscode/**`           | `.vscode/settings.json`, `.vscode/tasks.json`                   |
| `*.code-workspace`     | `my-project.code-workspace`                                     |
| `AGENTS.md`            | `AGENTS.md`, `AGENT.md`                                         |

Implementation: [`ShoferProtectedController`](../src/core/protect/ShoferProtectedController.ts)

---

## Summary: Files Read Into System Prompt

| File/Directory           | Section in Prompt                     | When                        |
| ------------------------ | ------------------------------------- | --------------------------- |
| `AGENTS.md`              | `# Agent Rules Standard`              | Task start, mode switch     |
| `.shofer/rules/`         | `# Rules from .shofer/rules/`         | Task start, mode switch     |
| `.shofer/rules-<mode>/`  | `# Rules from .shofer/rules-<mode>/`  | Mode-specific, task start   |
| `.shofer/commands/`      | Slash command palette                 | Task start                  |
| `.shofer/skills/`        | `<available_skills>`                  | Task start                  |
| `.shofer/shoferignore`   | `# .shofer/shoferignore` instructions | Task start (if file exists) |
| Custom instructions (UI) | `USER'S CUSTOM INSTRUCTIONS`          | Every system prompt         |

---

## Gaps, Issues & Areas for Improvement

This section documents inaccuracies and gaps discovered during a full audit
of this document against the live codebase (2026-05-20). Issues are listed
for transparency; some have been corrected inline above.

### 1. Fabricated `.shofer/shoferignore` error message (corrected)

The doc previously quoted a specific error message for blocked file access
that did not exist anywhere in the source code. `ShoferIgnoreController`
returns booleans (or `undefined` for commands); no tool produces the quoted
wording. Replaced with a factual description of the controller's API.

### 2. `ShoferIgnoreController` is dead code

[`ShoferIgnoreController`](../src/core/ignore/ShoferIgnoreController.ts)
is defined but **never imported or instantiated** anywhere in the `extensions/`
directory. The `.shofer/shoferignore` enforcement path is either implemented
elsewhere (e.g., in the worktree extensions) or not yet wired. If the file
is truly unused, it should be removed or integrated.

### 3. Duplicate `.shoferrules*` in `PROTECTED_PATTERNS`

[`ShoferProtectedController.PROTECTED_PATTERNS`](../src/core/protect/ShoferProtectedController.ts:16-27)
lists `.shoferrules*` twice (lines 18-19). Harmless but redundant.

### 4. Missing patterns in write-protected summary table

The write-protected summary table (§ Summary: Write-Protected Files) does
not list `.shoferrules*` or `.shoferprotected`, even though both are in
`PROTECTED_PATTERNS`. `.shoferrules*` is NOT covered by `.shofer/**` because
`.shoferrules*` files live at the workspace root. The table should list all
protected patterns.

### 5. `.shoferprotected` is reserved but has a pattern entry

§ `.shoferprotected` is documented as "Reserved for future use" (TBD format).
However, it is already an active entry in `PROTECTED_PATTERNS`, meaning
any file named `.shoferprotected` at the workspace root would be
write-protected today, despite no subsystem loading it.

### 6. Legacy rules files NOT in legacy compatibility table

§ Legacy Compatibility Files does not list `.shoferrules` / `.shoferrules-<mode>`
as a legacy filename, yet `.shoferrules*` is in `PROTECTED_PATTERNS`.
Either this was an intentional intermediate rebrand name or it should be
documented alongside `.roorules` / `.clinerules`.
