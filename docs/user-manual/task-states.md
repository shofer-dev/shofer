# Understanding Task States

Shofer shows the status of every task — past and present — with colored icons in the
task dropdown and chat header. This guide explains what each state means so you
can tell at a glance what your tasks are doing.

## Where You See Task States

Task states appear in two places:

1. **TaskSelector dropdown** — the sidebar drawer that opens when you click the
   tree-list icon in the VS Code title bar. Every history item and running
   parallel task has a state icon.

    <!-- XXX: Screenshot — TaskSelector dropdown open, showing several task rows with different state icons: a spinning sync icon (running) on one row, a question mark (waiting_input) on a background task, a green pass-filled (completed/excellent) on an older task. -->

2. **Chat header dot** — the small colored circle in the TaskHeader bar above the
   chat messages. It matches the same state as the TaskSelector icon for the
   current task.

    <!-- XXX: Screenshot — ChatView with TaskHeader visible, showing the green pulsing dot next to the task title ("running" state), with the context window bar and token/cost counters visible. -->

## The Seven Task States

| Icon               | State                 | What It Means                                                                                                                                                                                            |
| ------------------ | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ○ (outline circle) | **Idle**              | The task is not running. It may be waiting for you to send a message, or it may be a completed/stopped task from history.                                                                                |
| ⟳ (spinning sync)  | **Running**           | Shofer is actively working — making API calls, executing tools, or streaming a response.                                                                                                                 |
| ? (question)       | **Waiting for Input** | The task needs your approval or answer. You'll see an Ask prompt in the chat (e.g., "Approve tool call?" or a followup question). Background tasks show a notification badge when they reach this state. |
| ⌚ (watch)         | **Waiting**           | The task is blocked waiting for something external — for example, a parent task waiting for its child subtask to finish (`wait_for_task`). This is not waiting for _you_; no action is needed.           |
| ⏸ (pause)         | **Paused**            | You stopped the task (clicked Stop) or it was paused due to a budget limit. You can resume it by sending another message.                                                                                |
| ✓ (pass / filled)  | **Completed**         | The task finished successfully. A green circle — hollow for "poor," filled for "well," or a filled pass icon for "excellent" — shows the agent's self-assessment.                                        |
| ✕ (error)          | **Error**             | The task stopped due to an error. Hover for details or switch to the task to see what went wrong.                                                                                                        |

<!-- XXX: Screenshot — Composite image showing a callout for each of the 7 state icons, ideally arranged in a 2-row grid: idle (gray outline), running (spinning blue), waiting_input (yellow question), waiting (blue watch), paused (orange pause), completed (green pass), error (red error). -->

## Completion Ratings

When a task completes, the agent rates its own work as **poor**, **well**, or
**excellent**. The rating changes the icon:

| Rating    | Icon                         | Meaning                                                                                                             |
| --------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Poor      | ○ (hollow circle, gray)      | The task finished but the result has significant issues. You may want to start a new task with better instructions. |
| Well      | ● (filled circle, green 60%) | The task completed acceptably. Room for improvement but the result is usable.                                       |
| Excellent | ✓ (filled checkmark, green)  | The task executed excellently. High-quality result.                                                                 |

<!-- XXX: Screenshot — TaskSelector showing three completed task rows side by side with the three rating icons: hollow circle (poor), filled circle (well), pass-filled (excellent), each with a different task name and "Completed · X" label. -->

## Where Ratings Come From

The rating is set by Shofer itself when it calls the `attempt_completion`
tool at the end of a task. You cannot manually assign a rating — it reflects
the agent's own assessment of how well it met your request.

## Task States After Restart

When you restart VS Code (or reload the window), tasks that were running or
waiting are shown as **Idle** — because no live task instance survives a
restart. Tasks that completed, errored, or were paused keep their state. This
prevents stale "Running" indicators from a previous session.

## Notification Badges

The TaskSelector shows a notification badge (count) when background tasks need
your attention:

- A background task reached **Waiting for Input** and needs your approval.
- The badge disappears once you focus that task and answer the prompt.

Tasks in the **Waiting** state do **not** trigger a badge — they are waiting
for something other than you.

<!-- XXX: Screenshot — TaskSelector header showing a red notification badge with count "2", and two background task rows below with yellow question-mark icons. -->
