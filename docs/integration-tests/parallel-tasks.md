# Parallel Tasks & Sub-Task Execution — Integration Test Scenarios

Feature under test: Parallel task execution via `new_task` (sync/background
delegation), background task orchestration tools (`check_task_status`,
`wait_for_task`, `list_background_tasks`, `cancel_tasks`,
`answer_subtask_question`), parent-child lifecycle management, and
`TaskManager` resource limits.

## Prerequisites

- Shofer extension running with TaskManager and ShoferProvider fully
  initialized.
- At least one API profile configured and functional.
- `alwaysAllowSubtasks` enabled in auto-approval settings (for subtask
  creation and cancellation).
- The TaskSelector is visible in the webview with at least one task listed.

---

## Scenarios

### 1. Synchronous delegation: parent blocks, child result returned

**Goal:** Verify the full sync `new_task` flow end-to-end.

1. Start a task in Orchestrator mode.
2. Send: "Use new_task to spawn a child in Code mode that says hello world."
3. Confirm the TaskSelector shows a new child task (focused, green dot).
4. Confirm the parent task is shown below with a blue `waiting` indicator.
5. Wait for the child to complete.
6. Confirm the parent is restored as the focused task.
7. Confirm the parent's chat shows the child's `attempt_completion` result as
   a `tool_result`.

**Expected:** Parent transitions `running` → `waiting` → `running`. Child
transitions `running` → `completed`. The child result is visible in the
parent's conversation.

### 2. Background delegation: parent continues immediately

**Goal:** Verify parent does not block when spawning background children.

1. Start a task in Orchestrator mode.
2. Send: "Spawn a background child in Code mode to count to 5 with sleep(2)
   between each count. Then tell me 'done spawning'."
3. Confirm the TaskSelector shows the child task below the parent with an
   indented display.
4. Confirm the parent immediately says "done spawning" (does not wait for
   the child).
5. Wait ~12 seconds for the child to finish.
6. Confirm the child's state transitions to `completed` in the TaskSelector.

**Expected:** Parent remains `running` throughout. Child starts `running`
and eventually reaches `completed`.

### 3. Multiple parallel background children

**Goal:** Verify multiple background children run concurrently.

1. Start a task in Orchestrator mode.
2. Send: "Spawn two background children in Code mode. Each should sleep(5)
   then say done."
3. Confirm both child tasks appear in the TaskSelector.
4. Confirm the parent responds immediately.
5. Use `wait_for_task` with `wait: "all"` to wait for both.
6. Confirm both children complete.

**Expected:** Both children run concurrently (total time ≈ 5s, not 10s).
Parent can collect results via `wait_for_task`.

### 4. `check_task_status` returns live state

**Goal:** Verify the parent can query child status without blocking.

