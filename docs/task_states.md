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

The `taskExecutionState` field in [`HistoryItem`](../packages/types/src/history.ts) stores the full state directly, including completion-rating variants (`completed_poorly`, `completed_well`, `completed_excellent`). There is no separate resolution step for "completed" — the rating is already part of the persisted state value.

### Completion Rating States

When a task completes via [`attempt_completion`](../src/core/tools/AttemptCompletionTool.ts), the agent's self-assessed `rating` determines the `taskExecutionState`:

| Rating        | taskExecutionState    | Icon                           | Color        | Description                          |
| ------------- | --------------------- | ------------------------------ | ------------ | ------------------------------------ |
| `"excellent"` | `completed_excellent` | `codicon-pass-filled`          | Green        | Task executed excellently            |
| `"well"`      | `completed_well`      | half-green SVG arc             | Green / Grey | Acceptable with room for improvement |
| `"poor"`      | `completed_poorly`    | `codicon-circle-large-outline` | Grey         | Significant issues or incomplete     |
| (no rating)   | `completed`           | `codicon-check`                | Green        | Legacy completed task (pre-rating)   |

The `completed_well` state is rendered as a custom SVG: a grey circle outline with a green semi-circle arc on the top half (representing a "partial" or "passable" result).

## State Icons

The full [`TASK_STATE_CONFIG`](../webview-ui/src/components/chat/TaskSelector.tsx) is defined in `TaskSelector.tsx`:

| State                 | Icon                           | Color                                   | Pulse | Label                 | Description                                         |
| --------------------- | ------------------------------ | --------------------------------------- | ----- | --------------------- | --------------------------------------------------- |
| `completed_excellent` | `codicon-pass-filled`          | Green (`--vscode-charts-green`)         | No    | Completed · Excellent | Task finished — agent rated it excellent            |
| `completed_well`      | half-green SVG arc             | Green / Grey                            | No    | Completed · Well      | Task finished — agent rated it well                 |
| `completed_poorly`    | `codicon-circle-large-outline` | Grey (`--vscode-descriptionForeground`) | No    | Completed · Poor      | Task finished — agent rated it poor                 |
| `completed`           | `codicon-check`                | Green (`--vscode-charts-green`)         | No    | Completed             | Task finished (no rating / legacy)                  |
| `idle`                | `codicon-circle-large-outline` | Grey (`--vscode-descriptionForeground`) | No    | Idle                  | No active execution; waiting for subtask or cleared |
| `running`             | `codicon-sync` (spinning)      | Blue (`--vscode-charts-blue`)           | Yes   | Running               | Agent is actively processing (API call in progress) |
| `waiting`             | `codicon-clock`                | Purple (`--vscode-charts-purple`)       | Yes   | Waiting               | Blocked — waiting for a tool or subtask to complete |
| `waiting_input`       | `codicon-question`             | Yellow (`--vscode-charts-yellow`)       | Yes   | Needs Input           | Paused and waiting for user approval/input          |
| `paused`              | `codicon-debug-pause`          | Orange (`--vscode-charts-orange`)       | No    | Paused                | Manually paused by the user                         |
| `error`               | `codicon-error`                | Red (`--vscode-errorForeground`)        | No    | Failed                | Stopped due to an error                             |

## Lifecycle

### Task State Transitions

The [`TaskManager`](../src/services/task-manager/TaskManager.ts) listens to [`Task`](../src/core/task/Task.ts) events and translates them into `ManagedTask` state updates:

| Task Event        | → ManagedTask State |
| ----------------- | ------------------- |
| `TaskStarted`     | `running`           |
| `TaskActive`      | `running`           |
| `TaskInteractive` | `waiting_input`     |
| `TaskIdle`        | `idle`              |
| `TaskCompleted`   | `idle`              |
| `TaskError`       | `error`             |
| `TaskAborted`     | `paused`¹           |
| `TaskToolFailed`  | (no state change)   |

¹ `TaskAborted` preserves terminal outcomes (`idle`, `error`) and defaults to `paused` otherwise.

> **Note on TaskIdle vs TaskCompleted**: Both events set the state to `idle` in `TaskManager`. The `TaskCompleted` event additionally emits `managedTask:completed`. The UI resolves the final icon via the persisted `taskExecutionState` (which `AttemptCompletionTool` sets to `completed_*`).

