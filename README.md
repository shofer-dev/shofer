# Shofer

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=Shoferdev.shofer"><img src="https://raster.shields.io/badge/VS_Code_Marketplace-007ACC?style=flat&logo=visualstudiocode&logoColor=white" alt="VS Code Marketplace" height="20"></a>
  <a href="https://discord.gg/x39UEEQ2"><img src="https://raster.shields.io/badge/Join%20Discord-5865F2?style=flat&logo=discord&logoColor=white" alt="Discord" height="20"></a>
  <a href="https://reddit.com/r/Shofer_dev"><img src="https://raster.shields.io/badge/Join%20r%2FShofer__dev-D84315?style=flat&logo=reddit&logoColor=white" alt="Reddit" height="20"></a>
</p>

<p align="center">
  <strong>Shofer is the open-source agentic coding platform for VS Code.</strong><br>
  Specify multi-agent workflows declaratively, watch them execute as live diagrams, and confine them at the kernel and the dollar — on a foundation of parallel tasks, custom modes, MCP, and bring-your-own-model.
</p>

<p align="center">
  <img width="100%" alt="Shofer running inside VS Code" src="src/media/walkthrough/images/WelcomeView.png">
</p>

<p align="center">
  <a href="https://shofer.dev">Website</a> ·
  <a href="https://github.com/shofer-dev/shofer/blob/master/USER_MANUAL.md">Docs</a> ·
  <a href="https://marketplace.visualstudio.com/items?itemName=Shoferdev.shofer">Install</a> ·
  <a href="https://github.com/shofer-dev/shofer">GitHub</a> ·
  <a href="https://github.com/shofer-dev/shofer/blob/master/docs/migration/shofer_for_roocode_users.md">Roo-Code Migration</a> ·
  <a href="https://github.com/shofer-dev/shofer/blob/master/docs/migration/shofer_for_copilot_users.md">Copilot Migration</a> ·
  <a href="https://github.com/shofer-dev/shofer/blob/master/docs/migration/shofer_for_claude_code_users.md">Claude Code Migration</a> ·
  <a href="https://github.com/shofer-dev/shofer/blob/master/docs/migration/shofer_for_opencode_users.md">OpenCode Migration</a>
</p>

<p align="center">
  Deterministic multi-agent workflows · live agent visualization · kernel-level sandboxing · code + git-history search — plus 50+ tools, custom modes, parallel tasks, and BYO model. Open source under <a href="https://github.com/shofer-dev/shofer/blob/master/LICENSE">Apache 2.0</a>.
</p>

## What Sets Shofer Apart

Parallel tasks, custom modes, MCP, and bring-your-own-model are strong — and, honestly, table stakes for a modern agent. What's harder to find anywhere else:

- **Deterministic multi-agent workflows** — specify a pipeline declaratively in a [`.slang`](docs/slang_specs.md) file (agents, message routing, control flow, `converge`, budgets). A non-LLM executor drives it, so runs are repeatable and inspectable — not ad-hoc runtime delegation.
- **Live agent visualization** — watch the agent tree execute: [topology, sequence, and swimlane diagrams](docs/workflow_visualization.md), an active-time/cost **Stats** breakdown across the whole tree, and a filterable **Logs** tab — all in-editor.
- **Kernel-level command sandboxing** — shell commands run in an OS-level write-only sandbox ([Landlock/bwrap](docs/worktree-shell-sandboxing.md)) scoped to the active worktree — a deterministic guarantee, not a model-based heuristic (Linux).
- **Semantic search over code _and_ git history** — `git_search` finds _why_ and _when_ a change was made, not just where.
- **Hard cost caps** — per-task / per-session USD limits that halt runaway loops, across any provider.

Everything else — parallel tasks, modes, worktrees, async MCP, semantic code search, local/offline models — is the solid baseline below.

## Quick Start

1. **Open Shofer** — Click the Shofer icon in the Activity Bar, or press the assigned keyboard shortcut
2. **Configure a Provider** — Open Settings → **Providers** → **New Profile**. Shofer works with Anthropic, OpenAI, Google Gemini, DeepSeek, OpenRouter, Ollama (local), and more. Your API keys are stored securely in your OS credential store.
3. **Start a Task** — Type a message in the chat input bar. Shofer reads your workspace, searches code, runs commands, and edits files. Review every change in the **File Changes Panel** — accept, revert, or diff each one.

