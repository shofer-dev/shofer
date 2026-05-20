# Checkpoints with Nested Git Repositories & Submodules

Shofer automatically saves **checkpoints** as you work — snapshotting your workspace so you can
undo, redo, or revert file changes at any point during a task. Checkpoints use a background
"shadow" git repository that lives outside your workspace.

Previously, if your workspace contained a **nested git repository** (a submodule, a cloned
project inside another project, or a git worktree), checkpoints were disabled with an error:

> Checkpoints are disabled because a nested git repository was detected at: ...

This is no longer the case. Checkpoints now work **transparently** in workspaces that contain
nested `.git` directories or git submodules — no errors, no configuration, no limitations.

<!-- XXX: Screenshot — Shofer chat view during an active task with the CheckpointWarning
     component absent (not shown). The file changes panel is visible with Accept/Revert
     buttons, demonstrating that checkpoint-based features (diff, revert, redo) work in
     a workspace that has a nested .git subdirectory. Ideally taken in a workspace like
     arkware.ai which has extensions/shofer as a git submodule. -->

## What Changed

| Before                                                  | After                                          |
| ------------------------------------------------------- | ---------------------------------------------- |
| Checkpoints blocked with error message                  | Checkpoints initialize silently                |
| Workspace with submodules → no checkpoint functionality | Workspace with submodules → full functionality |
| Manual workaround: relocate nested repos                | No user action required                        |

## What This Means for You

- **No action required.** If you previously saw the "nested git repository" error, it is gone.
  Checkpoints now initialize normally in the same workspace.
- **All checkpoint features work**: undo file changes per-task, revert to any checkpoint,
  redo reverted changes, and view diffs.
- **Your workspace is not modified.** The fix operates entirely within Shofer's internal
  shadow git — your nested repos and submodules are left untouched.

## When This Applies

Your workspace triggers the old detection if it contains any of these:

- A **git submodule** (declared in `.gitmodules`, with a `.git` file pointing to the parent's
  `.git/modules/` directory).
- A **nested git clone** (a project inside another project, each with its own `.git/`).
- A **git worktree** (created by `git worktree add`, with a `.git` file pointing back to the
  main repository).

All three cases are handled automatically.

## Verifying Checkpoints Are Working

1. Open a workspace that contains a nested git repository or submodule.
2. Start any Shofer task and make a file edit.
3. Open the **File Changes Panel** — the edited file appears with Accept and Revert buttons.
    <!-- XXX: Screenshot — FileChangesPanel showing a modified file with insertion/deletion
         counts, Accept (checkmark) and Revert (undo) action buttons visible. This confirms
         the working-directory backend is functioning. -->
4. Click **Revert** on the file — the file is restored to its pre-edit state. Click **Redo**
   to re-apply Shofer's edit.

If revert and redo work, checkpoints are functioning correctly.

## Technical Note

Shofer isolates its shadow git from your workspace's git structure by setting the `GIT_DIR`
environment variable to point exclusively to the internal checkpoint repository. This prevents
git from discovering nested `.git` directories as submodules during checkpoint operations,
while leaving your actual workspace git configuration untouched.
