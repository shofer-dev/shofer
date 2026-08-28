# Parallel Tasks & Sub-Task Execution — Integration Test Scenarios

Feature under test: Concurrent task execution via `new_task`, the task
orchestration tools (`check_task_status`, `list_background_tasks`,
`cancel_tasks`), the mailbox tools a parent uses to collect a child's result and
answer its questions (`wait`, `reply`), parent-child lifecycle management, and
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

### 1. A child's result reaches the parent as mail

**Goal:** Verify the full `new_task` → `attempt_completion` → mailbox flow
end-to-end.

1. Start a task in Orchestrator mode.
2. Send: "Use new_task to spawn a child in Code mode that says hello world,
   then wait for its result."
3. Confirm `new_task` returns `Child task started: <id>` immediately, and that
   focus stays on the parent.
4. Confirm the TaskSelector shows the new child task below the parent.
5. Confirm the parent shows a blue `waiting` indicator while parked in `wait`.
6. Wait for the child to complete.
7. Confirm the parent's `wait` returns a `notification` from the child whose
   subject is `result: <child title>` and whose body is the child's
   `attempt_completion` result.

**Expected:** Parent transitions `running` → `waiting` → `running`. Child
transitions `running` → `completed`. The child result is visible in the
parent's conversation as a `peer_message` say row.

### 2. The parent is never blocked by spawning

**Goal:** Verify `new_task` returns immediately and never steals focus.

1. Start a task in Orchestrator mode.
2. Send: "Spawn a child in Code mode to count to 5 with sleep(2)
   between each count. Then tell me 'done spawning'."
3. Confirm the TaskSelector shows the child task below the parent with an
   indented display, and that the parent stays focused.
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
5. Call `wait` with `from` naming both child IDs, twice, until both results
   have been read.
6. Confirm both children complete.

**Expected:** Both children run concurrently (total time ≈ 5s, not 10s). Each
child's `attempt_completion` result reaches the parent's mailbox as a
`notification`, and the parent collects them with `wait`.

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

### 6. `wait` returns on the first result to land

**Goal:** Verify a parked parent wakes on the first child that finishes.

1. Spawn two background children: one fast ("say done immediately"), one
   slow ("sleep(10) then say done").
2. Call `wait` with `from` naming both child IDs.
3. Confirm the call returns as soon as the fast child completes, carrying that
   child's `result:` notification.
4. Confirm the slow child is still running.
5. Call `wait` with `from` naming the slow child alone.
6. Confirm it eventually completes.

**Expected:** `wait` returns on the first delivery matching its wake condition,
carrying the whole box. Remaining children are unaffected.

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

### 10. A child's `ask_followup_question` reaches both channels

**Goal:** Verify the dual-channel routing for child questions.

1. Spawn a child in Code mode with: "Use ask_followup_question to ask which
   color is best: red or blue."
2. Confirm the question is raised in the **child's own chat** with its
   suggestions.
3. Confirm the parent's mailbox digest lists a `request` whose subject starts
   `question:`.
4. Call `check_task_status` on the child. Confirm it reports
   `Waiting on your answer: "<question>"` together with the `reply(...)` call
   that answers it.
5. Answer from the parent with `reply({ replies: [{ message_id: "<id>", body:
"blue" }] })`.
6. Confirm the child resumes, and that the ask in the child's own chat is
   withdrawn.
7. Call `check_task_status` — confirm `status: "completed"`.

**Expected:** The question is delivered to the parent's mailbox AND raised in the
child's chat; the child sits in `waiting_input` throughout; the first answer wins
and the other channel is withdrawn.

### 10b. A human answers the child's question first

**Goal:** Verify the human channel wins when it answers first.

1. Repeat scenario 10 through step 3.
2. Click a suggestion in the **child's own chat**.
3. Confirm the child resumes immediately.
4. Confirm the `request` is gone from the parent's mailbox digest, and that a
   later `reply` naming that message id is refused as unknown.

**Expected:** First answer wins in either direction.

### 10c. An unanswered child question expires

**Goal:** Verify the expiry text the child receives.

1. Repeat scenario 10 through step 3, and answer from neither channel.
2. Wait out the 600-second child-question deadline.

**Expected:** The child's ask is answered with the synthesized text
`Your question to the parent expired unanswered after 600s. Decide yourself, or
ask again.`, and the child resumes.

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

### 13. `wait` timeout does not error

**Goal:** Verify the timeout parameter works as a soft deadline.

1. Spawn a background child doing a 30-second operation.
2. Call `wait` with `timeout_sec: 5` and `from` naming the child.
3. Confirm the call returns after ~5 seconds with an empty box, and that
   `check_task_status` still reports the child as `running`.
4. Confirm no error is thrown — an empty box at the timeout is a normal answer.

**Expected:** The timeout returns an empty list gracefully. The child continues
running.

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