Try the built-in `/init` slash command to analyze your codebase and create an `AGENTS.md` file with build commands, code style, and project conventions.

## What You'll See

<img src="src/media/walkthrough/images/WelcomeView.png" alt="Shofer Welcome Screen" width="500" />

| UI Element              | Purpose                                                                           |
| ----------------------- | --------------------------------------------------------------------------------- |
| **Chat View**           | Interact with the AI — type messages, see results                                 |
| **Task Selector**       | Switch between multiple parallel tasks in a tree hierarchy                        |
| **Mode Selector**       | Choose Code, Architect, Debug, Code Search, Web Search, Reviewer, or custom modes |
| **API Config Selector** | Pick which AI provider and model to use per task                                  |
| **Worktree Selector**   | Create and select git worktrees for isolated parallel work                        |
| **File Changes Panel**  | Review, accept, revert, or diff every file Shofer modifies                        |
| **Context Window Bar**  | Monitor token usage and cost for the current task                                 |

## Modes

Shofer ships with 6 built-in modes — choose from the Mode Selector dropdown in the chat input bar:

| Mode               | Best For                                                                 |
| ------------------ | ------------------------------------------------------------------------ |
| 💻 **Code**        | Writing, modifying, and refactoring code. Broadest tool access.          |
| 🏗️ **Architect**   | Planning and designing before writing code. Read + markdown-only writes. |
| 🪲 **Debug**       | Troubleshooting errors and diagnosing root causes.                       |
| 🔎 **Code Search** | Navigating and explaining the codebase — read-only.                      |
| 🌐 **Web Search**  | Researching with web/browser tools.                                      |
| 👀 **Reviewer**    | Reviewing changes and inspecting work.                                   |

