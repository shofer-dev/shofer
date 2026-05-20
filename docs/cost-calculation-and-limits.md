# Cost Calculation & Per-Root-Task Cost Limit

Status (cost limit): **shipped in 3.53.0**, hardened through 3.54.10.

A user-configurable USD spend cap, scoped to the root task, with
subtask costs aggregated into the root via the existing
`aggregateTaskCostsRecursive` helper. Implements automatic
pause / abort / kill when a task's cumulative cost (root + all
descendant subtasks) reaches the configured limit.

---

## Part 1: Cost Calculation

How Shofer tracks API cost, token usage, and displays totals in the chat UI.

### Overview

Shofer computes the **total cost** for a task by aggregating token usage and pricing data from every AI provider API call made during the conversation, plus any context condensation costs. The total is displayed in the [`TaskHeader`](../webview-ui/src/components/chat/TaskHeader.tsx) at the top of the chat window.

### Data Flow

```
Provider API response
        │
        ▼
Stream chunks ("usage" type)
        │  inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens, totalCost
        ▼
updateApiReqMsg() ──► stamps api_req_started message text (JSON)
        │
        ▼
consolidateTokenUsage() ──► sums all api_req_started + condense_context messages
        │
        ▼
TaskHeader (total cost display)
```

### Key Files

| File                                                                                      | Role                                                                                        |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [`Task.ts`](../src/core/task/Task.ts)                                                     | Emits `api_req_started`, accumulates usage during streaming, calls `updateApiReqMsg()`      |
| [`consolidateTokenUsage.ts`](../packages/core/src/message-utils/consolidateTokenUsage.ts) | Aggregates all `api_req_started` and `condense_context` messages into a `TokenUsage` total  |
| [`ChatRow.tsx`](../webview-ui/src/components/chat/ChatRow.tsx)                            | Renders (or hides) the per-request `api_req_started` row in the chat                        |
| [`TaskHeader.tsx`](../webview-ui/src/components/chat/TaskHeader.tsx)                      | Displays the aggregated total cost                                                          |
| [`cost.ts`](../src/shared/cost.ts)                                                        | Provider-specific pricing functions (`calculateApiCostAnthropic`, `calculateApiCostOpenAI`) |

### Step-by-Step

#### 1. Request Started

When Shofer is about to call the AI provider, it emits a placeholder `api_req_started` message:

```typescript
// Task.ts line ~3418
await this.say(
	"api_req_started",
	JSON.stringify({ apiProtocol, model: modelId, retryAttempt: currentItem.retryAttempt ?? 0 }),
)
```

At this point the message has no cost or token data — just the protocol (`"anthropic"` or `"openai"`), model ID, and retry attempt counter.

#### 2. Streaming — Usage Accumulation

As the provider streams its response, Shofer receives periodic `"usage"` chunks that carry token counts:

```typescript
// Task.ts lines 3735-3741
case "usage":
    inputTokens += chunk.inputTokens
    outputTokens += chunk.outputTokens
    cacheWriteTokens += chunk.cacheWriteTokens ?? 0
    cacheReadTokens += chunk.cacheReadTokens ?? 0
    totalCost = chunk.totalCost
```

#### 3. Message Updated with Cost

The `updateApiReqMsg()` function (Task.ts line 3554) stamps the accumulated usage into the `api_req_started` message's `text` field:

```typescript
this.shoferMessages[lastApiReqIndex].text = JSON.stringify({
	...existingData,
	tokensIn: costResult.totalInputTokens,
	tokensOut: costResult.totalOutputTokens,
	cacheWrites: cacheWriteTokens,
	cacheReads: cacheReadTokens,
	cost: totalCost ?? costResult.totalCost, // provider-reported or Shofer-calculated
})
```

Cost is calculated using provider-specific functions:

- **Anthropic protocol**: [`calculateApiCostAnthropic`](../src/shared/cost.ts)
- **OpenAI protocol**: [`calculateApiCostOpenAI`](../src/shared/cost.ts)

`updateApiReqMsg()` is called:

- During the stream from `drainStreamInBackgroundToFindAllUsage` (captures usage even on interruptions)
- At the end of the stream
- On abort/cancellation (with `cancelReason`)

#### 4. Aggregation — Total Cost

[`consolidateTokenUsage()`](../packages/core/src/message-utils/consolidateTokenUsage.ts:29) walks all messages and sums:

