# Git Worktree Support in Shofer

## Overview

Shofer supports git worktrees with an **embedded model**: each worktree lives at `<workspace>/.shofer/worktrees/<name>/`, and worktree-scoped tasks run concurrently inside the same VS Code window. This enables orchestrated parallel work, in-window task switching, and merge-back without window juggling.

Manually-created worktrees outside the workspace (e.g. `git worktree add ../foo` opened with `code ../foo`) are still detected and listed by the Worktrees view; they simply behave as normal Shofer workspaces in their own window.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Webview UI (React)                                               │
│  WorktreesView · Create/Delete Modals                              │
│  WorktreeIndicator                                                 │
│  TaskHeader · TaskSelector (worktree badge)                        │
├──────────────────────────────────────────────────────────────────┤
│  VSCode Bridge (handlers.ts)                                      │
│  handleListWorktrees · handleCreateWorktree                        │
│  handleDeleteWorktree · handleGetWorktreeDefaults                  │
│  handleGetWorktreeStatus                                           │
├──────────────────────────────────────────────────────────────────┤
│  Platform-Agnostic Core (@shofer/core)                          │
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

[`WorktreeIncludeService`](../packages/core/src/worktree/worktree-include.ts) implements the `.shofer/worktreeinclude` mechanism:

- Computes the **intersection** of `.shofer/worktreeinclude` and `.gitignore` patterns
- Only copies files that match **both** pattern sets (ensures only untracked/ignored files like `node_modules` are copied)
- Progress is reported via `CopyProgressCallback` with byte-level granularity
- Cross-platform: uses `robocopy` on Windows, `cp` on Unix

### 2. VSCode Bridge (`src/core/webview/worktree/handlers.ts`)

Handlers translate webview IPC messages to core service calls:

- `handleListWorktrees` — Enforces constraints (no multi-root; subfolder workspaces allowed only when the subfolder lives under `<gitRoot>/.shofer/worktrees/` — i.e., it is itself an embedded worktree)
- `handleCreateWorktree` — Creates worktree then auto-copies `.shofer/worktreeinclude` files with progress
- `handleDeleteWorktree` — Delegates to core service
- `handleGetWorktreeDefaults` — Generates suggested path (`<workspace>/.shofer/worktrees/<project>-<random>`) and branch name (`worktree/shofer-<random>`)

### 3. Per-Task `cwd`

Each `Task` instance has a `cwd` property (defaults to the workspace root). For embedded worktree tasks, `cwd` is set to the worktree subdirectory (e.g., `<workspace>/.shofer/worktrees/repo-hl911/`).

- All tools operate relative to `task.cwd`
- `HistoryItem.cwd` is persisted in task metadata so worktree tasks rehydrate correctly
- `ShoferProvider.createTask(…, cwd?)` accepts an optional `cwd` override
- `createManagedTask(name, text, images, worktreeDir?)` creates an in-window task scoped to a worktree directory
- Webview messages `newTask` and `createParallelTask` both accept a `worktreeDir` field

### 3a. Path Isolation (Mutating Tool Guard)

When a task runs inside an embedded worktree (`task.cwd` points into `.shofer/worktrees/<name>/`), **all mutating native tools enforce path containment**. Any target path that resolves outside the task's assigned worktree directory is blocked with an error message.

**Guarded tools:**

| Tool                   | What is validated                                                      |
| ---------------------- | ---------------------------------------------------------------------- |
| `write_to_file`        | `path`                                                                 |
| `apply_diff`           | `path`                                                                 |
| `create_directory`     | `path`                                                                 |
| `file` (rm)            | `path`                                                                 |
| `file` (mv)            | `path` + `destination`                                                 |
| `insert_edit`          | `filePath`                                                             |
| `sed`                  | `path`                                                                 |
| `rename_symbol`        | `filePath` (the symbol location)                                       |
| `create_new_workspace` | `projectRoot` (path + name)                                            |
| `execute_command`      | sandboxed on Linux (Landlock/bwrap), advisory warning on macOS/Windows |

