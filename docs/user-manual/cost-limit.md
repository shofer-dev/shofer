# Per-Task Cost Limit (Spend Cap)

Shofer lets you set a **USD budget cap** on any task. When the
running cost reaches the limit, Shofer pauses, aborts, or kills the
task — so you never get a surprise bill from a runaway
agentic loop or a forgotten background subtask.

## Where You See It

### The Cost Row in the Task Header

When a cost limit is active, the [TaskHeader] at the top of the chat
shows `$0.09 / $1.00` next to the API Cost row, with a **pencil icon**
for live-editing the cap:

<!-- XXX: Screenshot — TaskHeader in ChatView showing "$0.0924 / $1.00" next to the API Cost row, with the pencil (edit) icon visible to the right. The task is mid-execution with some chat messages visible below. -->

| Element                | Meaning                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| `$0.09` (left number)  | Total USD spent so far (root task + all subtasks). Includes an `*` indicator when subtask costs are included. |
| `$1.00` (right number) | The current budget cap. Editable via the pencil icon.                                                         |
| Pencil icon            | Opens the [Budget Limit dialog](#editing-the-limit) for changing the cap or action mid-task.                  |

### The Budget Limit Dialog

Clicking the pencil opens a small popup where you set:

- **Cap amount** (USD, must be > $0)
- **Action on exceed**: `Pause` (ask you what to do), `Abort` (clean stop), or `Kill` (immediate stop)

<!-- XXX: Screenshot — BudgetLimitDialog popup showing a "Max USD" text field with "1.00" filled in and a dropdown for Action with "Pause" selected, plus Save/Cancel buttons. -->

### When the Limit Is Hit (Pause Mode)

If the action is `Pause`, Shofer stops the current request and shows
a prompt in the chat with three choices:

<!-- XXX: Screenshot — ChatView showing a budget-limit ask row: "Cost limit reached: $0.0501 of $0.05" with two buttons "Continue without limit" (primary) and "Abort task" (secondary), plus a text input for typing a new USD amount. -->

| Choice                     | What happens                                                       |
| -------------------------- | ------------------------------------------------------------------ |
| **Continue without limit** | Removes the cap for the rest of this task only. No further checks. |
| **Abort task**             | Stops the current task cleanly (preserves history).                |
| **Type a new amount**      | Replaces the cap with the value you type (e.g. `0.25` or `$0.25`). |

The prompt also shows the exact amount spent (`$0.0501`) and the
limit that was hit (`$0.05`).

## Setting a Default (Global) Limit

You can set a default cost limit that applies to **every new root task**
automatically. This is configured via `settings.json`:

```json
{
	"shofer.defaultCostLimit": {
		"maxUsd": 1.0,
		"action": "pause"
	}
}
```

- `maxUsd` — the cap in USD (must be > 0)
- `action` — `"pause"`, `"abort"`, or `"kill"`

> **Note:** This setting currently has no UI in the Settings panel.
> You must set it via JSON editing. A Settings panel row is planned.

## Per-Task vs. Global

| Scope    | Set via                                              | Persists across sessions?    |
| -------- | ---------------------------------------------------- | ---------------------------- |
| Global   | `settings.json` → `shofer.defaultCostLimit`          | Yes — all new root tasks     |
| Per-task | Pencil icon in TaskHeader, or the Pause prompt reply | Yes — stored in task history |

Each task inherits the global default at creation time, then you can
edit it independently. Editing a running task's limit updates the
**root task** — subtasks always share their root's cap.

## How Subtask Costs Are Counted

The displayed spend includes **all descendant subtasks** recursively.
If you have a root task and it spawns 3 background `new_task` children,
the `$0.09 / $1.00` in the header includes all 4 tasks. An `*`
indicator confirms subtask costs are folded in.

When a `new_task` tool call would push the root's total over the cap,
the child is **refused** with a tool error — the subtask never starts.

## Prerequisites

Cost-limit enforcement depends on the **Shofer LLM Model Provider**
extension being installed and active. This extension registers VS Code
commands that supply USD pricing data.

If you set a cost limit but see `$0` for every request and the limit
never fires, check the **Shofer output channel** for messages like:

```
[vscode-lm] shofer.llm.getRequestCost command not found — is the Shofer LLM Model Provider extension installed and active?
```

The integration is controlled by the `shofer.enableLlmProviderIntegration`
setting (also in `settings.json`, default `false`).

## Known Limitations

- **Per-task caps at task creation** are not yet supported. You must
  set the cap after the task starts (live-edit) or rely on the global
  default.
- **Resuming an already-over-limit task** does not immediately surface
  the budget prompt. The check fires on the next API request.
- There is no **80% "soft warning"** before the hard cap fires.
- **Parallel subtasks** racing the check may in rare cases have
  multiple racers observe the exceed simultaneously, though in
  practice only the first abort matters.
