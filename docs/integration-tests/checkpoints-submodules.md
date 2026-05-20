# Checkpoints with Nested Git Repositories — Integration Test Scenarios

## Setup

Each scenario assumes a git repository with at least one commit and a clean working tree.
The Shofer extension must be activated in the workspace.

## Scenarios

### 1. Nested `.git` directory — checkpoint init succeeds

1. Create a workspace with a primary git repo.
2. Inside the workspace, create a subdirectory with its own `git init` + commit
   (`mkdir nested && cd nested && git init && touch f.txt && git add . && git commit -m init`).
3. Start a Shofer task.
4. **Assert:** No "Checkpoints are disabled" error appears.
5. **Assert:** The output channel logs `nested git repo detected at <path> — GIT_DIR prevents submodule detection; source files are tracked directly`.
6. **Assert:** `saveCheckpoint()` succeeds (modify a file, verify a checkpoint is created).

### 2. Git submodule with `gitdir:` pointer — checkpoint init succeeds

1. Create a workspace with a primary git repo.
2. Add a submodule: `git submodule add <url> sub`.
3. Start a Shofer task.
4. **Assert:** Checkpoint initialization succeeds (no throw).
5. **Assert:** Files inside the submodule are tracked by content (not as gitlinks) in the
   shadow git — edit a file inside `sub/`, save a checkpoint, verify via `checkpointDiff`.

### 3. Workspace with multiple nested `.git` directories

1. Create a workspace with a primary git repo.
2. Create two nested repos: `nested-a/.git/` and `nested-b/.git/` (each with at least one commit).
3. Start a Shofer task.
4. **Assert:** Checkpoint initialization succeeds.
5. **Assert:** Both nested repos are logged as detected.
6. **Assert:** Editing files in either nested repo produces correct checkpoints.

### 4. Inherited `GIT_DIR`/`GIT_WORK_TREE` in process environment

1. Set `GIT_DIR=/some/other/repo/.git` and `GIT_WORK_TREE=/some/other/repo` in the
   environment before launching VS Code (or in the integrated terminal).
2. Start a Shofer task in a workspace with a primary git repo.
3. **Assert:** `createSanitizedGit` strips the inherited variables and sets its own `GIT_DIR`.
4. **Assert:** Checkpoint operations target the shadow repo, not `/some/other/repo`.
5. **Assert:** The output channel logs `Removed git environment variables for checkpoint isolation: GIT_DIR=..., GIT_WORK_TREE=...`.

### 5. Inherited `GIT_CEILING_DIRECTORIES` in process environment

1. Set `GIT_CEILING_DIRECTORIES=/some/path` in the environment before launching VS Code.
2. Start a Shofer task.
3. **Assert:** `createSanitizedGit` strips `GIT_CEILING_DIRECTORIES`.
4. **Assert:** Checkpoint initialization and operations succeed normally.

### 6. `GIT_DIR` isolation prevents submodule gitlink recording

1. Create a workspace with a primary git repo and a nested `.git/` directory.
2. Start a Shofer task and make a file edit inside the nested repo.
3. Save a checkpoint.
4. **Assert:** The shadow git's `diff` shows the nested-repo file as a regular file
   (with insertions/deletions), NOT as a mode `160000` gitlink entry.
5. **Assert:** Restoring the checkpoint correctly recovers the nested-repo file content.

### 7. `deleteBranch` safety with `GIT_DIR` set (no `GIT_WORK_TREE`)

1. Create a workspace with a nested `.git/` directory.
2. Start a Shofer task, make edits, save checkpoints.
3. Trigger branch deletion (e.g., by deleting the task via TaskActions → Delete).
4. **Assert:** `deleteBranch` temporarily unsets `core.worktree`, runs `git clean -f -d`,
   and falls back to CWD (the shadow directory) — NOT the workspace.
5. **Assert:** The workspace is not cleaned. Only the shadow repo is affected.

### 8. `getExcludePatterns` excludes nested `.git` metadata from staging

1. Create a workspace with a primary git repo.
2. Verify `.git/info/exclude` in the shadow repo contains patterns from
   `getExcludePatterns()` including project-level `.gitignore` rules.
3. Start a Shofer task.
4. **Assert:** `git add . --ignore-errors` in the shadow repo does not stage `.git/HEAD`,
   `.git/index`, or other git-internal files from the workspace.

### 9. File Changes Panel works independently of checkpoint backend

1. Create a workspace with a nested `.git/` directory.
2. Start a Shofer task.
3. Make a file edit that triggers `FileContextTracker.captureOriginal` + `trackFileContext("shofer_edited")`.
4. **Assert:** The edited file appears in the File Changes Panel with Accept/Revert buttons.
5. **Assert:** The panel reports `backend: "working"` (working-directory backend) — it never
   falls back to a "tracker" or "checkpoint" backend mode.
6. **Assert:** Revert restores the original content from `<taskDir>/base/<relPath>`.
7. **Assert:** Redo re-applies the final content from `<taskDir>/final/<relPath>`.

### 10. No false detection of workspace root `.git`

1. Create a workspace with a single primary git repo (no nested repos).
2. Start a Shofer task.
3. **Assert:** `getNestedGitRepository()` returns `null` (the root `.git/HEAD` is filtered out).
4. **Assert:** No "nested git repo detected" log message appears.
5. **Assert:** Checkpoint initialization proceeds via the normal path (no special handling).
