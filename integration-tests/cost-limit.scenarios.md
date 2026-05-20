# Integration Tests: Per-Task Cost Limit (Spend Cap)

> Feature docs: [`docs/cost-calculation-and-limits.md`](../docs/cost-calculation-and-limits.md),
> [`docs/user-manual/cost-limit.md`](../docs/user-manual/cost-limit.md)
> Implementation: [`Task.ts`](../src/core/task/Task.ts),
> [`aggregateTaskCosts.ts`](../src/core/webview/aggregateTaskCosts.ts),
> [`NewTaskTool.ts`](../src/core/tools/NewTaskTool.ts),
> [`TaskHeader.tsx`](../webview-ui/src/components/chat/TaskHeader.tsx),
> [`BudgetLimitDialog.tsx`](../webview-ui/src/components/chat/BudgetLimitDialog.tsx)

## Scenarios

### 1. In-stream gate fires on a `usage` chunk that crosses the cap

**Given** a root task has `costLimit = { maxUsd: 0.01, action: "pause" }`
**And** `_priorAggregateUsd = 0.005`
**When** a `usage` chunk arrives with `totalCost = 0.006`
**Then** `checkInFlightCostLimit()` computes `spent = 0.005 + 0.006 = 0.011 >= 0.01`
**And** `enforceCostLimit()` is called with `action: "pause"`
**And** the in-flight HTTP request is cancelled via `cancelCurrentRequest()`
**And** a `budget_limit` ShoferAsk is emitted with `{ spentUsd: 0.011, limitUsd: 0.01 }`

**Verification**: Set a tight cap ($0.01) on a task. Trigger an API call
known to cost more than $0.01. Assert the `budget_limit` ask appears
before the request completes normally. Assert the API call was cancelled.

### 2. In-stream gate does not fire when current request stays under cap

**Given** a root task has `costLimit = { maxUsd: 0.10, action: "pause" }`
**And** `_priorAggregateUsd = 0.005`
**When** a `usage` chunk arrives with `totalCost = 0.003`
**Then** `spent = 0.008 < 0.10` and no enforcement fires
**And** the stream continues normally

**Verification**: Set a loose cap. Run a normal task. Assert no `budget_limit` ask appears.

### 3. Post-stream gate catches limit after stream ends

**Given** a root task has `costLimit = { maxUsd: 0.01, action: "pause" }`
**And** the in-stream gate did not fire (usage chunk never exceeded cap)
**When** `checkCostLimit()` runs after `drainStreamInBackgroundToFindAllUsage`
**And** `aggregateTaskCostsRecursive()` returns `totalCost = 0.012`
**Then** enforcement fires via the post-stream path
**And** a `budget_limit` ask is emitted

**Verification**: Use a provider that sends `usage` only on the final
chunk. Set cap at half the expected request cost. Assert the ask
appears after stream completion.

### 4. Pause-mode "Continue without limit" (yes button)

**Given** a `budget_limit` ask is displayed
**When** the user clicks the "Continue without limit" button
**Then** `_costLimitBypassed` is set to `true` on the root task
**And** `invalidateCostLimitCache()` is called
**And** no further cost-limit checks fire for this task

**Verification**: After bypass, make more API calls. Assert no
`budget_limit` ask appears regardless of total spend.

### 5. Pause-mode "Abort task" (no button)

**Given** a `budget_limit` ask is displayed
**When** the user clicks the "Abort task" button
**Then** `root.abortTask(false)` is called (clean abort)
**And** all background subtasks are recursively aborted
**And** the task state transitions to `idle` then `error` or `completed`

**Verification**: Assert `task.abort` is `true` after button click.
Assert `TaskAborted` lifecycle event is emitted.

### 6. Pause-mode reply with a new positive USD amount

**Given** a `budget_limit` ask is displayed with `limitUsd: 0.05`
**When** the user types `0.25` (or `$0.25`) as a reply
**Then** `root.costLimit` is updated to `{ maxUsd: 0.25, action: "pause" }`
**And** `invalidateCostLimitCache()` is called
**And** the task continues running
**And** the new limit is persisted to `HistoryItem` via `webviewMessageHandler.updateCostLimit`

**Verification**: Send a text reply `"0.25"` to the `budget_limit` ask.
Assert `root.costLimit.maxUsd === 0.25`. Trigger more API calls; assert
the new $0.25 cap is enforced, not the old $0.05.

### 7. Pause-mode reply with non-numeric input falls back to "continue without limit"

**Given** a `budget_limit` ask is displayed
**When** the user types `"please stop"` (non-numeric)
**Then** the fallback path treats it as "Continue without limit"
**And** `_costLimitBypassed` is set to `true`

**Verification**: Reply with non-numeric text. Assert bypass flag is set.
Assert no further cost checks fire.

### 8. `abort` action — clean abort

**Given** a root task has `costLimit = { maxUsd: 0.01, action: "abort" }`
**When** the in-stream gate fires
**Then** `cancelCurrentRequest()` is called
**And** `this.abortTask(false)` is called
**And** `root.abortTask(false)` is called (if `root !== this`)
**And** no `budget_limit` ask is shown (direct abort, no user prompt)

**Verification**: Set action to "abort". Trigger exceed. Assert task
transitions to terminated state without user interaction.

### 9. `kill` action — immediate kill

