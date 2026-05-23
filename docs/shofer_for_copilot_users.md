# Shofer for GitHub Copilot Users

If you're using GitHub Copilot and wondering what Shofer brings to the table, this document is for you.

Shofer is a **locally-run, fully configurable AI coding agent** that operates as a VS Code extension — on your machine, under your control. It gives you capabilities far beyond what Copilot's chat and inline completions offer, without sending your code to Microsoft or GitHub.

> **Quick Start**: Run the `/migrate-from-copilot` slash command to automatically migrate your existing GitHub Copilot configuration files (`.github/copilot-instructions.md`, agents, skills, instructions) to Shofer equivalents. See [`copilot.md`](copilot.md) for the full Copilot file reference.

> **Philosophy**: Shofer is your AI pair programmer that you own. You choose the models, you control the data, you define the workflows.

---

## Privacy & Control: The Fundamental Difference

| Concern                  | GitHub Copilot                                           | Shofer                                                                                        |
| ------------------------ | -------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **Where your code goes** | Sent to Microsoft/GitHub cloud for processing            | Stays on your machine — the extension processes everything locally                            |
| **What model runs**      | Copilot's proprietary models (you can't choose)          | **Any** LLM provider: Anthropic, OpenAI, Ollama (local), OpenRouter, Google, xAI — you decide |
| **Data retention**       | Microsoft's privacy policy governs retention             | Zero retention by Shofer — the extension stores nothing externally                            |
| **Network dependency**   | Requires internet; data leaves your network              | Fully functional offline with local models (Ollama, LM Studio)                                |
| **Auditability**         | Closed-source agent logic                                | 100% open source — every prompt, every tool, every decision is inspectable                    |
| **Rate limits**          | Subject to Copilot's tiered rate limits                  | Only your provider's limits apply (none for local models)                                     |
| **Subscription**         | $10–$39/month for individuals, $19–$39/seat for business | Free and open source — you only pay your LLM provider                                         |

> **Note on external providers**: If you choose to use a cloud LLM provider (Anthropic, OpenAI, etc.), your prompts and code context are sent to that provider per their terms. Shofer itself never sees your data. Using a local model (Ollama, LM Studio) keeps **everything** on your machine.

---

## Feature Comparison: What Copilot Can't Do

### Multi-Task Architecture

Copilot gives you one conversation at a time. Shofer gives you an entire development team.

| Capability                        | Copilot         | Shofer                                                                           |
| --------------------------------- | --------------- | -------------------------------------------------------------------------------- |
| Single chat conversation          | ✅ Copilot Chat | ✅                                                                               |
| Multiple concurrent conversations | ❌              | ✅ Switch between independent tasks freely                                       |
| Background/async tasks            | ❌              | ✅ Fan out work with `is_background: true` — parent continues while children run |
| Task orchestration                | ❌              | ✅ `wait_for_task`, `check_task_status`, `cancel_tasks` — full lifecycle control |
| Subtask question routing          | ❌              | ✅ Background children ask the parent, not the user                              |

### Tools & Capabilities

Copilot's agent can use a limited set of tools. Shofer exposes 50+ native tools with deep system integration.

| Capability               | Copilot    | Shofer                                                                               |
| ------------------------ | ---------- | ------------------------------------------------------------------------------------ |
| Read/write files         | ✅ Basic   | ✅ Full toolkit: `write_to_file`, `apply_diff`, `insert_edit`, `sed`, `file` (rm/mv) |
| Symbol rename via LSP    | ❌         | ✅ `rename_symbol` — rename across entire codebase                                   |
| Semantic code search     | ❌         | ✅ `rag_search` — find code by meaning, not just keywords                            |
| Git history search       | ❌         | ✅ `git_search` — semantic search over commit history                                |
| Execute shell commands   | ✅ Limited | ✅ Full terminal with timeout, working directory, output capture                     |
| Web browsing             | ❌         | ✅ Browser automation — navigate, click, type, extract data                          |
| MCP server integration   | ❌         | ✅ Connect to any MCP server; async parallel MCP calls                               |
| Image generation         | ❌         | ✅ Generate images from prompts                                                      |
| Web page fetching        | ❌         | ✅ `fetch_web_page` — extract text content from URLs                                 |
| Command output retrieval | ❌         | ✅ `read_command_output` — paginate and search truncated output                      |

### Codebase Understanding

| Capability                  | Copilot | Shofer                                                                    |
| --------------------------- | ------- | ------------------------------------------------------------------------- |
| Code indexing (RAG)         | ❌      | ✅ Full codebase indexing with tree-sitter parsing + embeddings           |
| `.gitignore`-aware scanning | ❌      | ✅ `GitIgnoreFilter` oracle — honors nested `.gitignore`, global excludes |
| Submodule support           | ❌      | ✅ Indexes and searches inside git submodules                             |
| Per-provider embedding      | ❌      | ✅ Embed with Ollama (local), Bedrock, or cloud providers                 |

### Workflow & Automation

| Capability                | Copilot                | Shofer                                                                     |
| ------------------------- | ---------------------- | -------------------------------------------------------------------------- |
| Custom slash commands     | ❌                     | ✅ Define reusable `/commands` with parameter interpolation                |
| Skills system             | ❌                     | ✅ Reusable prompt + tool packages (Agent Skills spec)                     |
| Custom modes              | ❌ (Agent vs Ask only) | ✅ 5 built-in modes (Code, Architect, Debug, Ask, Reviewer) + custom modes |
| Mode-specific tool access | ❌                     | ✅ Per-mode `allowed`/`denied` tool lists                                  |
| Task export               | ❌                     | ✅ Export to Markdown or structured JSON                                   |
| Message queuing           | ❌                     | ✅ Type ahead while the LLM works; messages queue and deliver when ready   |
| Per-task drafts           | ❌                     | ✅ Unsent input preserved per task                                         |
| File changes panel        | ❌                     | ✅ See every file the AI touched; Accept or Revert with one click          |

