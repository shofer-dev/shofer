# RAG Code Indexing — Design & Implementation

## Purpose

Shofer's code indexing is a **semantic code search** system (RAG — Retrieval-Augmented Generation) that uses **vector embeddings** stored in a **Qdrant** collection to let the AI agent search codebases by meaning rather than just keywords. It lives under `src/services/code-index/` and is exposed to the AI as the `rag_search` native tool. A lighter companion tool `lsp_search` uses VS Code's built-in Language Server Protocol workspace symbol provider and requires no external infrastructure.

Indexing is **incremental** — startup reconciliation uses a cascade of increasingly selective layers to avoid re-embedding anything that hasn't changed. At the top, git-aware narrowing diffs from the last indexed commit so only changed files are even considered. For the files that remain, a `stat()`-only mtime+size fast-path skips unchanged files without reading them. Files that fail mtime/size fall through to a SHA-256 content-hash check. Files whose content hash changed are parsed, but even then per-segment deduplication checks each block's `segmentHash` against the cache and skips embedding for blocks that already exist in Qdrant with identical content — the embedding API is called only for genuinely new or modified code blocks. On a large repo with no changes, startup reconciliation completes with zero `readFile` calls. After a branch switch with a populated shared-worktree index, 99%+ of blocks survive the cascade and zero embedding calls are made.

