# Task States

This document describes the task state model used in the Task Selector sidebar and how each state maps to visual indicators.

## State Resolution

The icon displayed for each task in the Task Selector is determined by a simple priority chain in [`TaskSelector.tsx`](../webview-ui/src/components/chat/TaskSelector.tsx):

```typescript
const runtime = runtimeStateMap.get(item.id)
const state = runtime?.state ?? item.taskExecutionState ?? "idle"
```

1. **`runtime.state`** — live execution state from `ManagedTask` (in-memory, session-only)
2. **`item.taskExecutionState`** — persisted execution state (survives restarts)
3. **`"idle"`** — default fallback

Both `ManagedTask.state` and `HistoryItem.taskExecutionState` use the same underlying type — [`TaskExecutionState`](../packages/types/src/history.ts:6). The runtime layer takes priority when both exist (live task), and the persisted layer serves as fallback when no live instance is present (restart, task completed and its instance removed).

### Completion Rating States

When a task completes via [`attempt_completion`](../src/core/tools/AttemptCompletionTool.ts), the agent's self-assessed `rating` determines the `taskExecutionState`:

| Rating        | taskExecutionState    | Icon                           | Color        | Description                          |
| ------------- | --------------------- | ------------------------------ | ------------ | ------------------------------------ |
| `"excellent"` | `completed_excellent` | `codicon-pass-filled`          | Green        | Task executed excellently            |
| `"well"`      | `completed_well`      | half-green SVG arc             | Green / Grey | Acceptable with room for improvement |
| `"poor"`      | `completed_poorly`    | `codicon-circle-large-outline` | Grey         | Significant issues or incomplete     |

If the rating is missing or invalid, it defaults to `"poor"` (`completed_poorly`). There is no plain `"completed"` state — a task is always completed with a rating.

The `completed_well` state is rendered as a custom SVG: a grey circle outline with a green semi-circle arc on the top half (representing a "partial" or "passable" result).

## State Icons

The full [`TASK_STATE_CONFIG`](../webview-ui/src/components/chat/TaskSelector.tsx) is defined in `TaskSelector.tsx`:

| State                 | Icon                           | Color                                   | Pulse | Label                 | Description                                         |
| --------------------- | ------------------------------ | --------------------------------------- | ----- | --------------------- | --------------------------------------------------- |
| `completed_excellent` | `codicon-pass-filled`          | Green (`--vscode-charts-green`)         | No    | Completed · Excellent | Task finished — agent rated it excellent            |
| `completed_well`      | half-green SVG arc             | Green / Grey                            | No    | Completed · Well      | Task finished — agent rated it well                 |
| `completed_poorly`    | `codicon-circle-large-outline` | Grey (`--vscode-descriptionForeground`) | No    | Completed · Poor      | Task finished — agent rated it poor                 |
| `idle`                | `codicon-circle-large-outline` | Grey (`--vscode-descriptionForeground`) | No    | Idle                  | No active execution; waiting for subtask or cleared |
| `running`             | `codicon-sync` (spinning)      | Blue (`--vscode-charts-blue`)           | Yes   | Running               | Agent is actively processing (API call in progress) |
| `waiting`             | `codicon-clock`                | Purple (`--vscode-charts-purple`)       | Yes   | Waiting               | Blocked — waiting for a tool or subtask to complete |
| `waiting_input`       | `codicon-question`             | Yellow (`--vscode-charts-yellow`)       | Yes   | Needs Input           | Paused and waiting for user approval/input          |
| `paused`              | `codicon-debug-pause`          | Orange (`--vscode-charts-orange`)       | No    | Paused                | Manually paused by the user                         |
| `error`               | `codicon-error`                | Red (`--vscode-errorForeground`)        | No    | Failed                | Stopped due to an error                             |

## Lifecycle

### Task State Transitions

The [`TaskManager`](../src/services/task-manager/TaskManager.ts) listens to [`Task`](../src/core/task/Task.ts) events and translates them into `ManagedTask` state updates:

