# RAG Code Indexing — Design & Implementation

## Purpose

Shofer's code indexing is a **semantic code search** system (RAG — Retrieval-Augmented Generation) that uses **vector embeddings** stored in **Qdrant** to let the AI agent search codebases by meaning rather than just keywords. It lives under `src/services/code-index/` and is exposed to the AI as the `rag_search` native tool. A lighter companion tool `lsp_search` uses VS Code's built-in Language Server Protocol workspace symbol provider and requires no external infrastructure.

---

## Architecture

```
CodeIndexManager (singleton per workspace)
 ├── CodeIndexConfigManager       — reads/writes settings & secrets
 ├── CodeIndexStateManager        — UI progress events
 │                                   (IndexingState: Standby|Indexing|Indexed|Error|Stopping)
 ├── CacheManager                 — file hash cache (SHA-256 per file, stored in VS Code globalStorage, NOT on Qdrant PVC)
 ├── CodeIndexServiceFactory      — creates embedder, vector-store, scanner, parser, file-watcher
 ├── CodeIndexOrchestrator        — drives the indexing workflow (scan → watch)
 │    ├── DirectoryScanner        — walks files, parses, batches embeddings, upserts to Qdrant
 │    │    └── CodeParser         — tree-sitter based AST parsing → CodeBlock[]
 │    └── FileWatcher             — VS Code `FileSystemWatcher` (`vscode.workspace.createFileSystemWatcher`) for incremental re-indexing
 └── CodeIndexSearchService       — embeds query → cosine search against Qdrant
```

### Key Source Files