**Implementation:** [`validateWorktreePath()`](../src/utils/worktreePathGuard.ts) resolves the target against `task.cwd` and verifies it stays within the worktree directory. It detects `..` traversal, absolute paths pointing outside, and any symlinks that resolve elsewhere. For non-worktree tasks, the guard is a no-op.

**`execute_command` sandboxing:** On Linux, shell commands in worktree-scoped tasks are automatically sandboxed using the `shofer-sandbox` wrapper binary ([`../sandbox/main.go`](../sandbox/main.go)). The wrapper applies a Landlock write-only sandbox (kernel 5.13+) or falls back to bubblewrap, restricting writes to the worktree directory, `/tmp`, and `/dev/null`. Reads remain unrestricted. On macOS/Windows, no kernel sandbox is available — the approval prompt displays a ⚠️ warning instead.

### 4. Checkpoint Isolation (`src/services/checkpoints/`)

Two parallel tasks running against the same workspace would interfere if their shadow gits both pointed `core.worktree` at the workspace root. The solution uses scoped shadow gits:

| Instance                   | `core.worktree`                         | Excludes                                       |
| -------------------------- | --------------------------------------- | ---------------------------------------------- |
| Main task (workspace root) | `<workspace>/`                          | `/.shofer/worktrees/` appended to exclude file |
| Worktree task              | `<workspace>/.shofer/worktrees/<name>/` | (already scoped — no exclude needed)           |

`ShadowCheckpointService` accepts an optional `scopedWorktreeDir` constructor argument. When set, the shadow git's `core.worktree` is set to the worktree subdirectory. Non-scoped instances exclude `.shofer/worktrees/` to prevent cross-contamination. `core.worktree` validation accepts the scoped path (not just `workspaceDir`).

### 5. Embedded Worktree Detection (`isEmbeddedWorktree`)

`handleListWorktrees` uses `path.relative(path.resolve(gitRootPath), path.resolve(cwd))` to determine whether a subfolder workspace is itself an embedded worktree:

```typescript
const rel = path.relative(path.resolve(gitRootPath), path.resolve(cwd))
const embeddedPrefix = path.join(".shofer", "worktrees") + path.sep
isEmbeddedWorktree = !rel.startsWith("..") && !path.isAbsolute(rel) && rel.startsWith(embeddedPrefix)
```

This is a containment check anchored to the git root — not a substring match — so it cannot be confused by unrelated directories that happen to contain the string `.shofer/worktrees`.

## UI Components

| Component                                                                               | Location            | Purpose                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`WorktreesView`](../webview-ui/src/components/worktrees/WorktreesView.tsx)             | Settings page       | Full CRUD management with 3-second polling; `.shofer/worktreeinclude` status footer                                                                                                                                                                           |
| [`CreateWorktreeModal`](../webview-ui/src/components/worktrees/CreateWorktreeModal.tsx) | Modal               | Searchable base-branch selector; auto-generated branch/path (read-only); progress tracking; `openAfterCreate` flag spawns an in-window task                                                                                                                   |
| [`DeleteWorktreeModal`](../webview-ui/src/components/worktrees/DeleteWorktreeModal.tsx) | Confirmation dialog | Branch and filesystem deletion warnings                                                                                                                                                                                                                       |
| [`WorktreeIndicator`](../webview-ui/src/components/chat/WorktreeIndicator.tsx)          | Chat input bar chip | Single worktree control: shows current branch + status (ahead/behind, file stats, merge readiness), lists other worktrees (click to spawn parallel task there), and "Create new worktree…" entry that opens `CreateWorktreeModal` with `openAfterCreate=true` |
| [`TaskHeader`](../webview-ui/src/components/chat/TaskHeader.tsx)                        | Chat header         | Shows worktree badge (leaf dir name) when task `cwd` differs from workspace                                                                                                                                                                                   |
| [`TaskSelector`](../webview-ui/src/components/chat/TaskSelector.tsx)                    | Task switcher       | Badges worktree tasks with their branch/directory name                                                                                                                                                                                                        |

## `.shofer/worktreeinclude` Mechanism