| Task Event        | → ManagedTask State | Notes                                                                     |
| ----------------- | ------------------- | ------------------------------------------------------------------------- |
| `TaskStarted`     | `running`           | Emitted just before first API request, not at loop entry                  |
| `TaskActive`      | `running`           | After user answers an approval ask                                        |
| `TaskInteractive` | `waiting_input`     | Needs user approval                                                       |
| `TaskIdle`        | `idle`              | Not emitted for `resume_completed_task` (re-visiting completed tasks)     |
| `TaskCompleted`   | (from history)      | Reads persisted state from `taskHistoryStore`; e.g. `completed_excellent` |
| `TaskError`       | `error`             |                                                                           |
| `TaskAborted`     | `paused`¹           |                                                                           |
| `TaskToolFailed`  | (no state change)   | Tool errors are often recoverable                                         |

¹ `TaskAborted` preserves terminal outcomes (`idle`, `error`) and defaults to `paused` otherwise.

### Key Design Decisions

**`TaskStarted` placement** — Emitted inside `recursivelyMakeShoferRequests`, right before [`attemptApiRequest`](../src/core/task/Task.ts:3468), on the first iteration only (gated by `taskStartedEmitted` flag). It is NOT emitted at the top of `initiateTaskLoop`, so visiting a completed/paused/errored task that shows a dialog (without making API calls) does not trigger `onStarted`.

**`TaskIdle` suppression** — [`Task.ask()`](../src/core/task/Task.ts:1695) skips `TaskIdle` emission for `resume_completed_task`. Re-visiting a completed task shows its completion dialog but does not change the managed task state.

**`TaskCompleted` state propagation** — [`onComplete`](../src/services/task-manager/TaskManager.ts:565) reads the persisted `taskExecutionState` from `taskHistoryStore` rather than hardcoding `"idle"`. This means rating-specific icons (`completed_excellent`, etc.) appear immediately in the TaskSelector, not just after a restart.

### `attempt_completion` Flow

1. Agent calls [`attempt_completion`](../src/core/tools/AttemptCompletionTool.ts) with `result`, `rating`, and optional `feedback`.
2. The tool validates the rating (defaults to `"poor"` if missing or invalid).
3. The `taskExecutionState` is set in the persisted history to `completed_poorly`, `completed_well`, or `completed_excellent` — these are the `TaskExecutionState` enum members, stored directly (no separate `completionRating` field).
4. **Subtask check**: If the task has a `parentTaskId`, the tool handles delegation (blocking foreground path, background child path, or re-focused completed child) before proceeding.
5. **User approval**: The tool calls `task.ask("completion_result", ...)`. Because `completion_result` is in [`nonBlockingAsks`](../packages/types/src/message.ts), it is auto-approved — the completion dialog appears but requires no manual approval.
6. On completion, the tool persists `taskExecutionState` (with the rating) and emits `TaskCompleted`, which `TaskManager.onComplete` reads back from the history store to set the runtime state.
7. **Background children**: For `is_background` subtasks, completion is handled without delegation — status is persisted, the parent's `backgroundChildren` handle is updated, and the child aborts cleanly.

### `idle` State

`idle` represents tasks with no active execution. It applies to:

- Tasks that have been cleared or not yet started
- Tasks blocked synchronously waiting for a subtask to complete
- Non-running states sanitized on restart (`running`/`waiting_input` → `idle`)

## Persistence

- **`taskExecutionState`** is written by [`TaskManager.updateTaskExecutionState`](../src/services/task-manager/TaskManager.ts) on every state transition (`running`, `idle`, `paused`, `waiting_input`, `error`). This writes through to the `HistoryItem` in the history store so the state survives restarts.
- **Completion-rating states** (`completed_poorly`, `completed_well`, `completed_excellent`) are written directly by [`AttemptCompletionTool`](../src/core/tools/AttemptCompletionTool.ts) on every completion path, then read back by `TaskManager.onComplete` to synchronize the runtime overlay.

### Startup Restore

At startup, [`initializeTaskHistoryStore`](../src/core/webview/ShoferProvider.ts:392-395) calls `taskHistoryStore.getAll()` and feeds the results into [`restoreManagedTasks`](../src/services/task-manager/TaskManager.ts). This seeds the `managedTasks` map with sanitized persisted states so the TaskSelector shows correct icons immediately after restart.

### Restore Sanitization

