# Git Commit History Search

Shofer can build a **semantic search index of your git commit history**, letting
the AI agent find relevant commits by _meaning_ rather than by exact keyword
matches. This is exposed through the `git_search` tool and complements
[`rag_search`](rag-indexing.md) (which indexes source code) with historical
rationale — who changed what, when, and why.

> **Note:** `git_search` indexes commit _messages_ only (subject + body). It does
> NOT index diffs, file contents, or blame data.

## Quick Start

1. **Prerequisite — Code Index must be configured.** `git_search` reuses the
   same Qdrant instance and embedding provider as [`rag_search`](rag-indexing.md).
   If you haven't set those up yet, do that first.
2. **Enable git indexing** in **Settings → RAG / Code Index → Git History**.
3. Shofer will scan your repository's commit history (default: last 365 days,
   up to 10,000 commits), build embeddings of commit messages, and store them in
   Qdrant.

The **indexing status badge** in the chat input bar reflects combined code and
git index status. Hover to see tooltip details:

<!-- XXX: Screenshot — Hover tooltip on the IndexingStatusBadge showing the
     combined status breakdown: "Code: Indexed / 12,430 files" and "Git: Indexed
     / 847 commits". The badge should show a green checkmark (both healthy). -->

## Indexing Status Badge

The same badge used for code indexing also reflects git index state. The tooltip
breaks down each indexer status separately:

| State        | Meaning                                                                  |
| ------------ | ------------------------------------------------------------------------ |
| **Standby**  | Git indexing is enabled but not running (not yet started, or stopped).   |
| **Indexing** | Currently extracting and embedding commit messages. A spinner is shown.  |
| **Indexed**  | Indexing is complete and up to date. Watcher is polling for new commits. |
| **Error**    | Something went wrong (e.g., not a git repo, Qdrant unreachable).         |

Click the badge to open the **Code Index Popover**, which shows a **Git History**
section with the number of indexed commits and **Start / Stop / Clear** buttons.

<!-- XXX: Screenshot — CodeIndexPopover open, scrolled down to show the "Git
     History" section with a green dot (Indexed state), "Indexed all commits"
     label, commit count ("847 commits indexed"), and the Start/Stop/Clear
     buttons below. -->

## How the Agent Uses `git_search`

The AI agent can call `git_search` to answer questions like:

- _"Who added the authentication middleware?"_
- _"When was the rate limiter last changed?"_
- _"Find commits related to the database migration."_
- _"What was the rationale for removing the caching layer?"_

The tool returns matching commits sorted by relevance (cosine similarity score),
each including: commit hash, short hash, author, date, subject, and body.

The agent decides when to use `git_search` vs. `rag_search` vs. `grep_search`
automatically — you don't need to tell it.

<!-- XXX: Screenshot — A ChatView showing a `git_search` result block: the
     agent's query ("Find commits related to authentication"), followed by a
     results card showing 3–5 commit entries, each with short hash, author name,
     date, subject line, and a relevance score. The "Showing N of M commits"
     header should be visible. -->

## Configuration Reference

All git search settings live under **Settings → RAG / Code Index → Git History**.
They can also be set via `settings.json`:

```jsonc
{
	// Enable/disable git commit history indexing
	"shofer.codebaseIndexGitEnabled": true,

	// Max days of commit history to index (1–365, default: 365)
	"shofer.codebaseIndexGitMaxHistoryDays": 365,

	// Hard cap on number of commits indexed (100–10000, default: 10000)
	"shofer.codebaseIndexGitMaxCommits": 10000,

	// Branch (git ref) to index; empty = HEAD (default)
	"shofer.codebaseIndexGitBranch": "",

	// Poll interval for new commit detection (1–60 min, default: 5)
	"shofer.codebaseIndexGitPollIntervalMinutes": 5,

	// Minimum similarity score for search results (0–1, default: 0.4)
	"shofer.codebaseIndexGitSearchMinScore": 0.4,

	// Default max results per query (1–50, default: 20)
	"shofer.codebaseIndexGitSearchMaxResults": 20,
}
```

<!-- XXX: Screenshot — The Settings panel scrolled to the RAG / Code Index →
     Git History section, showing the Enable toggle, all sliders (Max history,
     Max commits, Poll interval, Min similarity, Max results), and the
     Start/Stop/Clear action buttons. -->

## What Gets Indexed

- **All commits** on the configured branch within the time window, up to the max
  commits cap.
- Each commit's **subject line + body** is embedded as a single unit.
- Commits from **git submodules** are included if your workspace contains them.
- Messages longer than **4,000 characters** are truncated before embedding.
- Non-UTF-8 commit messages are handled (forced to UTF-8 with replacement
  characters).

## Incremental Updates

Once the initial index is built, Shofer starts a **watcher** that polls for new
commits every N minutes (configurable, default 5). When you make new commits,
they're automatically picked up and indexed. The poll interval can be adjusted in
Settings.

## Reboots & Cache

Shofer caches per-commit content hashes in VS Code's `globalStorage`. On
restart or re-index, unchanged commits are skipped — only new commits are
embedded. This makes re-indexing fast even for large repositories.

If Qdrant or the embedding provider is unreachable, the cache is preserved and
indexing resumes when connectivity is restored.

## `git_search` vs Other Search Tools

| Tool          | Searches                   | Needs setup?    | Best for                                     |
| ------------- | -------------------------- | --------------- | -------------------------------------------- |
| `git_search`  | Git commit messages        | ✅ Yes (shared) | "Who added this?", "When did this change?"   |
| `rag_search`  | Source code (semantic)     | ✅ Yes          | "How does auth work?", finding by concept    |
| `lsp_search`  | Symbols (functions, types) | ❌ No           | Finding function/class definitions by name   |
| `grep_search` | File contents (text)       | ❌ No           | Exact string matches, finding all call sites |

## Privacy

Commit messages are embedded by your configured embedding provider (same one used
for code indexing). If you use a local provider like **Ollama**, your commit
messages never leave your machine. If you use a cloud provider (OpenAI, etc.),
commit message text is sent for embedding generation — consider this when
indexing repositories with sensitive commit messages.
