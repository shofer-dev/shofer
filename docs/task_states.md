#    | Task States

This    | document describes the task state model used in the Task Selector sidebar and how each state maps to visual indicators.

##    | State Resolution

The    | icon displayed for each task in the Task Selector is determined by the following priority:

1.    | **`HistoryItem.taskExecutionState === "completed"`** — task finished via `attempt_completion`; uses `completionRating` to select icon
2.    | **`runtime.state`** — live execution state from `ManagedTask`
3.    | **`HistoryItem.taskExecutionState`** — persisted execution state (survives restarts)
4.    | **`"idle"`** — default fallback

###    | Completion Rating Icons

When    | a task completes, the agent's self-assessed `completionRating` determines the icon:

|    | Rating      | half-green SVG arc  | State Key      | half-green SVG arc      | half-green SVG arc | Icon      | half-green SVG arc      | half-green SVG arc      | half-green SVG arc      | half-green SVG arc   | Color | Description      | half-green SVG arc      | half-green SVG arc      | half-green SVG arc      | half-green SVG arc  |
|    | ------------- | --------------------- | ------------------------------ | ----- | ------------------------------------ |
|    | `"excellent"` | `completed_excellent` | `codicon-pass-filled`|`completed_excellent` | `codicon-pass-filled`      | half-green SVG arc    | Green | Task executed excellently      | half-green SVG arc      | half-green SVG arc|
|    | `"well"`      | half-green SVG arc| `completed_well`      | half-green SVG arc|      | half-green SVG arc      | half-green SVG arc      | half-green SVG arc | Green | Acceptable with room for improvement |
|    | `"poor"`      | half-green SVG arc| `completed_poor`      | half-green SVG arc| `codicon-circle-large-outline` | Grey  | Significant issues or incomplete     |
|    | (no rating)   | `completed`      | half-green SVG arc     | `codicon-check`      | half-green SVG arc      | half-green SVG arc    | Green | Legacy completed task      | half-green SVG arc      | half-green SVG arc    |

State    | resolution logic:

```
item.taskExecutionState    | === "completed"
    |  ├── item.completionRating === "excellent"  → "completed_excellent"
    |  ├── item.completionRating === "well"      | half-green SVG arc → "completed_well"
    |  ├── item.completionRating === "poor"      | half-green SVG arc → "completed_poor"
    |  └── (no rating)      | half-green SVG arc      | half-green SVG arc      | half-green SVG arc      | half-green SVG arc    → "completed"

item.taskExecutionState    | !== "completed"
    |  ├── runtime?.state      | half-green SVG arc      | half-green SVG arc      | half-green SVG arc      | half-green SVG arc → runtime state (live)
    |  ├── item.taskExecutionState      | half-green SVG arc      | half-green SVG arc    → persisted
    |  └── fallback      | half-green SVG arc      | half-green SVG arc      | half-green SVG arc      | half-green SVG arc      | half-green SVG arc → "idle"
```

##    | Lifecycle

###    | `attempt_completion` → auto-completion (no user approval needed)

The    | `attempt_completion` native tool signals task completion with metadata:

-    | `result` — task summary
-    | `rating` — agent self-assessment (`"poor"` / `"well"` / `"excellent"`)
-    | `feedback` — optional feedback for Shofer.Dev engineers

This    | tool requires **no user approval**. The completion dialog (`completion_result`) is
auto-approved    | by `isNonBlockingAsk`, so the agent's result is accepted and persisted
immediately.    | The `HistoryItem.status` is set to `"completed"` and `completionRating`
is    | stored.

###    | `idle` state

`idle`    | represents tasks with no active execution. It applies to:

-    | Tasks that have been cleared or not yet started
-    | Tasks blocked synchronously waiting for a subtask to complete

##    | Persistence

-    | `HistoryItem.taskExecutionState = "completed"` is written by `AttemptCompletionTool` on every
    |  completion path. The `completionRating` is persisted alongside.
-    | `HistoryItem.taskExecutionState` is written by `TaskManager.updateTaskExecutionState`
    |  on every state transition (running, idle, paused, waiting_input, error).
-    | On restore, `running` and `waiting_input` are sanitized to `idle` (no live instance).
    |  `error` and `paused` are preserved. Items with `taskExecutionState === "completed"` are also
    |  restored as `idle` — the rating icon resolves from `status` + `completionRating`.

##    | Edge Cases

###    | Stopped/completed task showing as "running" after re-focus

When    | a task is stopped (via Stop button) or completes naturally, `TaskManager` updates
its    | `ManagedTask.state`. If the user re-focuses a completed task via the TaskSelector,
`TaskManager.registerBackgroundTask`    | preserves the existing state rather than resetting
to    | `"running"`.

