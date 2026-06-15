# Shofer for OpenCode Users

If you are using **OpenCode** — the open-source, terminal-based AI coding agent — this breakdown outlines the core architectural and functional differences from Shofer.

Both tools share the same foundational philosophy: **open-source, model-agnostic, local-first**. Neither locks you to a vendor's models or proxies your code through their servers. The difference is one of _surface and scope_: OpenCode is a lightweight, terminal/TUI-first agent with a client-server core, ideal for keyboard-driven and remote workflows. Shofer is a GUI-native VS Code agent that layers on parallel task orchestration, a visual cockpit, semantic code/git indexing, native worktrees, and a deterministic multi-agent **Workflow** engine.

> **Current as of June 15, 2026**: The AI tools landscape shifts rapidly. This guide reflects the native feature sets, capabilities, and ecosystems of both tools as of today.

> **Quick Migration**: Shofer reads the same `AGENTS.md` convention OpenCode uses, so your project rules carry over directly. MCP servers map across one-to-one, and your `opencode.json` provider/model setup translates to Shofer's provider profiles. (There is no automated importer for OpenCode yet — the mapping is straightforward and manual.)

---

## Privacy & Architectural Topology

Both are open-source and model-agnostic, so the privacy story is similar. The contrast is in surface and architecture.

| Aspect                  | OpenCode                                                                                                     | Shofer                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| **Primary Surface**     | Terminal UI (TUI), editor-agnostic; a client-server core lets you drive a remote session from a thin client. | Native VS Code extension with a graphical UI (task tree, diagrams, cost panels), plus a headless CLI for automation. |
| **Model Ecosystem**     | Provider-agnostic (Anthropic, OpenAI, OpenRouter, local, …).                                                 | Provider-agnostic (Anthropic, OpenAI, OpenRouter, xAI, Bedrock, Ollama, LM Studio). Mix models per task.             |
| **Source Availability** | Open-source.                                                                                                 | Open-source (Apache 2.0).                                                                                                   |
| **Offline / Local**     | Supports local models.                                                                                       | Supports local models; fully air-gapped operation.                                                                   |
| **Config Convention**   | `opencode.json` + `AGENTS.md`.                                                                               | `.shofer/` rules + custom modes + provider profiles; **also reads `AGENTS.md`**, so project rules port directly.     |

---

## Core Capabilities: What Shofer Offers Beyond OpenCode

### 1. A graphical, visual cockpit

| Capability                  | OpenCode                                            | Shofer                                                                                                                                                                                                                                       |
| --------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Task & agent visibility** | Terminal transcript / TUI panes.                    | A graphical task tree plus per-task **Topology / Sequence / Swimlane** diagrams, a **Stats** tab (active-time donut + per-tool breakdown aggregated across the whole tree), and a filterable **Logs** tab — all updating live as agents run. |
| **Cost & token governance** | Usage is shown, but without hard programmatic caps. | Live per-task and whole-tree cost/token panels, with hard **USD budget caps** per task or session that pause or abort runaway autonomous loops.                                                                                              |

### 2. Deterministic multi-agent Workflows

| Capability              | OpenCode                                                                   | Shofer                                                                                                                                                                                                                                                                                        |
| ----------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Orchestration model** | Configurable agents/subagents driven imperatively by the model at runtime. | A declarative **Slang** spec defines agents, message routing (`stake`/`await`), control flow (`when`/`repeat`), a `converge` condition, and `budget` limits, driven by a deterministic non-LLM executor — repeatable, inspectable, and visualized, with per-agent output-contract validation. |
| **Parallelism**         | Can run subagents; primarily a single interactive session.                 | Many concurrent tasks and full workflow trees, with background subtasks, async MCP calls, and least-privilege inter-agent peer messaging.                                                                                                                                                     |

### 3. Deep workspace integration

| Capability                      | OpenCode                                                     | Shofer                                                                                                                                                                                                                          |
| ------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Semantic RAG (code + git)**   | LSP-aware; reads files and runs git on demand.               | Indexes code (AST-aware, tree-sitter) **and the entire git log** into an embedding DB. `git_search` answers _why_/_when_ a change happened by concept, not keyword.                                                             |
| **Cross-session context reuse** | Each session is independent.                                 | A persistent **Assistant Agent** accumulates codebase knowledge; other tasks query its pre-warmed context via `ask_assistant_agent`, cutting redundant reads and token spend.                                                   |
| **Worktrees & sandboxing**      | Manual `git worktree`; relies on user-confirmed permissions. | Native worktree management inside one VS Code window (auto-create, submodule init, merge commands) and **OS-level command sandboxing** (Landlock/`bwrap` write-only confinement) scoping shell commands to the active worktree. |

---

## Choosing the Right Tool for Your Workflow

### When Shofer is Best Utilized

| Scenario                             | Description                                                                                                               |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| **Visual, GUI-driven development**   | You want a graphical cockpit — task tree, live diagrams, cost panels — rather than a terminal transcript.                 |
| **Repeatable multi-agent pipelines** | You want declarative, deterministic, visualized orchestration (Slang Workflows) over ad-hoc runtime delegation.           |
| **Workspace-deep features**          | You want semantic code + git-log RAG, a cross-session Assistant Agent, native worktrees, and OS-level command sandboxing. |
| **Hard spend governance**            | You need enforceable per-task/session USD caps that halt runaway loops.                                                   |

### When OpenCode is Best Utilized

| Scenario                                | Description                                                                                                                      |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **Terminal-native & editor-agnostic**   | You live in the terminal, want a fast TUI, and don't want to be tied to VS Code.                                                 |
| **Remote / headless via client-server** | You want to run the agent on a powerful remote host and attach a thin client, or script it in lightweight headless environments. |
