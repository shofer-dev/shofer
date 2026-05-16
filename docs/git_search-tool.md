# `git_search` — Git Commit History RAG Tool

## Purpose

`git_search` is a **semantic search tool over git commit history**. It indexes commit messages (subject + body, **not diffs**) into a Qdrant vector collection separate from the code index. The agent can then discover relevant commit context — who changed what, when, and why — by searching by meaning rather than exact keywords. This complements [`rag_search`](rag_indexing.md) (which indexes source code) with historical rationale and change narrative.

**Non-goals:** This tool does NOT index diffs, file contents, or blame data. It is strictly commit-message search.

---

## Architecture

```
GitHistoryManager (per workspace, sibling to CodeIndexManager)
 ├── GitLogExtractor            — runs `git log`, parses structured output
 ├── CodeIndexConfigManager     — REUSED: same embedder/Qdrant settings
 ├── GitCacheManager            — SHA-256 per-commit hash cache (globalStorage, like code cache)
 ├── CodeIndexServiceFactory    — REUSED: creates IEmbedder + QdrantVectorStore (dedicated collection)
 ├── GitHistoryOrchestrator     — drives indexing (extract → embed → upsert)
 │    ├── GitLogExtractor       — runs `git log --format=...` for structured output
 │    └── GitWatcher            — polls or watches for new commits
 └── GitSearchService           — embeds query → cosine search against git Qdrant collection
```

### Relationship to existing Code Index

| Aspect                | Code Index (`rag_search`)    | Git Index (`git_search`)          | Shared?           |
| --------------------- | ---------------------------- | --------------------------------- | ----------------- |
| **Qdrant collection** | `ws-<hash>`                  | `git-<hash>`                      | ✗ No — dedicated  |
| **Embedder**          | `IEmbedder` (8 providers)    | `IEmbedder` (8 providers)         | ✓ Yes — same pool |
| **Qdrant URL**        | `codebaseIndexQdrantUrl`     | `codebaseIndexQdrantUrl`          | ✓ Yes             |
| **Config manager**    | `CodeIndexConfigManager`     | `CodeIndexConfigManager`          | ✓ Yes             |
| **Service factory**   | `CodeIndexServiceFactory`    | `CodeIndexServiceFactory`         | ✓ Yes             |
| **Cache manager**     | `CacheManager` (file hashes) | `GitCacheManager` (commit hashes) | ✗ Separate        |
| **State manager**     | `CodeIndexStateManager`      | `GitHistoryStateManager`          | ✗ Separate        |
| **Search service**    | `CodeIndexSearchService`     | `GitSearchService`                | ✗ Separate        |

---

## Data Model

### GitCommitBlock — a parsed commit message segment

```typescript
{
	commit_hash: string // full SHA
	short_hash: string // 7-char abbrev
	author: string // "Name <email>"
	author_date: string // ISO 8601
	subject: string // first line of commit message
	body: string // remaining lines (may be empty)
	content: string // subject + "\n\n" + body — what gets embedded
	fileHash: string // SHA-256 of content (for cache skipping)
}
```

### GitSearchResult — returned by the search

```typescript
{
	id: string | number
	score: number
	payload: {
		commit_hash: string
		short_hash: string
		author: string
		author_date: string
		subject: string
		body: string
	}
}
```

### Qdrant Point Structure

Each commit message chunk is stored as one Qdrant point:

```typescript
{
	id: uuidv5(commit_hash, QDRANT_GIT_NAMESPACE)
	vector: number[]   // embedding of (subject + "\n\n" + body)
	payload: {
		commit_hash: string
		short_hash: string
		author: string
		author_date: string
		subject: string
		body: string
	}
}
```

---

## Data Flow

### Indexing Pipeline (Phase 1)

```
GitHistoryManager.startIndexing()
  → GitLogExtractor.extractCommits()
      `git log --format=%H|||%h|||%an <%ae>|||%aI|||%s|||%b|||ENDCOMMIT`
      → stream parse → GitCommitBlock[]
  → filter by maxHistoryDays (config, default 365)
  → GitCacheManager check: skip commits whose hash is unchanged
  → batch commits (BATCH_SEGMENT_THRESHOLD at a time)
  → embedder.createEmbeddings(batchContentTexts)
  → QdrantVectorStore.upsertPoints(points) → git-specific collection
  → start GitWatcher for incremental updates
```

### Search Pipeline

```
User query
  → embedder.createEmbeddings([query]) → query vector
  → vectorStore.search(vector, minScore, maxResults)
      (searches GIT collection, NOT code collection)
  → return results [{commit_hash, short_hash, author, author_date, subject, body, score}]
```