| File                                                     | Role                                                                                                                                                    |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/services/code-index/manager.ts`                     | Singleton per workspace. Orchestrates lifecycle: `initialize()` → `startIndexing()` → `searchIndex()`. Handles error recovery and settings changes.     |
| `src/services/code-index/orchestrator.ts`                | Runs full or incremental scan, starts file watcher. Manages abort/cancel via `AbortController`. Phase 2: git-aware short-circuit before directory walk. |
| `src/services/code-index/service-factory.ts`             | Creates `IEmbedder`, `IVectorStore`, `DirectoryScanner`, `FileWatcher` based on config.                                                                 |
| `src/services/code-index/git/git-source.ts`              | Thin wrapper around VS Code built-in Git extension API. Provides `diffSince()`, `discoverSubmodules()`, `diffSubmoduleSince()`.                         |
| `src/services/code-index/processors/scanner.ts`          | Parallel file traversal with concurrency control (`p-limit`). Batches code blocks, creates embeddings, upserts to Qdrant. Handles file deletions.       |
| `src/services/code-index/processors/parser.ts`           | Uses **web-tree-sitter** for AST-aware parsing. Falls back to line-based chunking for unsupported languages. Also handles Markdown via custom parser.   |
| `src/services/code-index/search-service.ts`              | Embeds query text → searches Qdrant with configurable min score & max results.                                                                          |
| `src/services/code-index/config-manager.ts`              | Reads settings from `ContextProxy` (global state + secrets). Detects config changes requiring restart.                                                  |
| `src/services/code-index/state-manager.ts`               | `vscode.EventEmitter`-based progress reporting to UI.                                                                                                   |
| `src/services/code-index/cache-manager.ts`               | Persists file cache (v2: hash + mtimeMs + size) to skip unchanged files during scans.                                                                   |
| `src/services/code-index/vector-store/qdrant-client.ts`  | Implements `IVectorStore` using `@qdrant/js-client-rest`. One collection per workspace. Stores metadata with commit info.                               |
| `packages/types/src/codebase-index.ts`                   | Zod schemas for config, shared constants, and cache entries.                                                                                            |
| `src/services/tree-sitter/languageParser.ts`             | Maps file extensions to tree-sitter WASM parsers and language-specific AST queries. Fallthrough to `default:` throws for unsupported extensions.        |
| `src/services/tree-sitter/queries/`                      | Per-language tree-sitter query files (e.g., `scala.ts`, `css.ts`, `python.ts`) that define AST capture patterns for definitions.                        |
| `src/services/code-index/shared/supported-extensions.ts` | `fallbackExtensions` — extensions routed to line-based chunking instead of tree-sitter parsing.                                                         |

### Language Coverage

Files are ingested only if their extension appears in [`CODEBASE_INDEX_FILE_EXTENSIONS`](extensions/shofer/packages/types/src/codebase-index.ts:25), defined in `@shofer/types`. The indexing pipeline then routes each file through either tree-sitter AST parsing or length-based fallback chunking:

| Extension(s)         | Parser            | Mechanism                                              |
| -------------------- | ----------------- | ------------------------------------------------------ |
| `.js` `.jsx` `.json` | JavaScript        | Tree-sitter WASM                                       |
| `.ts`                | TypeScript        | Tree-sitter WASM                                       |
| `.tsx`               | TSX               | Tree-sitter WASM                                       |
| `.py`                | Python            | Tree-sitter WASM                                       |
| `.rs`                | Rust              | Tree-sitter WASM                                       |
| `.go`                | Go                | Tree-sitter WASM                                       |
| `.c` `.h`            | C                 | Tree-sitter WASM                                       |
| `.cpp` `.hpp`        | C++               | Tree-sitter WASM                                       |
| `.cs`                | C#                | Tree-sitter WASM                                       |
| `.rb`                | Ruby              | Tree-sitter WASM                                       |
| `.java`              | Java              | Tree-sitter WASM                                       |
| `.php`               | PHP               | Tree-sitter WASM                                       |
| `.swift`             | Swift             | Fallback chunking (parser instability)                 |
| `.kt` `.kts`         | Kotlin            | Tree-sitter WASM                                       |
| `.css`               | CSS               | Tree-sitter WASM                                       |
| `.html` `.htm`       | HTML              | Tree-sitter WASM (shared parser, `parserKey = "html"`) |
| `.ml` `.mli`         | OCaml             | Tree-sitter WASM                                       |
| `.scala`             | Scala             | Tree-sitter WASM                                       |
| `.sol`               | Solidity          | Tree-sitter WASM                                       |
| `.toml`              | TOML              | Tree-sitter WASM                                       |
| `.vue`               | Vue               | Tree-sitter WASM                                       |
| `.lua`               | Lua               | Tree-sitter WASM                                       |
| `.rdl`               | SystemRDL         | Tree-sitter WASM                                       |
| `.tla`               | TLA⁺              | Tree-sitter WASM                                       |
| `.zig`               | Zig               | Tree-sitter WASM                                       |
| `.ejs` `.erb`        | Embedded Template | Tree-sitter WASM (`parserKey = "embedded_template"`)   |
| `.el`                | Emacs Lisp        | Tree-sitter WASM                                       |
| `.ex` `.exs`         | Elixir            | Tree-sitter WASM                                       |
| `.vb`                | Visual Basic .NET | Fallback chunking (no WASM parser)                     |
| `.elm`               | Elm               | Fallback chunking (no WASM parser)                     |
| `.md` `.markdown`    | —                 | Custom markdown parser (heading/anchor extraction)     |

Extensions in `fallbackExtensions` ([`supported-extensions.ts`](extensions/shofer/src/services/code-index/shared/supported-extensions.ts:21)) are detected before tree-sitter dispatch by [`shouldUseFallbackChunking()`](extensions/shofer/src/services/code-index/shared/supported-extensions.ts:32). They never reach [`loadRequiredLanguageParsers()`](extensions/shofer/src/services/tree-sitter/languageParser.ts:78), so the corresponding `case` in the parser switch is dead code — kept only for the `list_code_definition_names` tool, which does **not** check `fallbackExtensions` and therefore will crash on these extensions.

### Interfaces

All interfaces are defined under `src/services/code-index/interfaces/`:

- **`IEmbedder`** (`embedder.ts`) — `createEmbeddings(texts, model?)`, `validateConfiguration()`
- **`IVectorStore`** (`vector-store.ts`) — `initialize()`, `upsertPoints()`, `search()`, `deletePointsByFilePath()`, `deletePointsByMultipleFilePaths()`, `hasIndexedData()`, `markIndexingComplete/Incomplete()`, `clearCollection()`, `deleteCollection()`, `collectionExists()`
- **`ICodeParser`** (`file-processor.ts`) — `parseFile(filePath, options?)` → `CodeBlock[]`
- **`IFileWatcher`** (`file-processor.ts`) — `initialize()`, `processFile()`, events: `onDidStartBatchProcessing`, `onBatchProgressUpdate`, `onDidFinishBatchProcessing`
- **`ICodeIndexManager`** (`manager.ts`) — public API contract

### Data Types

**`CodeBlock`** — a parsed code segment:

```typescript
{
	file_path: string
	identifier: string | null // function/class name
	type: string // AST node type
	start_line: number
	end_line: number
	content: string
	fileHash: string
	segmentHash: string
}
```

**`VectorStoreSearchResult`** — a search hit:

```typescript
{
	id: string | number
	score: number
	payload?: Payload | null
	// Payload: { filePath: string, codeChunk: string, startLine: number, endLine: number, ... }
}
```

---

## Supported Embedding Providers

8 providers, each implementing `IEmbedder`:

| Provider          | Source File                      | Auth                      |
| ----------------- | -------------------------------- | ------------------------- |
| OpenAI            | `embedders/openai.ts`            | API key                   |
| Ollama            | `embedders/ollama.ts`            | Base URL (local)          |
| OpenAI-Compatible | `embedders/openai-compatible.ts` | Base URL + API key        |
| Gemini            | `embedders/gemini.ts`            | API key                   |
| Mistral           | `embedders/mistral.ts`           | API key                   |
| Vercel AI Gateway | `embedders/vercel-ai-gateway.ts` | API key                   |
| AWS Bedrock       | `embedders/bedrock.ts`           | Region + optional profile |
| OpenRouter        | `embedders/openrouter.ts`        | API key                   |

Provider selection is stored in `codebaseIndexEmbedderProvider` setting. Model ID and dimension are resolved via `shared/embeddingModels.ts` profiles.

---

## Data Flow: Indexing Pipeline

### 1. Activation (`extension.ts:126-142`)

During extension activation, for each workspace folder:

```
CodeIndexManager.getInstance(context, folder.uri.fsPath)
  → manager.initialize(contextProxy)   // non-blocking, runs in background
