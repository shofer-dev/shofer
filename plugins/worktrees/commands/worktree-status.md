---
description: Detailed status report for current worktree branch
---

<task>
You are producing a detailed status report for the current worktree branch. The user may specify a branch name; if not provided, use the current branch.
</task>

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
- **BASE_BRANCH**: check if main or master exists locally. Prefer whichever exists. If both, prefer main.
- **BASE_WORKTREE_PATH**: the filesystem path of the worktree with BASE_BRANCH checked out (only needed for the merge-readiness fallback)
- **ALL_WORKTREES**: all worktrees listed

If CURRENT_BRANCH is the base branch, skip ahead/behind and focus on files changed and last-commit info.

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
# Uncommitted changes (count the lines of output yourself — each line is one
# changed tracked file; avoids piping to wc, which doesn't exist on Windows)
git status --short
```

## Step 3: Check merge readiness

If CURRENT_BRANCH is the base branch, skip this step (a branch cannot conflict with itself).

Probe whether CURRENT_BRANCH would merge cleanly into BASE_BRANCH using a
read-only merge — this touches no working tree and avoids the "merge a branch
into itself" trap of running a plain `git merge` while standing on CURRENT_BRANCH
(which always reports clean):

```bash
git merge-tree --write-tree <BASE_BRANCH> <CURRENT_BRANCH>
```

A zero exit code means the merge is clean. A non-zero exit code means conflicts —
the output lists the conflicted paths (lines under "CONFLICT"). Nothing to abort,
since no merge was actually started.

(Fallback for git older than 2.38, which lacks `--write-tree`: in BASE_WORKTREE_PATH
run `git checkout <BASE_BRANCH> && git merge --no-commit --no-ff <CURRENT_BRANCH>`,
inspect with `git diff --name-only --diff-filter=U`, then `git merge --abort`.)

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
- No conflicts with <BASE_BRANCH> -- safe to merge
  OR
- Conflicts detected in <N> file(s): [list] -- merge will need resolution
```

## Step 5: Recommend next steps

Based on the status:

- **Has unique commits + no conflicts**: "Ready to merge. Run merge-worktree or merge-worktree-cleanup."
- **Has unique commits + conflicts**: "Conflicts expected. Run dryrun-rebase-worktree to preview, then merge-worktree when ready."
- **No unique commits**: "This branch has no unique commits relative to <BASE_BRANCH>. You can safely delete it with merge-worktree-cleanup (no merge needed)."
- **Has uncommitted changes**: "You have <N> uncommitted changes. Commit or stash them before merging."
- **Behind base**: "This branch is <N> commits behind <BASE_BRANCH>. Consider rebasing first: rebase-worktree."
- **Current branch is base branch**: "You are on <BASE_BRANCH>. All other worktrees:" (then list each with its ahead/behind count)
