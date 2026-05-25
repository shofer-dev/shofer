# Migrating from Roo-Code

Shofer is a major architectural improvement over Roo-Code (Roo-Code fork), with task parallelism, agent-to-agent async collaboration, generalized async MCP calling, lighting-fast semantic code and git log indexing, seemless worktree support, an extensive set of comprehensive build-in tools, the ability to share context across sessions, and dozens more unique features.

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

Run the `/migrate-from-roocode` slash command to automatically migrate your Roo-Code configuration into Shofer. Notice that conversations are not migrated.

[Read the full Roo-Code → Shofer guide](https://github.com/shofer-dev/shofer/blob/master/docs/shofer_for_roocode_users.md)