### `attempt_completion` Flow

1. Agent calls [`attempt_completion`](../src/core/tools/AttemptCompletionTool.ts) with `result`, `rating`, and optional `feedback`.
2. The tool validates the rating (defaults to `"poor"` if missing or invalid).
3. The `taskExecutionState` is set directly to `completed_poorly`, `completed_well`, or `completed_excellent` — these are the `TaskExecutionState` enum members, not a separate field.
4. **Subtask check**: If the task has a `parentTaskId`, the tool handles delegation (blocking foreground path, background child path, or re-focused completed child) before proceeding.
5. **User approval**: The tool calls `task.ask("completion_result", ...)`. Because `completion_result` is in [`nonBlockingAsks`](../packages/types/src/message.ts), it is auto-approved — the completion dialog appears but requires no manual approval.
6. On completion, the tool persists `taskExecutionState` (with the rating) and emits `TaskCompleted`, which `TaskManager` translates to `idle` for the live runtime overlay.
7. **Background children**: For `is_background` subtasks, completion is handled without delegation — status is persisted, the parent's `backgroundChildren` handle is updated, and the child aborts cleanly.

### `idle` State

`idle` represents tasks with no active execution. It applies to:

- Tasks that have been cleared or not yet started
- Tasks blocked synchronously waiting for a subtask to complete
- Tasks that have reached an idle ask state: `completion_result`, `api_req_failed`, `resume_completed_task`, `mistake_limit_reached`, or `auto_approval_max_req_reached` (defined as [`idleAsks`](../packages/types/src/message.ts))

## Persistence

- **`taskExecutionState`** is written by [`TaskManager.updateTaskExecutionState`](../src/services/task-manager/TaskManager.ts) on every state transition (`running`, `idle`, `paused`, `waiting_input`, `error`). This writes through to the `HistoryItem` in the history store so the state survives restarts.
- **Completion-rating states** (`completed_poorly`, `completed_well`, `completed_excellent`) are written directly by [`AttemptCompletionTool`](../src/core/tools/AttemptCompletionTool.ts) on every completion path.
- **`completionRating`** (the raw "poor"/"well"/"excellent" string) is also persisted separately on `HistoryItem`, set by `AttemptCompletionTool`.

### Restore Sanitization

On restore (after extension reload or code-server restart), [`sanitizeRestoredState`](../src/services/task-manager/TaskManager.ts) sanitizes the persisted state:

- `running` → `idle` (stale — no live instance)
- `waiting_input` → `idle` (stale — no live instance)
- `error` → preserved (terminal)
- `paused` → preserved (terminal)
- `completed_*` → preserved (terminal)
- Any other → `idle` (default fallback)

This means after a restart, only terminal states (`error`, `paused`, `completed_*`) survive; transient states revert to `idle`.

## Edge Cases

### Stopped/completed task showing as "running" after re-focus

When a task is stopped (via Stop button) or completes naturally, `TaskManager` updates its `ManagedTask.state`. The `TaskAborted` event handler checks the current state before overriding: if already `idle` or `error` (terminal outcomes), it preserves them instead of setting `paused`.

### Subtask completion without parent delegation

For `is_background` subtasks, `AttemptCompletionTool` handles completion independently — it persists the completed status, updates the parent's `backgroundChildren` handle, emits `TaskCompleted`, and aborts the child. No delegation or parent resume occurs.

## Source Files

- [`webview-ui/src/components/chat/TaskSelector.tsx`](../webview-ui/src/components/chat/TaskSelector.tsx) — `TASK_STATE_CONFIG` and state resolution logic
- [`packages/types/src/history.ts`](../packages/types/src/history.ts) — `HistoryItem` schema (`taskExecutionState`, `completionRating`)
- [`packages/types/src/message.ts`](../packages/types/src/message.ts) — `idleAsks`, `nonBlockingAsks` (auto-approves `completion_result`)
- [`src/core/tools/AttemptCompletionTool.ts`](../src/core/tools/AttemptCompletionTool.ts) — completion tool implementation
- [`src/services/task-manager/TaskManager.ts`](../src/services/task-manager/TaskManager.ts) — state transitions, persistence, `sanitizeRestoredState`
