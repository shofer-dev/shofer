---
description: "Rebase a worktree branch onto the base branch (main/master)"
---

You are rebasing a worktree branch onto the base branch, producing a linear history without a merge commit. The user may specify the branch name; if not provided, infer it from the current branch (typically `worktree/shofer-<suffix>`).

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

- **SOURCE_BRANCH**: the worktree branch to rebase. If the user specified one, use it. Otherwise, use the current branch if it starts with `worktree/`. If neither is clear, ask the user.
- **SOURCE_WORKTREE_PATH**: the filesystem path of the worktree with SOURCE_BRANCH checked out (from `git worktree list`)
- **BASE_BRANCH**: the target branch. Check if `main` or `master` exists locally. Prefer whichever exists. If both, prefer `main`.
- **BASE_WORKTREE_PATH**: the filesystem path of the worktree with BASE_BRANCH checked out

## Step 2: Validate

- SOURCE_BRANCH exists (`git branch --list <SOURCE_BRANCH>`)
- BASE_BRANCH exists (`git branch --list <BASE_BRANCH>`)
- SOURCE_BRANCH ≠ BASE_BRANCH

Show commits unique to SOURCE_BRANCH:

```bash
git log <BASE_BRANCH>..<SOURCE_BRANCH> --oneline
```

If empty, the branch has no unique commits. Report this and ask if the user still wants to proceed (a no-op rebase).

Fetch latest base (ask first):

```bash
git pull origin <BASE_BRANCH>
```

## Step 3: Rebase the source branch onto base

You must be in SOURCE_WORKTREE_PATH, on SOURCE_BRANCH:

```bash
cd <SOURCE_WORKTREE_PATH> && git checkout <SOURCE_BRANCH>
```

Run the rebase:

```bash
git rebase <BASE_BRANCH>
```

### Handling conflicts during rebase

If the rebase produces conflicts, resolve them automatically:

1. `git diff --name-only --diff-filter=U` — list conflicted files
2. For each conflicted file, use `git blame` and `git log` to understand the intent behind both sides. Use `git log <BASE_BRANCH>..<SOURCE_BRANCH> -- <file>` to see what the source branch changed.
3. Resolve intelligently:
    - Keep both changes when they are independent (different lines, different concerns)
    - Prefer the more recent change when they overlap on the same logic
    - Prioritize bugfixes over refactors, refactors over cosmetics
4. After resolving: `git add <file>` then `git rebase --continue`
5. **BAIL-OUT**: If you are unsure about the correct resolution for any file, stop. Run `git rebase --abort` to return to pre-rebase state. Tell the user: _"Unsure how to resolve conflicts in [files]. Aborted the rebase. Please resolve manually or use a merge strategy instead."_

## Step 4: Fast-forward the base branch

After a clean rebase, SOURCE_BRANCH is now ahead of BASE_BRANCH with a linear history. Fast-forward the base branch:

```bash
cd <BASE_WORKTREE_PATH> && git checkout <BASE_BRANCH> && git merge <SOURCE_BRANCH> --ff-only
```

## Step 5: Report

Summarize:

- Rebased: `<SOURCE_BRANCH>` onto `<BASE_BRANCH>`
- Fast-forwarded: `<BASE_BRANCH>` to include rebased commits
- Commits applied: `<count>`

Remind the user:

- The worktree branch `<SOURCE_BRANCH>` still exists (`git branch -d <SOURCE_BRANCH>` to delete it)
- The worktree directory still exists (use **Settings → Worktrees** to delete it)
- Consider pushing the base branch: `git push origin <BASE_BRANCH>`
- ⚠️ Since this was a rebase, the remote base branch will require `--force-with-lease` if it had been previously pushed

Do NOT push to origin. Do NOT delete the branch or worktree.