---

## Tool Schema (`native-tools/git_search.ts`)

```typescript
export default {
	type: "function",
	function: {
		name: "git_search",
		description: `Search git commit history (messages only) using semantic search. ...
Parameters:
- query: (required) The search query. ...
- maxResults: (optional) Maximum number of results (default 20, max 50).`,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: "Meaning-based search query...",
				},
				maxResults: {
					type: ["number", "null"],
					description: "Maximum number of results (default 20, max 50).",
				},
			},
			required: ["query", "maxResults"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
```

---

## Configuration

Reuses existing `codebaseIndex*` settings. New git-specific settings:

| Setting                            | Type    | Default | Description                           |
| ---------------------------------- | ------- | ------- | ------------------------------------- |
| `codebaseIndexGitEnabled`          | boolean | false   | Enable git history indexing           |
| `codebaseIndexGitMaxHistoryDays`   | number  | 365     | Max days of commit history to index   |
| `codebaseIndexGitMaxCommits`       | number  | 10000   | Hard cap on number of commits indexed |
| `codebaseIndexGitSearchMinScore`   | number  | 0.4     | Cosine similarity threshold           |
| `codebaseIndexGitSearchMaxResults` | number  | 20      | Default max results per query         |

These are added to [`packages/types/src/codebase-index.ts`](../packages/types/src/codebase-index.ts) (the existing Zod schema).

---

## Phased Implementation Plan

### Phase 1: Core Indexing + Search (MVP)

**Goal:** Single-workspace, full-scan-only, working search tool.

**Files to create:**

| File                                                     | Purpose                                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------------ | -------- | ------- | ----- |
| `src/services/git-index/interfaces/git.ts`               | `GitCommitBlock`, `IGitLogExtractor`, `IGitWatcher`, `IGitSearchService` |
| `src/services/git-index/processors/git-log-extractor.ts` | `GitLogExtractor`: runs `git log`, parses output                         |
| `src/services/git-index/processors/git-watcher.ts`       | Stub (no-op in Phase 1, implemented in Phase 2)                          |
| `src/services/git-index/git-cache-manager.ts`            | `GitCacheManager`: per-commit SHA-256 hash cache                         |
| `src/services/git-index/git-state-manager.ts`            | `GitHistoryStateManager`: Standby                                        | Indexing | Indexed | Error |
| `src/services/git-index/git-search-service.ts`           | `GitSearchService`: embed query → Qdrant search                          |
| `src/services/git-index/git-index-manager.ts`            | `GitIndexManager`: singleton, orchestrates lifecycle                     |
| `src/core/tools/GitSearchTool.ts`                        | `GitSearchTool`: `BaseTool<"git_search">` handler                        |
| `src/core/prompts/tools/native-tools/git_search.ts`      | Tool schema definition                                                   |

**Files to modify:**

| File                                                    | Change                                                                                       |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `packages/types/src/tool.ts`                            | Add `"git_search"` to `toolNames`, `ALWAYS_AVAILABLE_TOOLS`, and `TOOL_DISPLAY_NAMES`        |
| `packages/types/src/codebase-index.ts`                  | Add git-specific config fields to Zod schema                                                 |
| `packages/types/src/vscode-extension-host.ts`           | Add `"gitSearch"` to `ShoferSayTool.tool` union                                              |
| `src/shared/tools.ts`                                   | Add `git_search` to `NativeToolArgs` type                                                    |
| `src/core/prompts/tools/native-tools/index.ts`          | Import + register `gitSearch` tool schema                                                    |
| `src/core/task/build-tools.ts`                          | Import `GitIndexManager`, pass to filter                                                     |
| `src/core/prompts/tools/filter-tools-for-mode.ts`       | Conditionally exclude `git_search` if not configured (mirrors `rag_search` at lines 271-277) |
| `src/core/assistant-message/presentAssistantMessage.ts` | Add dispatch case (mirrors `rag_search`)                                                     |
| `src/core/assistant-message/NativeToolCallParser.ts`    | Add switch cases for `git_search`                                                            |
| `src/core/auto-approval/tools.ts`                       | Add `gitSearch: "git_search"` to auto-approved tools                                         |
| `src/extension.ts`                                      | Initialize `GitIndexManager` per workspace                                                   |
| `src/core/webview/ShoferProvider.ts`                    | Add `getCurrentWorkspaceGitIndexManager()`                                                   |
| `src/core/webview/webviewMessageHandler.ts`             | Add settings save/status/start/stop handlers                                                 |
| `src/activate/registerCommands.ts`                      | Wire up commands                                                                             |