```

### 2. Initialization (`manager.ts:163-215`)

```
ConfigManager.loadConfiguration()
  → check: enabled? configured? workspace enabled?
  → CacheManager.initialize()
  → _recreateServices():
      ServiceFactory.createServices() → {embedder, vectorStore, scanner, fileWatcher}
      validateEmbedder() → probe embedding API
  → orchestrator.startIndexing()
```

### 3. Indexing (`orchestrator.ts:98-358`)

```
vectorStore.initialize() → create Qdrant collection if needed
  → if existing data:
      Phase 2 (Git-aware narrowing): getMetadata() → getRepository()
        → if repo && lastIndexedCommit:
            diffSince(lastIndexedCommit) → changed + deleted
            + dirtyChanges (unstaged/staged/untracked)
            + submodule: diffSubmoduleSince(storedCommit) → changed + deleted
            → scanner.scanSpecificFiles(changed) + deleteSpecificFiles(deleted)
            → markIndexingComplete(HEAD, submoduleCommits)
            → skip directory walk
        → else: fall through to Phase 1 incremental scan
  → if no data: full scan
  → scanner.scanDirectory():   (Layer A fallback)
      listFiles() → filter by extensions, .gitignore, .shoferignore
      → for each file (parallel, concurrency=10):
          stat() → get mtimeMs + size
          Phase 1 fast-path: if cache entry has matching mtimeMs+size → skip
          (avoids readFile + SHA-256 for unchanged files)
          readFile() + SHA-256 hash → if hash matches cache → update mtimeMs+size, skip
          → CodeParser.parseFile():
              tree-sitter AST → extract functions/classes etc. as CodeBlock[]
              fallback: line-based chunking for unsupported exts
          → accumulate blocks into batches (threshold=60)
          → when batch full:
              embedder.createEmbeddings(batchTexts)
              → QdrantVectorStore.upsertPoints(points with UUID-v5 IDs)
              → CacheManager.updateEntry() (stores hash + mtimeMs + size)
      → handle deleted files (remove from Qdrant + cache)
  → start FileWatcher for incremental updates
  → markIndexingComplete()
