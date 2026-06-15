# Migrating from OpenCode

Coming from OpenCode? You already share Shofer's philosophy — open-source, model-agnostic, local-first. Shofer keeps all of that and adds a graphical VS Code cockpit, parallel task orchestration, semantic code/git indexing, native worktrees, and a deterministic multi-agent Workflow engine.

## Key Differences from OpenCode

- **Graphical cockpit** — task tree plus live Topology/Sequence/Swimlane diagrams, Stats, and Logs, instead of a TUI transcript
- **Deterministic Workflows** — declarative Slang multi-agent orchestration with output-contract validation
- **Parallel tasks & background subtasks** — many concurrent conversations and full workflow trees
- **Semantic RAG over code _and_ git history** — `git_search` finds _why_ and _when_, not just keywords
- **Assistant Agent** — a persistent, cross-session context window other tasks reuse to cut token spend
- **Native worktrees + OS-level sandboxing** — parallel branches in one window; shell commands confined via Landlock/bwrap
- **Hard cost caps** — per-task and per-session USD budgets that halt runaway loops
- **Reads `AGENTS.md`** — your existing project rules carry over directly

## Quick Start for OpenCode Users

Shofer reads the same `AGENTS.md` convention, so your project rules work as-is. Map your `opencode.json` provider/model setup to a Shofer provider profile, and re-add your MCP servers (they port one-to-one). Conversations are not migrated.

[Read the full OpenCode → Shofer guide](https://github.com/shofer-dev/shofer/blob/master/docs/migration/shofer_for_opencode_users.md)
