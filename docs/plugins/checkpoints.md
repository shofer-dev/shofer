# Checkpoints

Checkpoints — per-task undo history over a shadow git repository — are **not part of
Shofer core**. They are a first-party plugin, bundled with the extension and enabled by
default:

- **Design + rationale:** [`plugins/checkpoints/DESIGN.md`](../../plugins/checkpoints/DESIGN.md)
- **Usage, settings, packaging:** [`plugins/checkpoints/README.md`](../../plugins/checkpoints/README.md)
- **Known gaps:** [`plugins/checkpoints/TODO.md`](../../plugins/checkpoints/TODO.md)

## What core provides instead

Core knows nothing about shadow git, commits, or restore. It provides the generic
plugin seams the feature is built from, all documented in
[`plugin_system.md`](../plugin_system.md):

| Seam                                                    | What checkpoints uses it for                                           |
| ------------------------------------------------------- | ---------------------------------------------------------------------- |
| `lifecycle.beforeToolCall` (+ manifest `hookTimeoutMs`) | Snapshot before a file-mutating tool, awaited so it precedes the write |
| `lifecycle.onUserMessage`                               | An anchor per user message                                             |
| `ctx.task.marker` / `listMarkers`                       | The timeline row that IS a checkpoint, and its ordering                |
| `ctx.task.rewind`                                       | The conversation half of a restore                                     |
| `lifecycle.onTimelineRewind`                            | Roll the workspace back when a message delete/edit asks for it         |
| `lifecycle.onTaskDeleted`                               | Drop the task's shadow repository                                      |
| `ShoferPlugin.handleRequest` + `PluginUIApi.request`    | Diff/restore driven from the row's UI, including for a remote executor |
| `ctx.host.editor.showMultiFileDiff`                     | Render a computed diff                                                 |

Every one of those is feature-agnostic: another plugin could implement a different undo
model on the same seams, and disabling the checkpoints plugin removes the feature
without leaving anything behind in core.

## Related

- [`plugins/file-changes.md`](./file-changes.md) — the File Changes Panel, a
  separate per-file diff/revert system with no git dependency.
- [`worktrees.md`](./worktrees.md) — how a per-task worktree scopes its snapshots.
- [`submodule-support.md`](../submodule-support.md) — the nested-repository investigation
  behind the plugin's `GIT_DIR` isolation.
