# File Changes Panel — Integration Test Scenarios

Feature under test: The FileChangesPanel (collapsible panel above the chat
input), ChangedFilesService (per-task working-directory backend),
FileContextTracker (snapshot capture), and the `changedFiles/*` IPC channel.

## Prerequisites

- Shofer extension running with a task active in Code mode.
- At least one API profile configured and functional.
- The FileChangesPanel is visible above the ChatTextArea.
- `alwaysAllowReadOnly` and `alwaysAllowWrite` enabled in auto-approval
  settings (to let Shofer freely read/write files).

---

## Scenarios

### 1. A modified file appears in the panel with correct line counts

**Goal:** Verify end-to-end tracking: Shofer edits a file → panel entry
appears → line counts are accurate.

1. Start a task in Code mode.
2. Ask Shofer to modify an existing file (e.g. "Add a comment to the top of
   src/utils/helpers.ts").
3. Wait for the tool call to complete.
4. Observe the FileChangesPanel.

**Expected:** The edited file appears with `state: "modified"`, and the
insertion/deletion counts reflect the actual edit (e.g. +1/0 for a single
comment line). The entry should have working Accept and Revert buttons.

---

### 2. A newly created file shows as "added"

**Goal:** Verify `state: "added"` for files Shofer creates from scratch.

1. Start a task in Code mode.
2. Ask Shofer: "Write a file called test-panel.tmp with the content 'hello'."
3. Wait for the write to complete.

**Expected:** The file appears with `state: "added"` and +1/0 (or however
many lines were written). Diff should show the file as all-additions.

---

### 3. A deleted file shows as "deleted"

**Goal:** Verify `state: "deleted"` for files Shofer removes via the `file`
tool.

1. Create a temporary file on disk (e.g. `touch test-delete.tmp`).
2. Start a task and ask Shofer: "Delete test-delete.tmp using the file tool."
3. Wait for the deletion to complete.

**Expected:** The deleted file appears with `state: "deleted"` and negative
deletion count matching the file's original line count.

---

### 4. Click-to-diff opens a VS Code diff editor

**Goal:** Verify clicking a panel row opens the `shofer-original:` vs.
current-on-disk diff.

1. Have at least one entry in the FileChangesPanel.
2. Click the file row.

**Expected:** A VS Code diff editor opens in the main area. The left side
is read-only (labeled "shofer-original") showing the file before Shofer
edited it. The right side is the current workspace file. The diff is
accurate.

---

### 5. Accept removes the file from the panel

**Goal:** Verify Accept promotes current disk content as new baseline.

1. Have at least one entry in the FileChangesPanel.
2. Note the file path and state.
3. Click **Accept** on that entry.

**Expected:** The entry disappears from the panel. Switching tasks and back
does not bring it back (the baseline is persisted).

---

### 6. Accept All clears the entire panel

**Goal:** Verify Accept All operates on all candidates at once.

1. Have at least two entries in the FileChangesPanel.
2. Click **Accept All** in the panel header.

**Expected:** All entries disappear. The panel shows zero files.

---

### 7. Revert restores original content

**Goal:** Verify Revert writes the captured original back to disk.

1. Ask Shofer to edit a known file with a visible change (e.g. change a
   specific string).
2. Confirm the entry appears in the panel.
3. Click **Revert**.

**Expected:** The file on disk reverts to its original content (verify by
reading the file or checking the diff). The panel entry stays but shows
`state: "reverted"` and a **Redo** button appears.

---

### 8. Redo re-applies Shofer's last state

**Goal:** Verify Redo restores the final snapshot after a revert.

1. Complete a revert (scenario 7).
2. Click **Redo** on the reverted entry.

**Expected:** The file on disk is restored to Shofer's last-produced state.
The panel entry returns to `state: "modified"` (or appropriate state) and
the Redo button disappears.

---

### 9. Revert All operates on every candidate

**Goal:** Verify Revert All with confirmation modal.

1. Have at least two entries in the panel.
2. Click **Revert All**.
3. Confirm the modal appears with the expected warning text.
4. Click **Revert** in the modal.

**Expected:** All files are reverted to their original state. Every entry
shows `state: "reverted"` with Redo buttons available.

---

### 10. User-edit warning on revert after manual modification

**Goal:** Verify the warning modal when the user edited a file after Shofer.

1. Ask Shofer to edit a file.
2. After the edit completes, manually modify the same file in the editor
   (add a line).
3. Click **Revert** on that entry.

**Expected:** A warning modal appears: "This file has changes you made after
Shofer last touched it. Reverting will discard those edits. Continue?" with
a **Revert** confirmation button. The revert should only proceed if the user
confirms.

---

### 11. Active-task guard blocks revert/redo during streaming

**Goal:** Verify the toast when trying to revert while Shofer is running.

1. Start a task that will take a moment (e.g. "Search for TODO in every
   TypeScript file").
2. While the task is streaming or executing tools, try clicking Revert on
   a file entry.

**Expected:** A yellow warning toast: "Cannot modify files while Shofer is
running. Pause or cancel the task first." The revert does not execute.

---

### 12. Zero-net-change files are dropped

**Goal:** Verify that a file Shofer created then deleted (or added lines
then removed them) does not appear in the panel.

1. Start a task and ask Shofer: "Create a file called zero-test.tmp with
   'hello', then immediately delete it."

**Expected:** After both operations complete, `zero-test.tmp` does NOT appear
in the FileChangesPanel (net change is zero).

---

### 13. Panel updates on task switch

**Goal:** Verify that switching tasks via TaskSelector shows the correct
task's file changes.

1. Create two tasks (A and B) that each edit different files.
2. Focus Task A and note its panel entries.
3. Switch to Task B via the TaskSelector.

**Expected:** The panel updates to show only Task B's file changes. Switch
back to Task A and the panel shows only Task A's changes.

---

### 14. Panel updates after task deletion

**Goal:** Verify that deleting a task removes its per-task directory.

1. Note the file changes for the current task.
2. Delete the task via HistoryView.
3. Confirm the task directory at `<globalStorage>/tasks/<taskId>/` no
   longer exists on disk.

**Expected:** The task directory is fully removed — `base/`, `final/`,
`originals/`, and `finals/` are all gone.

---

### 15. Multi-task same-file editing isolation

**Goal:** Verify that two parallel tasks editing the same file track
independent baselines.

1. Create a file `shared.txt` with content "line1".
2. Start Task A (background) that appends "A" to shared.txt.
3. Start Task B (background) that appends "B" to shared.txt.
4. Wait for both to complete.
5. Focus Task A and check its panel.
6. Focus Task B and check its panel.

**Expected:** Each task's panel shows only its own edit. Task A's revert
restores to "line1" (pre-A). Task B's revert restores to "line1A" (Task A's
output, since B captured its original after A ran).

---

### 16. `get_changed_files` tool returns correct data

**Goal:** Verify the native tool reports accurate changed-file information.

1. Ask Shofer to edit a file, then call `get_changed_files`.
2. Observe the tool result in chat.

**Expected:** The tool returns a list containing the edited file with
correct path, state, insertion/deletion counts, and `hasOriginalContent` /
`hasFinalContent` booleans.