| Source                      | Fields aggregated                                            |
| --------------------------- | ------------------------------------------------------------ |
| `api_req_started` messages  | `tokensIn`, `tokensOut`, `cacheWrites`, `cacheReads`, `cost` |
| `condense_context` messages | `contextCondense.cost`                                       |

```typescript
// consolidateTokenUsage.ts lines 40-71 (simplified)
messages.forEach((message) => {
	if (message.type === "say" && message.say === "api_req_started" && message.text) {
		const parsedText = JSON.parse(message.text)
		const { tokensIn, tokensOut, cacheWrites, cacheReads, cost } = parsedText
		if (typeof tokensIn === "number") {
			result.totalTokensIn += tokensIn
		}
		if (typeof tokensOut === "number") {
			result.totalTokensOut += tokensOut
		}
		if (typeof cacheWrites === "number") {
			result.totalCacheWrites = (result.totalCacheWrites ?? 0) + cacheWrites
		}
		if (typeof cacheReads === "number") {
			result.totalCacheReads = (result.totalCacheReads ?? 0) + cacheReads
		}
		if (typeof cost === "number") {
			result.totalCost += cost
		}
	} else if (message.type === "say" && message.say === "condense_context") {
		result.totalCost += message.contextCondense?.cost ?? 0
	}
})
```

### What Is Counted

- **Every AI provider API call** — each turn that invokes the model (including tool call responses) creates an `api_req_started` message
- **Context condensation** — the cost of running the summarization model to condense conversation history
- **Cancelled/aborted requests** — partial cost is preserved via `updateApiReqMsg(cancelReason, ...)`
- **Background-subtask requests** — aggregated into the parent task's total (shown with `*` indicator for subtask-inclusive totals)

### What Is NOT Counted (Known Gap)

**Orphaned `api_req_started` messages** — if a request was started (`api_req_started` emitted) but the extension crashed or the task was force-closed before ANY response data arrived, the message has no `cost` and no `cancelReason`. These are removed during `saveShoferMessages()`:

```typescript
// Task.ts lines 2517-2519
if (cost === undefined && cancelReason === undefined) {
	modifiedShoferMessages.splice(lastApiReqStartedIndex, 1)
}
```

This means tokens from a request that was initiated but never received any response bytes are lost from the total. In practice this only happens on hard crashes or force-quits.

### Per-Request vs. Total Display

As of the current implementation:

- **Per-request "API Request" rows** are **hidden on success** (cost present, no cancel reason) to avoid chat clutter — same pattern as `tool_preparing` dismissal
- **Failure/cancellation** rows remain visible ("API Request Failed", "API Request Cancelled", "API Streaming Failed")
- **Total cost** in the TaskHeader aggregates all `api_req_started` costs regardless of whether individual rows are hidden

### Sub-Task Cost Aggregation

Parent tasks aggregate costs from all child subtasks. The [`TaskHeader`](../webview-ui/src/components/chat/TaskHeader.tsx) displays:

- `totalCost` — this task's own API costs
- `aggregatedCost` — this task + all subtask costs (when `hasSubtasks` is true)

A `*` indicator shows that the total includes subtask costs.

### Cost Data Paths

Two paths converge on the same `totalCost` field in the `usage` chunk, which feeds the in-stream gate and the `api_req_started` message that `consolidateTokenUsage` sums.

#### Path 1 — static per-token pricing (direct models)

`shofer.llm.getModelPricing` → `vscode-lm.getModel().info`
(`inputPrice` / `outputPrice` / `cacheReadsPrice`) →
`calculateApiCostOpenAI` → `shoferMessages[lastApiReqIndex].cost`.

Landed in `llm-provider` 0.6.0 / Shofer 3.52.87.

Used as the **fallback** whenever the usage chunk carries no
`totalCost` (Path 2 not available). Does not differentiate
cache-hit vs cache-miss tokens because the vscode-lm provider counts
tokens locally (VS Code LM API) and has no per-token cache metadata.

#### Path 2 — `usage.cost` from llm-router (all providers with streaming usage)

`llm-router` computes and stamps `usage.cost` (USD float, OpenRouter
convention) on the final streaming chunk via generic `stampUsageCost`
in [`provider.go`](../../../llm-router/internal/services/provider.go) →
`llm-provider` accumulates per-`conversationId` in a bounded LRU
ledger → `vscode-lm` snapshots the ledger before and after the stream,
yielding the **delta** as `totalCost` in the usage chunk.

