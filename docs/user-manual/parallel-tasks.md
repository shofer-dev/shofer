# Parallel Tasks — Getting More Done at Once

Shofer can run **multiple tasks at the same time** — one in the foreground that
you're watching, and others in the background that keep working independently.
This is especially useful when you have a large goal that can be broken into
smaller pieces.

---

## What Are Parallel Tasks?

When Shofer runs a task (Code, Debug, Search, etc.), it's a single conversation
running a tool loop. Normally you interact with one task at a time in the chat
panel. With parallel tasks, Shofer can **spawn child tasks** that run
concurrently — either blocking (the parent waits for the result) or in the
background (the parent keeps going).

**Real-world examples:**

- **"Audit all TypeScript files for security issues"** — Shofer spawns one
  background task per file, then collects the results.
- **"Research this topic and also refactor the auth module"** — two independent
  background tasks run in parallel.
- **"Write tests for every module in src/"** — one synchronous delegation per
  module, collecting results sequentially.

<!-- XXX: Screenshot showing the TaskSelector dropdown with three tasks listed —
one focused (green dot, pulsing), two background (their status dots), with
parent-child indentation visible. Caption: "The TaskSelector showing a parent
task and its two background children." -->

---

## How It Works

Shofer's model uses the **`new_task`** tool to spawn children. There are two
modes:

### Synchronous (Blocking)

The model spawns a child task and **waits** for it to finish. The child's result
is fed back into the parent as a tool result, and the parent continues from
where it left off. This is useful for sequential work — "do A, then B, then C."

In the UI, the child task takes focus (its messages appear in the chat panel).
When the child finishes, the parent is restored automatically.

<!-- XXX: Screenshot showing a child task's chat view (with messages from the
child's work) while the parent is waiting. The TaskSelector shows "Parent Task"
below with a blue "waiting" indicator. Caption: "A child task running in
synchronous mode — the parent is waiting below." -->

### Background (Async)

The model spawns one or more children that run **concurrently in the
background**. The parent receives the child's ID and continues immediately.
Multiple background children can run at the same time.

<!-- XXX: Screenshot showing the chat view of a parent task with background
children running — the TaskSelector shows the parent (green running dot) with
two indented children below (their own status dots). A notification badge
appears next to a child that needs input. Caption: "Parent task running while
two background children work — one needs input (yellow badge)." -->

---

## Controlling Background Tasks

When the model spawns background children, it uses five tools to manage them.
These are **always available** and do not require your approval for read-only
operations:

| Tool                      | What it does                           | Needs approval?                    |
| ------------------------- | -------------------------------------- | ---------------------------------- |
| `check_task_status`       | Check how a background child is doing  | No                                 |
| `wait_for_task`           | Wait until one or more children finish | No                                 |
| `list_background_tasks`   | List all background children           | No                                 |
| `cancel_tasks`            | Stop one or more background children   | Yes (if alwaysAllowSubtasks is on) |
| `answer_subtask_question` | Answer a question a child asked        | Yes (if alwaysAllowSubtasks is on) |

The parent can `wait_for_task` on all children, or just wait for **any** one
child to finish first (the `"any"` strategy). A timeout (default 120 seconds)
prevents infinite blocking.

<!-- XXX: Screenshot showing a tool-call chat row for `wait_for_task` — displays
the tool name, the list of task IDs being waited on, and the strategy ("all").
Caption: "The `wait_for_task` tool call rendered in chat." -->

---

## When a Background Child Needs Help

If a background child calls `ask_followup_question` (e.g., "Which file should I
check next?"), the question is **automatically routed to the parent task** — not
to you. The parent sees the question through `check_task_status` and answers via
`answer_subtask_question`. The child then resumes as if the parent had answered
directly.

This keeps the experience clean: you, the user, only need to interact with the
focused task. Background children communicate through their parent.

---

## Task Lifecycle & Indicators

Every task has a lifecycle state shown as a colored dot in the TaskSelector:

| Color            | State           | Means                                  |
| ---------------- | --------------- | -------------------------------------- |
| Gray             | `idle`          | Not running                            |
| Green (pulsing)  | `running`       | Actively working                       |
| Yellow (pulsing) | `waiting_input` | Needs your approval or input           |
| Blue (pulsing)   | `waiting`       | Blocked on a subtask (`wait_for_task`) |
| Orange           | `paused`        | You paused it                          |
| Green (solid)    | `completed`     | Finished via `attempt_completion`      |
| Red              | `error`         | Failed or stopped                      |

<!-- XXX: Screenshot showing the TaskSelector expanded with a mix of task states
visible — one running (green pulse), one waiting_input (yellow pulse), one
completed (green solid), one error (red). Show parent-child indentation with
nested children under their parent. Caption: "TaskSelector showing various task
lifecycle states across a parent task and its children." -->

You can always click any task in the TaskSelector to switch focus to it.
Switching to a different task **does not abort** the current task — it continues
running in the background.

---

## Limits

Shofer enforces concurrent task limits to prevent API rate-limit issues:

| Limit                          | Default | What it controls                                   |
| ------------------------------ | ------- | -------------------------------------------------- |
| Max concurrent active tasks    | 3       | Total tasks running at once (focused + background) |
| Max concurrent streaming tasks | 2       | Tasks streaming LLM responses at once              |
| Background task timeout        | 30s     | Internal timeout for background task operations    |

If the limit is reached, new background children are rejected with an error
message.

---

## What Happens When...

### The parent finishes before the children

All background children are **automatically aborted**. Children cannot outlive
their parent task.

### The parent is stopped (you press Stop)

Background children are aborted automatically. The abort propagates down to all
children.

### A child encounters an error

The child transitions to `error` state. The parent discovers this through
`check_task_status` or `wait_for_task` (which returns `status: "error"`). The
parent can then decide to `cancel_tasks` on the failed child or continue with
other children.

### You restart VS Code

Tasks that were `running` or `waiting_input` are reset to `idle`. Completed,
errored, and paused tasks keep their state. Task instances are **not**
automatically restarted — you must explicitly re-open a task to resume it.

---

## Tips

- **Break large tasks into smaller ones.** Instead of "refactor the whole
  project," ask Shofer to spawn one background child per module.
- **Use `wait_for_task` with `"any"`** when order doesn't matter — the parent
  processes children as they finish.
- **Check the notification badge** in the TaskSelector — a yellow badge means a
  background child needs your input.
- **Cancel stalled children** if you don't need their results anymore — it frees
  up a concurrency slot.