See [Startup Reconciliation Cascade](#startup-reconciliation-cascade) for the full layer-by-layer breakdown.

---

## Architecture

```
CodeIndexManager (singleton per workspace)
 ├── CodeIndexConfigManager       — reads/writes settings & secrets
 ├── CodeIndexStateManager        — UI progress events
 │                                   (IndexingState: Standby|Indexing|Indexed|Error|Stopping)
 ├── CacheManager                 — per-file cache (v3: hash + mtimeMs + size + segmentHashes, stored in VS Code globalStorage, NOT on Qdrant PVC)
 ├── CodeIndexServiceFactory      — creates embedder, vector-store, scanner, parser, file-watcher
 ├── CodeIndexOrchestrator        — drives the indexing workflow (scan → watch)
 │    ├── DirectoryScanner        — walks files, parses, batches embeddings, upserts to Qdrant
 │    │    └── CodeParser         — tree-sitter based AST parsing → CodeBlock[]
 │    └── FileWatcher             — VS Code `FileSystemWatcher` (`vscode.workspace.createFileSystemWatcher`) for incremental re-indexing
 └── CodeIndexSearchService       — embeds query → cosine search against Qdrant
```

### Key Source Files

| File                                                     | Role                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/services/code-index/manager.ts`                     | Singleton per workspace. Orchestrates lifecycle: `initialize()` → `startIndexing()` → `searchIndex()`. Handles error recovery and settings changes.                                                                                                                                                           |
| `src/services/code-index/orchestrator.ts`                | Runs full or incremental scan, starts file watcher. Manages abort/cancel via `AbortSignal`. Wraps `vectorStore.initialize()` with exponential-backoff retry.                                                                                                                                                  |
| `src/services/code-index/service-factory.ts`             | Creates `IEmbedder`, `IVectorStore`, `DirectoryScanner`, `FileWatcher` based on config. Wraps `validateEmbedder()` with exponential-backoff retry.                                                                                                                                                            |
| `src/services/code-index/shared/retry.ts`                | `retryWithBackoff()` — reusable exponential-backoff helper used by orchestrator and service factory for service-level recovery.                                                                                                                                                                               |
| `src/services/code-index/git/git-source.ts`              | Thin wrapper around VS Code built-in Git extension API. Provides `diffSince()`, `discoverSubmodules()`, `diffSubmoduleSince()`.                                                                                                                                                                               |
| `src/services/code-index/processors/scanner.ts`          | Parallel file traversal with concurrency control (`p-limit`). Batches code blocks, applies per-segment dedup (skips embedding for blocks whose `segmentHash` already exists in the cache), creates embeddings only for new/changed blocks, upserts to Qdrant, deletes stale segments. Handles file deletions. |
| `src/services/code-index/processors/parser.ts`           | Uses **web-tree-sitter** for AST-aware parsing. Filters out `@name.definition.*` captures (bare identifiers) to avoid indexing noise; re-extracts the identifier from the full definition node. Falls back to line-based chunking for unsupported languages. Also handles Markdown via custom parser.         |
| `src/services/code-index/search-service.ts`              | Embeds query text → searches Qdrant with configurable min score & max results.                                                                                                                                                                                                                                |
| `src/services/code-index/config-manager.ts`              | Reads settings from `ContextProxy` (global state + secrets). Detects config changes requiring restart.                                                                                                                                                                                                        |
| `src/services/code-index/state-manager.ts`               | `vscode.EventEmitter`-based progress reporting to UI.                                                                                                                                                                                                                                                         |
| `src/services/code-index/cache-manager.ts`               | Persists per-file cache (v3: hash + mtimeMs + size + `segmentHashes[]`) to skip unchanged files during scans and to drive per-segment dedup in the file watcher.                                                                                                                                              |
| `src/services/code-index/vector-store/qdrant-client.ts`  | Implements `IVectorStore` using `@qdrant/js-client-rest`. One collection per workspace. Stores metadata with commit info.                                                                                                                                                                                     |
| `packages/types/src/codebase-index.ts`                   | Zod schemas for config, shared constants, and cache entries.                                                                                                                                                                                                                                                  |
| `src/services/tree-sitter/languageParser.ts`             | Maps file extensions to tree-sitter WASM parsers and language-specific AST queries. Fallthrough to `default:` throws for unsupported extensions.                                                                                                                                                              |
| `src/services/tree-sitter/queries/`                      | Per-language tree-sitter query files (e.g., `scala.ts`, `css.ts`, `python.ts`) that define AST capture patterns for definitions.                                                                                                                                                                              |
| `src/services/code-index/shared/supported-extensions.ts` | `fallbackExtensions` — extensions routed to line-based chunking instead of tree-sitter parsing.                                                                                                                                                                                                               |

### Language Coverage

Files are ingested only if their extension appears in [`CODEBASE_INDEX_FILE_EXTENSIONS`](extensions/shofer/packages/types/src/codebase-index.ts:25), defined in `@shofer/types`. The indexing pipeline then routes each file through either tree-sitter AST parsing or length-based fallback chunking. All 28 languages (31 extensions) are supported; 25 use tree-sitter WASM parsers, 3 use fallback chunking, and Markdown uses a custom heading/anchor parser.

| Extension(s)         | Parser            | Query file                                                                                        | Capture convention                                                | Mechanism                                              |
| -------------------- | ----------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------ |
| `.js` `.jsx` `.json` | JavaScript        | [`javascript.ts`](extensions/shofer/src/services/tree-sitter/queries/javascript.ts)               | `@name` / `@definition.xxx` (no `.definition` on name)            | Tree-sitter WASM                                       |
| `.ts`                | TypeScript        | [`typescript.ts`](extensions/shofer/src/services/tree-sitter/queries/typescript.ts)               | `@name.definition.xxx` / `@definition.xxx`                        | Tree-sitter WASM                                       |
| `.tsx`               | TSX               | [`tsx.ts`](extensions/shofer/src/services/tree-sitter/queries/tsx.ts)                             | `@name` / `@definition.xxx` (no `.definition` on name)            | Tree-sitter WASM                                       |
| `.py`                | Python            | [`python.ts`](extensions/shofer/src/services/tree-sitter/queries/python.ts)                       | `@name.definition.xxx` / `@definition.xxx`                        | Tree-sitter WASM                                       |
| `.rs`                | Rust              | [`rust.ts`](extensions/shofer/src/services/tree-sitter/queries/rust.ts)                           | `@name.definition.xxx` / `@definition.xxx`                        | Tree-sitter WASM                                       |
| `.go`                | Go                | [`go.ts`](extensions/shofer/src/services/tree-sitter/queries/go.ts)                               | `@definition.xxx` only (no name captures)                         | Tree-sitter WASM                                       |
| `.c` `.h`            | C                 | [`c.ts`](extensions/shofer/src/services/tree-sitter/queries/c.ts)                                 | `@name.definition.xxx` / `@definition.xxx`                        | Tree-sitter WASM                                       |
| `.cpp` `.hpp`        | C++               | [`cpp.ts`](extensions/shofer/src/services/tree-sitter/queries/cpp.ts)                             | `@name.definition.xxx` / `@definition.xxx`                        | Tree-sitter WASM                                       |
| `.cs`                | C#                | [`c-sharp.ts`](extensions/shofer/src/services/tree-sitter/queries/c-sharp.ts)                     | `@name` / `@definition.xxx` (no `.definition` on name)            | Tree-sitter WASM                                       |
| `.rb`                | Ruby              | [`ruby.ts`](extensions/shofer/src/services/tree-sitter/queries/ruby.ts)                           | `@name.definition.xxx` / `@definition.xxx`                        | Tree-sitter WASM                                       |
| `.java`              | Java              | [`java.ts`](extensions/shofer/src/services/tree-sitter/queries/java.ts)                           | `@name.definition.xxx` / `@definition.xxx`                        | Tree-sitter WASM                                       |
| `.php`               | PHP               | [`php.ts`](extensions/shofer/src/services/tree-sitter/queries/php.ts)                             | `@name.definition.xxx` / `@definition.xxx`                        | Tree-sitter WASM                                       |
| `.swift`             | Swift             | [`swift.ts`](extensions/shofer/src/services/tree-sitter/queries/swift.ts)                         | `@name` / `@definition.xxx` (no `.definition` on name)            | Fallback chunking (parser instability)                 |
| `.kt` `.kts`         | Kotlin            | [`kotlin.ts`](extensions/shofer/src/services/tree-sitter/queries/kotlin.ts)                       | `@name.definition.xxx` / `@definition.xxx`                        | Tree-sitter WASM                                       |
| `.css`               | CSS               | [`css.ts`](extensions/shofer/src/services/tree-sitter/queries/css.ts)                             | `@name.definition.xxx` / `@_xxx`                                  | Tree-sitter WASM                                       |
| `.html` `.htm`       | HTML              | [`html.ts`](extensions/shofer/src/services/tree-sitter/queries/html.ts)                           | `@name.definition` / `@definition.xxx`                            | Tree-sitter WASM (shared parser, `parserKey = "html"`) |
| `.ml` `.mli`         | OCaml             | [`ocaml.ts`](extensions/shofer/src/services/tree-sitter/queries/ocaml.ts)                         | `@name.definition` / `@definition.xxx`                            | Tree-sitter WASM                                       |
| `.scala`             | Scala             | [`scala.ts`](extensions/shofer/src/services/tree-sitter/queries/scala.ts)                         | `@name.definition` / `@definition.xxx`                            | Tree-sitter WASM                                       |
| `.sol`               | Solidity          | [`solidity.ts`](extensions/shofer/src/services/tree-sitter/queries/solidity.ts)                   | `@name.definition.xxx` / `@definition.xxx`                        | Tree-sitter WASM                                       |
| `.toml`              | TOML              | [`toml.ts`](extensions/shofer/src/services/tree-sitter/queries/toml.ts)                           | `@definition` only (no name captures)                             | Tree-sitter WASM                                       |
| `.vue`               | Vue               | [`vue.ts`](extensions/shofer/src/services/tree-sitter/queries/vue.ts)                             | `@xxx.name.definition` / `@xxx.definition` (reversed)             | Tree-sitter WASM                                       |
| `.lua`               | Lua               | [`lua.ts`](extensions/shofer/src/services/tree-sitter/queries/lua.ts)                             | `@name.definition.xxx` / `@definition.xxx`                        | Tree-sitter WASM                                       |
| `.rdl`               | SystemRDL         | [`systemrdl.ts`](extensions/shofer/src/services/tree-sitter/queries/systemrdl.ts)                 | `@name.definition.xxx` / `@definition.xxx`                        | Tree-sitter WASM                                       |
| `.tla`               | TLA⁺              | [`tlaplus.ts`](extensions/shofer/src/services/tree-sitter/queries/tlaplus.ts)                     | `@name.definition.xxx` / `@definition.xxx`                        | Tree-sitter WASM                                       |
| `.zig`               | Zig               | [`zig.ts`](extensions/shofer/src/services/tree-sitter/queries/zig.ts)                             | `@name` / `@xxx.definition` (no `.definition` on name)            | Tree-sitter WASM                                       |
| `.ejs` `.erb`        | Embedded Template | [`embedded_template.ts`](extensions/shofer/src/services/tree-sitter/queries/embedded_template.ts) | `@name.definition.xxx` / `@definition.xxx`                        | Tree-sitter WASM (`parserKey = "embedded_template"`)   |
| `.el`                | Emacs Lisp        | [`elisp.ts`](extensions/shofer/src/services/tree-sitter/queries/elisp.ts)                         | `@name.definition.xxx` / `@_xxx`                                  | Tree-sitter WASM                                       |
| `.ex` `.exs`         | Elixir            | [`elixir.ts`](extensions/shofer/src/services/tree-sitter/queries/elixir.ts)                       | Raw captures (`@function`, `@definition.xxx` — no `name.` prefix) | Tree-sitter WASM                                       |
| `.vb`                | Visual Basic .NET | —                                                                                                 | —                                                                 | Fallback chunking (no WASM parser)                     |
| `.elm`               | Elm               | —                                                                                                 | —                                                                 | Fallback chunking (no WASM parser)                     |
| `.md` `.markdown`    | —                 | —                                                                                                 | —                                                                 | Custom markdown parser (heading/anchor extraction)     |

#### Capture Filtering

Tree-sitter queries produce two captures per definition node — a bare `@name.definition.xxx` capture (the identifier substring, e.g. `"setupQuietMode"` at 14 chars) and a `@definition.xxx` capture (the full node). The parser in [`parser.ts`](extensions/shofer/src/services/code-index/processors/parser.ts:179) filters out any capture whose name starts with `"name."` before queueing nodes for embedding. The identifier string is re-extracted from the full definition node via `childForFieldName("name")` — no metadata is lost.

This filter is **language-agnostic** and works across all 28 languages because every query file uses one of these naming patterns:

| Pattern                                                    | Languages                                                                                                    | Filter behavior                                                 |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `@name.definition.xxx` / `@definition.xxx`                 | TypeScript, Python, Rust, C, C++, Java, PHP, Ruby, Kotlin, Lua, Solidity, SystemRDL, TLA⁺, Embedded Template | `name.definition.*` filtered; `definition.*` enters queue ✓     |
| `@name` / `@definition.xxx` (no `.definition` on name)     | JavaScript, C#, Swift, TSX, Zig                                                                              | `"name"` doesn't start with `"name."` → unaffected ✓            |
| `@name.definition` / `@definition.xxx` (no subtype)        | Scala, OCaml, HTML                                                                                           | `name.definition` filtered; `definition.xxx` enters queue ✓     |
| `@name.definition.xxx` / `@_xxx` (underscore-prefixed def) | CSS, Emacs Lisp                                                                                              | `name.definition.*` filtered; `_xxx` enters queue ✓             |
| `@xxx.name.definition` / `@xxx.definition` (reversed)      | Vue                                                                                                          | Starts with element name (e.g. `"element.name"`) → unaffected ✓ |
| `@definition.xxx` only (no name captures at all)           | Go, TOML                                                                                                     | Nothing to filter; all captures enter queue ✓                   |
| Raw captures (no `name.` prefix)                           | Elixir                                                                                                       | No `name.` prefix anywhere → unaffected ✓                       |

Without this filter, roughly 30–50% of indexed points would be bare identifiers carrying zero semantic value, inflating embedding costs and polluting search results.

Extensions in `fallbackExtensions` ([`supported-extensions.ts`](extensions/shofer/src/services/code-index/shared/supported-extensions.ts:21)) are detected before tree-sitter dispatch by [`shouldUseFallbackChunking()`](extensions/shofer/src/services/code-index/shared/supported-extensions.ts:32). They never reach [`loadRequiredLanguageParsers()`](extensions/shofer/src/services/tree-sitter/languageParser.ts:80), so the corresponding `case` in the parser switch is dead code — kept only for the `list_code_definition_names` tool, which does **not** check `fallbackExtensions` and therefore will crash on these extensions.

### Interfaces

All interfaces are defined under `src/services/code-index/interfaces/`:

- **`IEmbedder`** (`embedder.ts`) — `createEmbeddings(texts, model?)`, `validateConfiguration()`
- **`IVectorStore`** (`vector-store.ts`) — `initialize()`, `upsertPoints()`, `search()`, `deletePointsByFilePath()`, `deletePointsByMultipleFilePaths()`, `deletePointsByIds()` (targeted deletion of stale segment points during per-segment dedup), `hasIndexedData()`, `markIndexingComplete/Incomplete()`, `clearCollection()`, `deleteCollection()`, `collectionExists()`
- **`ICodeParser`** (`file-processor.ts`) — `parseFile(filePath, options?)` → `CodeBlock[]`
- **`IFileWatcher`** (`file-processor.ts`) — `initialize()`, `processFile()`, events: `onDidStartBatchProcessing`, `onBatchProgressUpdate`, `onDidFinishBatchProcessing`
- **`ICacheManager`** (`cache.ts`) — `deleteHash(filePath)`, `flush()`, `getEntry(filePath)` (returns `CodebaseIndexCacheEntry`), `updateEntry(filePath, entry)`, `getAllPaths()`, `getSegmentHashes(filePath)` (returns `Set<string>` of previously-indexed segment hashes for the file, used by the per-segment dedup path)
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
	segmentHash: string // SHA-256(path + identifier + content length + content preview); drives per-segment dedup and Qdrant point IDs (uuidv5)
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

### 1. Activation ([`extension.ts:130-149`](extensions/shofer/src/extension.ts:130))

During extension activation, for each workspace folder:

```
CodeIndexManager.getInstance(context, folder.uri.fsPath)
  → manager.initialize(contextProxy)   // non-blocking, runs in background
```

### 2. Initialization ([`manager.ts:169-280`](extensions/shofer/src/services/code-index/manager.ts:169))

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
| **File cache** (v3: hash + mtimeMs + size + segmentHashes per file)                | Local filesystem — VS Code globalStorage directory: `~/.config/Code/User/globalStorage/shofer.dev/shofer-index-cache-<workspace-hash>.json` | ✗ No — stored on laptop filesystem, outside PVC |
| **Metadata marker** (`indexing_complete`, `lastIndexedCommit`, `submoduleCommits`) | Qdrant collection — a special point with `type: "metadata"` and indexing status + git commit info                                           | ✓ Yes — persisted in Qdrant                     |

#### Cache Location & Format

The `CacheManager` persists a version 3 JSON cache to VS Code's extension global storage directory:

```
~/.config/Code/User/globalStorage/shofer.dev/shofer-index-cache-<sha256-of-workspace-path>.json
```

**v3 format** (Phase 1 stat() fast-path + per-segment dedup):

```json
{
	"version": 3,
	"entries": {
		"src/utils/helpers.ts": {
			"hash": "a1b2c3d4...",
			"mtimeMs": 1715952000000,
			"size": 4096,
			"segmentHashes": ["e3f1a2...", "9c7d4b..."]
		}
	}
}
```

Each entry stores the file's SHA-256 hash, last-modified time (ms), size (bytes), and the list of `segmentHash` values produced by the tree-sitter parser for the file's previously-indexed blocks. On startup reconciliation, the scanner calls `stat()` and compares `mtimeMs` and `size` against the cache. If both match, the file is skipped without reading or hashing it. If only the hash matches (mtime changed but content identical — rare cases like `touch`, rebase, rsync -t), the cache entry is updated with the new mtimeMs/size and the file is still skipped. The `segmentHashes` list drives the **per-segment deduplication** path in the file watcher (see below). Per the **Versioned Snapshot Rule**, a `version` mismatch discards the entire cache and starts fresh — v2 cache files are dropped on load.

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

#### Per-Segment Deduplication (File Watcher)

The full-file SHA-256 is the right signal for **skipping** an unchanged file, but it is far too coarse for **re-indexing** a changed file: if a 2,000-line file gains a single line, the old pipeline re-embedded every block in the file and re-upserted every point, and the historical points for any removed lines were never cleaned up at all.

Per-segment dedup uses the parser's per-block `segmentHash` (`SHA-256(filePath + start_line + end_line + content.length + contentPreview[0:100])`, computed in `parser.ts`) as a stable identity for each indexed segment. The cache's `segmentHashes[]` records which segments the file watcher last persisted to Qdrant for a given file.

When [`FileWatcher.processFile()`](extensions/shofer/src/services/code-index/processors/file-watcher.ts) handles a changed file:

1. Read the previous segment-hash set from the cache: `prev = cacheManager.getSegmentHashes(filePath)`.
2. Parse the file and compute `newSegmentHashes = blocks.map(b => b.segmentHash)`.
3. Diff:
    - **Reused**: `b.segmentHash ∈ prev` → skip embedding, the point is already in Qdrant.
    - **New / changed**: `b.segmentHash ∉ prev` → embed and upsert.
    - **Stale**: `h ∈ prev ∧ h ∉ new` → delete the corresponding point from Qdrant. Point IDs are derived from segment hashes via `uuidv5(segmentHash, QDRANT_CODE_BLOCK_NAMESPACE)`, so no extra lookup is needed.
4. After [`processBatch`](extensions/shofer/src/services/code-index/processors/file-watcher.ts) completes Phase 2 (per-file processing), it:
    - Issues a single `vectorStore.deletePointsByIds(allStaleSegmentIds)` for the whole batch (Phase 3a). `deletePointsByIds` throws on failure so the error is surfaced via `overallBatchError` and the `CODE_INDEX_ERROR` telemetry event with `location: "deletePointsByIds"`.
    - If every file in the batch turned out to be all-reused (no points to upsert), an early-return path in `_executeBatchUpsertOperations` still updates the cache (so the new full-file hash + segment hashes are persisted) without contacting the embedder or issuing an upsert.
    - Fires a single aggregated `CODE_INDEX_SEGMENT_DEDUP` telemetry event with `{ fileCount, totalBlocks, reused, embedded, deleted }` per batch (not per file, to keep cardinality bounded and avoid leaking file paths).
5. If the parser produces 0 blocks (file shrunk below `MIN_BLOCK_CHARS`, became empty, etc.) the file is still processed: the cache entry is refreshed and any previously-indexed segments are queued for deletion via the same `staleSegmentIds` path — no special "skip on empty" short-circuit.

The scanner ([`scanner.ts`](extensions/shofer/src/services/code-index/processors/scanner.ts)) writes `segmentHashes` at all three cache-update sites: the unchanged-file skip path preserves the existing list, the no-blocks path writes `[]`, and the successful batch-upsert path groups `batchBlocks` by `file_path` into a `Map<string, string[]>` so each file's full segment-hash list is recorded with one cache entry.

**Trade-off**: edits to a small "hot" file no longer cascade into N redundant embedding calls and upserts, and removed code is actively cleaned out of Qdrant on the next save rather than lingering until a full re-index. The cache file is slightly larger (one extra string array per entry), but still well within an order of magnitude of the v2 layout for typical workspaces.

The same per-segment dedup logic applies in the scanner's [`processBatch()`](extensions/shofer/src/services/code-index/processors/scanner.ts:447) during startup reconciliation: before creating embeddings, the scanner checks each block's `segmentHash` against the cache's `segmentHashes[]` for that file. Reused blocks skip both the embedding API call and the Qdrant upsert. If every block in a batch is reused, the embedder is bypassed entirely — cache entries are updated in-place. Stale segments (cached hashes no longer in the current parse) are deleted from Qdrant by their deterministic point ID.

#### Worktree-Shared Collections

Git worktrees are separate directories and would normally get separate Qdrant collections and cache files. To avoid re-indexing when switching between worktrees of the same repository, the system resolves a stable **index key path** equal to the main repository root.

[`GitSource.resolveWorktreeMainRepoPath()`](extensions/shofer/src/services/code-index/git/git-source.ts:95) reads the `.git` file in a worktree directory, parses the `gitdir:` line (`gitdir: /path/to/main/.git/worktrees/name`), and derives the main repository root. This resolved path is passed as `indexKeyPath` to [`CacheManager`](extensions/shofer/src/services/code-index/cache-manager.ts:41) (for cache file naming) and [`QdrantVectorStore`](extensions/shofer/src/services/code-index/vector-store/qdrant-client.ts:63) (for collection naming). For regular repos, `indexKeyPath` defaults to the workspace path.

All worktrees of the same repository share:

- One Qdrant collection (`ws-<sha256(main-repo-path)[:16]>`)
- One local cache file (`shofer-index-cache-<sha256(main-repo-path)>.json`)

#### Reboot Behavior

After a system reboot, **no restart of indexing is needed** because:

- ✓ Qdrant PVC retains all vectors
- ✓ Metadata marker (`indexing_complete`) stored in Qdrant, survives reboot
- ✓ If hash cache is intact → incremental scan skips unchanged files, and the file watcher uses `segmentHashes` to embed only changed blocks on the next edit
- ✓ If hash cache was lost/deleted but Qdrant has data → the scanner reads and parses changed files but per-segment dedup skips embedding for blocks whose `segmentHash` is already in the cache

The hash cache is the only component that may not survive a reboot depending on system configuration. The Qdrant PVC is the durable store of record.

#### Startup Reconciliation Cascade

The startup reconciliation pipeline is organised as five layers, each more selective than the last. A layer falls through to the next when its inputs are missing or its assumptions fail. The cascade is designed so that the most expensive operation — calling the embedding API — only happens for genuinely new or modified code blocks.

| Layer                       | Operates on                                 | Mechanism                                                                                                                                                                                                                                                                                                  | Cost per file                                                                                 | Fallback trigger                                                                                         |
| --------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **1. Git-aware narrowing**  | Git diff → candidate files                  | `git diff <lastIndexedCommit> HEAD` ∪ dirty changes ∪ submodule diffs. Most files are eliminated here.                                                                                                                                                                                                     | 1 git command                                                                                 | git extension unavailable, `lastIndexedCommit` missing, `diffSince` throws ("bad object"), new submodule |
| **2. mtime+size fast-path** | Candidate files from layer 1 (or all files) | `stat()` only — skip when `cached.mtimeMs === stats.mtimeMs && cached.size === stats.size`. Zero I/O beyond the stat syscall.                                                                                                                                                                              | 1 `stat()` syscall                                                                            | cache file missing or version mismatch                                                                   |
| **3. Content-hash check**   | Files that failed layer 2                   | `readFile()` + SHA-256 — skip when hash matches cache (mtime changed but content didn't — `touch`, rebase, rsync -t).                                                                                                                                                                                      | 1 `readFile()` + 1 SHA-256                                                                    | none (always available)                                                                                  |
| **4. Tree-sitter parse**    | Files that failed layer 3                   | AST parsing → `CodeBlock[]`, each with a deterministic `segmentHash`.                                                                                                                                                                                                                                      | CPU: tree-sitter parse                                                                        | none (always available)                                                                                  |
| **5. Per-segment dedup**    | CodeBlock[] from layer 4                    | Compare each block's `segmentHash` against the cache's `segmentHashes[]` for that file. Matching blocks skip the embedding API call entirely — the point already exists in Qdrant (deterministic `uuidv5` from `segmentHash`). Stale segments (in cache but not in current parse) are deleted from Qdrant. | Only for blocks with new/changed content: embed + upsert. Everything else: cache update only. | none (always available)                                                                                  |

**Runtime layer** (file watcher, not startup): When a file is saved, the file watcher applies layers 3–5 per-file: SHA-256 → if changed, parse → per-segment dedup against cache → embed only new/changed blocks.

**Example: branch switch with shared worktree index (50k-file repo, 10 files changed)**

```
Layer 1: git diff → 10 files changed, 2 deleted  ← 49,990 files eliminated
Layer 2: 10 files → 10 fail mtime (checkout resets mtimes)  ← 0 saved
Layer 3: 10 files → 10 fail hash (different branch content)  ← 0 saved
Layer 4: 10 files parsed → ~500 CodeBlocks
Layer 5: ~485 blocks match segmentHash in cache (reused from previous index)
         ~15 blocks are genuinely new/changed → embedded
         ~2 stale blocks deleted from Qdrant
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Total: 10 readFile + 10 SHA-256 + 10 parse + 15 embedding API calls
```

Without layers 1 and 5 this would be 50,000 readFile + 50,000 SHA-256 + 50,000 embedding API calls.

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

| Point      | File                                           | Details                                                                                                                                             |
| ---------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Activation | `src/extension.ts:130-149`                     | Creates `CodeIndexManager` per workspace folder, initializes in background                                                                          |
| Provider   | `src/core/webview/ShoferProvider.ts:3210-3259` | `getCurrentWorkspaceCodeIndexManager()` + `updateCodeIndexStatusSubscription()` subscribes to `onProgressUpdate` to push indexing status to webview |
| Commands   | `src/activate/registerCommands.ts`             | Registers commands that reference `CodeIndexManager` (imported at line 13)                                                                          |

### Settings & Webview

| Point            | File                          | Details                                                                                                             |
| ---------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Settings save    | `webviewMessageHandler.ts`    | `saveCodeIndexSettingsAtomic` → saves secrets + `handleSettingsChange()`                                            |
| Status request   | `webviewMessageHandler.ts`    | `requestIndexingStatus`                                                                                             |
| Start/stop/clear | `webviewMessageHandler.ts`    | `startIndexing`, `stopIndexing`, `clearIndexData`                                                                   |
| Secret status    | `webviewMessageHandler.ts`    | `requestCodeIndexSecretStatus`                                                                                      |
| Status display   | `ShoferProvider.ts:3210-3259` | `getCurrentWorkspaceCodeIndexManager()`, subscribes to `onProgressUpdate` via `updateCodeIndexStatusSubscription()` |

### Tool System

| Point             | File                                                                     | Details                                                                 |
| ----------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Tool registration | `src/core/task/build-tools.ts:258-259`                                   | Gets `CodeIndexManager` for current workspace, passes to tool filter    |
| Tool filtering    | `src/core/prompts/tools/filter-tools-for-mode.ts:271-277`                | Removes `rag_search` if indexing is disabled/unconfigured/uninitialized |
| Tool dispatch     | `src/core/assistant-message/presentAssistantMessage.ts:850-853, 871-874` | Routes to `RagSearchTool` or `LspSearchTool`                            |
| Auto-approval     | `src/core/auto-approval/tools.ts:20`                                     | `ragSearch` is auto-approved by default                                 |
| System prompt     | `src/core/prompts/system.ts:72`                                          | Includes indexing status in system prompt context                       |

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

| Constant                          | Value  | Purpose                                                                      |
| --------------------------------- | ------ | ---------------------------------------------------------------------------- |
| `MAX_BLOCK_CHARS`                 | 1000   | Max characters per code block                                                |
| `MIN_BLOCK_CHARS`                 | 30     | Min characters per code block                                                |
| `MIN_CHUNK_REMAINDER_CHARS`       | 200    | Min size for the remainder when splitting a chunk                            |
| `MAX_CHARS_TOLERANCE_FACTOR`      | 1.15   | 15% tolerance on max block size                                              |
| `MAX_FILE_SIZE_BYTES`             | 1 MB   | Skip files larger than this                                                  |
| `BATCH_SEGMENT_THRESHOLD`         | 60     | Code segments per embedding API call                                         |
| `MAX_LIST_FILES_LIMIT_CODE_INDEX` | 50,000 | Max files to scan                                                            |
| `PARSING_CONCURRENCY`             | 10     | Parallel file parsing limit                                                  |
| `BATCH_PROCESSING_CONCURRENCY`    | 10     | Parallel embedding batch processing                                          |
| `MAX_PENDING_BATCHES`             | 20     | Backpressure limit on pending embedding batches                              |
| `MAX_BATCH_RETRIES`               | 3      | Retry count for failed embedding batches                                     |
| `INITIAL_RETRY_DELAY_MS`          | 500    | Initial delay before first batch retry (ms)                                  |
| `MAX_SERVICE_ATTEMPTS`            | 5      | Total attempts for service-level (Qdrant/Ollama) ops (4 retries + 1 initial) |
| `SERVICE_INITIAL_RETRY_DELAY_MS`  | 2000   | Initial delay for service-level retry (ms)                                   |
| `SERVICE_MAX_BACKOFF_MS`          | 60,000 | Max delay cap for service-level retry (ms)                                   |
| `DEFAULT_SEARCH_MIN_SCORE`        | 0.4    | Cosine similarity threshold for search results                               |
| `DEFAULT_MAX_SEARCH_RESULTS`      | 50     | Default max number of search results                                         |

---

## Multi-Workspace Support

`CodeIndexManager` uses a **singleton-per-workspace** pattern via `Map<string, CodeIndexManager>` keyed by `workspacePath`. Per-workspace enablement is stored in `workspaceState` under key `codeIndexWorkspaceEnabled:<folder-uri>`. Each workspace gets its own Qdrant collection name derived from a hash of the workspace path.

---

## Error Handling & Recovery

### Service-Level Retry (Ollama / Qdrant connectivity)

Two entry points wrap their operations with **exponential backoff retry** so that a brief outage of either Ollama or Qdrant does not permanently block indexing:

| Location                                  | Wrapped operation                  | Attempts | Initial delay | Max delay |
| ----------------------------------------- | ---------------------------------- | -------- | ------------- | --------- |
| `orchestrator.ts` (`startIndexing`)       | `vectorStore.initialize()`         | 5        | 2 s           | 60 s      |
| `service-factory.ts` (`validateEmbedder`) | `embedder.validateConfiguration()` | 5        | 2 s           | 60 s      |

`MAX_SERVICE_ATTEMPTS = 5` counts _total_ invocations — the helper sleeps 4 times between them: 2 s → 4 s → 8 s → 16 s (capped at 60 s), so worst-case sleep time before giving up is ≈ 30 s plus the cost of the 5 failed calls themselves. If the signal is aborted mid-backoff the retry loop exits immediately with an `AbortError`.

The orchestrator also updates the UI status on each retry attempt: `"Qdrant connection failed (attempt N/5), retrying in Xs..."` so the user can see that indexing is not stuck — it is waiting for the infrastructure to come back. `validateEmbedder` emits the analogous `"Embedder connection failed (attempt N/5), …"` message via a `notifyRetryStatus` callback injected by `CodeIndexManager`. Per-attempt telemetry is intentionally **not** emitted — only a single `CODE_INDEX_ERROR` event at the end of a fully-exhausted retry loop, carrying `retryAttempts: N`, so transient blips do not amplify telemetry volume 5×.

### Batch-Level Retry

Failed embedding batches inside the scanner retry up to 3 times with a 500 ms initial delay (`MAX_BATCH_RETRIES`, `INITIAL_RETRY_DELAY_MS` in `constants/index.ts`). This is unchanged.

### Other Recovery

- **`recoverFromError()`** clears all service instances, forcing a clean re-initialization on next use. Protected against race conditions with `_isRecoveringFromError` flag.
- **Cache preservation**: If Qdrant connection fails before any data is written, the cache is preserved for future incremental scans. If indexing fails mid-way (after connecting), the cache is cleared to avoid inconsistency.
- **Telemetry**: All errors are captured via `TelemetryService.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {...})` with location context and `attemptNumber` when they occur inside a retry loop. The file watcher additionally fires `TelemetryEventName.CODE_INDEX_SEGMENT_DEDUP` once per batch (`captureCodeIndexSegmentDedup({ fileCount, totalBlocks, reused, embedded, deleted })`) so the effectiveness of per-segment dedup can be tracked in production without per-file cardinality or path leakage.

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

---

## Gaps, Issues & Areas for Improvement

Discovered during the 2026-05-20 review that verified every file path, line number, entity name, constant value, and code example against the live source.

### Documentation Accuracy

- **`serialized-embedder.ts` not documented** — the embedders directory contains a 9th file (`serialized-embedder.ts`) that wraps an `IEmbedder` in a concurrency lane (`embedder-lane.ts`). Neither file is mentioned in the embedder provider table (§8) or architecture diagram.

- **`embeddingModels.ts` path is imprecise** — the doc says "resolved via `shared/embeddingModels.ts`" (§8). The file lives at [`src/shared/embeddingModels.ts`](extensions/shofer/src/shared/embeddingModels.ts), not under `src/services/code-index/shared/`. The doc should use an absolute or workspace-relative link.

### Interfaces

- **`interfaces/index.ts` barrel export is incomplete** — the barrel re-exports `embedder`, `vector-store`, `file-processor`, and `manager`, but omits `cache` and `config`. `ICacheManager` and `CodeIndexConfig` are therefore not available through a single `interfaces/` import, which the interface table implies.

- **`ICodeIndexManager` interface methods not listed** — the doc says "public API contract" but doesn't enumerate the actual methods: `dispose()`, `stopWatcher()`, `loadConfiguration()`, `getCurrentStatus()`, `clearIndexData()`, etc. The `ICacheManager` entry lists methods explicitly; the `ICodeIndexManager` entry should too for consistency.

### Constants

- **The constants table (§Key Constants) presents a flattened list** — in the source, constants are grouped by consumer: `/**Parser */`, `/**Search */`, `/**File Watcher */`, `/**Directory Scanner */`, `/**OpenAI Embedder */`, `/**Gemini Embedder */`. The doc table loses this grouping, making it unclear which subsystem owns each constant.

### Multi-Workspace Support

- **Collection naming is not explained** — the doc says each workspace gets its own Qdrant collection "derived from a hash of the workspace path" but doesn't show the hash function or the collection name pattern. This is relevant for anyone debugging Qdrant directly.

### Architecture Diagram

- **The architecture diagram (§Architecture) is prose-only** — the text-based tree is good for hierarchy but doesn't show data flow arcs (embedding API calls, Qdrant gRPC/HTTP, file-system reads). A Mermaid or ASCII-art dataflow diagram would help readers understand the embedding round-trips.

### Search Ranking Quality

- **Semantic ranking is too lexical in practice** — Despite the tool description promising meaning-based search, the top results for queries like "home screen recent tasks" are dominated by i18n JSON entries (e.g., `"Show worktrees in home screen"`, score 0.65–0.71) that match on word-level substring overlap ("tasks", "home", "screen"). The actual architectural component ([`HistoryPreview.tsx`](extensions/shofer/webview-ui/src/components/history/HistoryPreview.tsx)) does not appear in the top 15. The embeddings (and the [default `cosine` similarity](extensions/shofer/src/services/code-index/vector-store/qdrant-client.ts)) appear to heavily weight lexical token overlap rather than structural/semantic relationships, making the tool unreliable for codebase exploration. In practice, `grep_search` with literal strings like `"Recent Tasks"` or component names like `HistoryPreview` finds the right files instantly. Possible avenues to investigate:

    - **Embedding model quality** — The embedder model (selected via [`codebaseIndexEmbedderProvider`](extensions/shofer/packages/types/src/codebase-index.ts)) may produce embeddings that are too lexically aligned. Testing with a higher-quality model (or a code-specific model) could help.
    - **Chunking strategy** — Tree-sitter AST blocks may capture too much or too little context for meaningful semantic comparison. The current [`MAX_BLOCK_CHARS`](extensions/shofer/src/services/code-index/constants/index.ts) of 1000 and `MIN_BLOCK_CHARS` of 30 produce blocks of varying granularity; i18n JSON files chunk differently than React components, potentially giving short, keyword-dense strings an unfair ranking advantage.
    - **Search query preprocessing** — The raw user/agent query is embedded as-is. Adding query expansion, synonym injection, or file-type boosting could improve results.
    - **Distance metric** — Qdrant's default `cosine` similarity may not be optimal for code search. `dot` product or a learned metric could be worth evaluating.

- **No feedback loop or relevance tuning** — There is no mechanism for the agent or user to signal that a search result was irrelevant or that a missed file should have ranked higher. A relevance-feedback loop (explicit or implicit from tool-call patterns) could progressively improve ranking.

### Concurrency

- **`embedder-lane.ts` not mentioned** — the Per-Provider Concurrency Lane Rule (from `AGENTS.md`) is implemented in [`embedder-lane.ts`](extensions/shofer/src/services/code-index/embedders/embedder-lane.ts), which wraps every `IEmbedder` in a `PQueue`-based lane keyed by `(provider, endpoint)`. The doc describes the embedding flow but never mentions this wrapper or the concurrency guarantees it provides.

- **`serialized-embedder.ts` is the lane-wrapped embedder** — it calls `embedder-lane.ts`'s `getOrCreateLane()` and queues every `createEmbeddings()` call through `lane.add(() => inner.createEmbeddings(...))`. The doc should mention both files together.

### Auth

- **Qdrant API key support not detailed** — the config schema lists `qdrantApiKey?: string` but the doc never explains when authenticated Qdrant is needed or how the key is used.