Originally added for composite (`shofer/*`) models where the
underlying is selected per-attempt. Now applied **universally** to
every provider whose upstream returns a `usage` object in the
streaming response (OpenAI, Google, Zhipu, Xiaomi, Moonshot, MiniMax,
DeepSeek). The stamping normalises across field-name variations:

| Upstream field                                      | Canonical meaning  |
| --------------------------------------------------- | ------------------ |
| `prompt_tokens_details.cached_tokens` (OpenAI)      | Cache-hit tokens   |
| `cache_read_input_tokens` (Anthropic non-streaming) | Cache-hit tokens   |
| `prompt_cache_hit_tokens` (DeepSeek)                | Cache-hit tokens   |
| `prompt_tokens_details.cache_creation_tokens`       | Cache-write tokens |
| `cache_creation_input_tokens`                       | Cache-write tokens |

Cache-write tokens are billed at `ContextCacheWrite` (or `Prompt` if
unset); cache-read tokens at `ContextCacheRead` (or `Prompt` if
unset). When no cache breakdown is reported, all prompt tokens are
billed at the base `Prompt` rate — correct behaviour.

Anthropic streaming splits usage across two SSE events
(`message_start` carries input tokens, `message_delta` carries output
tokens). The router accumulates these and emits a synthetic usage
chunk after the final `finish_reason` chunk, which `stampUsageCost`
then processes normally.

**When Path 2 is active, `totalCost` arrives in the chunk and
`calculateApiCostOpenAI` is NOT called** — the chunk's value wins
(`totalCost ?? costResult.totalCost` in Task.ts). This avoids
double-counting.

#### Priority

Path 2 always wins when `totalCost` is present in the usage chunk
(ledger delta available). Path 1 is the fallback, still needed for:

- **Non-streaming requests** — [`handleNonStreamingRequest`](../../../llm-router/internal/handlers/chat.go:310)
  does not stamp `usage.cost` on the response (only the streaming path
  does). Non-streaming requests always use Path 1.
- **Unknown models** — if `GetModelByID` returns nil (model not in
  [`model_registry.go`](../../../llm-router/internal/types/model_registry.go:49)),
  `stampUsageCost` returns the chunk unchanged and Path 1 takes over.
- **Defense in depth** — if stamping fails for any reason (malformed
  chunk, pricing not available), Path 1 provides a reasonable estimate.

Without either path, vscode-lm-routed models report `cost: 0` and the
budget limit can never trip — this is by design (we only enforce on
real billed cost), but worth flagging to users debugging "why isn't my
limit firing?".

---

## Part 2: Per-Root-Task Cost Limit

### Why

Shofer already surfaces a per-task `API Cost` and an `aggregatedCost`
that rolls subtask spend into the root task (see
[`aggregateTaskCosts.ts`](../src/core/webview/aggregateTaskCosts.ts) and
the `getTaskWithAggregatedCosts` IPC path in
[`webviewMessageHandler.ts`](../src/core/webview/webviewMessageHandler.ts)).
But there was no enforcement: a runaway agentic loop on a frontier
model — or a poorly-bounded `new_task` tree — could quietly burn
through real money with no upper bound.

### Goals

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

### Non-Goals

- Per-day or per-organisation spend caps (belongs in `llm-router`,
  not in the editor extension).
- Token-count limits (`maxTokens` / context-window pressure is
  handled by `condenseContext`).
- Hard cost prediction before a request is made — enforcement is
  _post-hoc_ on the running aggregate, not pre-flight.

### Design

#### Where the budget lives

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
  `ShoferProvider.createTask()` via
  `contextProxy.getValue("defaultCostLimit")`.
  See also: [`configuration.md`](configuration.md) for all
  `shofer.*` settings.

#### Where the check fires

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

#### UI

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

#### Persistence & restore

- `costLimit` round-trips through
  [`taskMetadata.ts`](../src/core/task-persistence/taskMetadata.ts)
  alongside `totalCost`.
- The `Task` constructor restores `historyItem.costLimit` **only
  when `parentTask` is unset**, enforcing the "single source of
  truth on the root" invariant even if a malformed history item
  carried the field on a subtask.

#### Telemetry

`TelemetryService.captureBudgetExceeded(taskId, {rootTaskId, limitUsd,
spentUsd, action, modelId})` emits the
`TelemetryEventName.BUDGET_EXCEEDED` event before the action runs.

