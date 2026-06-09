# Worktree Integration Test Scenarios

## Setup

Each scenario assumes a git repository with at least one commit and a clean working tree.

## Scenarios

### 1. Create an embedded worktree and spawn a parallel task

1. Open a single-folder git workspace.
2. Click the WorktreeIndicator chip → "Create new worktree…".
3. Accept auto-generated branch and path. Click **Create**.
4. **Assert:** A new task appears in the TaskSelector with the worktree branch badge.
5. **Assert:** The new worktree directory exists at `<workspace>/.shofer/worktrees/<name>/`.
6. **Assert:** `git worktree list` shows both the main tree and the new worktree.
7. **Assert:** The new task's `cwd` is the worktree subdirectory (verify via `execute_command pwd` in the new task).

### 2. Copy `.shofer/worktreeinclude` files on creation

1. Create a `.shofer/worktreeinclude` file in the workspace root with `node_modules/`.
2. Ensure `node_modules/` is in `.gitignore`.
3. Create a worktree via the UI.
4. **Assert:** The creation modal shows a progress bar with bytes copied.
5. **Assert:** `node_modules/` exists in the new worktree directory.
6. **Assert:** Tracked source files are NOT duplicated (only ignored files matched by `.shofer/worktreeinclude`).

### 3. `.shofer/worktreeinclude` intersection behavior

1. Create `.shofer/worktreeinclude` with a pattern that is NOT in `.gitignore` (e.g., `src/`).
2. Create a worktree.
3. **Assert:** The pattern is NOT copied (only files matching BOTH `.gitignore` AND `.shofer/worktreeinclude` are copied).

### 4. Worktree path enforcement

1. Attempt to create a worktree with a path outside `.shofer/worktrees/` (e.g., via a manually-crafted `createWorktree` IPC message or by modifying the modal).
2. **Assert:** The path is normalized to `.shofer/worktrees/<dirname>/` by `handleCreateWorktree`.

### 5. List worktrees and availability constraints

1. Open a single-folder git workspace.
2. Open the Worktrees settings page.
3. **Assert:** The worktree list appears with the main tree and any existing worktrees.
4. **Assert:** The `.shofer/worktreeinclude` status footer shows correct status.
5. Open a multi-root workspace.
6. **Assert:** Worktrees view shows "not supported in multi-root workspaces".
7. Open a subfolder of a git repo (not under `.shofer/worktrees/`).
8. **Assert:** Worktrees view shows "not supported when workspace is a subfolder".

### 6. Embedded worktree exemption for subfolder restriction

1. Create an embedded worktree via the UI.
2. Open that worktree as a VS Code workspace (`code .shofer/worktrees/<name>/`).
3. Navigate to the Worktrees settings page.
4. **Assert:** Worktrees ARE available (the subfolder restriction is bypassed for embedded worktrees).

### 7. Delete worktree

1. Create a worktree via the UI.
2. Delete it via the Worktrees settings page (normal delete).
3. **Assert:** The worktree directory no longer exists on disk.
4. **Assert:** `git worktree list` no longer shows the worktree.
5. **Assert:** The branch is deleted (best-effort via `git branch -d`) if it had no unmerged changes.

### 8. Force-delete worktree with uncommitted changes

1. Create a worktree.
2. Make an uncommitted change in that worktree.
3. Delete it with **Force** enabled.
4. **Assert:** The worktree directory is removed.
5. **Assert:** The branch is NOT deleted (force-delete prunes the worktree but not the branch).

### 9. WorktreeIndicator status display

1. Open a git workspace with commits on current branch.
2. Click the WorktreeIndicator chip.
3. **Assert:** The popover shows: branch name, ahead/behind counts, files changed, last commit info.
4. Make an uncommitted change.
5. Re-open the popover.
6. **Assert:** The status updates to show the uncommitted change count.

### 10. Switch to another worktree via WorktreeIndicator

1. Create two worktrees (A and B) in addition to the main tree.
2. Click the WorktreeIndicator chip.
3. **Assert:** The "Other Worktrees" section lists worktrees A and B (not the current one, not the bare repo).
4. Click on worktree A.
5. **Assert:** A new parallel task is spawned (`createParallelTask` with `worktreeDir` set to worktree A's path).
6. **Assert:** The new task appears in the TaskSelector with the correct worktree badge.

### 11. Checkpoint isolation between parallel worktree tasks

1. Create a worktree task.
2. Make file changes in the main task.
3. Make different file changes in the worktree task.
4. **Assert:** The main task's shadow git excludes `.shofer/worktrees/`.
5. **Assert:** The worktree task's shadow git has `core.worktree` scoped to the worktree subdirectory.
6. **Assert:** Checkpoint diffs in each task only show changes from that task's working tree (no cross-contamination).

### 12. Task rehydration with worktree `cwd`

1. Create a worktree task. Make some progress (send a message, get a response).
2. Close and reopen VS Code.
3. **Assert:** The worktree task appears in history with `cwd` set to the worktree path.
4. Resume the task.
5. **Assert:** `execute_command pwd` in the resumed task shows the worktree subdirectory.

### 13. `handleGetWorktreeStatus` with `cwdOverride`

1. Create a worktree task (Task B) while the main task (Task A) is active.
2. Request worktree status from Task B's context (with `cwdOverride` set to Task B's worktree path).
3. **Assert:** The returned status reflects Task B's worktree (branch, ahead/behind, uncommitted changes), NOT the main workspace's status.

### 14. Submodule interaction

1. Open a git repo that has submodules.
2. Create a worktree.
3. **Assert:** The worktree is created successfully.
4. **Assert:** Submodule directories in the worktree are empty (no auto-init).
5. Run `git submodule update --init` in the worktree.
6. **Assert:** Submodules populate correctly.
