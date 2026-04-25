# RAG Code Indexing — Design & Implementation

## Purpose

Roo-Code's code indexing is a **semantic code search** system (RAG — Retrieval-Augmented Generation) that uses **vector embeddings** stored in **Qdrant** to let the AI agent search codebases by meaning rather than just keywords. It lives under `src/services/code-index/` and is exposed to the AI as the `codebase_search` native tool. A lighter companion tool `codebase_search_with_lsp` uses VS Code's built-in Language Server Protocol workspace symbol provider and requires no external infrastructure.

---

## Architecture

```
CodeIndexManager (singleton per workspace)
 ├── CodeIndexConfigManager       — reads/writes settings & secrets
 ├── CodeIndexStateManager        — UI progress events
 │                                   (IndexingState: Standby|Indexing|Indexed|Error|Stopping)
 ├── CacheManager                 — file hash cache (avoids re-indexing unchanged files)
 ├── CodeIndexServiceFactory      — creates embedder, vector-store, scanner, parser, file-watcher
 ├── CodeIndexOrchestrator        — drives the indexing workflow (scan → watch)
 │    ├── DirectoryScanner        — walks files, parses, batches embeddings, upserts to Qdrant
 │    │    └── CodeParser         — tree-sitter based AST parsing → CodeBlock[]
 │    └── FileWatcher             — chokidar-based watcher for incremental re-indexing
 └── CodeIndexSearchService       — embeds query → cosine search against Qdrant
```

### Key Source Files

| File                                                    | Role                                                                                                                                                  |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/services/code-index/manager.ts`                    | Singleton per workspace. Orchestrates lifecycle: `initialize()` → `startIndexing()` → `searchIndex()`. Handles error recovery and settings changes.   |
| `src/services/code-index/orchestrator.ts`               | Runs full or incremental scan, starts file watcher. Manages abort/cancel via `AbortController`.                                                       |
| `src/services/code-index/service-factory.ts`            | Creates `IEmbedder`, `IVectorStore`, `DirectoryScanner`, `FileWatcher` based on config.                                                               |
| `src/services/code-index/processors/scanner.ts`         | Parallel file traversal with concurrency control (`p-limit`). Batches code blocks, creates embeddings, upserts to Qdrant. Handles file deletions.     |
| `src/services/code-index/processors/parser.ts`          | Uses **web-tree-sitter** for AST-aware parsing. Falls back to line-based chunking for unsupported languages. Also handles Markdown via custom parser. |
| `src/services/code-index/search-service.ts`             | Embeds query text → searches Qdrant with configurable min score & max results.                                                                        |
| `src/services/code-index/config-manager.ts`             | Reads settings from `ContextProxy` (global state + secrets). Detects config changes requiring restart.                                                |
| `src/services/code-index/state-manager.ts`              | `vscode.EventEmitter`-based progress reporting to UI.                                                                                                 |
| `src/services/code-index/cache-manager.ts`              | Persists file hashes (SHA-256) to skip unchanged files during scans.                                                                                  |
| `src/services/code-index/vector-store/qdrant-client.ts` | Implements `IVectorStore` using `@qdrant/js-client-rest`. One collection per workspace.                                                               |
| `packages/types/src/codebase-index.ts`                  | Zod schemas for config, shared constants.                                                                                                             |

### Interfaces

All interfaces are defined under `src/services/code-index/interfaces/`:

- **`IEmbedder`** (`embedder.ts`) — `createEmbeddings(texts, model?)`, `validateConfiguration()`
- **`IVectorStore`** (`vector-store.ts`) — `initialize()`, `upsertPoints()`, `search()`, `deletePointsByFilePath()`, `hasIndexedData()`, `markIndexingComplete/Incomplete()`
- **`ICodeParser`** (`file-processor.ts`) — `parseFile(filePath, options?)` → `CodeBlock[]`
- **`IFileWatcher`** (`file-processor.ts`) — `initialize()`, events: `onDidStartBatchProcessing`, `onBatchProgressUpdate`, `onDidFinishBatchProcessing`
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
	payload: {
		filePath: string
		codeChunk: string
		startLine: number
		endLine: number
	}
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

### 1. Activation (`extension.ts:182-203`)

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
  → if existing data: incremental scan (skip unchanged via cache)
  → if no data: full scan
  → scanner.scanDirectory():
      listFiles() → filter by extensions, .gitignore, .rooignore
      → for each file (parallel, concurrency=10):
          SHA-256 hash check → skip if unchanged
          → CodeParser.parseFile():
              tree-sitter AST → extract functions/classes etc. as CodeBlock[]
              fallback: line-based chunking for unsupported exts
          → accumulate blocks into batches (threshold=60)
          → when batch full:
              embedder.createEmbeddings(batchTexts)
              → QdrantVectorStore.upsertPoints(points with UUID-v5 IDs)
              → CacheManager.updateHash()
      → handle deleted files (remove from Qdrant + cache)
  → start FileWatcher for incremental updates
  → markIndexingComplete()
```

