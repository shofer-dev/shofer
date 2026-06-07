---
description: "Dry-run rebase: preview conflicts without committing"
---

You are performing a dry-run rebase to preview what conflicts would occur, without actually completing the rebase. The user may specify the branch name; if not provided, infer it from the current branch (typically `worktree/shofer-<suffix>`).

## Step 1: Gather information

Run these commands in parallel:

```bash
git branch --show-current
```

```bash
git worktree list
```

```bash
git branch --list 'worktree/*'
```

From the output, identify:

- **SOURCE_BRANCH**: the worktree branch to test-rebase. If the user specified one, use it. Otherwise, use the current branch if it starts with `worktree/`. If neither is clear, ask the user.
- **SOURCE_WORKTREE_PATH**: the filesystem path of the worktree with SOURCE_BRANCH checked out
- **BASE_BRANCH**: the target branch. Check if `main` or `master` exists locally. Prefer whichever exists. If both, prefer `main`.

## Step 2: Validate

- SOURCE_BRANCH exists (`git branch --list <SOURCE_BRANCH>`)
- BASE_BRANCH exists (`git branch --list <BASE_BRANCH>`)
- SOURCE_BRANCH ≠ BASE_BRANCH

Show what would be rebased:

```bash
git log <BASE_BRANCH>..<SOURCE_BRANCH> --oneline
```

## Step 3: Simulate the rebase

Switch to the source worktree:

```bash
cd <SOURCE_WORKTREE_PATH> && git checkout <SOURCE_BRANCH>
```

Run the dry-run rebase. We use `git rebase` and abort if conflicts occur, or reset if it succeeds:

```bash
git rebase <BASE_BRANCH>
```

## Step 4: Report results

### If the rebase applies cleanly:

Report: _"✅ Rebase of `<SOURCE_BRANCH>` onto `<BASE_BRANCH>` would apply cleanly. No conflicts expected."_

Show the new commit order:

```bash
git log --oneline -<N>
```

Then abort back to the original state:

```bash
git rebase --abort
# If rebase completed successfully, reset back:
# git reset --hard ORIG_HEAD
```

Actually, if rebase already completed, use:

```bash
git reset --hard ORIG_HEAD
```

### If conflicts are detected:

List them:

```bash
git diff --name-only --diff-filter=U
```

For each conflicted file, show the conflict markers:

```bash
grep -n '<<<<<<<\|=======\|>>>>>>>' <file>
```

Report: _"⚠️ Conflicts would occur in `<N>` file(s): [list]. These will need to be resolved if you proceed with the rebase."_

## Step 5: Abort and clean up

If rebase is in progress (conflicts occurred):

```bash
git rebase --abort
```

If rebase completed successfully, reset back to original:

```bash
git reset --hard ORIG_HEAD
```

Confirm clean state:

```bash
git status --short  # should be empty
git branch --show-current  # should be SOURCE_BRANCH
```

## Step 6: Recommend next steps

Based on the result:

- **No conflicts**: _"Safe to proceed. Run `merge-worktree-rebase` to rebase and fast-forward merge."_
- **Conflicts found**: _"Conflicts expected. You can: (a) run `merge-worktree-rebase` and let the agent auto-resolve, (b) resolve them yourself, or (c) use `merge-worktree` (merge strategy) which may produce different conflicts."_
- **Many commits**: _"There are `<N>` commits to rebase. If conflicts occur, you may need to resolve them multiple times (once per commit). Consider `merge-worktree` for a single conflict resolution."_