Create your own modes (and override the built-ins) via [`.shofer/shofermodes`](USER_MANUAL.md#4-custom-modes) files at the project or global level. Control exactly which tool categories are available per mode, with file-scoped restrictions.

Learn more: [User Manual](USER_MANUAL.md) • [Custom Modes](USER_MANUAL.md#4-custom-modes)

## Workflows

Shofer ships with **two built-in multi-agent workflows** — formal, deterministic coordination of multiple AI agents specified in `.slang` files:

| Workflow                   | Description                                                                                     |
| -------------------------- | ----------------------------------------------------------------------------------------------- |
| 🪲 **Collaborative Debug** | Two developers triage independently, converge on root cause, one fixes while the other reviews  |
| 🔧 **Implement a Feature** | Architect designs → you approve → Developer implements → Reviewer inspects — iterate until done |

<img src="media/debug.png" alt="Debug Workflow" width="440" />
<img src="media/implement feature.png" alt="Implement a Feature Workflow" width="440" />

Launch a workflow via **New… → New Workflow** in the chat toolbar. Create your own custom workflows as `.slang` files under `.shofer/workflows/` (project) or `~/.shofer/workflows/` (global).

Learn more: [User Manual → Workflows](USER_MANUAL.md#9-workflows) • [Built-in Workflows SoT](docs/built-in-workflows.md) • [Slang Language Spec](docs/slang_specs.md)

## Parallel Tasks & Worktrees

Shofer supports **true parallel tasks** organized in a tree hierarchy. Start multiple conversations simultaneously — each runs independently with its own mode, provider, and context.

- **Background subtasks** — fan out work without blocking the parent. The Orchestrator mode delegates to specialized sub-tasks automatically.
- **Message queuing** — type ahead while the AI is working. Click **Send Now** to redirect it immediately.
- **Task states** — colored dots show each task's status: idle, running, waiting for input, waiting on subtask, completed, or errored.

### Git Worktrees

<img src="src/media/walkthrough/images/worktree1.png" alt="Task Header with Worktree Selector" width="500" />

Run parallel tasks on different branches — all in one VS Code window:

- Worktrees live at `.shofer/worktrees/<name>/` inside your workspace
- Create, switch, and delete worktrees from the **Worktree Selector** in the Task Header
- Each task can be scoped to a specific worktree for branch-isolated parallel work
- No more stash/commit gymnastics or multiple VS Code windows for PRs

[Read the full worktree documentation](https://github.com/shofer-dev/shofer/blob/master/docs/worktrees.md)

## RAG Indexing

<img src="src/media/walkthrough/images/RAGView.png" alt="RAG Indexing Settings" width="280" />

Build a **semantic search index** of your codebase and git history so the AI can find code and commits by _meaning_ — not just keywords.

| Index           | What It Searches                    | Tool         |
| --------------- | ----------------------------------- | ------------ |
| **Code**        | Functions, classes, types, comments | `rag_search` |
| **Git History** | Commit messages and metadata        | `git_search` |

Requires a reachable **Qdrant v1.14.x** server (local or remote). Configure in Settings → **RAG Indexing** — pick an embedding provider, point to your Qdrant instance, and click **Start Indexing**. A file watcher keeps the index up to date as you edit.

[Read the full RAG indexing documentation](https://github.com/shofer-dev/shofer/blob/master/docs/rag_indexing.md)

## Assistant Agent

<img src="src/media/walkthrough/images/AssistantView.png" alt="Assistant Agent Status" width="280" />

The **Assistant Agent** is a persistent, read-only AI companion that accumulates codebase knowledge over time — surviving task completion and VS Code restarts.

- Runs on a **low-cost model with a large context window** (you choose the model)
- Answers questions from any task via the [`ask_assistant_agent`]() tool
- **Strictly read-only** — can read files, search code, and look up symbols; cannot write or execute
- **KV-cache friendly** — append-only context window keeps provider costs minimal
- Learns organically — each question adds context, building an ever-richer understanding of your codebase

Enable in Settings and choose a lightweight model (e.g., Gemini Flash, GPT-4o-mini).

[Read the full Assistant Agent documentation](https://github.com/shofer-dev/shofer/blob/master/docs/assistant_agent.md)

## Special Files

Shofer recognizes several files in your workspace that control its behavior. These files are **write-protected** — Shofer cannot modify them without your explicit approval.

| File / Directory        | Purpose                                              |
| ----------------------- | ---------------------------------------------------- |
| `.shofer/shoferignore`  | Hide files from Shofer (same syntax as `.gitignore`) |
| `.shofer/shofermodes`   | Define custom AI modes for your project              |
| `AGENTS.md`             | Project rules injected into every task               |
| `.shofer/rules/`        | Mode-agnostic rules (always active)                  |
| `.shofer/rules-<mode>/` | Rules for a specific mode (e.g., `rules-code/`)      |
| `.shofer/commands/`     | Custom slash commands                                |
| `.shofer/skills/`       | Domain-specific skill instructions                   |
| `.shofer/mcp.json`      | Per-project MCP server configuration                 |

## Settings at a Glance

| Section                | What You Can Do                                            |
| ---------------------- | ---------------------------------------------------------- |
| **Providers**          | Add API profiles, switch models, configure endpoints       |
| **Modes**              | Create and edit custom modes with per-tool access control  |
| **Auto-Approval**      | Toggle which tool categories run without asking permission |
| **MCP Servers**        | Connect external tools (browser, databases, Kubernetes)    |
| **RAG Indexing**       | Build a semantic search index of your codebase             |
| **Context Management** | Control when conversations get condensed                   |
| **Limits**             | Set per-task USD cost caps and API request limits          |

Key recommendations: start with auto-approval toggles **OFF** and enable incrementally. Set `shofer.defaultCostLimit` to cap spending. Configure a command allowlist for shell operations.

## Migration Paths

**Coming from Roo-Code?** Shofer is a major architectural improvement with parallel tasks, async MCP calling, semantic code & git log indexing, native worktree support, and background subtasks. Run `/migrate-from-roocode` to migrate your configuration. [Read the migration guide →](https://github.com/shofer-dev/shofer/blob/master/docs/migration/shofer_for_roocode_users.md)

**Coming from GitHub Copilot?** Shofer gives you full model choice, local-first privacy, 50+ native tools, and parallel task execution. Run `/migrate-from-copilot` to migrate your configuration. [Read the migration guide →](https://github.com/shofer-dev/shofer/blob/master/docs/migration/shofer_for_copilot_users.md)

**Coming from Claude Code?** Keep the agentic power, but bring any model (including local/offline), a graphical cockpit, deterministic Slang Workflows, semantic code & git-log search, native worktrees, and hard cost caps. Run `/migrate-from-claude` to migrate your configuration. [Read the migration guide →](https://github.com/shofer-dev/shofer/blob/master/docs/migration/shofer_for_claude_code_users.md)

**Coming from OpenCode?** Same open-source, model-agnostic philosophy — plus a graphical VS Code cockpit, parallel orchestration, semantic code & git-log search, native worktrees, and a deterministic multi-agent Workflow engine. Your `AGENTS.md` rules carry over directly. [Read the migration guide →](https://github.com/shofer-dev/shofer/blob/master/docs/migration/shofer_for_opencode_users.md)

## Community

- **[Discord](https://discord.gg/x39UEEQ2)** — Chat with the team, get help, share feedback
- **[Reddit](https://reddit.com/r/Shofer_dev)** — Community discussions and tips
- **[GitHub Issues](https://github.com/shofer-dev/shofer/issues)** — Bug reports and tracking

Shofer is open source (Apache 2.0). Contributions are welcome — read [`CONTRIBUTING.md`](CONTRIBUTING.md) and check the [roadmap](https://github.com/orgs/shofer/projects/1).

## Resources

- **[User Manual](USER_MANUAL.md):** The complete guide to every feature, setting, and concept in Shofer.
- **[Developer Documentation](https://shofer.dev/docs):** Official docs for installing, configuring, and mastering Shofer.
- **[GitHub Issues and Feature Requests](https://github.com/shofer-dev/shofer/issues):** Report bugs, feature requests, and track development.

---

## Local Setup & Development

1. **Clone** the repo:

```sh
git clone https://github.com/shofer-dev/shofer.git
```

2. **Install dependencies**:

```sh
pnpm install
```

3. **Run the extension**:

There are several ways to run the Shofer extension:

### Development Mode (F5)

For active development, use VSCode's built-in debugging:

Press `F5` (or go to **Run** → **Start Debugging**) in VSCode. This will open a new VSCode window with the Shofer extension running.

- Changes to the webview will appear immediately.
- Changes to the core extension will also hot reload automatically.

### Automated VSIX Installation

To build and install the extension as a VSIX package directly into VSCode:

```sh
pnpm install:vsix [-y] [--editor=<command>]
```

This command will:

- Ask which editor command to use (code/cursor/code-insiders) - defaults to 'code'
- Uninstall any existing version of the extension.
- Build the latest VSIX package.
- Install the newly built VSIX.
- Prompt you to restart VS Code for changes to take effect.

Options:

- `-y`: Skip all confirmation prompts and use defaults
- `--editor=<command>`: Specify the editor command (e.g., `--editor=cursor` or `--editor=code-insiders`)

### Manual VSIX Installation

If you prefer to install the VSIX package manually:

1.  First, build the VSIX package:
    ```sh
    pnpm vsix
    ```
2.  A `.vsix` file will be generated in the `bin/` directory (e.g., `bin/shofer-<version>.vsix`).
3.  Install it manually using the VSCode CLI:
    ```sh
    code --install-extension bin/shofer-<version>.vsix
    ```

---

We use [changesets](https://github.com/changesets/changesets) for versioning and publishing. Check our `CHANGELOG.md` for release notes.

---

## Disclaimer

**Please note** that Shofer, Inc does **not** make any representations or warranties regarding any code, models, or other tools provided or made available in connection with Shofer, any associated third-party tools, or any resulting outputs. You assume **all risks** associated with the use of any such tools or outputs; such tools are provided on an **"AS IS"** and **"AS AVAILABLE"** basis. Such risks may include, without limitation, intellectual property infringement, cyber vulnerabilities or attacks, bias, inaccuracies, errors, defects, viruses, downtime, property loss or damage, and/or personal injury. You are solely responsible for your use of any such tools or outputs (including, without limitation, the legality, appropriateness, and results thereof).

---

## Contributing

We love community contributions! Get started by reading our [CONTRIBUTING.md](CONTRIBUTING.md).

---

## License

[Apache 2.0 © 2026 Shofer, Inc.](./LICENSE)
