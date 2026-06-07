---
description: "Show detailed status for a worktree branch: commits ahead/behind, files changed, last commit age, merge readiness"
---

You are producing a detailed status report for the current worktree branch. The user may specify a branch name; if not provided, use the current branch.

## Step 1: Gather basic information

Run these commands in parallel:

```bash
git branch --show-current
```

```bash
git worktree list
```

```bash
git status --short
```

Identify:

- **CURRENT_BRANCH**: the branch to report on
- **CURRENT_WORKTREE_PATH**: the filesystem path of the current worktree
- **BASE_BRANCH**: check if `main` or `master` exists locally. Prefer whichever exists. If both, prefer `main`.
- **ALL_WORKTREES**: all worktrees listed

If CURRENT_BRANCH is the base branch, the status is about the base branch itself. Skip the ahead/behind section and focus on files changed and last-commit info.

## Step 2: Collect status data

Run these in parallel:

```bash
# Commits on this branch that are NOT on base
git log <BASE_BRANCH>..<CURRENT_BRANCH> --oneline
```

```bash
# Commits on base that are NOT on this branch
git log <CURRENT_BRANCH>..<BASE_BRANCH> --oneline
```

```bash
# Files changed (working tree vs HEAD)
git diff --name-status HEAD
```

```bash
# Last commit info
git log -1 --format="%h %s (%ar) by %an"
```

```bash
# Total files changed in this branch vs base
git diff --name-status <BASE_BRANCH>...<CURRENT_BRANCH>
```

```bash
# Uncommitted changes summary
git status --short | wc -l
```

## Step 3: Check merge readiness

Simulate a merge to detect conflicts:

```bash
git merge --no-commit --no-ff <CURRENT_BRANCH>
```

If the merge fails due to conflicts:

```bash
git diff --name-only --diff-filter=U
```

Then: `git merge --abort`

If the merge succeeds cleanly: `git merge --abort`

## Step 4: Present the report

Format the output clearly:

```
## Worktree Status: <CURRENT_BRANCH>

**Path**: <CURRENT_WORKTREE_PATH>
**Base branch**: <BASE_BRANCH>
**Last commit**: <hash> "<subject>" (<relative time>) by <author>

### Ahead/Behind
- Ahead of <BASE_BRANCH>: <N> commits
- Behind <BASE_BRANCH>: <N> commits

### Files Changed (vs base)
- <N> files changed, <N> insertions, <N> deletions
- <list of changed files with status letters>

### Working Tree
- <N> uncommitted changes (tracked files)

### Merge Readiness
- ✅ No conflicts with <BASE_BRANCH> — safe to merge
  OR
- ⚠️ Conflicts detected in <N> file(s): [list] — merge will need resolution
```

## Step 5: Recommend next steps

Based on the status:

- **Has unique commits + no conflicts**: _"Ready to merge. Run `merge-worktree` or `merge-worktree-cleanup`."_
- **Has unique commits + conflicts**: _"Conflicts expected. Run `dryrun-merge-worktree` to preview, then `merge-worktree` when ready."_
- **No unique commits**: _"This branch has no unique commits relative to <BASE_BRANCH>. You can safely delete it with `merge-worktree-cleanup` (no merge needed)."_
- **Has uncommitted changes**: _"You have <N> uncommitted changes. Commit or stash them before merging."_
- **Behind base**: _"This branch is <N> commits behind <BASE_BRANCH>. Consider rebasing first: `merge-worktree-rebase`."_
- **Current branch is base branch**: _"You are on <BASE_BRANCH>. All other worktrees:"_ (then list each with its ahead/behind count)
