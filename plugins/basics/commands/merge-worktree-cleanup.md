---
description: Merge worktree branch into base, then delete branch + worktree directory
---

<task>
You are merging a worktree branch into the base branch, then cleaning up both the branch and the worktree directory. The user may specify the branch name; if not provided, infer it from the current branch (typically worktree/shofer-<suffix>).
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

- **SOURCE_BRANCH**: the worktree branch to merge and then delete. If the user specified one, use it. Otherwise, use the current branch if it starts with worktree/. If neither is clear, ask the user.
- **SOURCE_WORKTREE_PATH**: the filesystem path of the worktree with SOURCE_BRANCH checked out (from git worktree list)
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

If this is empty, the branch has no unique commits. Report: "<SOURCE_BRANCH> has no unique commits relative to <BASE_BRANCH>. There is nothing to merge." Then ask: "Do you still want to clean up (delete the branch and worktree)?" If yes, skip to Step 5.

## Step 3: Switch to the base worktree

You MUST be in the base worktree before merging:

```bash
cd <BASE_WORKTREE_PATH> && git checkout <BASE_BRANCH>
```

Pull latest (ask first):

```bash
git pull origin <BASE_BRANCH>
```

## Step 4: Merge

```bash
git merge <SOURCE_BRANCH> --no-ff
```

### If conflicts occur:

1. git diff --name-only --diff-filter=U -- list conflicted files
2. For each conflicted file, use git blame and git log to understand the intent behind both sides
3. Make intelligent decisions: keep both changes when independent, prefer more recent when overlapping, prioritize bugfixes over refactors
4. **BAIL-OUT**: If unsure about ANY file -- if both sides contain substantial, conflicting logic changes -- do NOT guess. Run git merge --abort. Tell the user: "Unsure how to resolve conflicts in [files]. Aborted the merge. You will need to resolve these manually." Stop here. Do NOT continue to cleanup.
5. After resolving: git add . && git commit -m "merge: resolve conflicts merging <SOURCE_BRANCH> into <BASE_BRANCH>"

### If merge succeeds:

Show the merge commit: git log -1 --oneline

## Step 5: Remove the worktree

Remove the worktree directory from git's worktree list first -- you cannot delete a branch while its worktree is still registered:

```bash
git worktree remove <SOURCE_WORKTREE_PATH>
```

If the worktree has uncommitted changes, remove will fail. Use --force only after confirming with the user.

## Step 6: Delete the branch

After the worktree is removed, delete the source branch:

```bash
git branch -d <SOURCE_BRANCH>
```

If the branch has unmerged changes, -d will fail. Use -D only after confirming with the user.

Note: If git worktree remove --force was used in Step 5, the branch may already be deleted automatically. git branch -d will report "branch not found" in that case -- this is expected.

## Step 7: Verify cleanup

Confirm everything is clean:

```bash
git worktree list
```

```bash
git branch --list "<SOURCE_BRANCH>"  # should return nothing
```

## Step 8: Report

Summarize:

- Merged: <SOURCE_BRANCH> -> <BASE_BRANCH>
- Merge commit: <hash>
- Branch deleted: <SOURCE_BRANCH>
- Worktree removed: <SOURCE_WORKTREE_PATH>

Remind the user to push: git push origin <BASE_BRANCH>

Do NOT push to origin yourself.
