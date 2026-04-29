# Per-Root-Task Cost Limit

Status: **shipped in 3.53.0**.

A user-configurable USD spend cap, scoped to the root task, with
subtask costs aggregated into the root via the existing
`aggregateTaskCostsRecursive` helper. Implements automatic
pause / abort / kill when a task's cumulative cost (root + all
descendant subtasks) reaches the configured limit.

## Why

Roo-Code already surfaces a per-task `API Cost` and an `aggregatedCost`
that rolls subtask spend into the root task (see
[`aggregateTaskCosts.ts`](../src/core/webview/aggregateTaskCosts.ts) and
the `getTaskWithAggregatedCosts` IPC path in
[`webviewMessageHandler.ts`](../src/core/webview/webviewMessageHandler.ts)).
But there was no enforcement: a runaway agentic loop on a frontier
model — or a poorly-bounded `new_task` tree — could quietly burn
through real money with no upper bound.

## Goals

1. Per-root-task USD budget cap that the user can set:
    - **Globally** (default for all new tasks) via the
      `defaultCostLimit` global setting.
    - **Live-editable** on a running task (raise or lower) via the
      pencil affordance next to the API Cost row in `TaskHeader`.
2. Cost accounting reuses the same `aggregatedCost` view that the UI
   already shows (root + all descendant subtasks, recursive).
3. Three configurable behaviours when the limit is hit:
    - `pause` — interrupts the streaming loop and surfaces an
      `ask: budget_limit` with three outcomes:
        - **Increase by $5** (yes button) — bumps the cap on the root
          and persists it to history.
        - **Abort task** (no button) — calls `root.abortTask(false)`;
          subtasks die via the existing recursive abort path.
        - **Continue without limit** (free-text reply) — sets a
          per-root bypass flag for the rest of the task.
    - `abort` — `root.abortTask(false)` (clean abort, persists state).
    - `kill` — `root.abortTask(true)` (abandoned, no further user
      interaction). Intended for headless / CLI / evals.
4. Subtasks: when a `new_task` would push the root's aggregated cost
   over the limit, the spawn is refused with a tool error.
5. Telemetry: emits `BUDGET_EXCEEDED` with
   `{rootTaskId, limitUsd, spentUsd, action, modelId}`.

## Non-Goals

- Per-day or per-organisation spend caps (belongs in `llm-router`,
  not in the editor extension).
- Token-count limits (`maxTokens` / context-window pressure is
  handled by `condenseContext`).
- Hard cost prediction before a request is made — enforcement is
  _post-hoc_ on the running aggregate, not pre-flight.

## Design

### Where the budget lives

- New optional field on `HistoryItem` (persisted) and on `Task`
  (in-memory), stored only on the **root** task:

    ```ts
    // packages/types/src/history.ts
    export const costLimitSchema = z.object({
    	maxUsd: z.number().positive(),
    	action: z.enum(["pause", "abort", "kill"]),
    })
    ```

    Subtasks never carry their own `costLimit`. The check always
    resolves to `root.costLimit` by walking the `parentTask` chain
    in `Task.resolveCostLimit()`.

- Global setting `defaultCostLimit` in `globalSettingsSchema`
  (same shape). Applied to the root task at creation time in
  `ClineProvider.createTask()` via
  `contextProxy.getValue("defaultCostLimit")`.

### Where the check fires

Single chokepoint in [`Task.ts`](../src/core/task/Task.ts) inside the
streaming loop, **right after** `updateApiReqMsg` writes the new
`cost` into `clineMessages[lastApiReqIndex]`. The call is
`await`ed so the abort flag is observed before the next chunk is
yielded — otherwise we'd keep burning tokens past the cap for the
remainder of the stream.

`checkCostLimit(requestIndex)`:

1. Bypass if `_costLimitBypassed` is set on the root.
2. Bypass if `_costLimitCheckCache.requestIndex === requestIndex`
   (already evaluated for this request — avoids repeated history
   scans inside one stream).
3. Resolve `{root, limit}` via `resolveCostLimit()`.
4. If `limit` is unset or `maxUsd <= 0`, return early.
5. `spent = aggregateTaskCostsRecursive(root.taskId, …).totalCost`
   (failures are logged via `provider.log()` and treated as
   "don't block"; we err on the side of not interrupting the user).
6. Cache `{spent, requestIndex}`.
7. If `spent < limit.maxUsd`, return.
8. Emit `TelemetryEventName.BUDGET_EXCEEDED` and a
   `say('text', "Cost limit reached: $X.XX of $Y.YY")` so the user
   sees _why_ the task stopped.
9. Branch on `limit.action`:
    - `pause` → `askUserForBudgetDecision(root, limit, spent)`.
    - `abort` → `await root.abortTask(false)`.
    - `kill` → `await root.abortTask(true)`.

A second chokepoint guards `new_task` in
[`NewTaskTool.ts`](../src/core/tools/NewTaskTool.ts): before
constructing the child, walk to the root, aggregate costs, and refuse
with a tool error if `aggregated.totalCost >= limit.maxUsd`.

