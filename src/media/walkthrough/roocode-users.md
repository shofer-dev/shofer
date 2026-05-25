<!-- XXX: Side-by-side comparison graphic showing Roo-Code vs Shofer feature table -->

![Roo-Code vs Shofer](images/roocode.png)

# Migrating from Roo-Code

Shofer is a major architectural improvement over Roo-Code, with parallel tasks, async MCP calling, semantic code search, native worktree support, and dozens more features.

> Roo-Code is sunsetting its VS Code Extension on May 15, 2026. Shofer is the natural migration path.

## Key Improvements Over Roo-Code

- **Parallel tasks** — run multiple conversations simultaneously (Roo-Code: one at a time)
- **Background subtasks** — fan out work without blocking the parent
- **Async MCP tool calling** — true parallel MCP calls
- **RAG code indexing** — semantic search across your codebase
- **Git history search** — find commits by meaning, not keywords
- **Native worktree support** — no separate VS Code windows needed
- **Message queuing** — type ahead while the LLM works
- **Task export** — Markdown and JSON formats

## Quick Start for Roo-Code Users

Run the `/migrate-from-roocode` slash command to automatically rename your legacy files (`.rooignore` → `.shoferignore`, `.roomodes` → `.shofermodes`, etc.).

[Read the full Roo-Code → Shofer guide](https://github.com/shofer-dev/shofer/blob/master/docs/shofer_for_roocode_users.md)
