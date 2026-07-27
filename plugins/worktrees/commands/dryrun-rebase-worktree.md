---
description: Preview rebase conflicts without committing changes
---

<task>
You are performing a dry-run rebase to preview what conflicts would occur, without actually completing the rebase. The user may specify the branch name; if not provided, infer it from the current branch (typically worktree/shofer-<suffix>).
</task>

## Step 1: Gather information

Run these commands in parallel:

```bash
git branch --show-current
```

```bash
git worktree list
```

```bash
git branch --list "worktree/*"
```

From the output, identify:

- **SOURCE_BRANCH**: the worktree branch to test-rebase. If the user specified one, use it. Otherwise, use the current branch if it starts with worktree/. If neither is clear, ask the user.
- **SOURCE_WORKTREE_PATH**: the filesystem path of the worktree with SOURCE_BRANCH checked out
- **BASE_BRANCH**: the target branch. Check if main or master exists locally. Prefer whichever exists. If both, prefer main.

## Step 2: Validate

- SOURCE_BRANCH exists (git branch --list <SOURCE_BRANCH>)
- BASE_BRANCH exists (git branch --list <BASE_BRANCH>)
- SOURCE_BRANCH != BASE_BRANCH

Show what would be rebased:

```bash
git log <BASE_BRANCH>..<SOURCE_BRANCH> --oneline
```

## Step 3: Simulate the rebase

Switch to the source worktree:

```bash
cd <SOURCE_WORKTREE_PATH> && git checkout <SOURCE_BRANCH>
```

Run the dry-run rebase:

```bash
git rebase <BASE_BRANCH>
```

## Step 4: Report results

### If the rebase applies cleanly:

Report: "Rebase of <SOURCE_BRANCH> onto <BASE_BRANCH> would apply cleanly. No conflicts expected."

Show the new commit order: git log --oneline -<N>

Then abort back to original state:

```bash
git reset --hard ORIG_HEAD
```

### If conflicts are detected:

List them:

```bash
git diff --name-only --diff-filter=U
```

Show the conflict markers across all conflicted files (git-native, works on
every OS — no grep needed):

```bash
git diff --check
```

Report: "Conflicts would occur in <N> file(s): [list]. These will need to be resolved if you proceed with the rebase."

## Step 5: Abort and clean up

If rebase is in progress (conflicts occurred): git rebase --abort
If rebase completed successfully: git reset --hard ORIG_HEAD

Confirm clean state:

```bash
git status --short  # should be empty
```

```bash
git branch --show-current  # should be SOURCE_BRANCH
```

## Step 6: Recommend next steps

Based on the result:

- **No conflicts**: "Safe to proceed. Run rebase-worktree to rebase and fast-forward merge."
- **Conflicts found**: "Conflicts expected. You can: (a) run rebase-worktree and let the agent auto-resolve, (b) resolve them yourself, or (c) use merge-worktree (merge strategy) which may produce different conflicts."
- **Many commits**: "There are <N> commits to rebase. If conflicts occur, you may need to resolve them multiple times (once per commit). Consider merge-worktree for a single conflict resolution."
