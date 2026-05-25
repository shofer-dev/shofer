# Git Worktrees

Shofer supports **git worktrees** natively — run parallel tasks on different branches without opening multiple VS Code windows.

## How It Works

- Worktrees live at `.shofer/worktrees/<name>/` inside your workspace
- Each worktree is a full checkout on its own branch
- Switch between worktrees via the **Worktree Selector** in the Task Header
- Create, delete, and manage worktrees directly from Shofer's UI

## Why Worktrees?

| Without Worktrees                  | With Shofer Worktrees                    |
| ---------------------------------- | ---------------------------------------- |
| One branch at a time               | Multiple branches active simultaneously  |
| Stash or commit to switch contexts | Switch instantly — no dirty-working-tree |
| Multiple VS Code windows for PRs   | One window, all branches                 |
| Manual `git worktree` CLI commands | UI-driven create, switch, delete         |

## Worktree + Tasks

Each task in Shofer can be scoped to a specific worktree. This means:

- Run a **Code** task on your `feature/new-api` worktree
- Simultaneously run an **Ask** task on `main` to research something
- Orchestrator can fan out subtasks across worktrees in parallel

The **Worktree Indicator** in the Task Header shows which worktree the current task is using.

## Getting Started

1. Click the **Worktree Selector** in the Task Header
2. Choose an existing worktree or create a new one
3. Start a task — it will use the selected worktree's branch

[Read the full worktree documentation](https://github.com/shofer-dev/shofer/blob/master/docs/worktrees.md)
