---
"shofer": minor
"@shofer/types": minor
---

Move embedded worktrees from `.shofer/worktrees/` to `<workspace>/.worktrees/`.

`.shofer/` holds committed configuration (modes, rules, commands, `mcp.json`) and is
write-protected wholesale, which meant a task running at the workspace root treated every
other worktree's files as protected. Worktrees now sit in their own top-level directory —
still inside the opened workspace folder, so parallel agents, in-window task switching and
merge-back are unchanged.

Worktrees you already have keep working: the old location is still recognised, so their
path confinement and Linux shell sandbox stay in force, and they remain listed and
deletable. New worktrees are created at the new path. The old location will stop being
recognised in a later release.

Also fixes a path-confinement hole: a symlink planted inside a worktree could point outside
it and pass validation, because paths were resolved lexically. They are now resolved through
symlinks.
