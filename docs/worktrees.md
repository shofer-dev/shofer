# Git Worktree Support in Roo Code

## Overview

Roo Code added full git worktree management in **v3.44.0** (January 2026, PR #10940). Worktrees enable agentic coding across multiple branches simultaneously — each branch gets its own directory and VS Code window, with Roo Code auto-opening in the new window.

## Architecture

The feature is split across three layers:

```
┌──────────────────────────────────────────────────────────────┐
│  Webview UI (React)                                           │
│  WorktreeSelector · WorktreesView · Create/Delete Modals      │
├──────────────────────────────────────────────────────────────┤
│  VSCode Bridge (handlers.ts)                                  │
│  handleListWorktrees · handleCreateWorktree                   │
│  handleSwitchWorktree · handleDeleteWorktree                  │
├──────────────────────────────────────────────────────────────┤
│  Platform-Agnostic Core (@roo-code/core)                      │
│  WorktreeService · WorktreeIncludeService                     │
│  (no VSCode dependencies — pure git CLI wrappers)             │
└──────────────────────────────────────────────────────────────┘
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

- `handleListWorktrees` — Enforces constraints (no multi-root, no subfolder workspace) before listing
- `handleCreateWorktree` — Creates worktree then auto-copies `.worktreeinclude` files with progress
- `handleSwitchWorktree` — Opens `vscode.openFolder` (same or new window); stores `worktreeAutoOpenPath` in global state for auto-open behavior
- `handleDeleteWorktree` — Delegates to core service
- `handleGetWorktreeDefaults` — Generates suggested path (`~/.roo/worktrees/<project>-<random>`) and branch name (`worktree/roo-<random>`)

### 3. Extension Activation Flow

When a worktree is opened (either same-window or new-window), the stored [`worktreeAutoOpenPath`](../src/extension.ts:83) triggers:

1. On activation, `checkWorktreeAutoOpen` reads the stored path from `globalState`
2. If the current workspace path matches, it clears the stored path and auto-opens the Roo Code sidebar (500ms delay for UI readiness)
3. This ensures Roo Code is immediately available in the new worktree window

## UI Components

| Component                                                                               | Location             | Purpose                                                                                                    |
| --------------------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------- |
| [`WorktreeSelector`](../webview-ui/src/components/chat/WorktreeSelector.tsx)            | Chat header dropdown | Quick-switch between worktrees; shows branch name and path; hidden when ≤1 worktree exists                 |
| [`WorktreesView`](../webview-ui/src/components/worktrees/WorktreesView.tsx)             | Settings page        | Full CRUD management with 3-second polling; `.worktreeinclude` status footer; "show in home screen" toggle |
| [`CreateWorktreeModal`](../webview-ui/src/components/worktrees/CreateWorktreeModal.tsx) | Modal                | Searchable base-branch selector, auto-generated branch/path defaults, progress tracking during file copy   |
| [`DeleteWorktreeModal`](../webview-ui/src/components/worktrees/DeleteWorktreeModal.tsx) | Confirmation dialog  | Branch and filesystem deletion warnings                                                                    |

## `.worktreeinclude` Mechanism

A custom extension to standard `git worktree`. The file `.worktreeinclude` in the workspace root lists files/directories (one per line, `.gitignore` syntax) to copy from the source worktree to newly created worktrees.

### How It Works

1. When a worktree is created, the system reads both `.worktreeinclude` and `.gitignore`
2. It computes the **intersection** of patterns from both files
3. Only files matching **both** pattern sets are copied using native OS commands (`cp -r` / `robocopy`)
4. Progress is streamed back to the UI via `worktreeCopyProgress` IPC messages

### Why Intersection?

The intersection ensures only **untracked/ignored** files are copied (e.g., `node_modules`, `.env`, build artifacts). This prevents accidental duplication of tracked source files, which would create merge conflicts. Only files that the developer explicitly ignores AND also wants in new worktrees are copied.

### UI Integration

- The `WorktreesView` footer shows whether `.worktreeinclude` exists
- If `.gitignore` exists but `.worktreeinclude` doesn't, a "Create from .gitignore" button generates it
- The `CreateWorktreeModal` shows a warning when `.worktreeinclude` is absent
- During creation, a progress bar displays bytes copied and current item name

## Subfolder Workspace Restriction

Worktrees are **disabled** when the VS Code workspace root is a subdirectory of the git repository root.

### The Check

The function `isWorkspaceSubfolder` runs `git rev-parse --show-toplevel` and compares the result to the workspace root. If the workspace is deeper than the git root, worktrees are rejected.

### Why?

`git worktree` operates at the repository level. If the workspace only covers a subdirectory, there's no single unambiguous repository root to attach worktrees to. The feature requires the workspace root to equal the git root.

### Submodule Interaction

| Workspace                                  | Git Root         | Worktrees? |
| ------------------------------------------ | ---------------- | ---------- |
| Parent repo root (`/repo/`)                | `/repo/`         | ✅         |
| Submodule root (`/repo/ext/sub/`)          | `/repo/ext/sub/` | ✅         |
| Subdirectory of parent repo (`/repo/ext/`) | `/repo/`         | ❌         |

Submodules have their **own** git root (via the `.git` file pointing to the parent's `.git/modules/` directory). Opening a submodule as its own workspace works correctly.

### Caveats with Submodules

- **No auto-initialization**: `git worktree add` creates the directory structure but does not run `git submodule update --init`. Submodules in the new worktree appear as empty directories until manually initialized.
- **`.worktreeinclude` doesn't apply**: Submodule directories are tracked by git, so they won't match `.gitignore` patterns. The `.worktreeinclude` mechanism cannot help here.
- **Checkpoint safety**: The shadow git checkpoint system uses `GIT_DIR` isolation (see [`submodule-support.md`](./submodule-support.md)) to prevent submodule discovery during checkpoint operations, so checkpoints work correctly even with submodules present.

## Checkpoint Integration

The shadow git checkpoint system ([`ShadowCheckpointService`](../src/services/checkpoints/ShadowCheckpointService.ts)) uses `core.worktree` config to point the shadow git at the workspace directory. Key interactions:

- **Worktree `.git` files**: `git worktree add` creates `.git` files (not directories), which historically evaded the nested-repo detector. This was resolved by setting `GIT_DIR` in the shadow git, preventing submodule discovery.
- **`core.worktree` validation**: On shadow git init, the system verifies `core.worktree` is set and matches the workspace directory. Missing or mismatched `core.worktree` throws an error.

## IPC Message Types

### From Webview to Extension

| Message Type               | Payload                                                                           |
| -------------------------- | --------------------------------------------------------------------------------- |
| `listWorktrees`            | (none)                                                                            |
| `createWorktree`           | `worktreePath`, `worktreeBranch`, `worktreeBaseBranch`, `worktreeCreateNewBranch` |
| `deleteWorktree`           | `worktreePath`, `worktreeForce`                                                   |
| `switchWorktree`           | `worktreePath`, `worktreeNewWindow`                                               |
| `getWorktreeDefaults`      | (none)                                                                            |
| `getWorktreeIncludeStatus` | (none)                                                                            |
| `getAvailableBranches`     | (none)                                                                            |
| `createWorktreeInclude`    | `worktreeIncludeContent`                                                          |
| `branchWorktreeInclude`    | `worktreeBranch`                                                                  |
| `checkoutBranch`           | `worktreeBranch`                                                                  |
| `browseForWorktreePath`    | (none)                                                                            |

### From Extension to Webview

| Message Type            | Payload                                                                          |
| ----------------------- | -------------------------------------------------------------------------------- |
| `worktreeList`          | `worktrees[]`, `isGitRepo`, `isMultiRoot`, `isSubfolder`, `gitRootPath`, `error` |
| `worktreeResult`        | `success`, `text` (message)                                                      |
| `worktreeCopyProgress`  | `copyProgressBytesCopied`, `copyProgressItemName`                                |
| `branchList`            | `localBranches[]`, `remoteBranches[]`, `currentBranch`                           |
| `worktreeDefaults`      | `suggestedBranch`, `suggestedPath`                                               |
| `worktreeIncludeStatus` | `exists`, `hasGitignore`, `gitignoreContent`                                     |

## Type Definitions

Core types are defined in [`packages/types/src/worktree.ts`](../packages/types/src/worktree.ts):

- `Worktree` — path, branch, commitHash, isCurrent, isBare, isDetached, isLocked, lockReason
- `WorktreeResult` — success, message, optional worktree reference
- `CreateWorktreeOptions` — path, branch?, baseBranch?, createNewBranch?
- `WorktreeIncludeStatus` — exists, hasGitignore, gitignoreContent?
- `WorktreeListResponse` — worktrees[], isGitRepo, isMultiRoot, isSubfolder, gitRootPath, error?

## Known Limitations

1. **No multi-root workspace support** — Workspaces with multiple folders cannot use worktrees
2. **No subfolder workspace support** — The workspace must be the git repository root
3. **No programmatic API** — Worktree operations are only accessible via webview IPC, not through a public extension API or CLI
4. **`.worktreeinclude` intersection-only** — Cannot copy files that are not also in `.gitignore`
5. **Single-connection model** — Each worktree is a separate VS Code window with independent state; there is no cross-worktree coordination
6. **No submodule initialization** — Creating a worktree in a repo with submodules requires manual `git submodule update --init`
