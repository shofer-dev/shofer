# Task States

This document describes the task state model used in the Task Selector sidebar and how each state maps to visual indicators.

## State Resolution

The icon displayed for each task in the Task Selector is determined by the following priority:

1. **`HistoryItem.taskExecutionState === "completed"`** — task finished via `attempt_completion`; uses `completionRating` to select icon
2. **`runtime.state`** — live execution state from `ManagedTask`
3. **`HistoryItem.taskExecutionState`** — persisted execution state (survives restarts)
4. **`"idle"`** — default fallback

### Completion Rating Icons

When a task completes, the agent's self-assessed `completionRating` determines the icon:

| Rating        | State Key             | Icon                           | Color | Description                          |
| ------------- | --------------------- | ------------------------------ | ----- | ------------------------------------ |
| `"excellent"` | `completed_excellent` | `codicon-pass-filled`          | Green | Task executed excellently            |
| `"well"`      | `completed_well`      | half-green SVG arc             | Green | Acceptable with room for improvement |
| `"poor"`      | `completed_poor`      | `codicon-circle-large-outline` | Grey  | Significant issues or incomplete     |
| (no rating)   | `completed`           | `codicon-check`                | Green | Legacy completed task                |

State resolution logic:

```
item.taskExecutionState === "completed"
  ├── item.completionRating === "excellent"  → "completed_excellent"
  ├── item.completionRating === "well"       → "completed_well"
  ├── item.completionRating === "poor"       → "completed_poor"
  └── (no rating)                            → "completed"

item.taskExecutionState !== "completed"
  ├── runtime?.state                         → runtime state (live)
  ├── item.taskExecutionState                → persisted
  └── fallback                               → "idle"
```

## Lifecycle

### `attempt_completion` → auto-completion (no user approval needed)

The `attempt_completion` native tool signals task completion with metadata:

- `result` — task summary
- `rating` — agent self-assessment (`"poor"` / `"well"` / `"excellent"`)
- `feedback` — optional feedback for Shofer.Dev engineers

This tool requires **no user approval**. The completion dialog (`completion_result`) is
auto-approved by `isNonBlockingAsk`, so the agent's result is accepted and persisted
immediately. The `HistoryItem.status` is set to `"completed"` and `completionRating`
is stored.

### `idle` state

`idle` represents tasks with no active execution. It applies to:

- Tasks that have been cleared or not yet started
- Tasks blocked synchronously waiting for a subtask to complete

## Persistence

- `HistoryItem.taskExecutionState = "completed"` is written by `AttemptCompletionTool` on every
  completion path. The `completionRating` is persisted alongside.
- `HistoryItem.taskExecutionState` is written by `TaskManager.updateTaskExecutionState`
  on every state transition (running, idle, paused, waiting_input, error).
- On restore, `running` and `waiting_input` are sanitized to `idle` (no live instance).
  `error` and `paused` are preserved. Items with `taskExecutionState === "completed"` are also
  restored as `idle` — the rating icon resolves from `status` + `completionRating`.

## Edge Cases

### Stopped/completed task showing as "running" after re-focus

When a task is stopped (via Stop button) or completes naturally, `TaskManager` updates
its `ManagedTask.state`. If the user re-focuses a completed task via the TaskSelector,
`TaskManager.registerBackgroundTask` preserves the existing state rather than resetting
to `"running"`.

## State Icons

| State                 | Icon                           | Color                                   | Description                                         |
| --------------------- | ------------------------------ | --------------------------------------- | --------------------------------------------------- |
| `completed_excellent` | `codicon-pass-filled`          | Green (`--vscode-charts-green`)         | Task finished — agent rated it excellent            |
| `completed_well`      | half-green SVG arc             | Green / Grey                            | Task finished — agent rated it well                 |
| `completed_poor`      | `codicon-circle-large-outline` | Grey (`--vscode-descriptionForeground`) | Task finished — agent rated it poor                 |
| `completed`           | `codicon-check`                | Green (`--vscode-charts-green`)         | Task finished (no rating / legacy)                  |
| `idle`                | `codicon-circle-large-outline` | Grey (`--vscode-descriptionForeground`) | No active execution; waiting for subtask or cleared |
| `running`             | `codicon-sync` (spinning)      | Blue (`--vscode-charts-blue`)           | Agent is actively processing (API call in progress) |
| `waiting_input`       | `codicon-question`             | Yellow (`--vscode-charts-yellow`)       | Paused and waiting for user approval/input          |
| `paused`              | `codicon-debug-pause`          | Orange (`--vscode-charts-orange`)       | Manually paused by the user                         |
| `error`               | `codicon-error`                | Red (`--vscode-errorForeground`)        | Stopped due to an error                             |

## Source Files

- [`webview-ui/src/components/chat/TaskSelector.tsx`](../webview-ui/src/components/chat/TaskSelector.tsx) — `TASK_STATE_CONFIG` and state resolution logic
- [`packages/types/src/history.ts`](../packages/types/src/history.ts) — `HistoryItem` schema (`status`, `taskExecutionState`, `completionRating`)
- [`packages/types/src/message.ts`](../packages/types/src/message.ts) — `isNonBlockingAsk` (auto-approves `completion_result`)
- [`src/core/tools/AttemptCompletionTool.ts`](../src/core/tools/AttemptCompletionTool.ts) — completion tool implementation
