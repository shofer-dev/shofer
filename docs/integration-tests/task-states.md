# Task States — Integration Test Scenarios

Feature under test: Task lifecycle state tracking (`TaskManager`, `TaskState`,
`TaskLifecycle`, `CompletionRating`, `LIFECYCLE_VISUAL`, `RATING_VISUAL`,
persistence round-trips via `HistoryItem.taskState`).

## Prerequisites

- A running Shofer extension instance with the TaskManager and ShoferProvider
  fully initialized.
- At least one API profile configured and functional.
- The TaskSelector sidebar and TaskHeader state dot are visible in the webview.

## Scenarios

### 1. New task starts in `running` state

1. Open Shofer and type a simple prompt (e.g., "Say hello").
2. Observe the TaskHeader dot: it should show a **spinning green/blue dot**
   (depending on UI mode).
3. Open the TaskSelector sidebar — the current task row should show the
   `codicon-sync` icon (spinning).
4. Wait for the task to finish.

**Expected**: The task transitions `idle` → `running` on first API call, then
`running` → `completed` (with rating) on `attempt_completion`.

### 2. User stops a running task → `paused`

1. Start a long-running task (e.g., a multi-step code generation with
   `new_task` delegation).
2. While it is running, click **Stop** in the chat input bar.
3. Observe: the state icon changes to `paused` (pause icon, orange).
4. Open the TaskSelector — the task shows the pause icon.
5. Send another message to the same task.

**Expected**: `running` → `paused` on user abort. Sending a new message
transitions back to `running`.

### 3. Task needs user approval → `waiting_input`

1. Start a task that will trigger a tool-approval prompt (e.g., "Write a new
   file `test.txt` in my workspace" — requires write approval if auto-approve
   is off for the `write` group).
2. When the approval prompt appears in chat, observe the TaskHeader dot: it
   should show a **yellow question mark**.
3. Open the TaskSelector — the task row should show `codicon-question`.
4. Approve or reject the tool call.

**Expected**: `running` → `waiting_input` when `TaskInteractive` fires,
`waiting_input` → `running` when `TaskActive` fires after approval.

### 4. Parent waits for child subtask → `waiting`

1. Start a task that spawns a background child with `is_background=true` and
   then calls `wait_for_task`.
2. Observe: parent transitions to `waiting` (watch icon, blue) while child runs.
3. Open the TaskSelector — the parent row shows `codicon-watch`, the child
   row shows the appropriate state (likely `running`).

**Expected**: Parent transitions `running` → `waiting` during the
`wait_for_task` block, and `waiting` → `running` when the child completes and
the parent resumes.

### 5. Background child asks a question → parent sees pending question

1. Start a task that spawns a background child instructed to call
   `ask_followup_question` with a specific question.
2. Call `check_task_status` on the child — it should surface the pending
   question.
3. Answer via `answer_subtask_question`.
4. Verify the child resumes and completes.

**Expected**: Child enters `waiting_input` (question mark), parent's
`check_task_status` returns the question text. After answering, child resumes.

### 6. Task completes → rating assigned

1. Run a simple task to completion (e.g., "List files in current directory").
2. Observe the final state: the icon should be one of the three completion
   rating icons (hollow circle, filled circle, or pass-filled).
3. Hover over the icon in the TaskSelector — the tooltip should read
   "Completed · Poor", "Completed · Well", or "Completed · Excellent".
4. Switch to another task and back — the rating should persist.

**Expected**: `running` → `completed` with a rating embedded in the state.
The rating icon + label match the `RATING_VISUAL` table.

### 7. Task error → `error` state

1. Cause a task to error (e.g., configure an invalid API key and attempt an
   API call).
2. Observe the state transitions to `error` (red error icon).
3. The error state should persist in the TaskSelector after switching away.

**Expected**: On `TaskError` event, state becomes `error`. The error icon and
color match `LIFECYCLE_VISUAL.error`.

### 8. State survives window reload (persistence)

1. Run tasks into various terminal states: `completed` (with a rating),
   `paused`, `error`.
2. Reload the VS Code window (`Developer: Reload Window`).
3. Open the TaskSelector — all terminal states (`completed`, `error`,
   `paused`) should show their original icons.
4. Any task that was `running`, `waiting_input`, or `waiting` at reload
   time should now show as `idle`.

**Expected**: Terminal states persist via `HistoryItem.taskState`.
Transient states are sanitized to `idle` by `sanitizeRestoredState`.

### 9. State icon updates in real-time across webview

1. Open two tasks: one running, one idle. Switch to the idle one.
2. In the TaskSelector sidebar, observe the running task's icon. It should
   update in real-time as the task transitions through `running` →
   `waiting_input` → `running` → `completed`.
3. No manual refresh needed — state push from `TaskManager` through
   `ExtensionMessage` should drive the UI.

**Expected**: `tasks:updated` event → `parallelTasksUpdated` message → UI
re-render without polling.

### 10. Cost limit pause → `paused` with reason

1. Configure a `CostLimit` on a task with `action: "pause"` and a very low
   `maxUsd`.
2. Run a task that will exceed the budget.
3. Observe the state transitions to `paused`.

**Expected**: Budget-exceeded pause behaves identically to user-initiated
pause in terms of state (`paused`).

### 11. Single-writer invariant

1. During any of the above scenarios, verify no other component writes
   `taskState` directly to `HistoryItem` outside `TaskManager.setState`.
2. This is a white-box invariant: code-review or mutation-test check that
   all `provider.updateTaskHistory({ ..., taskState })` calls go through
   `TaskManager.persistState`.

**Expected**: Only `TaskManager.setState` (via `persistState`) writes
`HistoryItem.taskState`.

### 12. Restore-Ordering guard

1. Write a test (or code-review check) that calls
   `taskManager.registerBackgroundTask(task)` before
   `taskManager.restoreManagedTasks(history)` has been called.
2. Verify it throws an `Error` with message matching
   `"registerBackgroundTask() called before restoreManagedTasks()"`.

**Expected**: `assertRestored()` throws, preventing order-of-initialization
bugs.

### 13. Multiple background children — concurrent state tracking

1. Spawn 3+ background children in parallel.
2. Observe all their states independently in the TaskSelector:
   each should show its own lifecycle independently.
3. Complete them in different orders — verify each transitions to
   `completed` with its own rating.

**Expected**: Per-child state isolation. No cross-contamination of
lifecycle/rating between concurrent children sharing a parent.
