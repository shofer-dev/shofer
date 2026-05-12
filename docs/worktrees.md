# Git Worktree Support in Roo Code

## Overview

Roo Code supports git worktrees with an **embedded model**: each worktree lives at `<workspace>/.roo/worktrees/<name>/`, and worktree-scoped tasks run concurrently inside the same VS Code window. This enables orchestrated parallel work, in-window task switching, and merge-back without window juggling.

Manually-created worktrees outside the workspace (e.g. `git worktree add ../foo` opened with `code ../foo`) are still detected and listed by the Worktrees view; they simply behave as normal Roo Code workspaces in their own window.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Webview UI (React)                                               │
│  WorktreesView · Create/Delete Modals                              │
│  WorktreeStatusIndicator · NewWorktreeTaskButton                  │
│  TaskHeader · TaskSelector (worktree badge)                        │
├──────────────────────────────────────────────────────────────────┤
│  VSCode Bridge (handlers.ts)                                      │
│  handleListWorktrees · handleCreateWorktree                        │
│  handleDeleteWorktree · handleGetWorktreeDefaults                  │
│  handleGetWorktreeStatus                                           │
├──────────────────────────────────────────────────────────────────┤
│  Platform-Agnostic Core (@roo-code/core)                          │
│  WorktreeService · WorktreeIncludeService                          │
│  (no VSCode dependencies — pure git CLI wrappers)                  │
└──────────────────────────────────────────────────────────────────┘
```

### 1. Core Services (`packages/core/src/worktree/`)

[`WorktreeService`](../packages/core/src/worktree/worktree-service.ts) wraps all `git worktree` CLI operations:

| Method                             | Git Command                                      | Purpose                                                                                             |
| ---------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `listWorktrees(cwd)`               | `git worktree list --porcelain`                  | Parses machine-readable output into typed `Worktree[]`                                              |
| `createWorktree(cwd, opts)`        | `git worktree add [-b <branch>] <path> [<base>]` | Creates worktree with optional new branch from base                                                 |
| `deleteWorktree(cwd, path, force)` | `git worktree remove [--force] <path>`           | Removes worktree; best-effort branch deletion via `git branch -d`                                   |
| `getAvailableBranches(cwd)`        | `git branch` + `git branch -r` (parallel)        | Enumerates local and remote branches, filtering out branches already checked out in other worktrees |
| `checkoutBranch(cwd, branch)`      | `git checkout <branch>`                          | Switches branch in current worktree                                                                 |

[`WorktreeIncludeService`](../packages/core/src/worktree/worktree-include.ts) implements the `.worktreeinclude` mechanism:

- Computes the **intersection** of `.worktreeinclude` and `.gitignore` patterns
- Only copies files that match **both** pattern sets (ensures only untracked/ignored files like `node_modules` are copied)
- Progress is reported via `CopyProgressCallback` with byte-level granularity
- Cross-platform: uses `robocopy` on Windows, `cp` on Unix

### 2. VSCode Bridge (`src/core/webview/worktree/handlers.ts`)

Handlers translate webview IPC messages to core service calls:

- `handleListWorktrees` — Enforces constraints (no multi-root; subfolder workspaces allowed only when the subfolder lives under `<gitRoot>/.roo/worktrees/` — i.e., it is itself an embedded worktree)
- `handleCreateWorktree` — Creates worktree then auto-copies `.worktreeinclude` files with progress
- `handleDeleteWorktree` — Delegates to core service
- `handleGetWorktreeDefaults` — Generates suggested path (`<workspace>/.roo/worktrees/<project>-<random>`) and branch name (`worktree/roo-<random>`)

### 3. Per-Task `cwd`

Each `Task` instance has a `cwd` property (defaults to the workspace root). For embedded worktree tasks, `cwd` is set to the worktree subdirectory (e.g., `<workspace>/.roo/worktrees/repo-hl911/`).

- All tools operate relative to `task.cwd`
- `HistoryItem.cwd` is persisted in task metadata so worktree tasks rehydrate correctly
- `ClineProvider.createTask(…, cwd?)` accepts an optional `cwd` override
- `createManagedTask(name, text, images, worktreeDir?)` creates an in-window task scoped to a worktree directory
- Webview messages `newTask` and `createParallelTask` both accept a `worktreeDir` field

### 4. Checkpoint Isolation (`src/services/checkpoints/`)

Two parallel tasks running against the same workspace would interfere if their shadow gits both pointed `core.worktree` at the workspace root. The solution uses scoped shadow gits:

| Instance                   | `core.worktree`                      | Excludes                                    |
| -------------------------- | ------------------------------------ | ------------------------------------------- |
| Main task (workspace root) | `<workspace>/`                       | `/.roo/worktrees/` appended to exclude file |
| Worktree task              | `<workspace>/.roo/worktrees/<name>/` | (already scoped — no exclude needed)        |

`ShadowCheckpointService` accepts an optional `scopedWorktreeDir` constructor argument. When set, the shadow git's `core.worktree` is set to the worktree subdirectory. Non-scoped instances exclude `.roo/worktrees/` to prevent cross-contamination. `core.worktree` validation accepts the scoped path (not just `workspaceDir`).

### 5. Embedded Worktree Detection (`isEmbeddedWorktree`)

`handleListWorktrees` uses `path.relative(gitRootPath, cwd)` to determine whether a subfolder workspace is itself an embedded worktree:

```typescript
const rel = path.relative(gitRootPath, cwd)
const embeddedPrefix = path.join(".roo", "worktrees") + path.sep
isEmbeddedWorktree = !rel.startsWith("..") && !path.isAbsolute(rel) && rel.startsWith(embeddedPrefix)
```

This is a containment check anchored to the git root — not a substring match — so it cannot be confused by unrelated directories that happen to contain the string `.roo/worktrees`.

## Native `worktree` Tool

The orchestrator can manage the full worktree lifecycle programmatically via the `worktree` native tool (registered in the `mode` tool group). This removes the need for `execute_command` access in worktree orchestration flows.

### Parameters

| Parameter       | Type          | Required | Description                                                                                               |
| --------------- | ------------- | :------: | --------------------------------------------------------------------------------------------------------- |
| `subcommand`    | string        |    ✅    | `create`, `list`, `merge`, `destroy`, or `status`                                                         |
| `path`          | string\|null  |    ✅    | Worktree path (absolute or relative to workspace root). Required for create/destroy/status; null for list |
| `branch`        | string\|null  |    ✅    | Branch name (create). Defaults to `worktree/roo-<random5>`                                                |
| `base_branch`   | string\|null  |    ✅    | Base branch to create from (create). Defaults to main/master                                              |
| `target_branch` | string\|null  |    ✅    | Target branch for merge. Defaults to detected base branch. Merge refuses if HEAD ≠ target                 |
| `force`         | boolean\|null |    ✅    | Force destroy even if unmerged. Default false                                                             |

All optional params use nullable types (`["string","null"]`/`["boolean","null"]`) to comply with OpenAI `strict: true` schema mode — all properties appear in the `required` array.

### Subcommand Behaviours

| Subcommand | Behavior                                                                                                     | Returns                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `create`   | `git worktree add <path> <branch>`, copies `.worktreeinclude` files, ensures `.roo/worktrees/` is gitignored | `{ path, branch, message }`                             |
| `list`     | `git worktree list --porcelain`, annotated with embedded-worktree flag                                       | `[{ path, branch, isCurrent, isRooWorktree }]`          |
| `merge`    | Checks target branch, `git merge --no-ff <branch>`, reports conflicts                                        | `{ merged, conflicts?, conflictedFiles? }`              |
| `destroy`  | `git worktree remove <path>` + `git branch -d <branch>`. Refuses unmerged unless `force=true`                | `{ removed, branchDeleted, message }`                   |
| `status`   | ahead/behind counts, uncommitted changes, dry-run merge readiness                                            | `{ branch, ahead, behind, hasUncommitted, mergeReady }` |

### Safety Invariants

- `destroy` refuses if the branch is not fully merged into the current branch (unless `force=true`)
- `merge` refuses if there are uncommitted changes in the main worktree
- `merge` refuses if the main worktree HEAD is not on `target_branch`
- `create` refuses if the path already exists or the branch name is taken
- All git operations run with `PAGER=cat` to avoid interactive pagers
- Paths are resolved relative to `task.cwd`

### Orchestrated Workflow

```
Orchestrator task (mode=orchestrator, cwd=/repo/)
  │
  ├─ worktree create → .roo/worktrees/repo-hl911/ (branch: worktree/roo-hl911)
  │
  ├─ new_task(mode=code, worktreeDir=".roo/worktrees/repo-hl911", message="…")
  │   └─ subtask runs with cwd=<worktreeDir>; works on branch worktree/roo-hl911
  │
  ├─ wait_for_task(task_id)
  │
  ├─ worktree merge path=.roo/worktrees/repo-hl911
  │   └─ git merge --no-ff worktree/roo-hl911 into main/master
  │
  └─ worktree destroy path=.roo/worktrees/repo-hl911
      └─ git worktree remove + git branch -d → cleanup complete