**Key design decisions:**

1. **Separate Qdrant collection name**: `git-<sha256-of-workspace-path>.substring(0, 16)` — distinct from code's `ws-<hash>` pattern.
2. **UUID namespace**: `QDRANT_GIT_NAMESPACE = "a1b2c3d4-..."` — separate UUID v5 namespace from code blocks.
3. **Reuse embedder**: Same `IEmbedder` instance. No new API keys or provider config needed.
4. **Same Qdrant client**: Same URL, same `QdrantClient` instance (just a different collection).
5. **Per-workspace singleton**: `GitIndexManager` follows the same `Map<string, GitIndexManager>` pattern as `CodeIndexManager`.
6. **Git command execution**: Use `child_process.execFile("git", ["log", ...])` in the workspace directory. Handle missing git, non-git workspaces.
7. **Commit message chunking**: Whole commit messages are embedded as single units. No splitting within a commit. If a single message is too large (>8K tokens), it is truncated.
8. **Config gating**: `git_search` is only available when `codebaseIndexGitEnabled === true` AND the code index infrastructure is configured (embedder + Qdrant URL).

### Phase 2: Incremental Updates

**Goal:** Watch for new commits, index only changes.

**Changes:**

- Implement `GitWatcher` — polls `git log --since=<last-indexed-date>` every N minutes (configurable, default 5).
- `GitCacheManager` tracks `lastCommitDate` in addition to per-commit hashes.
- On workspace open, catch up any new commits since last index.

### Phase 3: Production Polish

**Goal:** Configuration UI, multi-workspace hardening, observability.

**Changes:**

- Settings UI in webview (toggle + history depth slider).
- Indexing progress in status bar.
- Structured logging via `TelemetryService`.
- Dedicated i18n strings in `chat.json`.

---

## Integration Checklist

Following the [adding-new-tools.md](adding-new-tools.md) 11-step checklist:

| #   | Location                                                | Item                                      |
| --- | ------------------------------------------------------- | ----------------------------------------- |
| 1   | `src/core/prompts/tools/native-tools/git_search.ts`     | Tool schema                               |
| 2   | `packages/types/src/tool.ts`                            | Add `"git_search"` to `toolNames`         |
| 3   | `packages/types/src/tool.ts`                            | Add to `ALWAYS_AVAILABLE_TOOLS`           |
| 4   | `src/core/tools/GitSearchTool.ts`                       | `BaseTool<"git_search">` handler          |
| 5   | `src/core/assistant-message/presentAssistantMessage.ts` | Dispatch case + `toolDescription()` case  |
| 6   | `src/shared/tools.ts`                                   | `NativeToolArgs` type entry               |
| 7   | `src/core/assistant-message/NativeToolCallParser.ts`    | 2 switch cases (partial + complete)       |
| 8   | `packages/types/src/vscode-extension-host.ts`           | `ShoferSayTool.tool` union                |
| 9   | `webview-ui/src/components/chat/ChatRow.tsx`            | ChatRow rendering case                    |
| 10  | `src/core/auto-approval/tools.ts`                       | Auto-approval entry (mirrors `ragSearch`) |
| 11  | `webview-ui/src/i18n/locales/en/chat.json`              | i18n strings                              |

---

## Error Handling & Edge Cases

| Scenario                       | Behavior                                                                   |
| ------------------------------ | -------------------------------------------------------------------------- |
| Not a git repository           | `git_search` tool unavailable; `GitIndexManager` stays in `Standby`        |
| `git` binary not found         | Graceful error logged; manager stays in `Error` state                      |
| Qdrant connection fails        | Same recovery path as code index; cache preserved                          |
| Empty commit history           | Indexing completes with 0 points; search returns "No results"              |
| Very large commit message      | Truncated to 8000 characters before embedding                              |
| Encoding issues (non-UTF-8)    | `git log` is forced to UTF-8 via `--encoding=UTF-8`; replace invalid chars |
| Workspace with 50,000+ commits | Capped by `codebaseIndexGitMaxCommits`; only most recent N are indexed     |

---

## State Machine

```
Standby ──startIndexing()──→ Indexing ──extract complete──→ Indexed
   ↑                            │                               │
   │                     stopIndexing()                   new commits
   │                            │                               │
   └──────────────────────── Stopping                   Incremental
                                │                               │
                           (aborted)                         Indexing
                                                               │
        Error ←─── any failure ────────────────────────────────┘
          │
          └──recoverFromError()──→ Standby (clean slate)
```
