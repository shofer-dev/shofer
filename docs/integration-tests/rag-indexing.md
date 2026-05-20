# RAG Code Indexing — Integration Test Scenarios

> Feature docs: [`docs/rag_indexing.md`](../docs/rag_indexing.md),
> [`docs/user-manual/rag-indexing.md`](../docs/user-manual/rag-indexing.md)
> Implementation: [`src/services/code-index/manager.ts`](../src/services/code-index/manager.ts),
> [`src/services/code-index/orchestrator.ts`](../src/services/code-index/orchestrator.ts),
> [`src/services/code-index/processors/scanner.ts`](../src/services/code-index/processors/scanner.ts),
> [`src/services/code-index/processors/file-watcher.ts`](../src/services/code-index/processors/file-watcher.ts),
> [`src/core/tools/RagSearchTool.ts`](../src/core/tools/RagSearchTool.ts)

## Prerequisites

- A running Qdrant instance (local or cloud) accessible from the test machine.
- At least one embedding provider configured and working (OpenAI key, local
  Ollama, or equivalent).
- A workspace with a mix of source files (~100+ files recommended) in languages
  that appear in `CODEBASE_INDEX_FILE_EXTENSIONS`.
- The test workspace should have a git repository for Phase 2 (git-aware
  narrowing) scenarios.

---

## Scenario 1: Enable and run a full index

**Goal:** Verify end-to-end indexing from Standby → Indexed.

1. Open Shofer in a workspace with source files.
2. Configure the embedding provider in Settings (API key + model).
3. Enable `codebaseIndexEnabled`.
4. Click "Start Indexing" in the CodeIndexPopover.
5. Observe the `IndexingStatusBadge` transitions: Standby → Indexing → Indexed.
6. Open the CodeIndexPopover: confirm file count > 0 and "indexed files" display
   is populated.
7. Run `rag_search` from the agent: "Find where authentication logic lives."
   Assert the tool returns results with `filePath`, `score`, `startLine`,
   `endLine`, `codeChunk`.

**Expected:** Indexing completes without errors. `rag_search` returns relevant
results with cosine similarity scores. The popover shows the correct indexed
file count.

---

## Scenario 2: Incremental reconciliation on restart (Phase 1 fast-path)

**Goal:** Verify that restarting VS Code reuses the cache and skips unchanged
files.

1. Complete a full index (Scenario 1).
2. Note the file count in the CodeIndexPopover.
3. Restart VS Code (or reload the window).
4. Observe the IndexingStatusBadge: it should go to Indexing briefly, then
   Indexed, **without** re-embedding all files.
5. Verify via output channel logs that `stat()` fast-path skipped most files
   ("mtimeMs + size match → skip").

**Expected:** Startup reconciliation completes in seconds (not minutes).
The file count matches the pre-restart count. The cache file
(`shofer-index-cache-<hash>.json`) is present in VS Code globalStorage.

---

## Scenario 3: Phase 2 git-aware narrowing

**Goal:** Verify that git diff narrows the scan to only changed files.

1. Complete a full index with a git repo (Scenario 1).
2. Make a small change to two files (add a comment line).
3. Stage and commit the changes (`git add . && git commit -m "test"`).
4. Restart VS Code.
5. Observe via output channel: "Phase 2: git-aware narrowing" log appears.
6. Confirm only the 2 changed files were re-indexed (not the entire workspace).

**Expected:** On a workspace where only 2 files changed, exactly 2 files are
re-parsed and re-embedded. The other files are skipped because git diff reports
them unchanged.

---

## Scenario 4: Phase 2 fallback to Phase 1 when git unavailable

**Goal:** Verify graceful degradation when git is not available.

1. Complete a full index in a workspace **without** a git repository (or with
   git unavailable).
2. Restart VS Code.
3. Observe: "Phase 2 skipped (no git repository)" log.
4. Confirm Phase 1 incremental scan runs instead (mtime+size fast-path).

**Expected:** No error. Phase 1 completes normally. The indexing badge shows
Indexed.

---

## Scenario 5: File watcher re-indexes on save

**Goal:** Verify that saving a file triggers incremental re-indexing.

1. With indexing complete, open an indexed file in the editor.
2. Add a new function and save the file.
3. Observe that the file watcher picks up the change (within the debounce
   window).
4. Run `rag_search` with a query targeting the newly added function name.
5. Confirm the new code block appears in search results.

**Expected:** The file watcher detects the save, parses the file, embeds new
blocks, and upserts them to Qdrant. Old blocks for the same file are not
re-embedded (per-segment dedup).

---

## Scenario 6: Per-segment deduplication

**Goal:** Verify that editing one line in a large file only re-embeds changed
blocks.

1. Index a workspace containing a file with 50+ tree-sitter blocks (e.g., a
   large TypeScript class with many methods).