```

### Storage Topology

The system uses **two separate storage locations** for different kinds of data:

| Data                                                                               | Storage Location                                                                                                                            | Survives Reboot?                                |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **Vector embeddings** (in Qdrant)                                                  | Qdrant PVC (`qdrant-storage`, `local-path`) — stored at `/var/lib/rancher/k3s/storage/pvc-<uuid>_shofer_qdrant-storage/`                    | ✓ Yes — persisted on Kubernetes PVC             |
| **File cache** (v2: hash + mtimeMs + size per file)                                | Local filesystem — VS Code globalStorage directory: `~/.config/Code/User/globalStorage/shofer.dev/shofer-index-cache-<workspace-hash>.json` | ✗ No — stored on laptop filesystem, outside PVC |
| **Metadata marker** (`indexing_complete`, `lastIndexedCommit`, `submoduleCommits`) | Qdrant collection — a special point with `type: "metadata"` and indexing status + git commit info                                           | ✓ Yes — persisted in Qdrant                     |

#### Cache Location & Format

The `CacheManager` persists a version 2 JSON cache to VS Code's extension global storage directory:

```
~/.config/Code/User/globalStorage/shofer.dev/shofer-index-cache-<sha256-of-workspace-path>.json
```

**v2 format** (Phase 1 — stat()-only fast-path):

```json
{
	"version": 2,
	"entries": {
		"src/utils/helpers.ts": {
			"hash": "a1b2c3d4...",
			"mtimeMs": 1715952000000,
			"size": 4096
		}
	}
}
```

Each entry stores the file's SHA-256 hash, last-modified time (ms), and size (bytes). On startup reconciliation, the scanner calls `stat()` and compares `mtimeMs` and `size` against the cache. If both match, the file is skipped without reading or hashing it. If only the hash matches (mtime changed but content identical — rare cases like `touch`, rebase, rsync -t), the cache entry is updated with the new mtimeMs/size and the file is still skipped. Per the **Versioned Snapshot Rule**, a `version` mismatch discards the entire cache and starts fresh.

This cache file is **NOT** on the Qdrant PVC. It lives on the local filesystem with VS Code's settings.

#### Incremental Scan Logic

After a reboot, when `CodeIndexManager.initialize()` runs:

```
1. vectorStore.initialize() → connects to Qdrant, collection already exists with N points
2. hasIndexedData() → checks if collection has points AND metadata marker exists
   → if points_count > 0 → collection has indexed data ✓
3. if hasIndexedData():
       → runs incremental scan: per-file stat() → compare mtimeMs+size with cache
         → if mtime+size match: skip (Phase 1 fast-path — no read, no hash)
         → if not: readFile + SHA-256 → if hash matches: update cache entry, skip
         → else: parse, embed, upsert
   else:
       → runs full scan: embed all files
