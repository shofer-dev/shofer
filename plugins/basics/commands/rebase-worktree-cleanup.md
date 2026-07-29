---
description: Rebase worktree branch onto base, fast-forward merge, then delete branch + worktree
---

<task>
You are rebasing a worktree branch onto the base branch and cleaning up both the branch and the worktree directory. The user may specify the branch name; if not provided, infer it from the current branch (typically worktree/shofer-<suffix>).
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

- **SOURCE_BRANCH**: the worktree branch to rebase and then delete. If the user specified one, use it. Otherwise, use the current branch if it starts with worktree/. If neither is clear, ask the user.
- **SOURCE_WORKTREE_PATH**: the filesystem path of the worktree with SOURCE_BRANCH checked out
- **BASE_BRANCH**: the target branch. Check if main or master exists locally. Prefer whichever exists. If both, prefer main.
- **BASE_WORKTREE_PATH**: the filesystem path of the worktree with BASE_BRANCH checked out

## Step 2: Validate

- SOURCE_BRANCH exists (git branch --list <SOURCE_BRANCH>)
- BASE_BRANCH exists (git branch --list <BASE_BRANCH>)
- SOURCE_BRANCH != BASE_BRANCH (never delete the base branch)
- You are NOT currently in SOURCE_WORKTREE_PATH (you cannot delete the worktree you're standing in)

Commits unique to SOURCE_BRANCH:

```bash
git log <BASE_BRANCH>..<SOURCE_BRANCH> --oneline
```

If empty, the branch has no unique commits. Report: "<SOURCE_BRANCH> has no unique commits relative to <BASE_BRANCH>. There is nothing to rebase." Then ask: "Do you still want to clean up (delete the branch and worktree)?" If yes, skip to Step 6.

Update the base branch in its own worktree (ask first) so the rebase targets
an up-to-date base. Do NOT `git pull` while on SOURCE_BRANCH — that would
merge base INTO the source branch and defeat the rebase:

```bash
cd <BASE_WORKTREE_PATH> && git checkout <BASE_BRANCH> && git pull origin <BASE_BRANCH>
```

## Step 3: Rebase the source branch onto base

Switch to SOURCE_WORKTREE_PATH, on SOURCE_BRANCH:

```bash
cd <SOURCE_WORKTREE_PATH> && git checkout <SOURCE_BRANCH>
```

Run the rebase:

```bash
git rebase <BASE_BRANCH>
```

### Handling conflicts during rebase

1. git diff --name-only --diff-filter=U -- list conflicted files
2. For each conflicted file, use git blame and git log to understand intent. Use git log <BASE_BRANCH>..<SOURCE_BRANCH> -- <file> to see what the source branch changed.
3. Resolve intelligently: keep both changes when independent, prefer more recent when overlapping, prioritize bugfixes over refactors
4. After resolving: git add <file> then git rebase --continue
5. **BAIL-OUT**: If unsure about ANY file, stop. Run git rebase --abort. Tell the user: "Unsure how to resolve conflicts in [files]. Aborted the rebase. Please resolve manually or use a merge strategy instead." Do NOT continue to cleanup.

## Step 4: Fast-forward the base branch

```bash
cd <BASE_WORKTREE_PATH> && git checkout <BASE_BRANCH> && git merge <SOURCE_BRANCH> --ff-only
```

## Step 5: Report rebase result

Show the new commits now on BASE_BRANCH: git log --oneline -<N>

## Step 6: Remove the worktree

Remove the worktree directory first -- you cannot delete a branch while its worktree is still registered:

```bash
git worktree remove <SOURCE_WORKTREE_PATH>
```

If the worktree has uncommitted changes, remove will fail. Use --force only after confirming with the user.

## Step 7: Delete the branch

```bash
git branch -d <SOURCE_BRANCH>
```

If the branch has unmerged changes, -d will fail. Use -D only after confirming with the user.

## Step 8: Verify cleanup

```bash
git worktree list
```

```bash
git branch --list "<SOURCE_BRANCH>"  # should return nothing
```

## Step 9: Report

Summarize:

- Rebased: <SOURCE_BRANCH> onto <BASE_BRANCH>
- Fast-forwarded: <BASE_BRANCH>
- Branch deleted: <SOURCE_BRANCH>
- Worktree removed: <SOURCE_WORKTREE_PATH>

Remind the user to push: git push origin <BASE_BRANCH>
Since this was a rebase, the remote base branch will require --force-with-lease if it had been previously pushed.

Do NOT push to origin yourself.