2. Note the embedding API call count (via output channel or telemetry).
3. Edit one line in one method and save.
4. Observe the file watcher processes the file.
5. Verify via `CODE_INDEX_SEGMENT_DEDUP` telemetry event that:
    - `totalBlocks` = original block count
    - `reused` > 0 (unchanged blocks skipped)
    - `embedded` = 1 (only the changed block)
    - `deleted` = 1 (the old version of the changed block)

**Expected:** The embedding API is called for exactly 1 block (the changed one),
not for all 50+ blocks. Stale point IDs are deleted from Qdrant.

---

## Scenario 7: File deletion removes from Qdrant

**Goal:** Verify that deleting a file cleans up its vectors.

1. Index a workspace.
2. Delete a source file from disk.
3. Either restart VS Code or wait for the file watcher to detect the deletion.
4. Run `rag_search` with a query that would have matched the deleted file.
5. Confirm the deleted file no longer appears in results.

**Expected:** The scanner (full scan path) or file watcher (incremental path)
removes the deleted file's points from Qdrant and its entry from the cache.

---

## Scenario 8: Clear index and re-index

**Goal:** Verify the "Clear Index" flow works correctly.

1. Complete a full index.
2. Click "Clear Index" in the CodeIndexPopover.
3. Confirm the badge transitions to Standby.
4. Run `rag_search`: confirm it returns no results (or the tool is unavailable).
5. Click "Start Indexing" and wait for completion.
6. Confirm `rag_search` returns results again.

**Expected:** After clear, the Qdrant collection is emptied and the cache file
is cleared. After re-index, results are restored.

---

## Scenario 9: Toggle indexing off while running

**Goal:** Verify stopping mid-index works cleanly.

1. Start indexing on a large workspace.
2. While indexing is in progress, click "Stop Indexing" in the popover.
3. Confirm the badge transitions: Indexing → Stopping → Standby.
4. Confirm no errors in the output channel.
5. Start indexing again — confirm it resumes without errors.

**Expected:** The `AbortController` cancels in-flight embedding calls and file
traversal. No partial/corrupt state. The cache from the partial run is valid for
the next start.

---

## Scenario 10: Error recovery when Qdrant is unreachable

**Goal:** Verify graceful error handling.

1. With indexing complete, stop the Qdrant service.
2. Restart VS Code.
3. Observe: the badge shows **Error** with a message about Qdrant connectivity.
4. Check `TelemetryService` for `CODE_INDEX_ERROR` event with location context.
5. Start Qdrant again.
6. Click "Start Indexing" — confirm it recovers and transitions to Indexed.

**Expected:** Errors are surfaced visibly (badge state + popover message), not
silently swallowed. Recovery works after the external dependency is restored.

---

## Scenario 11: Search with directory prefix filter

**Goal:** Verify `rag_search` respects directory scoping.

1. Index a workspace with code in multiple top-level directories (e.g., `src/`,
   `lib/`, `tests/`).
2. Run `rag_search` from a subdirectory (agent's `cwd` is `src/`).
3. Confirm results are scoped to `src/` and its subdirectories.

**Expected:** The `directoryPrefix` parameter filters Qdrant results by
`filePath` prefix. Results from outside the directory are excluded.

---

## Scenario 12: Multi-workspace isolation

**Goal:** Verify workspaces don't interfere.

1. Open two VS Code windows with different workspace folders.
2. Index both workspaces.
3. Confirm each workspace's CodeIndexPopover shows its own file count.
4. Run `rag_search` in each window — confirm each returns results from its own
   workspace only.

**Expected:** Each workspace has a separate Qdrant collection. The
`CodeIndexManager` singleton-per-workspace pattern prevents cross-workspace
leakage.

---

## Scenario 13: `lsp_search` fallback when RAG is disabled

**Goal:** Verify `lsp_search` works independently of the RAG index.

1. Disable `codebaseIndexEnabled` or don't configure an embedding provider.
2. Run `lsp_search` from the agent: "find the function handleUserLogin".
3. Confirm LSP returns symbol results.
4. Run `rag_search` from the agent: confirm the tool is **not** available
   (filtered by `filter-tools-for-mode.ts`).

**Expected:** `lsp_search` works in all configurations. `rag_search` is only
available when indexing is enabled, configured, and initialized.

---

## Scenario 14: Embedding provider switching

**Goal:** Verify switching providers triggers a re-index.

1. Index with OpenAI embeddings.
2. Switch to Ollama embeddings in Settings.
3. Observe: the Settings save triggers `handleSettingsChange()` → detects
   provider change → prompts for re-index or auto-clears.
4. Start indexing with the new provider.
5. Confirm `rag_search` returns results using the new embedding model.

**Expected:** Provider switching is detected as a configuration change requiring
restart. The old vectors (wrong dimensions) are cleared before re-indexing.
