# Parallel Work with Git Worktrees

Shofer lets you run multiple tasks **in parallel** using git worktrees — all inside a single VS Code window. No windows to juggle, no terminal commands to memorize.

## What Are Worktrees?

A git worktree is an additional working copy of your repository on a different branch. Shofer manages them for you: each new parallel task gets its own worktree under `.shofer/worktrees/` so you can work on a feature in one task while a code review or refactor runs in another — with no branch conflicts or file collisions.

## Quick Start

1. Click the **branch chip** in the chat input bar (`WorktreeIndicator`).
    <!-- XXX: Screenshot — chat input bar with the WorktreeIndicator chip highlighted (shows branch name + git status). -->

2. In the popover, click **"Create new worktree…"** .
    <!-- XXX: Screenshot — WorktreeIndicator popover open, pointer hovering over "Create new worktree…" entry at the bottom. -->

3. The **Create Worktree** modal opens with auto-generated branch and path names. Optionally pick a base branch from the searchable dropdown.
    <!-- XXX: Screenshot — CreateWorktreeModal showing auto-generated "worktree/shofer-abc12" branch and ".shofer/worktrees/myproject-xyz89" path, with the base branch dropdown expanded. -->

4. Click **Create**. A progress bar shows files being copied (from `.worktreeinclude`). Once created, a new task spawns automatically in that worktree.
    <!-- XXX: Screenshot — CreateWorktreeModal during creation, showing progress bar with bytes copied and current item name. -->

5. **You now have two tasks running in parallel.** Switch between them in the TaskSelector dropdown — each operates in its own branch with its own working directory.
    <!-- XXX: Screenshot — ChatView showing two tasks in the TaskSelector dropdown, one badge "main" and the other badge "worktree/shofer-abc12". -->

## Switching Between Worktrees

Click the WorktreeIndicator chip → the popover lists every other worktree. Click any entry to **spawn a new parallel task** in that worktree's directory — you stay in the same window.

<!-- XXX: Screenshot — WorktreeIndicator popover showing a list of worktree entries: "feature-login (ahead 3)", "fix-typo (clean)", each clickable. -->

Each task in the TaskSelector shows a **worktree badge** (the branch or directory name) so you can tell them apart at a glance.

<!-- XXX: Screenshot — TaskSelector dropdown with two entries: "Add login page" badge "main", "Refactor auth module" badge "worktree/shofer-abc12". -->

## The `.worktreeinclude` File

When you create a worktree, only tracked git files are present — `node_modules`, `.env`, and build artifacts are **not** copied by default. The `.worktreeinclude` file lets you specify which ignored files to copy automatically.

**How to set it up:**

1. Go to **Settings** → **Worktrees** tab (`WorktreesView`).
2. If your workspace has a `.gitignore` but no `.worktreeinclude`, click **"Create from .gitignore"** .
3. Edit the generated `.worktreeinclude` to keep only the directories you want copied (e.g., `node_modules/`).
    <!-- XXX: Screenshot — WorktreesView settings page showing the ".worktreeinclude status" footer with "Create from .gitignore" button. -->

Only files that appear in **both** `.gitignore` and `.worktreeinclude` are copied — so you never accidentally duplicate tracked source files.

## Managing Worktrees

Open **Settings** → **Worktrees** tab to see all worktrees. From there you can:

- View details: path, branch, commit hash, locked status.
- **Delete** a worktree (removes the directory and optionally the branch). Use **Force Delete** if the worktree has uncommitted changes.
    <!-- XXX: Screenshot — WorktreesView showing a table of worktrees with Delete buttons and a confirmation dialog. -->

The list refreshes every 3 seconds so you always see the latest state.

## Viewing Worktree Status

The WorktreeIndicator chip shows:

- Current branch name
- **Ahead/behind** counts (e.g., "↑3 ↓0" means 3 commits ahead of base)
- **Uncommitted changes** count
- **Last commit** info (hash, subject, author, relative time)
- **Merge readiness** — whether merging the current branch into the base would cause conflicts
    <!-- XXX: Screenshot — WorktreeIndicator popover fully expanded showing the Status section with ahead/behind arrows, "3 files changed (+42, -7)", "Last commit: a1b2c3d Fix login bug (2 hours ago) by Jane", and "Merge into main: no conflicts". -->

## Caveats

| Situation             | What Happens                                                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Multi-root workspaces | Worktrees are **not supported**. Open the repo as a single-folder workspace first.                                                      |
| Subfolder workspaces  | Worktrees are disabled unless the subfolder is itself an embedded worktree (i.e., opened from `.shofer/worktrees/`).                    |
| Submodules            | `git worktree add` does **not** run `git submodule update --init`. Submodule directories appear empty — initialize them manually.       |
| Untracked files       | Only files listed in `.worktreeinclude` are copied. Other untracked files (outside `.gitignore`) are not available in the new worktree. |