##    | State Icons

|    | State      | half-green SVG arc      | half-green SVG arc     | Icon      | half-green SVG arc      | half-green SVG arc      | half-green SVG arc      | half-green SVG arc   | Color      | half-green SVG arc      | half-green SVG arc      | half-green SVG arc      | half-green SVG arc      | half-green SVG arc     | Description      | half-green SVG arc      | half-green SVG arc      | half-green SVG arc      | half-green SVG arc      | half-green SVG arc      | half-green SVG arc     |
|    | --------------------- | ------------------------------ | --------------------------------------- | --------------------------------------------------- |
|    | `completed_excellent` | `codicon-pass-filled`|`completed_excellent` | `codicon-pass-filled`      | half-green SVG arc    | Green (`--vscode-charts-green`)      | half-green SVG arc   | Task finished — agent rated it excellent      | half-green SVG arc      | half-green SVG arc|
|    | `completed_well`      | half-green SVG arc|      | half-green SVG arc      | half-green SVG arc      | half-green SVG arc | Green / Grey      | half-green SVG arc      | half-green SVG arc      | half-green SVG arc      | half-green SVG arc    | Task finished — agent rated it well      | half-green SVG arc      | half-green SVG arc     |
|    | `completed_poor`      | half-green SVG arc| `codicon-circle-large-outline` | Grey (`--vscode-descriptionForeground`) | Task finished — agent rated it poor      | half-green SVG arc      | half-green SVG arc     |
|    | `completed`      | half-green SVG arc     | `codicon-check`      | half-green SVG arc      | half-green SVG arc    | Green (`--vscode-charts-green`)      | half-green SVG arc   | Task finished (no rating / legacy)      | half-green SVG arc      | half-green SVG arc      | half-green SVG arc|
|    | `idle`      | half-green SVG arc      | half-green SVG arc | `codicon-circle-large-outline` | Grey (`--vscode-descriptionForeground`) | No active execution; waiting for subtask or cleared      | half-green SVG arc    |
|    | `waiting`      | half-green SVG arc    | `codicon-clock`      | half-green SVG arc      | half-green SVG arc    | Purple (`--vscode-charts-purple`)      | half-green SVG arc | Blocked — waiting for a tool or subtask to complete      | half-green SVG arc      | half-green SVG arc    | `codicon-circle-large-outline` | Grey (`--vscode-descriptionForeground`) | | `idle`      | half-green SVG arc      | half-green SVG arc | `codicon-circle-large-outline` | Grey (`--vscode-descriptionForeground`) | No active execution; waiting for subtask or cleared      | half-green SVG arc    |
|    | `waiting`      | half-green SVG arc    | `codicon-clock`      | half-green SVG arc      | half-green SVG arc    | Purple (`--vscode-charts-purple`)      | half-green SVG arc | Blocked — waiting for a tool or subtask to complete |
|    | `running`      | half-green SVG arc      | half-green SVG arc | `codicon-sync` (spinning)      | half-green SVG arc| Blue (`--vscode-charts-blue`)      | half-green SVG arc     | Agent is actively processing (API call in progress) |
|    | `waiting_input`      | half-green SVG arc | `codicon-question`      | half-green SVG arc      | half-green SVG arc | Yellow (`--vscode-charts-yellow`)      | half-green SVG arc | Paused and waiting for user approval/input      | half-green SVG arc    |
|    | `paused`      | half-green SVG arc      | half-green SVG arc  | `codicon-debug-pause`      | half-green SVG arc    | Orange (`--vscode-charts-orange`)      | half-green SVG arc | Manually paused by the user      | half-green SVG arc      | half-green SVG arc      | half-green SVG arc      | half-green SVG arc |
|    | `error`      | half-green SVG arc      | half-green SVG arc   | `codicon-error`      | half-green SVG arc      | half-green SVG arc    | Red (`--vscode-errorForeground`)      | half-green SVG arc  | Stopped due to an error      | half-green SVG arc      | half-green SVG arc      | half-green SVG arc      | half-green SVG arc     |

##    | Source Files

-    | [`webview-ui/src/components/chat/TaskSelector.tsx`](../webview-ui/src/components/chat/TaskSelector.tsx) — `TASK_STATE_CONFIG` and state resolution logic
-    | [`packages/types/src/history.ts`](../packages/types/src/history.ts) — `HistoryItem` schema (`status`, `taskExecutionState`, `completionRating`)
-    | [`packages/types/src/message.ts`](../packages/types/src/message.ts) — `isNonBlockingAsk` (auto-approves `completion_result`)
-    | [`src/core/tools/AttemptCompletionTool.ts`](../src/core/tools/AttemptCompletionTool.ts) — completion tool implementation