### Git & Worktrees

| Capability                | Copilot | Shofer                                                              |
| ------------------------- | ------- | ------------------------------------------------------------------- |
| Native worktree support   | ❌      | ✅ Create, switch, and manage git worktrees without leaving VS Code |
| Worktree status indicator | ❌      | ✅ Live branch + dirty/ahead/behind status chip in chat bar         |

### Auto-Approval & Safety

| Capability                 | Copilot | Shofer                                                         |
| -------------------------- | ------- | -------------------------------------------------------------- |
| Fine-grained auto-approval | ❌      | ✅ 9 tool categories with per-category toggles                 |
| Command allowlisting       | ❌      | ✅ Define exactly which commands can run without approval      |
| Cost limits                | ❌      | ✅ Set USD spend caps per task — auto-pause/abort when reached |
| Per-task mode locking      | ❌      | ✅ Each task keeps its mode; switching tasks doesn't leak      |

---

## Architecture: Copilot vs Shofer

```
GitHub Copilot                          Shofer
──────────────────────────              ──────────────────────────
                                        ┌─────────────────────────┐
┌──────────────────────┐                │  ┌───────────────────┐  │
│   VS Code Extension  │                │  │   VS Code Ext.    │  │
│         │            │                │  │        │          │  │
│         ▼            │                │  │        ▼          │  │
│  GitHub Copilot API  │──Cloud────────▶│  │  Local Task Loop  │  │
│  (Microsoft Cloud)   │                │  │        │          │  │
│         │            │                │  │        ▼          │  │
│         ▼            │                │  │  LLM Provider API │──│──▶ Your chosen model
│   Proprietary Model  │                │  │  (Anthropic,      │  │    (local or cloud)
│   (GPT-based)        │                │  │   Ollama, etc.)   │  │
└──────────────────────┘                │  └───────────────────┘  │
                                        │                         │
                                        │  ┌───────────────────┐  │
                                        │  │   Task Manager    │  │
                                        │  │  (Multi-task)     │  │
                                        │  └───────────────────┘  │
                                        │                         │
                                        │  ┌───────────────────┐  │
                                        │  │  Code Indexer     │  │
                                        │  │  (Qdrant + T-S)   │  │
                                        │  └───────────────────┘  │
                                        │                         │
                                        │  ┌───────────────────┐  │
                                        │  │  MCP Client       │  │
                                        │  │  (Tool Servers)   │  │
                                        │  └───────────────────┘  │
                                        └─────────────────────────┘
```

---

## Use Cases: When Shofer Excels

### "I work with sensitive/proprietary code"

Shofer + Ollama = 100% air-gapped AI coding. Nothing leaves your machine. Copilot sends your code to Microsoft's cloud on every request.

### "I need to parallelize complex work"

Spawn 3 background tasks — one researches APIs, one writes tests, one refactors — and collect results when they're all done. Copilot can only do one thing at a time.

### "I need custom tool integrations"

Connect Shofer to your internal MCP servers — databases, APIs, monitoring, Kubernetes. Copilot has a fixed, non-extensible tool set.

### "I want to use the best model for each task"

Use Claude Opus for architecture, GPT-5 for code generation, and a local model for quick edits — all in the same session. Copilot gives you one model.

### "I need reproducible AI workflows"

Export tasks as JSON, version-control the traces, replay them in CI. Copilot offers no export or replay capability.

### "I work in air-gapped environments"

Shofer is the only fully-functional AI coding agent that works with zero internet connectivity (using Ollama or LM Studio local models).

---

## What Copilot Does Better (Today)

To be fair, Copilot has strengths Shofer doesn't replicate:

| Copilot Advantage                                   | Shofer Status                                                |
| --------------------------------------------------- | ------------------------------------------------------------ |
| **Inline code completions** (tab-to-accept)         | ❌ Not implemented — Shofer is conversation/agent-focused    |
| **Next-edit suggestions** (ghost text)              | ❌ Not implemented                                           |
| **Code review on PRs**                              | ❌ No PR integration                                         |
| **Agent mode in terminal**                          | ❌ Terminal is a tool, not an agent host                     |
| **Seamless VS Code integration** (no configuration) | ⚠️ Requires LLM provider setup                               |
| **Copilot Free tier**                               | ⚠️ Free, but you need your own LLM provider (or local model) |

> Shofer is an **agent platform**, not an autocomplete engine. It complements Copilot rather than replacing it — many users run both side by side.

---

## Getting Started for Copilot Users

1. **Install Shofer** from the VS Code marketplace
2. **Choose a model** — point it at Ollama (local), Anthropic, OpenAI, or any supported provider
3. **Open the chat** — `Cmd+Shift+P` → `Shofer: New Task` (or use the sidebar icon)
4. **Pick a mode** — Code mode is the default (like Copilot's Agent); switch to Architect for planning, Debug for troubleshooting
5. **Start coding** — Shofer has access to your entire workspace, git history, and code index

> **Pro tip**: Set up Shofer with a local Ollama model for sensitive work, and a cloud provider for heavy lifting. You can switch between them per task.

---

## See Also

- [`shofer_for_roocode_users.md`](shofer_for_roocode_users.md) — comprehensive feature catalogue for Roo-Code migrants
- [`CHANGELOG.md`](../CHANGELOG.md) — complete release history
- [`configuration.md`](configuration.md) — VS Code settings reference
- [`native_tools.md`](native_tools.md) — complete 50+ native tools reference