1. Spawn a background child that takes ~10 seconds (e.g., "count to 10
   with a 1-second sleep between each").
2. Call `check_task_status` on the child ID.
3. Confirm the response shows `status: "running"`.
4. Wait for the child to finish.
5. Call `check_task_status` again.
6. Confirm the response shows `status: "completed"` with the child's result.

**Expected:** Read-only query works for both running and completed children.

### 5. `check_task_status` with `include_activity=true`

**Goal:** Verify activity reporting for running children.

1. Spawn a background child that reads a file and reports findings.
2. Call `check_task_status` with `include_activity: true`.
3. Confirm the response includes recent tool calls or messages from the
   child.

**Expected:** Activity output includes readable descriptions of the child's
last operations.

### 6. `wait_for_task` with `"any"` strategy

**Goal:** Verify early return when at least one child completes.

1. Spawn two background children: one fast ("say done immediately"), one
   slow ("sleep(10) then say done").
2. Call `wait_for_task` on both with `wait: "any"`.
3. Confirm the call returns as soon as the fast child completes.
4. Confirm the slow child is still running.
5. Call `wait_for_task` on the slow child alone.
6. Confirm it eventually completes.

**Expected:** `"any"` returns on first completion. Remaining children are
unaffected.

### 7. `cancel_tasks` stops a running background child

**Goal:** Verify the parent can cancel its own children.

1. Spawn a background child running an infinite loop (e.g., "count to 100
   with sleep(2) between each").
2. Wait 3 seconds.
3. Call `cancel_tasks` on the child ID.
4. Confirm the child transitions to `cancelled` status.
5. Call `check_task_status` — confirm `status: "cancelled"`.

**Expected:** Child is stopped cleanly. Status is `cancelled` (not `error`).

### 8. `cancel_tasks` on already-completed child is a no-op

**Goal:** Verify cancellation is idempotent for terminal children.

1. Spawn and wait for a fast background child ("say done").
2. Call `cancel_tasks` on the completed child ID.
3. Confirm the response says "already completed" (no error, no state change).

**Expected:** Already-completed children are unaffected by `cancel_tasks`.

### 9. `list_background_tasks` enumerates children

**Goal:** Verify the parent can see all its background children.

1. Spawn three background children with descriptive messages.
2. Call `list_background_tasks`.
3. Confirm the response lists all three children with their IDs, statuses,
   and timestamps.

**Expected:** All background children are listed.

### 10. Background child `ask_followup_question` routes to parent

**Goal:** Verify the routing mechanism for child questions.

1. Spawn a background child in Code mode with: "Use ask_followup_question to
   ask which color is best: red or blue."
2. Call `check_task_status` on the child.
3. Confirm the response shows `status: "waiting"` and the question text
   with suggestions.
4. Call `answer_subtask_question` with `answer: "blue"`.
5. The child resumes and completes.
6. Call `check_task_status` — confirm `status: "completed"`.

**Expected:** Child blocks on question; parent sees it via
`check_task_status`; parent answers via `answer_subtask_question`; child
resumes.

### 11. Parent completion aborts children

**Goal:** Verify children cannot outlive their parent.

1. Start a task in Orchestrator mode.
2. Spawn a background child doing a long operation ("count to 100 with
   sleep(2)").
3. Tell the parent: "Now call attempt_completion with rating excellent."
4. Confirm the child's state transitions to `error` or `cancelled` shortly
   after the parent completes.

**Expected:** All background children are aborted when the parent calls
`attempt_completion`.

### 12. Parent abort cascades to children

**Goal:** Verify Stop button propagates to background children.

1. Start a task in Orchestrator mode.
2. Spawn a background child doing a long operation.
3. Click the **Stop** button in the chat input bar.
4. Confirm the parent transitions to `paused`.
5. Confirm the child transitions to `error` or `cancelled`.

**Expected:** Stopping the parent also aborts background children.

### 13. `wait_for_task` timeout does not error

**Goal:** Verify the timeout parameter works as a soft deadline.

1. Spawn a background child doing a 30-second operation.
2. Call `wait_for_task` with `timeout: 5`.
3. Confirm the call returns after ~5 seconds with the child still in
   `running` status.
4. Confirm no error is thrown — the timeout is informational only.

**Expected:** Timeout returns current statuses gracefully. The child
continues running.

### 14. Task state restore after VS Code restart

**Goal:** Verify states are sanitized correctly on reload.

1. Spawn a background child in the middle of a long operation.
2. While it's running, quit VS Code.
3. Restart VS Code and re-open the Shofer panel.
4. Confirm the child task shows `idle` state (not `running`) — transient
   states are sanitized.
5. Confirm the parent shows its last persisted state.

**Expected:** Transient states (`running`, `waiting_input`, `waiting`) are
downgraded to `idle`. Terminal states (`completed`, `error`, `paused`) are
preserved.

### 15. Hierarchical `list_background_tasks` per-parent

**Goal:** Verify each parent only sees its own children.

1. Start task A. Spawn background child A1.
2. Start task B (switch to a new task). Spawn background child B1.
3. Switch back to task A.
4. Call `list_background_tasks`.
5. Confirm only child A1 appears (not B1).

**Expected:** Each parent's `backgroundChildren` map is scoped to that
parent.

### 16. Nested delegation: background child spawns its own child

**Goal:** Verify multi-level delegation works.

1. Start a task in Orchestrator mode.
2. Spawn a background child in Orchestrator mode.
3. In that child, verify it can spawn its own background child.
4. Confirm the grandchild appears in the TaskSelector under the child.

**Expected:** Multi-level parent→child→grandchild hierarchy is tracked
correctly.

### 17. `switch_mode` from background child does not affect focused task

**Goal:** Verify mode isolation for background tasks.

1. Start the focused task in Code mode.
2. Spawn a background child in Search mode.
3. Confirm the ModeSelector still shows Code mode (the focused task's mode).
4. Switch focus to the background child.
5. Confirm the ModeSelector now shows Search mode.

**Expected:** Each task has its own mode. Background tasks' mode changes
do not affect the focused task's mode in the UI.
