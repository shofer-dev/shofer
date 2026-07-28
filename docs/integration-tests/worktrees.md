# Worktree Integration Test Scenarios

## Setup

Each scenario assumes a git repository with at least one commit and a clean working tree,
and the bundled `worktrees` plugin enabled (its default).

## Scenarios

### 1. Create an embedded worktree and run a task in it

1. Open a single-folder git workspace.
2. Click the branch chip in the chat input → "Create new worktree…".
3. Accept auto-generated branch and path. Click **Create**.
4. **Assert:** The new worktree directory exists at `<workspace>/.worktrees/<name>/`.
5. **Assert:** `git worktree list` shows both the main tree and the new worktree.
6. **Assert:** `.gitignore` contains `.worktrees/`.
7. Send a message.
8. **Assert:** The task appears in the TaskSelector badged with the worktree's directory name.
9. **Assert:** The task's `cwd` is the worktree subdirectory (verify via `execute_command pwd`).

### 1b. A task started with no choice gets its own worktree

1. Open a single-folder git workspace with no pending selection (fresh window).
2. Send a message straight away.
3. **Assert:** A `shofer-<random>` worktree was created and the task runs in it.
4. Click the branch chip, choose the current branch, and start another task.
5. **Assert:** That task runs in the workspace root — no second worktree.

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

1. Attempt to create a worktree with a path outside `.worktrees/` (e.g. by calling the plugin's `create` request with an absolute path elsewhere).
2. **Assert:** The path is normalized to `.worktrees/<dirname>/` by the plugin.
3. Create a worktree by hand at the legacy `.shofer/worktrees/<name>/` (`git worktree add`).
4. **Assert:** It is still listed in Settings → Plugins → Worktrees and can still be deleted there (the transition shim).

### 5. List worktrees and availability constraints

1. Open a single-folder git workspace.
2. Open Settings → Plugins → Worktrees.
3. **Assert:** The worktree list appears with the main tree and any existing worktrees.
4. **Assert:** The `.shofer/worktreeinclude` status footer shows correct status.
5. Open a multi-root workspace.
6. **Assert:** The panel explains that multi-root workspaces are not supported.
7. Open a subfolder of a git repo (not under `.worktrees/`).
8. **Assert:** The panel explains that the workspace is a subfolder of a repository.

### 6. Embedded worktree exemption for subfolder restriction

1. Create an embedded worktree via the UI.
2. Open that worktree as a VS Code workspace (`code .worktrees/<name>/`).
3. Open Settings → Plugins → Worktrees.
4. **Assert:** Worktrees ARE available (the subfolder restriction is bypassed for embedded worktrees).

### 7. Delete worktree

1. Create a worktree via the UI.
2. Delete it from Settings → Plugins → Worktrees (normal delete).
3. **Assert:** The worktree directory no longer exists on disk.
4. **Assert:** `git worktree list` no longer shows the worktree.
5. **Assert:** The branch is deleted (best-effort via `git branch -d`) if it had no unmerged changes.

### 8. Force-delete worktree with uncommitted changes

1. Create a worktree.
2. Make an uncommitted change in that worktree.
3. Delete it with **Force** enabled.
4. **Assert:** The worktree directory is removed.
5. **Assert:** The branch is NOT deleted (force-delete prunes the worktree but not the branch).

### 9. Branch-chip status display

1. Open a git workspace with commits on current branch.
2. Click the branch chip.
3. **Assert:** The popover shows: branch name, ahead/behind counts, files changed, last commit info.
4. Make an uncommitted change.
5. Re-open the popover.
6. **Assert:** The status updates to show the uncommitted change count.

### 10. Pick which worktree the next task runs in

1. Create two worktrees (A and B) in addition to the main tree.
2. Click the branch chip.
3. **Assert:** The "Select worktree for new task" section lists A and B alongside the current one (never the bare repo).
4. Click worktree A, then send a message.
5. **Assert:** The task runs in worktree A (`execute_command pwd`), and the TaskSelector badges it with A's directory name.
6. **Assert:** The message after that does NOT reuse A — one pick scopes one task.

### 11. Checkpoint isolation between parallel worktree tasks

1. Create a worktree task.
2. Make file changes in the main task.
3. Make different file changes in the worktree task.
4. **Assert:** The main task's shadow git excludes `.worktrees/`.
5. **Assert:** The worktree task's shadow git has `core.worktree` scoped to the worktree subdirectory.
6. **Assert:** Checkpoint diffs in each task only show changes from that task's working tree (no cross-contamination).

### 12. Task rehydration with worktree `cwd`

1. Create a worktree task. Make some progress (send a message, get a response).
2. Close and reopen VS Code.
3. **Assert:** The worktree task appears in history with `cwd` set to the worktree path.
4. Resume the task.
5. **Assert:** `execute_command pwd` in the resumed task shows the worktree subdirectory.

### 13. Status is scoped to the task's own worktree

1. Create a worktree task (Task B) while the main task (Task A) is active.
2. With Task B focused, open the branch chip.
3. **Assert:** The status reflects Task B's worktree (branch, ahead/behind, uncommitted changes), NOT the main workspace's.

### 14. Submodule interaction

1. Open a git repo that has submodules.
2. Create a worktree.
3. **Assert:** With "Initialize submodules" left on, the worktree is created and its submodules are populated (`--depth 1`).
4. Repeat with the option unchecked.
5. **Assert:** The worktree is created and its submodule directories are empty.
