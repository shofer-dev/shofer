# Checkpoints

Per-task undo history for Shofer, as a first-party plugin.

Before the agent touches a file, the workspace is snapshotted into a **shadow git
repository** that lives outside it. Each snapshot appears as a row in the chat
timeline, from which you can diff the changes or restore the workspace — and, if you
want, rewind the conversation with it. Your own git repository is never touched, never
committed to, and never has its history rewritten.

## What it does

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

## Requirements

`git` on the PATH. Without it (or without a workspace folder) the plugin gives up on
that task with a warning and Shofer keeps working — checkpoints are best-effort.

## Settings

Settings → Plugins → Checkpoints:

| Setting              | Default   | What it does                                                                                                                          |
| -------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `initTimeoutSeconds` | 15        | How long a task's shadow repo may take to initialize before checkpoints are given up on for that task.                                |
| `excludePatterns`    | _(empty)_ | Extra newline-separated `.gitignore`-style patterns, on top of the built-in build-artifact / media / cache / database / LFS excludes. |

Turning the whole feature off is the plugin toggle in Settings → Plugins. It is
**enabled by default** — it is a shipped Shofer feature rather than an opt-in add-on.

## Removing it

Disable it in Settings → Plugins, or delete `plugins/checkpoints/` (bundled) /
`~/.shofer/plugins/checkpoints/` (installed). Nothing in Shofer's core knows it exists;
removing it removes the feature, and nothing else changes.

## Distribution

The plugin is a single file:

```bash
shofer plugin pack plugins/checkpoints        # → checkpoints-0.1.0.shofer-plugin
shofer plugin install checkpoints-0.1.0.shofer-plugin --enable
```

The archive ships the built `main.js` (with `simple-git` bundled) and `ui/row.js`, so
it installs with no build step and no `npm install`.

## Development

```bash
node plugins/checkpoints/build-ui.mjs                            # build main.js + ui/row.js
npx tsgo -p plugins/checkpoints                                  # typecheck
cd packages/core && npx vitest run --config vitest.plugins.config.ts checkpoints
```

`build-ui.mjs` also runs automatically as part of the extension bundle. The design and
its reasoning are in [DESIGN.md](DESIGN.md); known gaps are in [TODO.md](TODO.md).
