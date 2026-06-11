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
- `handleGetWorktreeDefaults` — Generates a single random token `shofer-<random>` used verbatim as the branch name, the worktree directory basename (`<workspace>/.shofer/worktrees/shofer-<random>`), and the worktree label — one name across all three surfaces

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

**`execute_command` sandboxing:** On Linux, shell commands in worktree-scoped tasks are automatically sandboxed using the `shofer-sandbox` wrapper binary, compiled from Go source at build time ([`../src/sandbox/main.go`](../src/sandbox/main.go)). The wrapper applies a Landlock write-only sandbox (kernel 5.13+) or falls back to bubblewrap, restricting writes to the worktree directory, `/tmp`, and `/dev/null`. Reads remain unrestricted. On macOS/Windows, no kernel sandbox is available — the approval prompt displays a ⚠️ warning instead.

### 3b. Auto-Create Worktree on Send

New ad-hoc tasks default to running in a freshly created worktree, with no extra clicks. The flow is split across the webview and host:

1. **Webview decision** ([`ChatView.tsx`](../webview-ui/src/components/chat/ChatView.tsx)) — on send, `handleSendMessage` sets `autoCreateWorktree = pendingWorktreeDir === null && !worktreeExplicitOptOut`. In other words, auto-create fires only when the user neither picked a specific worktree (`pendingWorktreeDir`) nor explicitly chose "Current branch" (`worktreeExplicitOptOut`, set by the opt-out entry in `WorktreeIndicator`). The flag is included in the `newTask` IPC message.
2. **Host creation** ([`webviewMessageHandler.ts`](../src/core/webview/webviewMessageHandler.ts), `newTask` case) — when `message.autoCreateWorktree && !worktreeDir`, the handler calls `handleGetWorktreeDefaults` for the unified `shofer-<suffix>` name, then `handleCreateWorktree` with `createNewBranch: true` and `baseBranch: undefined` (branches from HEAD).
3. **Scoping** — on success, the created `worktree.path` becomes the `worktreeDir` passed to `createManagedTask`, so the task runs scoped to the new worktree.
4. **Hard-failure abort** — if creation (or its required submodule init, see §"Submodule Auto-Initialization") fails, the handler does **not** start a task on the workspace root. It resets the UI (`newChat`) and surfaces `vscode.window.showErrorMessage` with the failure message, then returns.

This guarantees a single, unambiguous trigger: an explicit worktree pick or an explicit "Current branch" opt-out both suppress auto-create, so the user never ends up with a second, unintended worktree.

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

### Submodule Auto-Initialization

When a worktree is created, Shofer automatically runs `git submodule update --init --depth 1` in the new worktree. This is a **shallow clone** — only the latest commit of each submodule is fetched, not the full history.

- **Trigger**: runs automatically after every worktree creation (via [`handleCreateWorktree`](../src/core/webview/worktree/handlers.ts)), immediately after worktreeinclude file copy.
- **.gitmodules guard**: if the repository has no `.gitmodules` file, the init is silently skipped (no submodules to initialize).
- **Hard failure**: if the submodule clone/init fails (network, auth, etc.), the worktree is torn down (directory removed, branch deleted) and the operation fails — a half-initialized worktree with empty submodule directories is not useful.
- **Depth**: `--depth 1` is the current default. This keeps the clone fast and lightweight for most use cases.

### Caveats with Submodules

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
| `newTask`                  | `text`, `images?`, `worktreeDir?`, `autoCreateWorktree?`                          |
| `createParallelTask`       | `taskName?`, `text?`, `images?`, `worktreeDir?`                                   |
| `getWorktreeStatus`        | (none)                                                                            |

### From Extension to Webview

| Message Type            | Payload                                                                          |
| ----------------------- | -------------------------------------------------------------------------------- |
| `worktreeList`          | `worktrees[]`, `isGitRepo`, `isMultiRoot`, `isSubfolder`, `gitRootPath`, `error` |
| `worktreeResult`        | `success`, `text`, `worktree?` (path, branch, isCurrent)                         |
| `worktreeCopyProgress`  | `copyProgressBytesCopied`, `copyProgressItemName`                                |
| `worktreeCreationStep`  | `worktreeCreationStep`, `worktreeCreationStepDetail`                             |
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

