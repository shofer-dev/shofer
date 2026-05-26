# Shofer User Manual

Welcome to Shofer. This manual covers the concepts and configuration you need to use Shofer effectively.

---

## Table of Contents

1. [Getting Started](#1-getting-started)
2. [Settings](#2-settings)
3. [Custom Modes](#3-custom-modes)
4. [Auto-Approval](#4-auto-approval)
5. [Parallel Tasks & Sub-tasks](#5-parallel-tasks--sub-tasks)
6. [MCP Servers](#6-mcp-servers)
7. [Semantic Code Search (RAG)](#7-semantic-code-search-rag)
8. [Skills](#8-skills)
9. [Git Worktrees](#9-git-worktrees)
10. [Per-Task Cost Limit](#10-per-task-cost-limit)
11. [Context Management & Condensation](#11-context-management--condensation)
12. [Special Files](#12-special-files)
13. [Privacy & Telemetry](#13-privacy--telemetry)
14. [Migrating from Roo-Code](#14-migrating-from-roo-code)
15. [Assistant Agent](#15-assistant-agent)
16. [Migrating from GitHub Copilot](#16-migrating-from-github-copilot)
17. [Community](#17-community)

---

## 1. Getting Started

## Home Screen

<img src="src/media/walkthrough/images/WelcomeView.png" alt="Shofer Welcome Screen" width="500" />

| UI Element              | Purpose                                                           |
| ----------------------- | ----------------------------------------------------------------- |
| **Chat View**           | Interact with the AI — type messages, see results                 |
| **Task Selector**       | Switch between multiple parallel tasks in a tree hierarchy        |
| **Mode Selector**       | Choose Code, Architect, Ask, Debug, Orchestrator, or custom modes |
| **API Config Selector** | Pick which AI provider and model to use per task                  |
| **Worktree Selector**   | Create and select git worktrees for isolated parallel work        |
| **File Changes Panel**  | Review, accept, revert, or diff every file Shofer modifies        |
| **Context Window Bar**  | Monitor token usage and cost for the current task                 |

### Modes

Shofer ships with five built-in modes that control what tools and models the AI can use:

| Mode               | Icon | Best For                                                         |
| ------------------ | ---- | ---------------------------------------------------------------- |
| **Code** (default) | 💻   | Writing, modifying, and refactoring code.                        |
| **Architect**      | 🏗️   | Planning and designing before writing code.                      |
| **Ask**            | ❓   | Getting explanations, answers, or recommendations.               |
| **Debug**          | 🪲   | Troubleshooting errors and diagnosing root causes.               |
| **Orchestrator**   | 🪃   | Coordinating complex multi-step work by delegating to sub-tasks. |

You can add any number of custom modes via [`.shofermodes`](#3-custom-modes). Common examples include a read-only **Reviewer**, a fast **Search** agent, or a **Browser** mode for web interaction.

### API Provider Profiles

<img src="src/media/walkthrough/images/provider.png" alt="API Provider Settings" width="280" />

An API Provider Profile bundles your API key, model selection, and endpoint URL into a named configuration. Switch between profiles via the API Config Selector dropdown. Each task remembers its profile — switching tasks restores that task's profile.

---

## 2. Settings

### VS Code Settings UI

Most settings appear under `shofer.*` in the VS Code Settings editor (⌘, / `Ctrl+,`). Browse by typing `shofer.` in the search bar.

### JSON-Only Settings

These settings must be added to `settings.json` directly:

| Setting                          | Purpose                                  | Default           |
| -------------------------------- | ---------------------------------------- | ----------------- |
| `shofer.defaultCostLimit`        | Per-task USD budget cap                  | `null` (disabled) |
| `shofer.disabledTools`           | Globally disable specific tools          | `[]`              |
| `shofer.useAgentRules`           | Load `AGENTS.md` rule files from project | `true`            |
| `shofer.commandExecutionTimeout` | Max seconds for command execution        | `0` (no timeout)  |
| `shofer.commandTimeoutAllowlist` | Commands exempt from timeout             | `[]`              |

### Settings Backup & Reset

Settings → About → **Export** saves your full configuration as `shofer-code-settings.json` (API profiles, keys, modes, auto-approval). **Import** restores from a previous export. **Reset** wipes everything to defaults. MCP server configs are NOT included in export — copy `mcp_settings.json` separately from your data directory.

---

## 3. Custom Modes

Define custom modes in a `.shofermodes` file at your project root (or globally at `~/.shofer/.shofermodes`).

### Tool Access Fields

| Field           | Purpose                                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------------------- |
| `groups`        | Grants broad categories of tools (`read`, `write`, `execute`, `mcp`, `browser`, `mode`, `subtasks`, `questions`) |
| `tools_allowed` | Grants individual tools outside the listed groups                                                                |
| `tools_denied`  | Unconditionally blocks specific tools (always wins)                                                              |

**Rule:** `(in groups OR in tools_allowed) AND NOT in tools_denied`

### Examples

**Read-only reviewer:**

```yaml
customModes:
    - slug: my-reviewer
      name: 🔍 My Reviewer
      roleDefinition: You are a code reviewer. You read code, find issues, and propose fixes — but you never edit files.
      groups:
          - read
```

**Docs-only editor (write restricted to Markdown):**

```yaml
- slug: docs-editor
  name: 📝 Docs Editor
  roleDefinition: You write and edit documentation.
  groups:
      - read
      - - write
        - fileRegex: "\\.(md|mdx)$"
```

A mode must have at least `groups` or `tools_allowed`. Project-level modes override global modes with the same slug.

---

## 4. Auto-Approval

Auto-approval controls when Shofer acts without asking permission. Configure it via the **AutoApproveDropdown** (shield icon) in the chat input bar.

### Toggles

| Toggle        | Controls                                           |
| ------------- | -------------------------------------------------- |
| **Read-Only** | Reading files, searching code, listing directories |
| **Write**     | Creating, editing, deleting files                  |
| **Execute**   | Running shell commands                             |
| **Browser**   | Browser automation tools                           |
| **MCP**       | MCP tool calls and resource access                 |
| **Mode**      | Switching between modes                            |
| **Subtasks**  | Spawning and managing background tasks             |
| **Questions** | Auto-selecting follow-up question answers          |

Each mode has its own set of toggles. Toggling Read-Only ON in Code mode does not affect Architect mode.

### Command Allowlisting

The **Execute** toggle requires a list of allowed command prefixes to have any effect. When enabled, each shell command is matched against the allowlist using a "longest prefix wins" rule. A denylist can override specific commands.

**Security:** Start with toggles OFF and enable incrementally. Use the denylist for destructive commands (`rm`, `git push --force`). Keep "Protected Files" and "Outside Workspace" options OFF unless you genuinely need them.

---

## 5. Parallel Tasks & Sub-tasks

Shofer can run multiple tasks at the same time. Start a new task from the title bar — your current task moves to the background.

### Background Sub-tasks

The model can spawn background children via `new_task` with `is_background: true`. The parent continues working and polls results:

| Tool                      | Purpose                                    |
| ------------------------- | ------------------------------------------ |
| `check_task_status`       | Query a child's state without blocking     |
| `wait_for_task`           | Block until one or more children finish    |
| `list_background_tasks`   | List all running children                  |
| `cancel_tasks`            | Stop children early                        |
| `answer_subtask_question` | Answer a question a background child asked |

When a background child needs clarification, its question is routed to the **parent task** (not to you). Canceling a parent automatically cancels all its children.

### Limits

- Background tasks are aborted when their parent finishes or is stopped.
- After a VS Code restart, running tasks are reset to Idle.

---

## 6. MCP Servers

Connect external tools via MCP (Model Context Protocol) servers. Configure them in Settings → Tools → MCP Servers (global) or `.shofer/mcp.json` (project).

### Configuration

**Local Node.js server (stdio):**

```json
{
	"my-tools": {
		"type": "stdio",
		"command": "node",
		"args": ["./mcp-servers/my-tools/dist/server.js"],
		"timeout": 60
	}
}
```

**Remote HTTP server:**

```json
{
	"arkware-tools": {
		"type": "streamable-http",
		"url": "http://localhost:30089"
	}
}
```

### Tool Group Assignment

Assign tool groups to control auto-approval per tool:

```json
{
	"readonly-server": {
		"command": "node",
		"args": ["server.js"],
		"toolGroups": {
			"search_tool": "read",
			"fetch_tool": "read"
		}
	}
}
```

Disable individual tools with `disabledTools`, or an entire server with `"disabled": true`. Config files are watched automatically — saving triggers a reconnect.

---

## 7. Semantic Code Search (RAG)

Shofer can build a semantic search index of your codebase using Qdrant and an embedding provider. Once configured, the agent can use `rag_search` to find code by meaning.

### Setup

1. Have a running Qdrant instance.
2. Choose an embedding provider (OpenAI, Ollama, Gemini, etc.) in Settings → RAG / Code Index.
3. Enter credentials and enable indexing.

Shofer scans workspace files, builds embeddings, and stores them in Qdrant. The indexing status badge in the chat input bar shows progress.

`rag_search` complements `lsp_search` (symbol search) and `grep_search` (text search) — the agent picks the right tool automatically. Git commit history can also be indexed via the same infrastructure (Settings → RAG / Code Index → Git History).

---

## 8. Skills

Skills are reusable instruction packs for specific tasks. Each skill is a folder with a `SKILL.md` file.

### Where Skills Live

| Directory                   | Scope   |
| --------------------------- | ------- |
| `{project}/.shofer/skills/` | Project |
| `~/.shofer/skills/`         | Global  |

### Creating a Skill

```
.shofer/skills/
└── my-skill/
    └── SKILL.md
```

`SKILL.md` uses YAML frontmatter followed by markdown instructions:

```markdown
---
name: my-skill
description: Brief description (1-1024 characters)
modeSlugs:
    - code
    - architect
---

# My Skill

Full instructions Shofer will follow when this skill is loaded...
```

Skills are discovered automatically. Use the 🎓 button in the chat input bar to browse and load them. Project-level skills override global skills with the same name.

---

## 9. Git Worktrees

Shofer manages git worktrees for parallel tasks, letting multiple tasks run on different branches simultaneously in the same VS Code window. Worktrees live under `.shofer/worktrees/`.

### Creating a Worktree

1. Click the branch chip in the chat input bar.
2. Click "Create new worktree…".
3. Confirm the branch and path (auto-generated).
4. A new task spawns automatically in that worktree.

### `.worktreeinclude`

By default, only tracked git files are present in a new worktree. Create a `.worktreeinclude` file to specify which gitignored files (e.g., `node_modules/`) to copy automatically. Only files matching **both** `.gitignore` and `.worktreeinclude` are copied.

Manage worktrees from Settings → Worktrees (view, delete, force-delete with uncommitted changes). Multi-root workspaces are not supported.

**Important:** Merging and rebasing should be done manually. For safety, Shofer only provides create, delete, and select operations on worktrees — it does not merge, rebase, or push.

---

## 10. Per-Task Cost Limit

Set a USD budget cap on any task. When reached, Shofer pauses, aborts, or kills the task.

### Configuration

Set a global default in `settings.json`:

```json
{
	"shofer.defaultCostLimit": {
		"maxUsd": 1.0,
		"action": "pause"
	}
}
```

Edit a running task's cap by clicking the pencil icon next to the cost display in the Task Header. Actions: `pause` (ask you what to do), `abort` (clean stop), `kill` (immediate stop).

The displayed cost includes all descendant sub-tasks. Cost tracking requires the Shofer LLM Model Provider extension (`shofer.enableLlmProviderIntegration`).

---

## 11. Context Management & Condensation

When a conversation approaches the model's context window limit, Shofer automatically **condenses** older messages into a summary, freeing space for new work. The context window bar in the Task Header shows current usage.

Adjust the auto-condensation threshold:

```json
{
	"shofer.autoCondenseContextPercent": 85
}
```

Condensation preserves file structure signatures, active workflows, and a conversation summary. If condensation fails, Shofer falls back to truncating the oldest messages.

---

## 12. Special Files

Shofer recognizes these files in your project:

| File / Directory        | Purpose                                       | Location               |
| ----------------------- | --------------------------------------------- | ---------------------- |
| `.shoferignore`         | Hides files from the AI (`.gitignore` syntax) | Workspace root         |
| `.shofermodes`          | Custom AI modes for this project              | Workspace root         |
| `AGENTS.md`             | Project rules injected into every task        | Workspace root         |
| `.shofer/rules/`        | Mode-agnostic rules (always active)           | Project or `~/.shofer` |
| `.shofer/rules-<mode>/` | Rules active only in a specific mode          | Project or `~/.shofer` |
| `.shofer/commands/`     | Slash commands                                | Project or `~/.shofer` |
| `.shofer/skills/`       | Domain-specific skills                        | Project or `~/.shofer` |
| `.shofer/mcp.json`      | MCP server config for this project            | Workspace `.shofer/`   |

### Write-Protected Files

The AI cannot modify these files without explicit approval: `.shoferignore`, `.shofermodes`, everything inside `.shofer/`, `.vscode/settings.json`, `*.code-workspace`, `AGENTS.md`.

### `.shoferignore`

Same syntax as `.gitignore`. Files matching the patterns are invisible to Shofer's tools. The "Show ignored files" setting (in Settings) controls whether ignored files appear in directory listings with a 🔒 badge.

---

## 13. Privacy & Telemetry

Shofer collects anonymous product signals only (mode usage, tool names, token counts, sanitized errors). **We never collect your code, prompts, or personally identifiable information.**

Choose whether to share data on first launch, or toggle in Settings → Notifications at any time. Shofer also respects VS Code's global `telemetry.telemetryLevel` — if set to anything other than `"all"`, Shofer telemetry is fully disabled regardless of the Shofer-specific toggle.

---

## 14. Migrating from Roo-Code

Key differences for Roo-Code users:

| Area                | Roo-Code                             | Shofer                              |
| ------------------- | ------------------------------------ | ----------------------------------- |
| **Tasks**           | One at a time                        | Multiple concurrent tasks           |
| **Sub-tasks**       | Blocks parent until done             | Background tasks run independently  |
| **Auto-approval**   | "BRRR" (YOLO)                        | Per-category toggles                |
| **Message queuing** | Lost while busy                      | Queue with Send Now                 |
| **Checkpoints**     | Disabled with nested repos           | Works via GIT_DIR isolation         |
| **Worktrees**       | Separate VS Code window per worktree | Embedded in one window              |
| **Skills**          | Manual, forgets on switch            | Persisted per-task, auto-rehydrated |
| **File changes**    | Git shadow-repo dependency           | Working-directory snapshots         |
| **Default mode**    | Architect                            | Code                                |

Shofer also adds: background sub-tasks, per-task cost limits, semantic code search (RAG), git commit history search, an assistant agent for persistent codebase knowledge, task export (Markdown & JSON), drag-and-drop file context, and per-task input drafts.

---

## 15. Assistant Agent

The **Assistant Agent** is a persistent, read-only AI companion that accumulates codebase knowledge over time — surviving task completion and VS Code restarts.

### What It Does

- Runs on a **low-cost model with a large context window** (you choose the model)
- Conversation history persists across tasks and VS Code restarts
- Learns organically — each question asked by a task adds context
- **Strictly read-only** — can only read files, search code, and look up symbols. Cannot write, execute, or use MCP tools

### How Tasks Use It

Any task can call the `ask_assistant_agent` tool to ask the Assistant Agent a question. The agent answers from its accumulated knowledge, saving the calling task from re-loading files into its own context window.

### Setup

1. Open **Settings** → enable the Assistant Agent
2. Link an **API Configuration profile** with a lightweight model (e.g., Gemini Flash, GPT-4o-mini, Claude Haiku)
3. The agent starts with an empty context and fills it as tasks ask questions

The **Assistant Agent Status** badge in the Shofer sidebar shows whether the agent is active and processing.

### Key Benefits

- **Context reuse** — knowledge persists across tasks, no redundant file loading
- **Cost efficient** — uses a cheap model; each answer costs a fraction of a cent
- **KV-cache friendly** — append-only context window keeps the provider's attention cache warm
- **File-aware** — notified of file changes to keep its knowledge fresh

[Read the full Assistant Agent documentation](https://github.com/shofer-dev/shofer/blob/master/docs/assistant_agent.md)

---

## 16. Migrating from GitHub Copilot

Key differences for Copilot users:

- **You own the models** — use Anthropic, OpenRouter, DeepSeek, or local models via Ollama
- **You own the infrastructure** — everything runs locally, including semantic indexing
- **Your code stays local** — or to the provider of your choice, no vendor lock-in
- **Higher degree of customization** — adjust every aspect exactly to your needs
- **Open-source and community-driven** — contribute and shape the future of Shofer
- **Cost control** — set per-task cost limits and monitor usage
- **Parallel tasks** — run multiple conversations simultaneously
- **Fine-grained tool access control** — via customizable modes and auto-approval settings
- **Git worktrees** — keep parallel tasks separate across multiple branches

Run `/migrate-from-copilot` to automatically migrate your Copilot configuration (`.github/copilot-instructions.md`, agents, skills, instructions) to Shofer equivalents.

[Read the full Copilot → Shofer guide](https://github.com/shofer-dev/shofer/blob/master/docs/shofer_for_copilot_users.md)

---

## 17. Community

- **[Discord](https://discord.gg/x39UEEQ2)** — Chat with the team, get help, share feedback
- **[Reddit](https://reddit.com/r/Shofer_dev)** — Community discussions and tips
- **[GitHub Discussions](https://github.com/shofer-dev/shofer/discussions)** — Feature requests and ideas
- **[GitHub Issues](https://github.com/shofer-dev/shofer/issues)** — Bug reports and tracking

Shofer is open source (Apache 2.0). Contributions are welcome — read [`CONTRIBUTING.md`](https://github.com/shofer-dev/shofer/blob/main/CONTRIBUTING.md) and check the [roadmap](https://github.com/orgs/shofer/projects/1).
