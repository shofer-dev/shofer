# Task States

This document describes the task state model used by the Task Selector and the
in-chat header. The model has been redesigned around two orthogonal axes:

1. **Lifecycle** — what the task is doing right now (`idle`, `running`,
   `waiting_input`, `waiting`, `paused`, `completed`, `error`).
2. **Completion rating** — _only_ meaningful when the lifecycle is
   `completed`. One of `poor`, `well`, `excellent`.

Both fields live together inside a single `TaskState` value:

```typescript
type TaskLifecycle = "idle" | "running" | "waiting_input" | "waiting" | "paused" | "completed" | "error"
type CompletionRating = "poor" | "well" | "excellent"
type TaskState = { lifecycle: TaskLifecycle; rating?: CompletionRating }
```

The previous model collapsed both axes into a single string enum
(`completed_poorly`, `completed_well`, `completed_excellent`, …). That made it
impossible to express, e.g., "this task is currently `running` but its previous
attempt completed with a `well` rating", and forced every consumer to do
`startsWith("completed")` checks. The two-axis model removes that ambiguity.

## State Resolution

The icon for a task row in the Task Selector — and for the in-chat title dot —
is resolved with a single fallback chain in
[`TaskSelector.tsx`](../webview-ui/src/components/chat/TaskSelector.tsx):

```typescript
const runtime = runtimeStateMap.get(item.id)
const state: TaskState = runtime?.state ?? item.taskState ?? { lifecycle: "idle" }
```

1. **`runtime.state`** — live execution state from `ManagedTask` (in-memory).
2. **`item.taskState`** — persisted state (survives restarts).
3. **`{ lifecycle: "idle" }`** — default fallback.

The runtime overlay always wins: if a live `ManagedTask` exists for the task,
it owns the displayed state. Persisted state is only consulted when no live
instance exists (e.g. immediately after a restart, or for tasks whose
instance has already been disposed).

## Visual Mapping

Visuals are produced by `resolveStateVisual(state)` in
[`TaskSelector.tsx`](../webview-ui/src/components/chat/TaskSelector.tsx). The
resolver looks up a `LIFECYCLE_VISUAL[lifecycle]` entry and, if the lifecycle
is `completed` and a rating is present, layers a `RATING_VISUAL[rating]`
overlay on top.

### Lifecycle visuals

| Lifecycle       | Icon                           | Color                               |
| --------------- | ------------------------------ | ----------------------------------- |
| `idle`          | `codicon-circle-large-outline` | description foreground              |
| `running`       | `codicon-sync` (spinning)      | charts blue                         |
| `waiting_input` | `codicon-question`             | charts yellow                       |
| `waiting`       | `codicon-watch`                | charts blue                         |
| `paused`        | `codicon-debug-pause`          | charts orange                       |
| `completed`     | `codicon-pass`                 | charts green (overridden by rating) |
| `error`         | `codicon-error`                | error foreground                    |

### Completion rating overlays (lifecycle = `completed`)

| Rating      | Icon                           | Color                      |
| ----------- | ------------------------------ | -------------------------- |
| `poor`      | `codicon-circle-large-outline` | description foreground     |
| `well`      | `codicon-circle-large-filled`  | charts green (60% opacity) |
| `excellent` | `codicon-pass-filled`          | charts green               |

Every visual now goes through the same `<span class="codicon …">` mechanism;
there are no special-case SVGs.

## The Single-Writer Rule

`TaskManager.setState(taskId, state)` is the **only** writer of `TaskState`
to both the in-memory `ManagedTask` and the persisted `HistoryItem.taskState`:

- Updates the in-memory `ManagedTask.state`.
- Persists the new state through `provider.updateTaskHistory(...)`.
- Skips the write if the persisted state already matches.

No other code path ever writes `taskState`. Code that previously called
`updateTaskHistory({ ..., taskExecutionState: "completed_poorly" })` directly
(e.g. `resumeBlockingParent`) now goes through `setState`. This makes the
in-memory and persisted views provably consistent and gives us a single
choke point for invariants and telemetry.

## Restore Ordering

Some methods (`registerBackgroundTask`, anything that depends on the
managed-task map being authoritative) require restoration to have run first.
`TaskManager.restoreManagedTasks(history)`:

1. Rehydrates the managed-task map from history.
2. Calls `sanitizeRestoredState` for each entry to downgrade any transient
   lifecycle (`running`, `waiting_input`, `waiting`) to `idle` — those
   values can never be true after a restart, since no live `Task` instance
   exists.
3. Sets a private `restored` flag.

`assertRestored()` is invoked at the top of any method that depends on the
restoration having completed; it throws if the flag isn't set, eliminating
order-of-initialization bugs.

## Self-Contained Lifecycle Events

`TaskCompleted` and `TaskAborted` carry the data needed to interpret them
inside the event payload — consumers no longer need to look up the task to
figure out what happened:

- `TaskCompleted`: `{ rating: CompletionRating, isSubtask: boolean }`
- `TaskAborted`: `{ reason: "user" | "completed" | "error" | "abandoned" }`

`TaskManager`'s aborted handler dispatches on `reason`:

| reason        | Resulting lifecycle                                           |
| ------------- | ------------------------------------------------------------- |
| `"user"`      | `paused`                                                      |
| `"abandoned"` | `paused`                                                      |
| `"completed"` | no-op (already moved to `completed` by the completed handler) |
| `"error"`     | no-op (already moved to `error`)                              |
