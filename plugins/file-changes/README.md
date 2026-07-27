# File Changes

Per-task file-change tracking for Shofer, as a first-party plugin.

Every time the agent is about to touch a file, the plugin keeps a copy of it as it was;
after the write, it keeps a copy of what the agent produced. The panel above the chat
input lists the difference — one row per file, with its net `+`/`−` — and lets you open
a diff, revert a file, or accept it.

Because both sides of every diff are copies **this task** owns, the list is immune to
what anything else does to the same files: a second task, a formatter on save, or your
own editing. It also needs no git repository, no shadow repo, and no checkpoint history.

## What it does

- **Track.** A baseline per file (captured once, on the task's first edit of it) and the
  latest state the agent produced.
- **List.** Files whose net effect is nothing — created then deleted, edited then edited
  back, or reverted by you — are dropped, so the panel shows work, not activity.
- **Diff.** Click a row to open the baseline against what the agent produced, in the
  editor's diff view.
- **Revert.** Put one file — or all of them — back to the baseline. If the file changed
  after the agent's last write (your edit, a formatter, auto-save) you are asked first.
  Refused while the task is still running: pause or cancel it, or the agent would be
  writing the file you are reverting.
- **Accept.** Take the file's current state as the new baseline. It leaves the panel;
  the agent's further edits to it are tracked from there.
- **Report.** The `get_changed_files` tool gives the agent the same list, and the task's
  `+`/`−` badge in the history comes from the same numbers.
- **Clean up.** Deleting a task deletes its copies.

## Where the copies live

`<plugin storage>/file-changes/tasks/<taskId>/`:

```
base/<relPath>         the file before this task's first edit
final/<relPath>        the file as the agent last left it
originals/<sha1>.json  { kind, hash } for base/
finals/<sha1>.json     { kind, hash } for final/
```

They persist for as long as the task exists in history — that is what makes diff and
revert keep working on a task you come back to days later. There is no pruning or size
cap; see [TODO.md](TODO.md).

## Requirements

None. It works in any workspace, with or without git.

## Settings

Only the plugin toggle, in Settings → Plugins. It is **enabled by default** — it is a
shipped Shofer feature rather than an opt-in add-on. Disabling it stops the tracking,
the panel and the tool; the copies already on disk are left alone and are used again if
you turn it back on.

## Design

See [DESIGN.md](DESIGN.md) for how the pieces fit together and why, and
[`docs/plugins/file-changes.md`](../../docs/plugins/file-changes.md) for the
source-of-truth chain in the wider system.
