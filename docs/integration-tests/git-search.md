# Git Commit History Search — Integration Test Scenarios

> Feature docs: [`docs/git_search-tool.md`](../docs/git_search-tool.md),
> [`docs/user-manual/git-search.md`](../docs/user-manual/git-search.md)
> Implementation: [`src/services/git-index/git-index-manager.ts`](../src/services/git-index/git-index-manager.ts),
> [`src/services/git-index/git-history-orchestrator.ts`](../src/services/git-index/git-history-orchestrator.ts),
> [`src/services/git-index/processors/git-log-extractor.ts`](../src/services/git-index/processors/git-log-extractor.ts),
> [`src/services/git-index/processors/git-watcher.ts`](../src/services/git-index/processors/git-watcher.ts),
> [`src/core/tools/GitSearchTool.ts`](../src/core/tools/GitSearchTool.ts)

## Prerequisites

- A running Qdrant instance and a configured embedding provider (shared with
  code index).
- A workspace that is a git repository with at least 50 commits, on a branch
  with a non-trivial history.
- The workspace should contain at least one git submodule for the submodule
  indexing scenarios.

---

## Scenario 1: Enable and run a full index

**Goal:** Verify end-to-end git indexing from Standby → Indexed.

1. Open Shofer in a workspace that is a git repository with existing commit
   history.
2. Ensure the code index is configured (Qdrant + embedder).
3. Enable `codebaseIndexGitEnabled` in Settings.
4. Click "Start Indexing" in the CodeIndexPopover → Git History section.
5. Observe the status transitions: Standby → Indexing → Indexed.
6. Open the CodeIndexPopover → Git History section: confirm commit count > 0
   and "Indexed all commits" display.
7. Run `git_search` from the agent: "Find commits related to configuration
   changes." Assert the tool returns results with `commit_hash`, `short_hash`,
   `author`, `author_date`, `subject`, `body`, `score`.

**Expected:** Indexing completes without errors. `git_search` returns relevant
results with cosine similarity scores. The popover shows the correct indexed
commit count.

---

## Scenario 2: Incremental catch-up on re-index

**Goal:** Verify that restarting a re-index skips already-indexed commits.

1. Complete a full index (Scenario 1).
2. Note the commit count.
3. Trigger "Start Indexing" again (or restart VS Code).
4. Observe that the index completes much faster (cached commits are skipped).
5. Verify the commit count is unchanged.

**Expected:** The cache manager skips all already-indexed commits. Indexing
finishes very quickly with no duplicate or changed count.

---

## Scenario 3: Incremental watcher picks up new commits

**Goal:** Verify the GitWatcher detects and indexes new commits.

1. Complete a full index (Scenario 1). Note the commit count.
2. Make 2–3 new commits in the workspace (e.g., touch files, commit with
   meaningful messages).
3. Wait for the configured poll interval (default 5 minutes) or reduce it for
   testing.
4. Observe the git index status remains "Indexed" and the commit count increases
   by the number of new commits.
5. Run `git_search` with a query matching the new commit messages — assert the
   new commits appear in results.

**Expected:** New commits are automatically picked up and searchable.

---

## Scenario 4: Branch switching

**Goal:** Verify that changing the indexed branch re-indexes correctly.

1. Complete a full index on branch `main` (Scenario 1).
2. Change `codebaseIndexGitBranch` to a different branch (e.g., `develop`).
3. Click "Start Indexing" again.
4. Observe the commit count changes to reflect the new branch's history.
5. Run `git_search` — assert results are from commits on the new branch.

**Expected:** The index reflects the configured branch. Commits from the
previous branch are not returned (the collection is rebuilt).

---

## Scenario 5: Non-git workspace

**Goal:** Verify graceful handling when the workspace is not a git repository.

1. Open Shofer in a workspace that is NOT a git repository.
2. Ensure the code index is configured and git indexing is enabled.
3. Observe the CodeIndexPopover → Git History section shows "Standby" or the
   git section is greyed out.
4. Run `git_search` from the agent — assert the tool returns an unavailable
   error message (not a crash).

**Expected:** `git_search` is unavailable but does not crash or produce
confusing errors. The popover shows a clear "Not a git repository" or
equivalent message.

---

## Scenario 6: Submodule indexing

**Goal:** Verify commits in git submodules are indexed alongside parent repo
commits.

1. Use a workspace that is a git repository containing at least one submodule
   with its own commit history.
2. Enable and run git indexing.
3. Verify the commit count includes commits from the submodule.
4. Run `git_search` with a query targeting a submodule-specific commit — assert
   results include that commit.

**Expected:** Submodule commits are indexed and searchable.

---

## Scenario 7: Settings gating

**Goal:** Verify `git_search` is excluded from the tool set when git indexing is
not configured.

1. Disable or unconfigure the embedding provider (remove Qdrant URL or API key).
2. Enable `codebaseIndexGitEnabled`.
3. Start a new task — assert `git_search` does NOT appear in the agent's
   available tools.
4. Re-configure the embedding provider.
5. Assert `git_search` appears in the tool list.

**Expected:** When git indexing prerequisites are not met, `git_search` is
excluded from the tool set passed to the LLM.

---

## Scenario 8: Clear and re-index

**Goal:** Verify the Clear button removes all git index data.

1. Complete a full index (Scenario 1).
2. Click "Clear" in the CodeIndexPopover → Git History section.
3. Confirm the commit count drops to 0 and status returns to "Standby".
4. Run `git_search` — assert it returns "No results" or "Index not ready."
5. Click "Start Indexing" — verify a fresh index is built.

**Expected:** Clearing deletes all git index data from Qdrant and the cache.
A fresh index can be built afterward.

---

## Scenario 9: Error recovery — Qdrant unreachable

**Goal:** Verify indexing fails gracefully when Qdrant is unreachable.

1. Complete a full index.
2. Stop the Qdrant instance.
3. Click "Start Indexing" — assert the status transitions to "Error."
4. Restart Qdrant.
5. Click "Start Indexing" — assert indexing resumes and completes.

**Expected:** Qdrant errors are surfaced in the status badge. The cache is
preserved. Recovery is possible without data loss.

---

## Scenario 10: Large commit messages (truncation)

**Goal:** Verify very large commit messages are truncated without breaking
indexing.

1. Create a test repository with a commit whose message exceeds 4,000
   characters.
2. Run git indexing.
3. Verify indexing completes without errors (the message is truncated).
4. Run `git_search` with a query matching the truncated message — assert the
   commit appears in results (the embedded content is the truncated version).

**Expected:** Oversized messages are truncated to 4,000 characters and indexed
successfully. No embedding errors occur.

---

## Scenario 11: `git` binary not found

**Goal:** Verify graceful handling when `git` is not installed.

1. Temporarily remove `git` from `PATH` or run in an environment without git.
2. Enable git indexing.
3. Attempt to start indexing — assert the status transitions to "Error" with a
   clear message.
4. Run `git_search` — assert it returns an appropriate error.

**Expected:** No crash. Clear error indication that git is unavailable.

---

## Scenario 12: Stop during indexing

**Goal:** Verify the Stop button interrupts an in-progress indexing run.

1. Start git indexing on a repository with many commits (5,000+).
2. While indexing is in progress, click "Stop."
3. Assert the status transitions to "Standby" (or "Stopping" → "Standby").
4. The partial index (whatever was embedded before stop) should remain usable
   for search.

**Expected:** Stopping is clean — no orphaned state, no stuck processes. Search
returns whatever was indexed before the stop.
