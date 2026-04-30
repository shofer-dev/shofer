# Task States

This document describes the task state model used in the Task Selector sidebar and how each state maps to visual indicators.

## State Resolution

The icon displayed for each task in the Task Selector is determined by the following priority:

1. **`HistoryItem.status`** — persisted lifecycle status
2. **`runtime.state`** — live execution state from `ManagedTask`
3. **`HistoryItem.taskExecutionState`** — persisted execution state (survives restarts)
4. **`"idle"`** — default fallback

```
item.status === "completed"   → "completed"  (green check)
runtime?.state               → runtime state (live)
item.taskExecutionState      → persisted     (e.g., error after restart)
fallback                     → "idle"        (grey circle)
```

## Persistence

- `HistoryItem.status = "completed"` is written by `AttemptCompletionTool` on every successful completion path: foreground approval, blocking subtask completion (`resumeBlockingParent`), and background-child completion. This guarantees the green check after restart for any task the user actually finished.
- `HistoryItem.taskExecutionState` is written through by `TaskManager.updateTaskExecutionState` on every state transition (running, idle, paused, waiting_input, error). The runtime overlay stays authoritative for live UI; the persisted value is only consulted when the runtime is gone.
- On restore (`TaskManager.restoreManagedTasks`), `running` and `waiting_input` are sanitized to `idle` because no live Task instance can exist after a restart. `error` and `paused` are preserved. Items with `status === "completed"` are also restored as `idle` so the green check (resolved from `status`) wins.

## State Icons

| State           | Icon                           | Color                                   | Description                                                   |
| --------------- | ------------------------------ | --------------------------------------- | ------------------------------------------------------------- |
| `completed`     | `codicon-check`                | Green (`--vscode-charts-green`)         | Task finished successfully                                    |
| `idle`          | `codicon-circle-large-outline` | Grey (`--vscode-descriptionForeground`) | No active execution; task has not been started or was cleared |
| `running`       | `codicon-sync` (spinning)      | Blue (`--vscode-charts-blue`)           | Agent is actively processing (API call in progress)           |
| `waiting_input` | `codicon-question`             | Yellow (`--vscode-charts-yellow`)       | Paused and waiting for user approval/input                    |
| `paused`        | `codicon-debug-pause`          | Orange (`--vscode-charts-orange`)       | Manually paused by the user                                   |
| `error`         | `codicon-error`                | Red (`--vscode-errorForeground`)        | Stopped due to an error                                       |

## Source Files

- [`webview-ui/src/components/chat/TaskSelector.tsx`](../webview-ui/src/components/chat/TaskSelector.tsx) — `TASK_STATE_CONFIG` and state resolution logic
- [`packages/types/src/history.ts`](../packages/types/src/history.ts) — `HistoryItem` schema (`status`, `taskExecutionState`)
