# Shofer Special Files — User Guide

Shofer recognizes certain files and directories in your project that change how it behaves. Some files control what the AI can see, others add custom instructions or skills, and some are write-protected so the AI cannot accidentally modify them.

This guide explains what each file does and how to use it.

## Quick Reference

| File / Directory        | What it does                               | Where to put it                |
| ----------------------- | ------------------------------------------ | ------------------------------ |
| `.shoferignore`         | Hides files from the AI                    | Workspace root                 |
| `.shofermodes`          | Adds custom AI modes for this project      | Workspace root                 |
| `.shofer/rules/`        | Adds rules the AI always follows           | Project or global `~/.shofer/` |
| `.shofer/rules-<mode>/` | Adds rules for a specific mode             | Project or global `~/.shofer/` |
| `.shofer/commands/`     | Adds slash commands                        | Project or global `~/.shofer/` |
| `.shofer/skills/`       | Adds domain-specific skills                | Project or global `~/.shofer/` |
| `.shofer/mcp.json`      | Configures MCP tools for this project      | Workspace `.shofer/` directory |
| `AGENTS.md`             | Instructions injected into the AI's prompt | Workspace root                 |
| `~/.shofer/`            | Global config (applies to all projects)    | Your home directory            |

## Write-Protected Files

The AI **cannot modify** these files without your explicit approval, even if you've enabled auto-approval:

- `.shoferignore`
- `.shofermodes`
- Everything inside `.shofer/`
- `.vscode/settings.json` and friends
- `*.code-workspace` files
- `AGENTS.md`

---

## `.shoferignore` — Hiding Files from the AI

### What it does

`.shoferignore` works like `.gitignore`, but instead of git, it controls what files the AI can **read, search, or write to**. Files matching the patterns are invisible to Shofer's tools.

### Format

Same syntax as `.gitignore` — one pattern per line:

```gitignore
# Hide large binaries
*.zip
*.tar.gz

# Hide secrets
.env
*.key

# Hide generated code
dist/
node_modules/
```

### What it affects

- **Read tools**: `read_file`, `grep_search`, `list_files`, `find_files` skip ignored files.
- **Write tools**: `write_to_file`, `apply_diff`, `sed` will refuse to touch ignored files.
- **Commands**: Shell commands like `cat`, `grep`, `head` that access ignored files are blocked.
- **File listings**: Ignored files won't appear in the file listing the AI sees each turn.

### The "Show ignored files" setting

There is a UI toggle in Settings called **"Show .shoferignore'd files in lists and searches."**

- **On (default)**: Ignored files still appear in directory listings but with a 🔒 badge. The AI knows the file exists but can't read it.
- **Off**: Ignored files are completely hidden from listings.

<!-- XXX: Screenshot — Settings panel showing the "Show .shoferignore'd files in lists and searches" toggle, ideally with the 🔒 badge visible in a file listing behind it. -->

---

## `AGENTS.md` — Custom Instructions

### What it does

Put an `AGENTS.md` file at the root of your project with instructions, conventions, or rules for the AI. Its contents are injected into the system prompt every time you start a task or switch modes.

### Example

```markdown
# Project Rules

- Use TypeScript strict mode.
- Prefer async/await over raw Promises.
- Tests must live in `__tests__/` folders alongside source files.
- Never use `any` without a comment explaining why.
```

The AI sees this content under a heading like `# Agent Rules Standard (AGENTS.md)` in its system prompt.

### File naming

Shofer looks for either `AGENTS.md` or `AGENT.md` (both work).

---

## `.shofer/rules/` — Mode-Agnostic Rules

### What it does

Put any text files (`.md`, `.txt`, `.yaml`, etc.) in `.shofer/rules/` and their contents are loaded into the AI's system prompt. These rules apply to **all modes**.

### Example structure

```
my-project/
└── .shofer/
    ├── rules/
    │   ├── coding-standards.md     ← Always loaded
    │   ├── api-conventions.md      ← Always loaded
    │   └── deployment/
    │       └── staging.md          ← Also loaded (recursive, up to 5 levels)
    └── rules-code/
        └── code-only-rule.md       ← Only in Code mode
```

### Global vs project

- **Project rules** go in `<project>/.shofer/rules/`.
- **Global rules** go in `~/.shofer/rules/` (applied to every project).

Project rules **override** global rules. If both define the same thing, the project version wins.

---

## `.shofer/rules-<mode>/` — Mode-Specific Rules

### What it does

Rules that only apply when a specific mode is active.

| Directory                       | Active in         |
| ------------------------------- | ----------------- |
| `.shofer/rules-code/`           | 💻 Code mode      |
| `.shofer/rules-architect/`      | 🏗️ Architect mode |
| `.shofer/rules-debug/`          | 🪲 Debug mode     |
| `.shofer/rules-ask/`            | ❓ Ask mode       |
| `.shofer/rules-reviewer/`       | 👀 Reviewer mode  |
| (and so on for any custom mode) |                   |

