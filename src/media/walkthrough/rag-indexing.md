# Code & Git Log Indexing

Shofer can build a **semantic search index** of your codebase and git history, letting the AI find code and commits by _meaning_ — not just keywords.

## What Gets Indexed

| Index           | What It Searches                          | Tool         |
| --------------- | ----------------------------------------- | ------------ |
| **Code**        | Functions, classes, types, comments, docs | `rag_search` |
| **Git History** | Commit messages and metadata              | `git_search` |

Both require a reachable **Qdrant v1.14.x** server (local or remote).

## How It Works

1. Shofer scans your workspace files using tree-sitter for AST-aware parsing
2. Code blocks are embedded as vectors and stored in Qdrant
3. A file watcher keeps the index up to date as you edit
4. The AI uses [`rag_search`]() and [`git_search`]() tools to query the index

## Setup

1. Open **Settings** → **RAG Indexing**
2. Configure your Qdrant server URL and API key
3. Pick an embedding provider (OpenAI, Ollama, etc.)
4. Click **Start Indexing**

The **Indexing Status Badge** in the Shofer sidebar shows progress and lets you stop/restart indexing.

## Why Index?

- **Lightning-fast code search** — semantic results in milliseconds
- **Understand code history** — find the commit that introduced a bug by describing _what_ changed, not searching for exact keywords
- **Works offline** — index once, query forever (local Qdrant)

[Read the full RAG indexing documentation](https://github.com/shofer-dev/shofer/blob/master/docs/rag_indexing.md)