The [`WorktreeIndicator`](../webview-ui/src/components/chat/WorktreeIndicator.tsx) is the single chat-input-bar control for everything worktree-related. It serves four purposes:

1. **Current branch** — when no task is active, the chip shows the current git branch. The popover lists other worktrees for switching and a "New worktree" option for creating one via the [`CreateWorktreeModal`](../webview-ui/src/components/worktrees/CreateWorktreeModal.tsx).
2. **Creation progress** — when a worktree is being created (via "New worktree" or the auto-create flow), the popover shows step-by-step progress: "Copying worktreeinclude files…" and "Initializing submodules…" with real-time done/failed status. Steps are reported via the `worktreeCreationStep` IPC message.
3. **Status** — ahead/behind counts, files changed, uncommitted change count, last commit, merge readiness. Requested via `getWorktreeStatus` when the popover opens; the backend handler runs 5+ git queries in parallel and returns a `WorktreeStatus` object.
4. **Pending workflow** — when a workflow is being launched (via the LauncherView "New Workflow" path), the chip shows "starting \<name\>…" and clears automatically when the workflow task appears in the webview.

The trigger is always rendered (it does not auto-hide on a single-worktree repo) so users can create the first worktree from the same place they later switch between them.

i18n translations: [`webview-ui/src/i18n/locales/en/worktreeStatus.json`](../webview-ui/src/i18n/locales/en/worktreeStatus.json)

## Built-in Worktree Slash Commands

Six worktree merge/rebase/cleanup commands ship as **built-in** slash commands in [`built-in-commands.ts`](../src/services/command/built-in-commands.ts), alongside `init` and the `migrate-from-*` commands. They are always available regardless of whether the project has a `.shofer/commands/` directory, and are invocable by the agent via the `run_slash_command` tool (gated behind the `runSlashCommand` experiment).

| Command                   | Description                                                                         | Cleanup? |
| ------------------------- | ----------------------------------------------------------------------------------- | -------- |
| `merge-worktree`          | Merge worktree branch into base with a merge commit (no cleanup)                    | ❌       |
| `merge-worktree-cleanup`  | Merge worktree branch into base, then delete branch + worktree directory            | ✅       |
| `rebase-worktree`         | Rebase worktree branch onto base, fast-forward merge (no cleanup)                   | ❌       |
| `rebase-worktree-cleanup` | Rebase worktree branch onto base, fast-forward merge, then delete branch + worktree | ✅       |
| `dryrun-rebase-worktree`  | Preview rebase conflicts without committing changes                                 | ❌       |
| `worktree-status`         | Detailed status report for current worktree branch                                  | N/A      |

**Behavior shared by all merge/rebase commands:**

- Auto-detect the base branch (`main` or `master`, preferring `main`) and the source branch (the current worktree branch, typically `shofer-<suffix>`).
- Attempt auto-resolution of conflicts first, but **bail out** on ambiguous conflicts rather than guessing, presenting clear next-step recommendations.
- **Never push to origin** — pushing is left to the user.

**Precedence.** Per the priority chain in [`commands.ts`](../src/services/command/commands.ts) (`project > global > built-in`), a project-level `.shofer/commands/<name>.md` overrides the built-in of the same name. Projects without `.shofer/commands/` get these as sensible defaults out of the box; projects with custom merge logic are unaffected.

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
2. **`.shofer/worktreeinclude` intersection-only** — Cannot copy files that are not also in `.gitignore`
3. **No programmatic API for external consumers** — Worktree operations are accessible via webview IPC, but not through a public extension API
4. **Shell sandboxing limited to Linux** — On macOS and Windows, `execute_command` in worktree tasks is not sandboxed (no kernel sandbox available). A warning is displayed in the approval prompt as a best-effort safeguard.
