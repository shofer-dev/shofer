# Shofer for Claude Code Users

If you are using Anthropic's **Claude Code** and wondering what Shofer brings to the table, this breakdown outlines the core architectural and functional differences between the two environments.

Shofer is an **open-source, model-agnostic AI coding agent** that operates as a VS Code extension, running entirely on your machine, under your own control. Where Claude Code is a terminal-first agent tightly integrated with Anthropic's own models, Shofer is a GUI-native agent that lets you bring any model — cloud or local — and adds parallel task orchestration, semantic code/git indexing, native worktrees, and a deterministic multi-agent **Workflow** engine.

> **Current as of June 15, 2026**: The AI tools landscape shifts rapidly. This guide reflects the native feature sets, capabilities, and ecosystems of both tools as of today.

> **Quick Migration**: Run the `/migrate-from-claude` slash command inside Shofer to port your existing Claude Code configuration — `CLAUDE.md` memory files, `.claude/` settings, subagents, slash commands, and MCP servers — into Shofer-compatible equivalents (`.shofer/` rules, custom modes, and MCP config).

---

## Privacy & Architectural Topology

Both tools can target Anthropic's frontier models, but they differ fundamentally in surface, openness, and model autonomy.

| Aspect                   | Claude Code                                                                                           | Shofer                                                                                                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Primary Surface**      | Terminal-first CLI, with companion IDE extensions and a web/desktop app.                              | A native VS Code extension with a rich graphical UI — task tree, diagrams, and live cost/token panels — alongside a headless CLI for automation.            |
| **Model Ecosystem**      | Anthropic Claude models only (Opus / Sonnet / Haiku), via the Anthropic API or a Claude subscription. | Agnostic **Bring-Your-Own-Model** pipeline: Anthropic, OpenAI, OpenRouter, xAI, AWS Bedrock, or **local** engines (Ollama, LM Studio). Mix models per task. |
| **Offline / Air-Gapped** | Requires connectivity to Anthropic's API.                                                             | Fully operational 100% offline when paired with local models.                                                                                               |
| **Source Availability**  | Proprietary product (an open SDK exists, but the agent itself is closed).                             | 100% open-source (MIT). Every tool hook, system-prompt prefix, and lifecycle event is inspectable and modifiable.                                           |
| **Cost Model**           | Claude subscription tiers or Anthropic API token billing.                                             | Free software; you pay only for the raw tokens you consume on whichever provider you choose — or nothing at all when running local models.                  |
| **Data Flow**            | Prompts and context route to Anthropic for inference.                                                 | Payloads flow directly to the provider you configure; with Ollama/LM Studio, **100% stays on-device**. Shofer never proxies or aggregates your code.        |

---

## Core Capabilities: What Shofer Offers Beyond Claude Code

### 1. A graphical, visual cockpit

| Capability                  | Claude Code                                                                           | Shofer                                                                                                                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Task & agent visibility** | Linear terminal transcript; subagent activity is summarized inline in the scrollback. | A graphical task tree plus per-task **Topology / Sequence / Swimlane** diagrams, a **Stats** tab (active-time donut + per-tool breakdown aggregated across the whole tree), and a filterable **Logs** tab — all updating live as agents run. |
| **Cost & token tracking**   | Reported per session.                                                                 | Live per-task and whole-tree cost/token panels, with hard **USD budget caps** per task or session that pause or abort autonomous loops the moment a threshold is crossed.                                                                    |

### 2. Deterministic multi-agent Workflows

| Capability              | Claude Code                                                                                                   | Shofer                                                                                                                                                                                                                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Orchestration model** | Imperative: the model decides at runtime when to spawn subagents; control flow lives inside the conversation. | A declarative **Slang** spec defines agents, message routing (`stake`/`await`), control flow (`when`/`repeat`), a `converge` condition, and `budget` limits. A deterministic, non-LLM executor drives it — repeatable, inspectable, and visualized. Output contracts validate each agent's result with retry. |
| **Parallelism**         | Spawns parallel subagents on demand.                                                                          | Runs many tasks and a whole workflow tree concurrently, with background subtasks, async MCP calls, and inter-agent peer messaging under a least-privilege default-deny scope.                                                                                                                                 |

### 3. Deep workspace integration

| Capability                      | Claude Code                                                                   | Shofer                                                                                                                                                                                                                                 |
| ------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Semantic RAG (code + git)**   | Reads files and can run `git log`; no persistent semantic index.              | Indexes code (AST-aware, tree-sitter) **and the entire git log** into an embedding DB. `git_search` answers _why_/_when_ a change happened by concept, not keyword.                                                                    |
| **Cross-session context reuse** | Each session starts fresh (with `CLAUDE.md` memory as static context).        | A persistent **Assistant Agent** accumulates codebase knowledge; other tasks query its pre-warmed context via `ask_assistant_agent`, cutting redundant file reads and token spend across sessions.                                     |
| **Worktrees & sandboxing**      | Manual `git worktree`; relies on permission prompts/hooks for command safety. | Native worktree management inside one VS Code window (auto-create, submodule init, merge commands), and **OS-level command sandboxing** (Landlock/`bwrap` write-only confinement) that contains shell commands to the active worktree. |

---

## Choosing the Right Tool for Your Workflow

### When Shofer is Best Utilized

| Scenario                               | Description                                                                                                                   |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Model freedom & local/offline**      | You want to use non-Anthropic models, mix providers per task, or run fully offline/air-gapped on local models.                |
| **Visual, GUI-driven development**     | You prefer a graphical cockpit — task tree, live diagrams, cost panels — over a terminal transcript.                          |
| **Repeatable multi-agent pipelines**   | You want declarative, deterministic, visualized orchestration (Slang Workflows) rather than ad-hoc runtime delegation.        |
| **Open-source transparency & control** | You want to inspect and modify every tool hook, prompt, and lifecycle event, and enforce hard spend caps across any provider. |

### When Claude Code is Best Utilized

| Scenario                              | Description                                                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Terminal-native, frontier-Claude**  | You live in the terminal and want best-in-class results from Anthropic's latest models with zero setup and a mature CLI agent loop.   |
| **Cross-surface Anthropic ecosystem** | You value Claude Code's terminal/IDE/web surfaces and its tightly integrated skills, hooks, and subagent ecosystem around one vendor. |