```

The critical dependency: **incremental scans require the cache file to be present**. Without it, the system cannot determine which files are unchanged → treats all files as new/changed → re-embeds everything, even though Qdrant already contains the vectors. The Phase 1 mtime+size fast-path makes startup reconciliation O(changed files) instead of O(workspace files) — on a workspace where nothing changed, zero `readFile` calls are made.

#### Phase 2: Git-Aware Narrowing

When a git repository is detected, the orchestrator bypasses the directory walk entirely:

```
4. getMetadata() → read lastIndexedCommit, submoduleCommits from Qdrant
5. if repo && lastIndexedCommit:
     git diffSince(lastIndexedCommit) → main-repo changed + deleted
     + dirtyChanges (unstaged/staged/untracked files)
     + for each submodule:
         if storedCommit != currentCommit:
             diffSubmoduleSince(storedCommit) → changed + deleted
     → scanner.scanSpecificFiles(changed) + scanner.deleteSpecificFiles(deleted)
     → markIndexingComplete(HEAD, submoduleCommits)
     → return (skip full directory walk)
   else:
     fall through to Layer A (Phase 1 fast-path full directory walk)
```

**Submodule support**: `GitSource.discoverSubmodules()` finds child repositories tracked by VS Code. For each submodule, the orchestrator compares the stored commit against the current HEAD. If they differ, it diffs the submodule from the stored commit. New submodules (no stored commit) are included in the directory walk via the Layer A fallback.

**Fallbacks**: If `diffSince` throws ("bad object", missing commit), or the git extension is unavailable, or `lastIndexedCommit` is absent from metadata — the orchestrator falls through to the existing Phase 1 incremental scan.

On a 50k-file repo with 3 dirty files, startup reconciliation now issues one `git diff` + one status query and processes 3 files — no directory walk at all.

#### Reboot Behavior

After a system reboot, **no restart of indexing is needed** because:

- ✓ Qdrant PVC retains all vectors (53,000+ points survive)
- ✓ Metadata marker (`indexing_complete`) stored in Qdrant, survives reboot
- ✓ If hash cache is intact → incremental scan skips unchanged files
- ⚠ If hash cache was lost/deleted → full re-embed (vectors re-created but identical)

The hash cache is the only component that may not survive a reboot depending on system configuration. The Qdrant PVC is the durable store of record.

#### Startup Reconciliation Layers (summary)

The startup reconciliation pipeline is organised as three layers, each strictly more selective than the next. A layer falls through to the next when its inputs are missing or its assumptions fail.

| Layer                                       | Candidate set                                                                                                                                         | Fallback trigger                                                                                                                                 |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **B. Git-aware narrowing** (Phase 2)        | `git diff <lastIndexedCommit> HEAD` ∪ working-tree dirty changes ∪ per-submodule diff                                                                 | git extension unavailable, `lastIndexedCommit` missing from Qdrant metadata, `diffSince` throws ("bad object"), or a new submodule is discovered |
| **A. Versioned mtime+size cache** (Phase 1) | every file in workspace, but only `stat()` per file — no read, no hash, no parse, when `entry.mtimeMs === stats.mtimeMs && entry.size === stats.size` | cache v1 (or older) on disk → version-mismatch discards cache and re-scans                                                                       |
| **Hash check** (legacy, final tiebreaker)   | files that failed layer A (mtime/size changed) — `readFile` + SHA-256, skip if hash matches cache                                                     | none — always available                                                                                                                          |

Per the **Versioned Snapshot Rule** and **No Backward Compatibility Unless Asked** rule, schema bumps (cache `version`, Qdrant metadata fields) discard old state rather than migrate. Each layer was shipped as its own minor-version bump.

Phase 3 (an "optimistic `Indexed` state" that flips the badge green immediately and reconciles in the background) is tracked in [`todos/code-indexer-optimistic-indexed.md`](../../../todos/code-indexer-optimistic-indexed.md).

### 4. Search (`RagSearchTool.ts` → `search-service.ts`)

```
User query string
  → embedder.createEmbeddings([query]) → query vector
  → vectorStore.search(vector, directoryPrefix, minScore, maxResults)
  → return results [{filePath, score, startLine, endLine, codeChunk}]
