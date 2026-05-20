# File Changes Panel — Reviewing Shofer's Edits

Whenever Shofer modifies your workspace files — applying a diff, writing a
new file, deleting or renaming something — those changes are tracked per-task
and displayed in the **File Changes Panel.** The panel sits above the chat
input and gives you a single place to review, revert, redo, or accept every
edit Shofer made during the current task.

<!-- XXX: Screenshot showing the FileChangesPanel in its expanded state above
the ChatTextArea, with 2–3 entries visible — one "modified", one "added", one
"deleted". Each entry should show the file path, the +/- line counts, and
the Accept / Revert / Redo buttons. Caption: "The File Changes Panel showing
three files Shofer edited during a task." -->

---

## What You See

Each row in the panel corresponds to a file Shofer touched at least once
during the current task. For every file you'll see:

| Element             | Meaning                                                                |
| ------------------- | ---------------------------------------------------------------------- |
| **File path**       | Workspace-relative path (e.g. `src/utils/helpers.ts`).                 |
| **+/− line counts** | Net insertions and deletions compared to the task's start.             |
| **State label**     | `modified`, `added`, `deleted`, or `reverted`.                         |
| **Accept button**   | Promote the current disk state as the new accepted baseline.           |
| **Revert button**   | Restore the file to its pre-Shofer content.                            |
| **Redo button**     | Re-apply the last Shofer-produced state (visible only after a revert). |

<!-- XXX: Close-up screenshot of a single panel entry with callout arrows /
labels pointing to each element described above. Caption: "Anatomy of a
single file-change entry." -->

Files you modified yourself (without Shofer's involvement) **do not** appear
in the panel — the panel is scoped exclusively to files Shofer edited during
the current task.

---

## Core Actions

### Viewing a Diff (Click-to-Diff)

Click **any row** to open a VS Code diff editor comparing the **original**
content (before Shofer edited it) against the **current on-disk** content.
This shows you Shofer's cumulative effect on the file, not incremental
patches.

<!-- XXX: Screenshot of the VS Code diff editor opened by clicking a row,
showing original on the left (read-only, "shofer-original" label) and current
on the right. Caption: "Click-to-diff showing the original vs. current state
of a file Shofer edited." -->

The diff button is dimmed only when the original content isn't available
(a rare edge case when the file was captured after the first edit).

### Accepting Changes

Click **Accept** on a single file or **Accept All** in the panel header.
This copies the current on-disk content into Shofer's internal baseline,
so the file disappears from the panel. Accept is **persistent** — closing
the task or restarting Shofer won't bring the file back.

> **When to accept:** You've reviewed the diff, you're happy with the result,
> and you want to "lock in" the change and clean up the panel.

### Reverting Changes

Click **Revert** on a single file or **Revert All** in the panel header
(requires a confirmation click). Revert restores the file to its original
state as it existed **before Shofer first edited it** in this task.

> **When to revert:** Shofer made a change you don't want. The file goes
> back to exactly how it was.

**What happens after a revert:**

- The entry stays in the panel, but its state changes to `reverted`.
- A **Redo** button appears — click it to re-apply the last Shofer-produced
  version (useful if you reverted by accident or want to A/B compare).
- The file's edit count drops to +0/−0 but the entry is preserved so Redo
  is always reachable.

<!-- XXX: Screenshot showing a reverted entry with the Redo button visible.
The entry should have 0 insertions / 0 deletions and state "reverted".
Caption: "A reverted file showing the Redo button." -->

### User-Edits Warning

If you edited a file yourself **after** Shofer touched it, clicking Revert
shows a warning modal:

> _"This file has changes you made after Shofer last touched it. Reverting
> will discard those edits. Continue?"_

This prevents you from accidentally losing your own work.

<!-- XXX: Screenshot of the revert-confirmation modal showing the
user-edits warning. Caption: "The user-edits warning shown when reverting
a file you modified after Shofer." -->

---

## Accept All & Revert All

Two header buttons next to the file count let you operate on every tracked
file at once.

| Button         | Effect                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Accept All** | Accepts every file simultaneously — all entries vanish from the panel.                                                                      |
| **Revert All** | Shows a confirmation modal, then reverts every file back to task-start state. All entries shift to `reverted` with Redo available per-file. |

> **Pro tip:** Revert All is a quick way to undo an entire task's filesystem
> changes without deleting the conversation. The chat history is preserved —
> only the files on disk are rolled back.

---

## When the Panel Won't Show a File

Some edits don't produce panel entries:

- **Zero net change:** Shofer added a line, then deleted it — or created a
  file, then removed it. If the final state matches the original, there's no
  diff to show.
- **Directory-only operations:** `create_directory` and `create_new_workspace`
  don't modify file contents, so they aren't tracked.
- **Arbitrary shell commands:** `execute_command` runs CLI tools directly;
  Shofer can't know which files were modified.

---

## Active-Task Guard

The Revert and Redo buttons are blocked while Shofer is **actively
streaming** (the task is generating a response or executing tools).
You'll see a toast: _"Cannot modify files while Shofer is running.
Pause or cancel the task first."_

Stop the task first, then revert or accept — this ensures the panel always
shows a consistent snapshot.

---

## Multi-Task Editing

If you run multiple tasks in parallel and both edit the same file:

- Each task tracks its own `before` snapshot independently.
- Task A's **Revert** restores to _before-Task-A_ started (which may include
  Task B's edits if Task B ran first).
- Task B's **Revert** restores to _before-both-tasks_ (the true original).

The panel always shows changes for the **currently focused foreground task**
only. Switch tasks via the TaskSelector to see a different task's file
changes.

---

## Quick Reference

| Goal                                  | Action                                         |
| ------------------------------------- | ---------------------------------------------- |
| See what Shofer changed               | Look at the File Changes Panel above the input |
| Inspect a specific diff               | Click the file row                             |
| Keep Shofer's change                  | Click **Accept**                               |
| Undo Shofer's change                  | Click **Revert**                               |
| Re-apply after revert                 | Click **Redo**                                 |
| Undo **all** Shofer changes this task | Click **Revert All** then confirm              |
| Lock in **all** Shofer changes        | Click **Accept All**                           |
| Check another task's changes          | Switch tasks via the TaskSelector              |

---

## What's Not Affected

The File Changes Panel operates independently of git. It uses Shofer's own
per-task working directories — no git repo required, no commits created,
no interaction with your staging area or working tree.