A custom extension to standard `git worktree`. The file `.shofer/worktreeinclude` in the workspace root lists files/directories (one per line, `.gitignore` syntax) to copy from the source worktree to newly created worktrees.

### How It Works

1. When a worktree is created, the system reads both `.shofer/worktreeinclude` and `.gitignore`
2. It computes the **intersection** of patterns from both files
3. Only files matching **both** pattern sets are copied using native OS commands (`cp -r` / `robocopy`)
4. Progress is streamed back to the UI via `worktreeCopyProgress` IPC messages

### Why Intersection?

The intersection ensures only **untracked/ignored** files are copied (e.g., `node_modules`, `.env`, build artifacts). This prevents accidental duplication of tracked source files, which would create merge conflicts.

### UI Integration

- The `WorktreesView` footer shows whether `.shofer/worktreeinclude` exists
- If `.gitignore` exists but `.shofer/worktreeinclude` doesn't, a "Create from .gitignore" button generates it
- The `CreateWorktreeModal` shows a warning when `.shofer/worktreeinclude` is absent
- During creation, a progress bar displays bytes copied and current item name

## Subfolder Workspace Restriction

Worktrees are disabled when the VS Code workspace root is a subdirectory of the git repository root, **unless** that subdirectory is itself an embedded worktree (i.e. lives under `<gitRoot>/.shofer/worktrees/`).

### Submodule Interaction

| Workspace                                                 | Git Root         | Worktrees? |
| --------------------------------------------------------- | ---------------- | ---------- |
| Parent repo root (`/repo/`)                               | `/repo/`         | ✅         |
| Submodule root (`/repo/ext/sub/`)                         | `/repo/ext/sub/` | ✅         |
| Subdirectory of parent repo (`/repo/ext/`)                | `/repo/`         | ❌         |
| Embedded worktree (`/repo/.shofer/worktrees/repo-hl911/`) | `/repo/`         | ✅         |

### Caveats with Submodules

- **No auto-initialization**: `git worktree add` creates the directory structure but does not run `git submodule update --init`. Submodules in the new worktree appear as empty directories until manually initialized.
- **`.shofer/worktreeinclude` doesn't apply**: Submodule directories are tracked by git, so they won't match `.gitignore` patterns.
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

`HistoryItem` now includes a `cwd` field (persisted per task).

## Worktree Indicator

The [`WorktreeIndicator`](../webview-ui/src/components/chat/WorktreeIndicator.tsx) is the single chat-input-bar control for everything worktree-related. It serves three purposes:

1. **Status** — ahead/behind counts, files changed, uncommitted change count, last commit, merge readiness. Requested via `getWorktreeStatus` when the popover opens; the backend handler runs 5+ git queries in parallel and returns a `WorktreeStatus` object.
2. **Switch** — lists every other worktree (excluding the bare repo and the currently checked-out one). Clicking one posts `createParallelTask` with `worktreeDir` set to that worktree's path, spawning a parallel task scoped to it without leaving the window.
3. **Create** — a "Create new worktree…" entry at the bottom opens `CreateWorktreeModal` with `openAfterCreate=true`, so a parallel task is automatically spawned in the freshly created worktree.

The trigger is always rendered (it does not auto-hide on a single-worktree repo) so users can create the first worktree from the same place they later switch between them.

i18n translations: [`webview-ui/src/i18n/locales/en/worktreeStatus.json`](../webview-ui/src/i18n/locales/en/worktreeStatus.json)

## Gaps, Issues & Areas for Improvement

This section catalogues discrepancies, omissions, and enhancement opportunities discovered during doc-to-source verification.

### Doc-Source Gaps