```

---

## Two Search Tools

### `rag_search` — Semantic (embedding-based)

- Requires Qdrant + embedding provider configuration.
- Uses vector cosine similarity search.
- Tool implementation: `src/core/tools/RagSearchTool.ts`.
- Tool schema: `src/core/prompts/tools/native-tools/rag_search.ts`.
- Conditionally available only when `CodeIndexManager` is enabled + configured + initialized (see `filter-tools-for-mode.ts:271-277`).

### `lsp_search` — Symbol-based (LSP)

- Uses `vscode.executeWorkspaceSymbolProvider` with word-level text fallback.
- No external infrastructure required — works out of the box.
- Tool implementation: `src/core/tools/LspSearchTool.ts`.
- Tool schema: `src/core/prompts/tools/native-tools/lsp_search.ts`.
- Always available to the agent.

---

## Integration Points

### Extension Host

| Point      | File                                           | Details                                                                                                   |
| ---------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Activation | `src/extension.ts:126-142`                     | Creates `CodeIndexManager` per workspace folder, initializes in background                                |
| Provider   | `src/core/webview/ShoferProvider.ts:3106-3139` | `updateCodeIndexStatusSubscription()` subscribes to `onProgressUpdate` to push indexing status to webview |
| Commands   | `src/activate/registerCommands.ts:289`         | Registers commands that reference `CodeIndexManager`                                                      |

### Settings & Webview

| Point            | File                                 | Details                                                                     |
| ---------------- | ------------------------------------ | --------------------------------------------------------------------------- |
| Settings save    | `webviewMessageHandler.ts:2562`      | `saveCodeIndexSettingsAtomic` → saves secrets + `handleSettingsChange()`    |
| Status request   | `webviewMessageHandler.ts:2724`      | `requestIndexingStatus`                                                     |
| Start/stop/clear | `webviewMessageHandler.ts:2812-2898` | `startIndexing`, `stopIndexing`, `clearIndexData`, `toggleCodeIndexEnabled` |
| Secret status    | `webviewMessageHandler.ts:2784`      | `requestCodeIndexSecretStatus`                                              |
| Status display   | `ShoferProvider.ts:3099-3139`        | `getCurrentWorkspaceCodeIndexManager()`, subscribes to progress updates     |

### Tool System

| Point             | File                                                            | Details                                                                 |
| ----------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Tool registration | `src/core/task/build-tools.ts:258-259`                          | Gets `CodeIndexManager` for current workspace, passes to tool filter    |
| Tool filtering    | `src/core/prompts/tools/filter-tools-for-mode.ts:271-277`       | Removes `rag_search` if indexing is disabled/unconfigured/uninitialized |
| Tool dispatch     | `src/core/assistant-message/presentAssistantMessage.ts:822-828` | Routes to `RagSearchTool` or `LspSearchTool`                            |
| Auto-approval     | `src/core/auto-approval/tools.ts:20`                            | `ragSearch` is auto-approved by default                                 |
| System prompt     | `src/core/prompts/system.ts:72`                                 | Includes indexing status in system prompt context                       |

### Configuration Schema

Defined in `packages/types/src/codebase-index.ts`:

```typescript
codebaseIndexEnabled: boolean
codebaseIndexQdrantUrl: string
codebaseIndexEmbedderProvider: "openai" |
	"ollama" |
	"openai-compatible" |
	"gemini" |
	"mistral" |
	"vercel-ai-gateway" |
	"bedrock" |
	"openrouter"