```

The `new_task` tool also accepts a `worktreeDir` parameter (nullable string, `strict: true` compatible). Relative paths are resolved against the parent task's `cwd`.

## UI Components

| Component                                                                                  | Location            | Purpose                                                                                                                                     |
| ------------------------------------------------------------------------------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| [`WorktreesView`](../webview-ui/src/components/worktrees/WorktreesView.tsx)                | Settings page       | Full CRUD management with 3-second polling; `.worktreeinclude` status footer                                                                |
| [`CreateWorktreeModal`](../webview-ui/src/components/worktrees/CreateWorktreeModal.tsx)    | Modal               | Searchable base-branch selector; auto-generated branch/path (read-only); progress tracking; `openAfterCreate` flag spawns an in-window task |
| [`DeleteWorktreeModal`](../webview-ui/src/components/worktrees/DeleteWorktreeModal.tsx)    | Confirmation dialog | Branch and filesystem deletion warnings                                                                                                     |
| [`WorktreeStatusIndicator`](../webview-ui/src/components/chat/WorktreeStatusIndicator.tsx) | Chat input bar chip | Shows current worktree branch; click for ahead/behind, file stats, merge readiness                                                          |
| [`NewWorktreeTaskButton`](../webview-ui/src/components/chat/NewWorktreeTaskButton.tsx)     | Chat input bar      | One-click entry to open `CreateWorktreeModal` with `openAfterCreate=true`                                                                   |
| [`TaskHeader`](../webview-ui/src/components/chat/TaskHeader.tsx)                           | Chat header         | Shows worktree badge (leaf dir name) when task `cwd` differs from workspace                                                                 |
| [`TaskSelector`](../webview-ui/src/components/chat/TaskSelector.tsx)                       | Task switcher       | Badges worktree tasks with their branch/directory name                                                                                      |

## `.worktreeinclude` Mechanism

A custom extension to standard `git worktree`. The file `.worktreeinclude` in the workspace root lists files/directories (one per line, `.gitignore` syntax) to copy from the source worktree to newly created worktrees.

### How It Works

1. When a worktree is created, the system reads both `.worktreeinclude` and `.gitignore`
2. It computes the **intersection** of patterns from both files
3. Only files matching **both** pattern sets are copied using native OS commands (`cp -r` / `robocopy`)
4. Progress is streamed back to the UI via `worktreeCopyProgress` IPC messages

### Why Intersection?

The intersection ensures only **untracked/ignored** files are copied (e.g., `node_modules`, `.env`, build artifacts). This prevents accidental duplication of tracked source files, which would create merge conflicts.

### UI Integration

- The `WorktreesView` footer shows whether `.worktreeinclude` exists
- If `.gitignore` exists but `.worktreeinclude` doesn't, a "Create from .gitignore" button generates it
- The `CreateWorktreeModal` shows a warning when `.worktreeinclude` is absent
- During creation, a progress bar displays bytes copied and current item name

## Subfolder Workspace Restriction

Worktrees are disabled when the VS Code workspace root is a subdirectory of the git repository root, **unless** that subdirectory is itself an embedded worktree (i.e. lives under `<gitRoot>/.roo/worktrees/`).

### Submodule Interaction

| Workspace                                              | Git Root         | Worktrees? |
| ------------------------------------------------------ | ---------------- | ---------- |
| Parent repo root (`/repo/`)                            | `/repo/`         | ✅         |
| Submodule root (`/repo/ext/sub/`)                      | `/repo/ext/sub/` | ✅         |
| Subdirectory of parent repo (`/repo/ext/`)             | `/repo/`         | ❌         |
| Embedded worktree (`/repo/.roo/worktrees/repo-hl911/`) | `/repo/`         | ✅         |

### Caveats with Submodules

- **No auto-initialization**: `git worktree add` creates the directory structure but does not run `git submodule update --init`. Submodules in the new worktree appear as empty directories until manually initialized.
- **`.worktreeinclude` doesn't apply**: Submodule directories are tracked by git, so they won't match `.gitignore` patterns.
- **Checkpoint safety**: The shadow git checkpoint system uses `GIT_DIR` isolation (see [`submodule-support.md`](./submodule-support.md)) to prevent submodule discovery during checkpoint operations.

## IPC Message Types

### From Webview to Extension

| Message Type               | Payload                                                                           |
| -------------------------- | --------------------------------------------------------------------------------- |
| `listWorktrees`            | (none)                                                                            |
| `createWorktree`           | `worktreePath`, `worktreeBranch`, `worktreeBaseBranch`, `worktreeCreateNewBranch` |
| `deleteWorktree`           | `worktreePath`, `worktreeForce`                                                   |
| `getWorktreeDefaults`      | (none)                                                                            |
| `getWorktreeIncludeStatus` | (none)                                                                            |
| `getAvailableBranches`     | (none)                                                                            |
| `createWorktreeInclude`    | `worktreeIncludeContent`                                                          |
| `branchWorktreeInclude`    | `worktreeBranch`                                                                  |
| `checkoutBranch`           | `worktreeBranch`                                                                  |
| `browseForWorktreePath`    | (none)                                                                            |
| `newTask`                  | `text`, `images?`, `worktreeDir?`                                                 |
| `createParallelTask`       | `taskName?`, `text?`, `images?`, `worktreeDir?`                                   |
| `getWorktreeStatus`        | (none)                                                                            |

### From Extension to Webview

| Message Type            | Payload                                                                          |
| ----------------------- | -------------------------------------------------------------------------------- |
| `worktreeList`          | `worktrees[]`, `isGitRepo`, `isMultiRoot`, `isSubfolder`, `gitRootPath`, `error` |
| `worktreeResult`        | `success`, `text`                                                                |
| `worktreeCopyProgress`  | `copyProgressBytesCopied`, `copyProgressItemName`                                |
| `branchList`            | `localBranches[]`, `remoteBranches[]`, `currentBranch`                           |
| `worktreeDefaults`      | `suggestedBranch`, `suggestedPath`                                               |
| `worktreeIncludeStatus` | `exists`, `hasGitignore`, `gitignoreContent`                                     |
| `worktreeStatus`        | `worktreeStatus: WorktreeStatus`                                                 |

## Type Definitions

Core types are defined in [`packages/types/src/worktree.ts`](../packages/types/src/worktree.ts):

- `Worktree` — path, branch, commitHash, isCurrent, isBare, isDetached, isLocked, lockReason
- `WorktreeResult` — success, message, optional worktree reference
- `CreateWorktreeOptions` — path, branch?, baseBranch?, createNewBranch?
- `WorktreeIncludeStatus` — exists, hasGitignore, gitignoreContent?
- `WorktreeListResponse` — worktrees[], isGitRepo, isMultiRoot, isSubfolder, gitRootPath, error?
- `WorktreeStatus` — branch, path, baseBranch, commitsAhead, commitsBehind, filesChanged, insertions, deletions, hasUncommittedChanges, uncommittedCount, lastCommit, mergeReadiness, isBaseBranch, otherWorktrees

`HistoryItem` now includes a `cwd` field (persisted per task) and the `worktree` tool is listed in `toolNames` and `TOOL_GROUPS.mode`.

## Worktree Status Indicator

The [`WorktreeStatusIndicator`](../webview-ui/src/components/chat/WorktreeStatusIndicator.tsx) provides at-a-glance visibility of the current worktree's state directly in the chat input bar.

- **When hidden**: ≤1 worktree exists (only the primary/bare worktree)
- **When visible**: Shows the current branch name as a compact chip (e.g., `🌿 worktree/roo-hl911`)

On click, the indicator requests status via `getWorktreeStatus`. The backend handler runs 5+ git queries in parallel (last commit, ahead/behind, diff stats, uncommitted count, dry-run merge) and returns a `WorktreeStatus` object.

i18n translations: [`webview-ui/src/i18n/locales/en/worktreeStatus.json`](../webview-ui/src/i18n/locales/en/worktreeStatus.json)

## Known Limitations

1. **No multi-root workspace support** — Workspaces with multiple folders cannot use worktrees
2. **No submodule initialization** — Creating a worktree in a repo with submodules requires manual `git submodule update --init`
3. **`.worktreeinclude` intersection-only** — Cannot copy files that are not also in `.gitignore`
4. **No programmatic API for external consumers** — Worktree operations are accessible via webview IPC and the native `worktree` tool, but not through a public extension API