### What's implemented

- [x] Schema additions in `@shofer/types`:
      `budgetActionSchema`, `costLimitSchema`, `historyItem.costLimit`,
      `globalSettings.defaultCostLimit`,
      `shoferAsks.budget_limit` (also added to `interactiveAsks`),
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
- [x] Default-limit seeding in `ShoferProvider.createTask()`.
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

### Bug fixes since 3.53.0

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
  `vscode-lm` provider. `shofer.llm.getRequestCost` returns the
  running ledger total for the whole conversation, but Shofer's pipeline
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
- **3.54.8 – 3.54.10** — Iterated on the composite-cost path end-to-end
  to confirm the in-stream gate fires for `shofer/*` models. Validated
  in production logs: `[vscode-lm] cost ledger: before=0.005237
after=0.015193 perRequest=0.009956` followed immediately by
  `[DIAG cost-limit] in-flight: prior=0.005237 + thisReq=0.009956 =
spent=0.015193, limit=0.01, willFire=true` and
  `[DIAG cost-limit] enforce: action=pause, spent=0.015193,
limit=0.01`. Pairs with `llm-router` 0.8.9 (forces
  `stream_options.include_usage=true` so OpenAI-compatible upstreams
  emit the final usage chunk that carries the stamped `usage.cost`)
  and `llm-provider` 0.6.1 (per-conversation cost ledger and
  `shofer.llm.getRequestCost` command).

### What was deferred

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
- [x] ~~AGENTS.md / `extensions/llm-provider/README.md` doc updates
      mentioning the dependency on `shofer.llm.getModelPricing`.~~
      → Done: [Operational Dependencies](#operational-dependencies) section documents both cost
      paths end-to-end, covering `shofer.llm.getModelPricing`,
      `shofer.llm.getRequestCost`, and the llm-router cost-stamping
      pipeline.

### Operational Dependencies

The llm-provider integration is **opt-in** and controlled by the
`shofer.enableLlmProviderIntegration` setting (default: `false`).
When disabled, Shofer operates without the llm-provider — token counts
are available but USD pricing and cost-limit enforcement are not.

When enabled, both cost paths depend on well-known VS Code commands
registered by the **Shofer LLM Model Provider** extension
([`extensions/llm-provider/`](../../../extensions/llm-provider/)):

| Command                           | Registers in                                                           | Consumed by                                         | Role                                                     |
| --------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------- |
| `shofer.llm.getModelPricing`      | [`llm-provider/main.ts`](../../../extensions/llm-provider/src/main.ts) | [`vscode-lm.ts`](../src/api/providers/vscode-lm.ts) | Path 1: per-token USD rates for `calculateApiCostOpenAI` |
| `shofer.llm.getRequestCost`       | [`llm-provider/main.ts`](../../../extensions/llm-provider/src/main.ts) | [`vscode-lm.ts`](../src/api/providers/vscode-lm.ts) | Path 2: per-conversation cumulative USD cost             |
| `shofer.llm.getModelCapabilities` | [`llm-provider/main.ts`](../../../extensions/llm-provider/src/main.ts) | [`vscode-lm.ts`](../src/api/providers/vscode-lm.ts) | Tool calling, image input, prompt cache flags            |

If the llm-provider extension is **not installed**, **not activated**,
or its command names **don't match** what the vscode-lm provider
expects, both cost paths silently return `undefined`. The consequence:
`totalCost` stays at `$0` for every request, `consolidateTokenUsage`
reports zero, and the budget limit can never trip.

**Diagnostics (v3.56.x+):** When `enableLlmProviderIntegration` is
enabled, the vscode-lm provider logs a one-shot warning to the Shofer
output channel when any of these commands fails:

```
[vscode-lm] shofer.llm.getModelPricing command not found — is the Shofer LLM Model Provider extension installed and active?
[vscode-lm] shofer.llm.getRequestCost command not found — is the Shofer LLM Model Provider extension installed and active?
```

If you have enabled the integration but still see `cost: $0` for every
request and the budget limit never trips, check the Shofer output
channel for these messages.

### Versioning

Shipped as Shofer **3.53.0** (minor bump): new user-visible
setting, new `ask` type, new persisted field on `HistoryItem`. No
backward-compat shims — missing `costLimit` is treated as "no limit".
Hardened across **3.54.1** – **3.54.10** (see "Bug fixes since
3.53.0" above).
