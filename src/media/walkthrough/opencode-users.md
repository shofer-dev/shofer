# Migrating from OpenCode

Coming from OpenCode? You already share Shofer's philosophy — open-source, model-agnostic, local-first. Shofer keeps all of that and adds a graphical VS Code cockpit, parallel task orchestration, semantic code/git indexing, native worktrees, and hard per-task cost caps.

## Key Differences from OpenCode

- **VS Code-native cockpit** — live Tree, Sequence, Stats and Logs tabs, with the whole task tree visualized in-editor
- **Whole-tree task orchestration** — many concurrent conversations and deep subtask trees, with cross-tree cost and stats
- **Semantic RAG over code _and_ git history** — `git_search` finds _why_ and _when_, not just keywords (OpenCode's edge is its real-time LSP/compiler feedback)
- **Live Memory** — a persistent, cross-session context window other tasks reuse to cut token spend
- **Native worktrees + OS-level sandboxing** — parallel branches in one window; shell commands confined via Landlock/bwrap
- **Hard cost caps** — per-task and per-session USD budgets that halt runaway loops
- **Reads `AGENTS.md`** — your existing project rules carry over directly

## Quick Start for OpenCode Users

Shofer reads the same `AGENTS.md` convention, so your project rules work as-is. Map your `opencode.json` provider/model setup to a Shofer provider profile, and re-add your MCP servers (they port one-to-one). Conversations are not migrated.

[Read the full OpenCode → Shofer guide](https://github.com/shofer-dev/shofer/blob/master/docs/migration/shofer_for_opencode_users.md)