**Given** a root task has `costLimit = { maxUsd: 0.01, action: "kill" }`
**When** the gate fires
**Then** `cancelCurrentRequest()` is called
**And** `this.abortTask(true)` is called (abandoned flag)
**And** no user prompt is shown

**Verification**: Set action to "kill". Trigger exceed. Assert
`abortTask(true)` is called.

### 10. `new_task` child refused when root cost would exceed cap

**Given** a root task has `costLimit = { maxUsd: 0.10, action: "pause" }`
**And** `aggregateTaskCostsRecursive(root)` returns `totalCost = 0.09`
**When** the model calls `new_task` with `mode: "code"` and any message
**Then** `NewTaskTool.execute()` calls `aggregateTaskCostsRecursive()` before spawning
**And** since `0.09 < 0.10`, the spawn proceeds normally

**Then** after the spawn, `aggregatedCost >= 0.10`
**When** the model calls `new_task` again
**Then** the tool returns an error: cost limit exceeded, subtask refused

**Verification**: Set a cap just above current spend. Spawn a subtask.
After it completes (adds cost), attempt another spawn. Assert second
spawn is refused.

### 11. Cost-limit enforcement requires llm-provider integration

**Given** `enableLlmProviderIntegration` is `false` (default)
**When** a task has `costLimit` set and makes API calls
**Then** `totalCost` stays `$0` for every request
**And** `consolidateTokenUsage()` reports `totalCost: 0`
**And** the budget limit never trips

**Verification**: Disable integration. Set a tight cap. Run an expensive
API call. Assert cap is never hit. Assert output channel shows no
diagnostic messages.

### 12. Enabling llm-provider integration makes cost stamps appear

**Given** `enableLlmProviderIntegration` is `true`
**And** the llm-provider extension is installed and active
**When** a task makes API calls
**Then** `totalCost` in usage chunks is > 0
**And** `consolidateTokenUsage()` returns `totalCost > 0`
**And** the budget limit fires when spend crosses the cap

**Verification**: Enable integration. Run a task with a cap. Assert
cost rows show real values (>$0). Assert cap enforcement works.

### 13. Diagnostic messages when llm-provider commands are missing

**Given** `enableLlmProviderIntegration` is `true`
**And** the llm-provider extension is NOT installed
**When** the vscode-lm provider attempts to call `shofer.llm.getModelPricing`
**Then** a one-shot warning is logged to the Shofer output channel:
`[vscode-lm] shofer.llm.getModelPricing command not found — is the Shofer LLM Model Provider extension installed and active?`
**And** cost remains $0 for all requests

**Verification**: Enable integration without the provider extension
installed. Check output channel for the warning.

### 14. Cost-limit persistence across task switch and restore

**Given** a root task has `costLimit = { maxUsd: 0.50, action: "pause" }`
**When** the task is archived and later restored
**Then** `HistoryItem.costLimit` is preserved
**And** `Task` constructor restores it (root task only)
**And** the TaskHeader shows `$spent / $0.50`

**Verification**: Set a cap on a task. Archive it. Restore it. Assert
TaskHeader shows the same cap. Make API calls; assert enforcement works.

### 15. Subtask inherits root limit (does not carry its own)

**Given** a root task has `costLimit = { maxUsd: 0.10, action: "pause" }`
**When** a child subtask is spawned via `new_task`
**Then** the child's `HistoryItem` does NOT have `costLimit`
**And** `Task.costLimit` is `undefined` on the child
**And** `resolveCostLimit()` on the child walks to root and returns the root's limit

**Verification**: Create a subtask. Check its `HistoryItem` — no `costLimit`.
Call `resolveCostLimit()` on the child — returns root's limit.

### 16. Default cost limit seeded at task creation

**Given** `defaultCostLimit = { maxUsd: 2.00, action: "abort" }` in global settings
**When** a new root task is created via `ShoferProvider.createTask()`
**Then** the new `Task` instance has `costLimit = { maxUsd: 2.00, action: "abort" }`
**And** the TaskHeader shows `$0.00 / $2.00` immediately (before any API calls)

**Verification**: Set a non-zero default. Create a new task. Assert
TaskHeader shows the cap from creation time.

### 17. Live-edit cost limit via pencil icon in TaskHeader

**Given** a running task with `costLimit = { maxUsd: 1.00, action: "pause" }`
**When** the user clicks the pencil icon and changes the cap to `{ maxUsd: 5.00, action: "kill" }`
**Then** `webviewMessageHandler.updateCostLimit` walks to root
**And** `root.costLimit` is updated
**And** `root.invalidateCostLimitCache()` is called
**And** the new limit is persisted to `HistoryItem`

**Verification**: Edit the cap mid-task. Assert TaskHeader shows new values.
Make API calls; assert new cap and action are enforced.

### 18. Cross-subtask parallel race (multiple racers observe exceed)

**Given** a root task spawns 2 background subtasks in parallel
**And** `costLimit = { maxUsd: 0.01, action: "abort" }` on root
**When** both subtasks complete API calls that push the aggregate over 0.01
**Then** both subtasks may fire `checkCostLimit()` concurrently
**And** each observes `spent >= limit` independently
**And** the first to call `enforceCostLimit()` aborts the root
**And** the second's abort is a no-op (task already aborted)

**Verification**: Spawn 2 parallel background tasks with a tight cap.
Assert the root is aborted exactly once. Assert no exceptions from
the second racer's `abortTask` call.
