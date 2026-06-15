# Migrating from Claude Code

Coming from Anthropic's Claude Code? Shofer gives you the same agentic power in a graphical VS Code cockpit — and frees you from a single vendor's models, adds visual multi-agent orchestration, semantic code/git indexing, native worktrees, and hard cost caps.

## Key Differences from Claude Code

- **Bring any model** — Anthropic, OpenAI, OpenRouter, xAI, Bedrock, or local via Ollama/LM Studio (Claude Code is Anthropic-only)
- **Runs offline** — fully air-gapped with local models
- **Graphical cockpit** — task tree plus live Topology/Sequence/Swimlane diagrams, Stats, and Logs instead of a terminal transcript
- **Deterministic Workflows** — declarative Slang multi-agent orchestration, not ad-hoc runtime delegation
- **Semantic RAG over code _and_ git history** — `git_search` finds _why_ and _when_, not just keywords
- **Assistant Agent** — a persistent, cross-session context window that other tasks reuse to cut token spend
- **Native worktrees + OS-level sandboxing** — parallel branches in one window; shell commands confined via Landlock/bwrap
- **Hard cost caps** — per-task and per-session USD budgets that halt runaway loops
- **Open-source (MIT)** — inspect and modify every tool hook and prompt

## Quick Start for Claude Code Users

Run the `/migrate-from-claude` slash command to port your `CLAUDE.md` memory, `.claude/` settings, subagents, slash commands, and MCP servers into Shofer equivalents. Conversations are not migrated.

[Read the full Claude Code → Shofer guide](https://github.com/shofer-dev/shofer/blob/master/docs/migration/shofer_for_claude_code_users.md)
