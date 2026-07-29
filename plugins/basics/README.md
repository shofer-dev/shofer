# Basics

Shofer's per-task workspace basics — **checkpoints**, **file changes** and
**worktrees** — as one first-party plugin, bundled with the extension and enabled by
default. Each feature can be switched off on its own; the plugin toggle in
Settings → Plugins switches off all three.

| Feature          | What it gives you                                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Checkpoints**  | Per-task undo history. The workspace is snapshotted into a shadow git repository before every file-mutating turn; diff or restore from the timeline.    |
| **File Changes** | A copy of every file the agent edits — before and after — listed above the chat input with per-file diff, revert and accept. No git repository needed.  |
| **Worktrees**    | A git worktree per task under `.worktrees/`, the branch picker in the chat input, worktree management in Settings, and the merge/rebase slash commands. |

## Checkpoints

Before the agent touches a file, the workspace is snapshotted into a **shadow git
repository** that lives outside it. Each snapshot appears as a row in the chat
timeline, from which you can diff the changes or restore the workspace — and, if you
want, rewind the conversation with it. Your own git repository is never touched.

- **Snapshot before every file-mutating turn.** One checkpoint per turn, taken _before_
  the first edit, so what it captures is the state you would want back.
- **Anchor every user message.** A hidden checkpoint per message, so "undo back to what
  I asked for" always has a point to undo to.
- **Diff.** From a checkpoint to the next one, to the current workspace, or from the
  first checkpoint — rendered in the editor's multi-file diff view.
- **Restore.** _Restore Files_ puts the workspace back; _Restore Files & Task_ also
  deletes the messages after that point and restarts the task against the shortened
  conversation.
- **Clean up.** Deleting a task deletes its shadow repository.

Requires `git` on the PATH. Without it (or without a workspace folder) the feature
gives up on that task with a warning and Shofer keeps working — checkpoints are
best-effort.

## File Changes

Every time the agent is about to touch a file, the plugin keeps a copy of it as it was;
after the write, it keeps a copy of what the agent produced. The panel above the chat
input lists the difference — one row per file, with its net `+`/`−` — and lets you open
a diff, revert a file, or accept it. Because both sides of every diff are copies **this
task** owns, the list is immune to what anything else does to the same files: a second
task, a formatter on save, or your own editing. It needs no git repository.

- **Diff.** Click a row to open the baseline against what the agent produced.
- **Revert.** Put one file — or all of them — back to the baseline. If the file changed
  after the agent's last write you are asked first. Refused while the task is running.
- **Accept.** Take the file's current state as the new baseline; the row leaves the
  panel.
- **Report.** The `get_changed_files` tool gives the agent the same list, and the
  task's `+`/`−` badge in the history comes from the same numbers.

The copies live under `<plugin storage>/file-changes/tasks/<taskId>/` and persist for
as long as the task exists in history — that is what makes diff and revert keep working
on a task you come back to days later.

## Worktrees

A git worktree is a second checkout of the same repository on another branch. The
plugin puts them **inside** the workspace — `<workspace>/.worktrees/<name>/` — and
gives every task its own, so two agents working at once never edit the same files.

**Just send a message.** The task gets `shofer-<random>` — a branch, a directory and a
label sharing one name — branched from your current HEAD. Work happens there; your
checkout is untouched.

**Pick where it runs.** Click the branch chip before sending: choose an existing
worktree, or the workspace itself ("current branch") to opt out of isolation for that
task. "Create new worktree…" opens a new, empty task already running in the new
checkout.

**Finish up.** In the task that did the work:

| Command                    | What it does                                                |
| -------------------------- | ----------------------------------------------------------- |
| `/merge-worktree`          | Merge the branch into base with a merge commit              |
| `/merge-worktree-cleanup`  | …then delete the branch and remove the worktree             |
| `/rebase-worktree`         | Rebase onto base and fast-forward merge                     |
| `/rebase-worktree-cleanup` | …then delete the branch and remove the worktree             |
| `/dryrun-rebase-worktree`  | Show the conflicts a rebase would produce, changing nothing |
| `/worktree-status`         | Ahead/behind, uncommitted changes, merge readiness          |

All of them auto-detect the base branch (`main`, else `master`), attempt conflict
auto-resolution but **bail out on anything ambiguous** rather than guess, and **never
push**. Because this plugin is bundled and first-party, the commands keep their bare
names (`/merge-worktree`, not `/basics:merge-worktree`), and a
`.shofer/commands/merge-worktree.md` in your project still overrides them.

A fresh worktree contains only what the branch tracks — no `node_modules`, no `.env`.
List those paths in `.shofer/worktreeinclude` (one per line, `.gitignore` syntax) and
they are copied into every new worktree; only paths **also** matched by `.gitignore`
are copied, because copying a tracked file would produce a merge conflict later.

Worktrees need a single-root workspace opened at the git repository root (or at one of
the plugin's own embedded worktrees); anything else disables the feature and says why.

## Settings

Settings → Plugins → Basics:

| Setting                        | Default   | What it does                                                                                                                          |
| ------------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `checkpoints`                  | `true`    | The checkpoints feature.                                                                                                              |
| `file-changes`                 | `true`    | The file-changes feature (panel + `get_changed_files`).                                                                               |
| `worktrees`                    | `true`    | The worktrees feature (placement, chip, Settings panel, commands).                                                                    |
| `checkpointInitTimeoutSeconds` | 15        | How long a task's shadow repo may take to initialize before checkpoints are given up on for that task.                                |
| `checkpointExcludePatterns`    | _(empty)_ | Extra newline-separated `.gitignore`-style patterns, on top of the built-in build-artifact / media / cache / database / LFS excludes. |

A deployment can also suppress one feature via governance:
`SHOFER_DISABLED_PLUGINS=basics:worktrees,basics:checkpoints` turns those features off
while the rest of the plugin keeps running (see [DESIGN.md](DESIGN.md)).

## Removing it

Disable the plugin in Settings → Plugins, or delete `plugins/basics/` (bundled) /
`~/.shofer/plugins/basics/` (installed). Nothing in Shofer's core knows it exists;
removing it removes the three features, and nothing else changes — tasks simply run in
the workspace with no undo history and no change panel.

## Distribution

```bash
shofer plugin pack plugins/basics        # → basics-0.1.0.shofer-plugin
shofer plugin install basics-0.1.0.shofer-plugin --enable
```

The archive ships the built UI bundles and the vendored dependencies
(`src/vendor/*.mjs`), so it installs with no build step and no `npm install`.

## Development

```bash
node plugins/basics/build-ui.mjs                                 # UI bundles + vendored deps
npx tsgo -p plugins/basics                                       # typecheck
cd packages/core && npx vitest run --config vitest.plugins.config.ts basics
```

`build-ui.mjs` also runs automatically as part of the extension bundle. The composition
design is in [DESIGN.md](DESIGN.md), each feature's own design under
[`docs/`](docs/), and known gaps in [TODO.md](TODO.md).
