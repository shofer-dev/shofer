---
description: Merge worktree branch into base with a merge commit (no cleanup)
---

<task>
You are merging a worktree branch into the base branch using a merge commit (--no-ff). The worktree and branch are left intact after the merge. The user may specify the branch name; if not provided, infer it from the current branch (typically worktree/shofer-<suffix>).
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

- **SOURCE_BRANCH**: the worktree branch to merge. If the user specified one, use it. Otherwise, use the current branch if it starts with worktree/. If neither is clear, ask the user.
- **SOURCE_WORKTREE_PATH**: the filesystem path of the worktree with SOURCE_BRANCH checked out (from git worktree list)
- **BASE_BRANCH**: the target branch. Check if main or master exists locally. Prefer whichever exists. If both, prefer main.
- **BASE_WORKTREE_PATH**: the filesystem path of the worktree with BASE_BRANCH checked out

## Step 2: Validate

- SOURCE_BRANCH exists (git branch --list <SOURCE_BRANCH>)
- BASE_BRANCH exists (git branch --list <BASE_BRANCH>)
- SOURCE_BRANCH != BASE_BRANCH

Commits unique to SOURCE_BRANCH:

```bash
git log <BASE_BRANCH>..<SOURCE_BRANCH> --oneline
```

If this is empty, the branch has no unique commits. Report: "<SOURCE_BRANCH> has no unique commits relative to <BASE_BRANCH>. There is nothing to merge."

## Step 3: Switch to the base worktree

You MUST be in the base worktree before merging. If you are currently in SOURCE_WORKTREE_PATH, switch away:

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
2. For each conflicted file, use git blame and git log to understand the intent behind both sides of the conflict
3. Make intelligent decisions: keep both changes when they are independent (bugfix + feature), prefer the more recent change when they overlap, prioritize bugfixes over refactors
4. **BAIL-OUT**: If you are unsure about the correct resolution for ANY file -- if both sides contain substantial, conflicting logic changes, or if the intent is unclear from git history -- do NOT guess. Run git merge --abort to return to pre-merge state. Tell the user: "Unsure how to resolve conflicts in [files]. Aborted the merge. You will need to resolve these manually." Stop here.
5. After resolving all files: git add . && git commit -m "merge: resolve conflicts merging <SOURCE_BRANCH> into <BASE_BRANCH>"

### If merge succeeds:

Show the merge commit: git log -1 --oneline

## Step 5: Report

Summarize:

- Merged: <SOURCE_BRANCH> -> <BASE_BRANCH>
- Merge commit: <hash>
- The worktree branch <SOURCE_BRANCH> and its directory still exist (use merge-worktree-cleanup to also clean up)

Remind the user to push the base branch if appropriate: git push origin <BASE_BRANCH>

Do NOT push to origin yourself.