### UI

- [`TaskHeader.tsx`](../webview-ui/src/components/chat/TaskHeader.tsx)
  shows `$spent / $limit` next to the existing API Cost row when
  `costLimit` is set, with a pencil icon that opens
  [`BudgetLimitDialog.tsx`](../webview-ui/src/components/chat/BudgetLimitDialog.tsx)
  for live editing.
- The pause-mode `ask` is wired to ChatView's existing primary /
  secondary button infrastructure (yes = "Increase by $5",
  no = "Abort task", free-text reply = "Continue without limit").
  No separate dialog component is needed for the ask itself.
- ChatView owns the `updateCostLimit` postMessage and passes a
  callback down via the `onUpdateCostLimit` prop, so TaskHeader
  doesn't talk to the host directly.

### Persistence & restore

- `costLimit` round-trips through
  [`taskMetadata.ts`](../src/core/task-persistence/taskMetadata.ts)
  alongside `totalCost`.
- The `Task` constructor restores `historyItem.costLimit` **only
  when `parentTask` is unset**, enforcing the "single source of
  truth on the root" invariant even if a malformed history item
  carried the field on a subtask.

### Telemetry

`TelemetryService.captureBudgetExceeded(taskId, {rootTaskId, limitUsd,
spentUsd, action, modelId})` emits the
`TelemetryEventName.BUDGET_EXCEEDED` event before the action runs.

## What's implemented

- [x] Schema additions in `@roo-code/types`:
      `budgetActionSchema`, `costLimitSchema`, `historyItem.costLimit`,
      `globalSettings.defaultCostLimit`,
      `clineAsks.budget_limit` (also added to `interactiveAsks`),
      `WebviewMessage.updateCostLimit` + `costLimit` field,
      `TelemetryEventName.BUDGET_EXCEEDED`.
- [x] Core enforcement in `Task.ts`:
      `costLimit` field, `_costLimitCheckCache`, `_costLimitBypassed`,
      `resolveCostLimit()`, `invalidateCostLimitCache()`,
      `checkCostLimit()` (awaited from the stream loop),
      `askUserForBudgetDecision()` (yes/no/text outcomes).
- [x] `new_task` tool guard.
- [x] Default-limit seeding in `ClineProvider.createTask()`.
- [x] `webviewMessageHandler.ts` `updateCostLimit` handler that
      walks to root, updates the live `Task`, invalidates the cache,
      and persists to history.
- [x] UI: TaskHeader inline `$spent / $limit` + pencil affordance,
      `BudgetLimitDialog` for live editing, ChatView wiring of the
      `budget_limit` ask to primary/secondary buttons.
- [x] Persistence round-trip via `taskMetadata.ts`.
- [x] Telemetry event.
- [x] Unit tests: parent-walk semantics + recursive cost aggregation
      ([`cost-limit.spec.ts`](../src/core/task/__tests__/cost-limit.spec.ts)).

## What was deferred

These items from the original spec did not ship in 3.53.0 and remain
follow-ups:

- [ ] Per-task cap input on the New Task creation flow (today the
      cap can only be set globally or live-edited mid-task).
- [ ] Settings panel UI for the global default — the
      `defaultCostLimit` schema is wired but no settings-pane row
      exists yet; users have to set it via JSON.
- [ ] Resume-into-already-exceeded-task: today the check fires on
      the next API request after resume. A pre-flight check at task
      restore would surface the `ask` immediately.
- [ ] "Soft" warning at 80% of the cap before the hard action at 100%.
- [ ] Integration tests for each of `pause` / `abort` / `kill`
      end-to-end (the heavy `Task.spec.ts` harness was left
      untouched; current tests cover the pure pieces).
- [ ] Re-entrancy guard around concurrent parallel subtasks racing
      `checkCostLimit` (today the cache + per-request index
      eliminates intra-task races, but cross-subtask parallel
      execution can in principle have multiple racers all observe
      `spent >= limit` and each fire the action; only the first
      `abortTask` matters in practice but the behaviour is not
      formally specified).
- [ ] AGENTS.md / `extensions/llm-provider/README.md` doc updates
      mentioning the dependency on `arkware.llm.getModelPricing`.

## Dependencies

Requires the cost data path:
`arkware.llm.getModelPricing` → `vscode-lm.getModel().info` →
`calculateApiCostOpenAI` → `clineMessages[lastApiReqIndex].cost`,
which landed in `llm-provider` 0.6.0 / Roo-Code 3.52.87.

Without it, vscode-lm-routed models report `cost: 0` and the budget
limit can never trip — this is by design (we only enforce on real
billed cost), but worth flagging to users debugging "why isn't my
limit firing?".

## Versioning

Shipped as Roo-Code **3.53.0** (minor bump): new user-visible
setting, new `ask` type, new persisted field on `HistoryItem`. No
backward-compat shims — missing `costLimit` is treated as "no limit".