| #   | Issue                                                    | Location                               | Detail                                                                                                                                                                                                                                                                                                             |
| --- | -------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **`handleGetWorktreeStatus` `cwdOverride` undocumented** | §2 VSCode Bridge / §Worktree Indicator | The handler accepts an optional second parameter `cwdOverride?: string` so callers can get status for worktrees that differ from `provider.cwd`. This parameter is absent from both the handler listing and the IPC table (which shows `getWorktreeStatus` payload as `(none)`).                                   |
| 2   | **Missing handler functions**                            | §2 VSCode Bridge                       | `handleGetAvailableBranches`, `handleGetWorktreeIncludeStatus`, `handleCheckBranchWorktreeInclude`, `handleCreateWorktreeInclude`, and `handleCheckoutBranch` exist in [`handlers.ts`](src/core/webview/worktree/handlers.ts) but are not enumerated in the handler list. Only the five most-used ones are listed. |
| 3   | **Missing types**                                        | §Type Definitions                      | `BranchInfo` (return of `getAvailableBranches`), `WorktreeDefaultsResponse` (return of `handleGetWorktreeDefaults`), and `CopyProgress`/`CopyProgressCallback` (`.shofer/worktreeinclude` copy progress) are defined in source but omitted from the type listing.                                                  |
| 4   | **No mention of `RepoPerTaskCheckpointService`**         | §4 Checkpoint Isolation                | The section only references `ShadowCheckpointService`, but the per-task orchestration is done by [`RepoPerTaskCheckpointService`](src/services/checkpoints/RepoPerTaskCheckpointService.ts) which constructs scoped instances.                                                                                     |

### Diagram vs. Reality

| #   | Issue                                                | Detail                                                                                                                                                                                                                                                                                    |
| --- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Architecture diagram omits `@shofer/types` layer** | The diagram shows Webview UI → VSCode Bridge → `@shofer/core`. In reality, `@shofer/types` (at [`packages/types/src/worktree.ts`](packages/types/src/worktree.ts)) is the cross-cutting source of truth for all IPC payload shapes, and should appear between the Bridge and Core layers. |
| 6   | **`@shofer/core` vs directory path mismatch**        | The diagram labels the bottom layer as `@shofer/core` but the actual source directory is `packages/core/`. The import alias is correct, but a reader navigating the file tree may be confused.                                                                                            |

### Improvement Opportunities

| #   | Area                                                                 | Suggestion                                                                                                                                                                                                                                                                                                                       |
| --- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7   | **Add sequence diagrams**                                            | A sequence diagram for worktree creation (webview → `createWorktree` → `handleCreateWorktree` → `WorktreeService.createWorktree` + `WorktreeIncludeService.copyWorktreeIncludeFiles` → `worktreeCopyProgress` → result) would clarify the multi-step flow.                                                                       |
| 8   | **Document `handleGetWorktreeStatus` parallelism**                   | The handler runs 5+ git queries in parallel (`getCurrentBranch`, `detectBaseBranch`, `listWorktrees`, `git log`, `git status`, then `git rev-list` ahead/behind). This performance design choice should be surfaced in the Architecture section.                                                                                 |
| 9   | **Cross-reference checkpoint isolation with `submodule-support.md`** | The checkpoint section should explicitly link to how `GIT_DIR` sanitization in `createSanitizedGit` (see [`ShadowCheckpointService.ts`](src/services/checkpoints/ShadowCheckpointService.ts:34-60)) prevents submodule gitlink pollution. This is mentioned for submodules (§Caveats) but not for the checkpoint section itself. |
| 10  | **Document the embedded-worktree path enforcement**                  | `handleCreateWorktree` normalizes any path outside `.shofer/worktrees/` by prepending the convention prefix (see [`handlers.ts:172-182`](src/core/webview/worktree/handlers.ts:172)). This enforcement should be documented in §2 or §5.                                                                                         |

## Known Limitations

1. **No multi-root workspace support** — Workspaces with multiple folders cannot use worktrees
2. **No submodule initialization** — Creating a worktree in a repo with submodules requires manual `git submodule update --init`
3. **`.shofer/worktreeinclude` intersection-only** — Cannot copy files that are not also in `.gitignore`
4. **No programmatic API for external consumers** — Worktree operations are accessible via webview IPC, but not through a public extension API
5. **Shell sandboxing limited to Linux** — On macOS and Windows, `execute_command` in worktree tasks is not sandboxed (no kernel sandbox available). A warning is displayed in the approval prompt as a best-effort safeguard.