### Example

Create `.shofer/rules-code/no-eval.md`:

```markdown
# Code Mode Rule

Never use `eval()` or `new Function()`. Use JSON.parse instead.
```

This rule **only** applies when the AI is in Code mode.

---

## `.shofer/commands/` — Slash Commands

### What it does

Create `.md` files in `.shofer/commands/` and they become **slash commands** you can type in the chat input. The filename (without `.md`) is the command name.

### Example

Create `.shofer/commands/deploy.md`:

```markdown
---
description: "Deploy the current project to staging"
argumentHint: "environment name (staging|production)"
mode: "code"
---

# Deploy Instructions

1. Run `npm run build` to compile.
2. Run `npm run deploy -- --env $ARGUMENTS` to push.
3. Verify the deployment by pinging the health endpoint.
```

Now type `/deploy staging` in chat and the AI will follow these steps.

### Front matter fields

| Field          | Purpose                                                       |
| -------------- | ------------------------------------------------------------- |
| `description`  | What the command does (shown in the command picker)           |
| `argumentHint` | Hint for what arguments to type after the command name        |
| `mode`         | Automatically switch to this mode when the command is invoked |

<!-- XXX: Screenshot — Chat input bar with the slash command palette open, showing `/deploy` and `/lint` as available commands with their descriptions. -->

---

## `.shofer/skills/` — Project Skills

### What it does

Skills are reusable instructions for specific tasks. Each skill is a subdirectory containing a `SKILL.md` file.

### Example structure

```
my-project/
└── .shofer/
    └── skills/
        └── pdf-extractor/
            └── SKILL.md          ← Instructions for extracting data from PDFs
```

### How they work

1. Shofer discovers skills at startup and lists them in the system prompt.
2. The AI can load a skill on-demand using the `skills` tool.
3. Mode-specific variants go in `.shofer/skills-<mode>/` (e.g., `.shofer/skills-code/`).

### Global skills

You can also install skills globally at `~/.shofer/skills/` or `~/.agents/skills/` (the [Agent Skills](https://agentskills.io/) standard). Project skills take priority over global ones.

---

## `.shofer/mcp.json` — Project MCP Configuration

### What it does

Defines MCP (Model Context Protocol) servers for this project. This file is **automatically git-ignored** by the Shofer extension to prevent committing API keys or credentials.

### Example

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

### When to use

- You want MCP tools available in this specific project.
- You're installing an MCP server from the Shofer Marketplace.

For global MCP servers (available in all projects), use the Settings UI instead.

---

## `.shofermodes` — Custom Modes

### What it does

Define your own AI modes for a project. Modes control which tools the AI can use, what instructions it follows, and how it behaves.

### Example

```yaml
customModes:
    - slug: "documentation"
      name: "📝 Tech Writer"
      roleDefinition: "You are a technical writer producing clear, concise documentation."
      customInstructions: |
          Follow the Google Developer Documentation Style Guide.
          Use sentence case for headings.
      groups: ["read", ["write", { fileRegex: "\\.(md|txt)$", description: "Docs only" }]]
      tools_allowed: ["update_todo_list"]
```

### Key fields

| Field                | Purpose                                            |
| -------------------- | -------------------------------------------------- |
| `slug`               | Unique ID (use `documentation`, not `📝 docs`)     |
| `name`               | Display name with emoji                            |
| `roleDefinition`     | Tells the AI what it is ("You are a tech writer…") |
| `groups`             | Which tool groups the mode can use                 |
| `tools_allowed`      | Extra tools beyond the groups                      |
| `tools_denied`       | Tools to explicitly block                          |
| `customInstructions` | Extra rules for this mode                          |

### Global vs project

- **Project modes** defined in `.shofermodes` at the workspace root override global modes with the same slug.
- **Global modes** are managed through the Settings UI (stored as `custom_modes.yaml`).

The project file wins when both define a mode with the same slug.

---

## File Discovery Order

Shofer loads configuration in this order (later overrides earlier):

1. **Global** `~/.shofer/` (applies to all projects)
2. **Project** `<workspace>/.shofer/` (overrides global)
3. **Subfolder** `<workspace>/<subdir>/.shofer/` (when enabled, processed alphabetically)

---

## Legacy Files (Still Supported)

These older filenames still work but will be removed in the future. Migrate to the modern equivalents:

| Old File                  | Move To                 |
| ------------------------- | ----------------------- |
| `.rooignore`              | `.shoferignore`         |
| `.roorules`               | `.shofer/rules/`        |
| `.roorules-<mode>`        | `.shofer/rules-<mode>/` |
| `.clinerules`             | `.shofer/rules/`        |
| `.clinerules-<mode>`      | `.shofer/rules-<mode>/` |
| `cline_mcp_settings.json` | `.shofer/mcp.json`      |