codebaseIndexEmbedderBaseUrl: string // base URL override (OpenAI-compatible)
codebaseIndexEmbedderModelId: string
codebaseIndexEmbedderModelDimension: number
codebaseIndexSearchMinScore: number // 0–1, default 0.4
codebaseIndexSearchMaxResults: number // 10–200, default 50
// OpenAI Compatible specific
codebaseIndexOpenAiCompatibleBaseUrl: string
codebaseIndexOpenAiCompatibleModelDimension: number
// Bedrock specific
codebaseIndexBedrockRegion: string
codebaseIndexBedrockProfile: string
// OpenRouter specific
codebaseIndexOpenRouterSpecificProvider: string
```

Secrets are stored via VS Code's `SecretStorage` (keyed as `codeIndexOpenAiKey`, `codeIndexQdrantApiKey`, `codebaseIndexOpenAiCompatibleApiKey`, `codebaseIndexGeminiApiKey`, `codebaseIndexMistralApiKey`, `codebaseIndexVercelAiGatewayApiKey`, `codebaseIndexOpenRouterApiKey`).

---

## Key Constants

Defined in `src/services/code-index/constants/index.ts`:

| Constant                          | Value  | Purpose                                           |
| --------------------------------- | ------ | ------------------------------------------------- |
| `MAX_BLOCK_CHARS`                 | 1000   | Max characters per code block                     |
| `MIN_BLOCK_CHARS`                 | 50     | Min characters per code block                     |
| `MIN_CHUNK_REMAINDER_CHARS`       | 200    | Min size for the remainder when splitting a chunk |
| `MAX_CHARS_TOLERANCE_FACTOR`      | 1.15   | 15% tolerance on max block size                   |
| `MAX_FILE_SIZE_BYTES`             | 1 MB   | Skip files larger than this                       |
| `BATCH_SEGMENT_THRESHOLD`         | 60     | Code segments per embedding API call              |
| `MAX_LIST_FILES_LIMIT_CODE_INDEX` | 50,000 | Max files to scan                                 |
| `PARSING_CONCURRENCY`             | 10     | Parallel file parsing limit                       |
| `BATCH_PROCESSING_CONCURRENCY`    | 10     | Parallel embedding batch processing               |
| `MAX_PENDING_BATCHES`             | 20     | Backpressure limit on pending embedding batches   |
| `MAX_BATCH_RETRIES`               | 3      | Retry count for failed embedding batches          |
| `INITIAL_RETRY_DELAY_MS`          | 500    | Initial delay before first batch retry (ms)       |
| `DEFAULT_SEARCH_MIN_SCORE`        | 0.4    | Cosine similarity threshold for search results    |
| `DEFAULT_MAX_SEARCH_RESULTS`      | 50     | Default max number of search results              |

---

## Multi-Workspace Support

`CodeIndexManager` uses a **singleton-per-workspace** pattern via `Map<string, CodeIndexManager>` keyed by `workspacePath`. Per-workspace enablement is stored in `workspaceState` under key `codeIndexWorkspaceEnabled:<folder-uri>`. Each workspace gets its own Qdrant collection name derived from a hash of the workspace path.

---

## Error Handling & Recovery

- **Error recovery**: `recoverFromError()` clears all service instances, forcing a clean re-initialization on next use. Protected against race conditions with `_isRecoveringFromError` flag.
- **Cache preservation**: If Qdrant connection fails, the cache is preserved for future incremental scans. If indexing fails mid-way (after connecting), the cache is cleared to avoid inconsistency.
- **Retry logic**: Failed embedding batches retry up to 3 times with exponential backoff (500ms initial delay).
- **Telemetry**: All errors are captured via `TelemetryService.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {...})` with location context.

---

## State Machine

```
Standby ──startIndexing()──→ Indexing ──scan complete──→ Indexed
   ↑                           │                          │
   │                    stopIndexing()              file changes
   │                           │                          │
   └─────────────────────── Stopping              Incremental scan
                                │                          │
                           (aborted)                    Indexing
                                                        │
         Error ←─── any failure ─────────────────────────┘
           │
           └──recoverFromError()──→ Standby (clean slate)
```