### 4. Search (`CodebaseSearchTool.ts` → `search-service.ts`)

```
User query string
  → embedder.createEmbeddings([query]) → query vector
  → vectorStore.search(vector, directoryPrefix, minScore, maxResults)
  → return results [{filePath, score, startLine, endLine, codeChunk}]
```

---

## Two Search Tools

### `codebase_search` — Semantic (embedding-based)

- Requires Qdrant + embedding provider configuration.
- Uses vector cosine similarity search.
- Tool implementation: `src/core/tools/CodebaseSearchTool.ts`.
- Tool schema: `src/core/prompts/tools/native-tools/codebase_search.ts`.
- Conditionally available only when `CodeIndexManager` is enabled + configured + initialized (see `filter-tools-for-mode.ts:271-277`).

### `codebase_search_with_lsp` — Symbol-based (LSP)

- Uses `vscode.executeWorkspaceSymbolProvider` with word-level text fallback.
- No external infrastructure required — works out of the box.
- Tool implementation: `src/core/tools/CodebaseSearchWithLspTool.ts`.
- Tool schema: `src/core/prompts/tools/native-tools/codebase_search_with_lsp.ts`.
- Always available to the agent.

---

## Integration Points

### Extension Host

| Point      | File                                    | Details                                                                    |
| ---------- | --------------------------------------- | -------------------------------------------------------------------------- |
| Activation | `src/extension.ts:182-203`              | Creates `CodeIndexManager` per workspace folder, initializes in background |
| Provider   | `src/core/webview/ClineProvider.ts:972` | Subscribes to `onProgressUpdate` to push indexing status to webview        |
| Commands   | `src/activate/registerCommands.ts:214`  | Registers commands that reference `CodeIndexManager`                       |

### Settings & Webview

| Point            | File                                             | Details                                                                     |
| ---------------- | ------------------------------------------------ | --------------------------------------------------------------------------- |
| Settings save    | `src/core/webview/webviewMessageHandler.ts:2549` | `saveCodeIndexSettingsAtomic` → saves secrets + `handleSettingsChange()`    |
| Status request   | `webviewMessageHandler.ts:2709`                  | `requestIndexingStatus`                                                     |
| Start/stop/clear | `webviewMessageHandler.ts:2773-2892`             | `startIndexing`, `stopIndexing`, `clearIndexData`, `toggleCodeIndexEnabled` |
| Secret status    | `webviewMessageHandler.ts:2744`                  | `requestCodeIndexSecretStatus`                                              |
| Status display   | `ClineProvider.ts:2859-2904`                     | `getCurrentWorkspaceCodeIndexManager()`, subscribes to progress updates     |

### Tool System

| Point             | File                                                            | Details                                                                      |
| ----------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Tool registration | `src/core/task/build-tools.ts:96-123`                           | Gets `CodeIndexManager` for current workspace, passes to tool filter         |
| Tool filtering    | `src/core/prompts/tools/filter-tools-for-mode.ts:271-277`       | Removes `codebase_search` if indexing is disabled/unconfigured/uninitialized |
| Tool dispatch     | `src/core/assistant-message/presentAssistantMessage.ts:780-788` | Routes to `CodebaseSearchTool` or `CodebaseSearchWithLspTool`                |
| Auto-approval     | `src/core/auto-approval/tools.ts:14`                            | `codebaseSearch` is auto-approved by default                                 |
| System prompt     | `src/core/prompts/system.ts:72`                                 | Includes indexing status in system prompt context                            |

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
codebaseIndexEmbedderModelId: string
codebaseIndexEmbedderModelDimension: number
codebaseIndexSearchMinScore: number // 0–1, default 0.4
codebaseIndexSearchMaxResults: number // 10–200, default 50
```

Secrets are stored via VS Code's `SecretStorage` (keyed as `codeIndexOpenAiKey`, `codeIndexQdrantApiKey`, etc.).

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