[`sanitizeRestoredState`](../src/services/task-manager/TaskManager.ts) resolves the initial state for each restored task:

- `running` → `idle` (stale — no live instance)
- `waiting_input` → `idle` (stale — no live instance)
- `error` → preserved (terminal)
- `paused` → preserved (terminal)
- `completed_*` → preserved (terminal)
- Any other → `idle` (default fallback)

Only terminal states survive restarts; transient states revert to `idle`.

### In-Session Registration

When a task is re-visited during a session,[`registerBackgroundTask`](../src/services/task-manager/TaskManager.ts) preserves the existing `ManagedTask.state`. Since `restoreManagedTasks` seeded the map on startup, the fallback `(task.abandoned || task.abort ? "idle" : "running")` is only reached for brand-new tasks that have never existed before.

## Edge Cases

### Stopped/completed task showing as "running" after re-focus

When a task is stopped (via Stop button) or completes naturally, `TaskManager` updates its `ManagedTask.state`. The `TaskAborted` event handler checks the current state before overriding: if already `idle` or `error` (terminal outcomes), it preserves them instead of setting `paused`.

### Re-visiting a completed task

Three guards prevent a completed task's state from changing when re-visited:

1. `TaskStarted` is not emitted (the task never makes an API call, only shows the completion dialog)
2. `TaskIdle` is not emitted for `resume_completed_task` asks
3. `registerBackgroundTask` preserves `existing.state` from the `managedTasks` map (seeded by `restoreManagedTasks`)

### Subtask completion without parent delegation

For `is_background` subtasks, `AttemptCompletionTool` handles completion independently — it persists the completed status, updates the parent's `backgroundChildren` handle, emits `TaskCompleted`, and aborts the child. No delegation or parent resume occurs.

## Known Issues & Inconsistencies

### `waiting` state is unused

The `"waiting"` value exists in [`taskExecutionStateSchema`](../packages/types/src/history.ts:9) and [`TASK_STATE_CONFIG`](../webview-ui/src/components/chat/TaskSelector.tsx:114), but no code path ever sets `ManagedTask.state` or `HistoryItem.taskExecutionState` to `"waiting"`. The only uses of `"waiting"` in the task system are child-task handles (`BackgroundTaskStatus` in [`task.ts`](../packages/types/src/task.ts:155)) and the `WaitForTaskTool`/`CheckTaskStatusTool` — both unrelated to `TaskExecutionState`.

### `registerBackgroundTask` fallback is a heuristic

When no `ManagedTask` exists (brand-new task that hasn't been persisted yet), [`registerBackgroundTask`](../src/services/task-manager/TaskManager.ts) defaults to `"running"` because `task.abort` is false for fresh instances. This is correct for genuinely new tasks but would be wrong for a rehydrated task if `restoreManagedTasks` wasn't called first. The startup call to `restoreManagedTasks` mitigates this.

## Source Files

- [`webview-ui/src/components/chat/TaskSelector.tsx`](../webview-ui/src/components/chat/TaskSelector.tsx) — `TASK_STATE_CONFIG` and state resolution logic
- [`webview-ui/src/components/chat/TaskHeader.tsx`](../webview-ui/src/components/chat/TaskHeader.tsx) — Task header state dot rendering
- [`packages/types/src/history.ts`](../packages/types/src/history.ts) — `HistoryItem` schema and `taskExecutionStateSchema` enum
- [`packages/types/src/message.ts`](../packages/types/src/message.ts) — `idleAsks`, `nonBlockingAsks` (auto-approves `completion_result`)
- [`src/core/tools/AttemptCompletionTool.ts`](../src/core/tools/AttemptCompletionTool.ts) — completion tool implementation
- [`src/services/task-manager/TaskManager.ts`](../src/services/task-manager/TaskManager.ts) — state transitions, persistence, `restoreManagedTasks`, `sanitizeRestoredState`
- [`src/core/task/Task.ts`](../src/core/task/Task.ts) — `TaskStarted` placement (before first API request) and `TaskIdle` suppression for `resume_completed_task`
- [`src/core/webview/ShoferProvider.ts`](../src/core/webview/ShoferProvider.ts) — `initializeTaskHistoryStore` calls `restoreManagedTasks` at startup
