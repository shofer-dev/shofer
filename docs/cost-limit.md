# Per-Root-Task Cost Limit

Status: **shipped in 3.53.0**, hardened through 3.54.7.

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
        - **Continue without limit** (yes button) — sets a per-root
          bypass flag for the rest of the task; no further checks fire.
        - **Abort task** (no button) — calls `root.abortTask(false)`;
          subtasks die via the existing recursive abort path.
        - **New limit** (free-text reply with a positive dollar
          amount, e.g. `0.10` or `$2.50`) — replaces the root's
          `maxUsd` with the user-supplied value and persists it to
          history. Non-numeric input falls back to "continue without
          limit" so we never silently ignore the user.
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

Two chokepoints inside the streaming loop in
[`Task.ts`](../src/core/task/Task.ts), both `await`ed so the abort
flag is observed before the next chunk is yielded — otherwise we'd
keep burning tokens past the cap for the remainder of the stream.

**1. In-stream gate** (`checkInFlightCostLimit(currentRequestCostUsd)`),
fired on every `usage` chunk during the main streaming loop:

1. At the start of each API request,
   `snapshotPriorAggregateForCostLimit()` records
   `_priorAggregateUsd = aggregateTaskCostsRecursive(root.taskId, …)`
   — the spend across the root's history, BEFORE this request's
   own usage is added. Resets the per-request enforcement latch.
2. On every `usage` chunk, compute
   `spent = _priorAggregateUsd + chunk.totalCost`.
3. Bypass if `_costLimitBypassed`,
   `_costLimitEnforcementFiredForRequest`, or no snapshot.
4. If `spent >= limit.maxUsd`, latch the per-request flag and call
   `enforceCostLimit(root, limit, spent)` (shared with the
   post-stream check).

This is what makes the cap _tight_ — a single expensive completion
can't silently blow past a small limit (e.g. $0.05) before the
post-stream check fires, because the abort/pause is triggered as
soon as the running spend crosses the cap.

**2. Post-stream gate** (`checkCostLimit(requestIndex)`), fired
from `drainStreamInBackgroundToFindAllUsage` after the request
finishes — catches cases where `usage` arrives only at the very end
or after stream drain. Behaves identically:

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
8. Otherwise call `enforceCostLimit(root, limit, spent)`.

`enforceCostLimit(root, limit, spent)` (shared):

1. Emit `TelemetryEventName.BUDGET_EXCEEDED`.
2. Branch on `limit.action`:
    - `pause` → `askUserForBudgetDecision(root, limit, spent)`.
    - `abort` → cancel in-flight request,
      `await this.abortTask(false)` and root if different.
    - `kill` → cancel in-flight request,
      `await this.abortTask(true)` and root if different.

A third chokepoint guards `new_task` in
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
  secondary button infrastructure (yes = "Continue without limit",
  no = "Abort task", free-text reply with a positive dollar amount =
  new limit). No separate dialog component is needed for the ask
  itself.
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
      `_priorAggregateUsd`, `_costLimitEnforcementFiredForRequest`,
      `resolveCostLimit()`, `invalidateCostLimitCache()`,
      `snapshotPriorAggregateForCostLimit()` (per-request snapshot),
      `checkInFlightCostLimit()` (per-`usage`-chunk in-stream gate),
      `checkCostLimit()` (post-stream gate from
      `drainStreamInBackgroundToFindAllUsage`),
      shared `enforceCostLimit()`, `askUserForBudgetDecision()`
      (yes = "Continue without limit" / no = "Abort task" /
      text = new positive USD limit).
- [x] `new_task` tool guard.
- [x] Default-limit seeding in `ClineProvider.createTask()`.
- [x] `webviewMessageHandler.ts` `updateCostLimit` handler that
      walks to root, updates the live `Task`, invalidates the cache,
      and persists to history.
- [x] UI: TaskHeader inline `$spent / $limit` + pencil affordance
      visible from task start (default seeded immediately, not on
      first request), `BudgetLimitDialog` for live editing, ChatView
      wiring of the `budget_limit` ask to primary/secondary buttons
      with "Continue without limit" / "Abort task" labels.
- [x] Persistence round-trip via `taskMetadata.ts`.
- [x] Telemetry event.
- [x] Unit tests: parent-walk semantics + recursive cost aggregation
      ([`cost-limit.spec.ts`](../src/core/task/__tests__/cost-limit.spec.ts)).

## Bug fixes since 3.53.0

- **3.54.1** — Suppress webview `Ctrl+F` forwarding to host find widget.
- **3.54.2** — `pause`-mode hard-stop on exceed (don't keep yielding
  "Cost limit reached: $X.XX of $Y.YY" messages); surface the seeded
  default cap immediately on task start so the row is visible from
  request 1.
- **3.54.5** — Removed the hard-coded `+ $5` increment on the pause
  dialog (which produced absurdities like `0.04 + 5 = 5.04` for tight
  budgets). The yes button now means "Continue without limit"; to
  raise the cap the user types a new positive USD amount in the chat
  reply.
- **3.54.6** — Added the in-stream `checkInFlightCostLimit` gate
  (above). Previously enforcement only ran from the fire-and-forget
  `drainStreamInBackgroundToFindAllUsage`, so the main loop kicked
  off the next request before the budget `ask` surfaced — meaning a
  tight cap could be exceeded several times over before the prompt
  appeared. The in-stream gate fires on every `usage` chunk and
  cancels the in-flight HTTP request as soon as the running spend
  crosses the cap.
- **3.54.7** — Fixed cumulative-vs-per-request cost mismatch in the
  `vscode-lm` provider. `arkware.llm.getRequestCost` returns the
  running ledger total for the whole conversation, but Roo's pipeline
  expects each `usage` chunk's `totalCost` to be the cost of THIS
  request only (it gets stored on the `apiReqInfo` message and
  re-summed by `consolidateTokenUsage`). The provider now snapshots
  the ledger before the request and yields the delta, so per-message
  accounting and the in-stream gate's `prior + thisReq` math are
  both correct. Without this fix the cap could either fire wildly
  early (ledger over-counted across consolidate) or — when the
  ledger never moved past zero (e.g. composite pricing miss) —
  never fire at all. Also added `[DIAG cost-limit]` provider-log
  output at snapshot/in-flight/enforce points so future
  "exceeded without stopping" reports are debuggable from the
  output channel.

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

For composite (`arkware/*`) models, where the underlying that served
the request is selected per-attempt and a static per-token rate
isn't meaningful, an additional path was added:
`llm-router` stamps `usage.cost` (USD float, OpenRouter convention)
on every chat-completion response based on the underlying model's
real pricing → `llm-provider` accumulates per-`conversationId` in a
bounded LRU ledger → `vscode-lm` queries the running total via
`arkware.llm.getRequestCost` after each stream and yields it as
`totalCost` in the usage chunk. Without this, composites would
report `cost: 0` and the budget limit could never trip on them.

Without either path, vscode-lm-routed models report `cost: 0` and
the budget limit can never trip — this is by design (we only
enforce on real billed cost), but worth flagging to users debugging
"why isn't my limit firing?".

## Versioning

Shipped as Roo-Code **3.53.0** (minor bump): new user-visible
setting, new `ask` type, new persisted field on `HistoryItem`. No
backward-compat shims — missing `costLimit` is treated as "no limit".
Hardened across **3.54.1** – **3.54.6** (see "Bug fixes since
3.53.0" above).
