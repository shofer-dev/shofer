# Cost Calculation & Per-Root-Task Cost Limit

Status (cost limit): **shipped in 3.53.0**, hardened through 3.54.11.

Backend coverage: enforcement is **backend-agnostic** — see the
[Backend Coverage Matrix](#backend-coverage-matrix) for how cost is
sourced (provider-stamped vs local-pricing fallback) for each of
llm-router, shofer-router/llm-provider, OpenRouter, and direct upstream
providers, and [Known Gaps by backend](#known-gaps-by-backend) for the
residual cases where cost is unknowable and the cap therefore can't
trip.

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

| File                                                                                      | Role                                                                                                              |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [`Task.ts`](../src/core/task/Task.ts)                                                     | Emits `api_req_started`, accumulates usage during streaming, calls `updateApiReqMsg()`                            |
| [`consolidateTokenUsage.ts`](../packages/core/src/message-utils/consolidateTokenUsage.ts) | Aggregates all `api_req_started` and `condense_context` messages into a `TokenUsage` total                        |
| [`ChatRow.tsx`](../webview-ui/src/components/chat/ChatRow.tsx)                            | Renders (or hides) the per-request `api_req_started` row in the chat                                              |
| [`TaskHeader.tsx`](../webview-ui/src/components/chat/TaskHeader.tsx)                      | Displays the aggregated total cost                                                                                |
| [`cost.ts`](../src/shared/cost.ts)                                                        | Provider-specific pricing functions (`calculateApiCostAnthropic`, `calculateApiCostOpenAI`, `applyCustomPricing`) |
| [`api/index.ts`](../src/api/index.ts)                                                     | `buildApiHandler` — wraps `getModel()` to apply `customPricing` overrides when set                                |
| [`provider-settings.ts`](../packages/types/src/provider-settings.ts)                      | `customPricing` schema field on `baseProviderSettingsSchema`                                                      |

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

### Workflow Header — Whole-Tree Cost & Tokens

A `WorkflowTask` is a deterministic orchestrator that makes **no LLM calls of its
own**, so its own cost/tokens are ~0 and per-task metrics like **Context Length**
and **Size** don't apply. The workflow surface therefore uses a dedicated
[`WorkflowHeader`](../webview-ui/src/components/chat/WorkflowHeader.tsx) (a fork of
[`TaskHeader`](../webview-ui/src/components/chat/TaskHeader.tsx)) that:

- **drops** Context Length, the context-window progress bar, Cache, and Size, and
- shows **API Cost** and **Tokens** aggregated across the **entire task tree**
  (the workflow + every agent it spawned, recursively).

The aggregates come from [`aggregateTaskCostsRecursive`](../src/core/webview/aggregateTaskCosts.ts),
which walks `HistoryItem.childIds` and now sums `tokensIn`/`tokensOut` alongside
`totalCost`. They are requested via `getTaskWithAggregatedCosts` and delivered on
the `taskWithAggregatedCosts` message (`aggregatedCosts: { totalCost, ownCost,
childrenCost, tokensIn, tokensOut }`). Cost was already aggregated; **token
aggregation was added** so the workflow header's Tokens row reflects real
tree-wide usage instead of the orchestrator's empty own-count.

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

#### Path 3 — `customPricing` manual override (user-supplied, per-provider-profile)

Users can supply explicit per-token prices (USD / 1 M tokens) in
**Settings → Providers → Advanced Settings → Pricing Override**. The
four configurable fields are:

| Field              | Overrides                    |
| ------------------ | ---------------------------- |
| `inputPrice`       | `ModelInfo.inputPrice`       |
| `outputPrice`      | `ModelInfo.outputPrice`      |
| `cacheReadsPrice`  | `ModelInfo.cacheReadsPrice`  |
| `cacheWritesPrice` | `ModelInfo.cacheWritesPrice` |

**How it works:**

`customPricing` is stored as an optional field in `ProviderSettings`
(schema: `baseProviderSettingsSchema.customPricing`). When
`buildApiHandler` constructs a handler, it wraps the underlying
handler's `getModel()` with a thin closure:

```ts
// src/api/index.ts
raw.getModel = () => {
	const m = rawGetModel() // auto-discovered
	return { id: m.id, info: applyCustomPricing(m.info, customPricing) }
}
```

`applyCustomPricing` (in `src/shared/cost.ts`) merges only the fields
that are set to a numeric value; `undefined` fields are silently
skipped and the auto-discovered value is kept:

```ts
return { ...modelInfo, ...overrides } // custom values overwrite auto-discovered
```

**Priority across all three paths:**

```
customPricing (manual, Path 3)
    └── overrides ModelInfo returned by getModel()
            └── Path 1 (static per-token pricing) uses that ModelInfo
            └── Path 2 (usage.cost from llm-router) wins over Path 1
                    but does NOT bypass customPricing —
                    customPricing affects ModelInfo only; if Path 2
                    delivers totalCost directly, customPricing has no
                    effect on that value.
```

In practice: if `customPricing` is set and Path 2 is active (the
router stamps `totalCost`), the router's value is used as-is and the
custom prices have no effect. Custom prices are most useful for
providers where Path 2 is unavailable (non-streaming, unknown models,
or providers not routed through llm-router).

**Backward compatibility:** `customPricing` is fully optional. Existing
profiles without the field behave exactly as before — `getModel()` is
not wrapped and auto-discovery runs unchanged.

---

## Backend Coverage Matrix

The cost-limit machinery in `Task.ts` is **backend-agnostic by
construction**: it never special-cases a provider. Enforcement depends
on exactly two values being correct for whichever backend serves the
traffic:

- **`usage` chunk `totalCost`** — feeds the tight in-stream gate
  (`checkInFlightCostLimit`). Either the backend stamps it, or
  `estimateRequestCostUsd` computes it locally from token counts ×
  `getModel().info` pricing.
- **persisted `cost`** (`totalCost ?? calculateApiCost*`) — feeds the
  post-stream aggregate (`checkCostLimit`) and the TaskHeader total via
  `consolidateTokenUsage`.

If a backend supplies a usable cost on **either** axis, limits enforce.
The only way enforcement can silently fail is when a request's cost is
genuinely `0`/unknown on **both** axes — i.e. the backend stamps no
cost AND `getModel().info` has no pricing. The matrix below maps each
backend the user can route through to its cost source.

| Backend (as the user sees it)                       | Shofer provider / path                   | Stamps `usage.totalCost`?                                                             | Local-pricing fallback works?                                   | In-stream gate                      | Post-stream gate       |
| --------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------- | ---------------------- |
| **Direct upstream — Anthropic**                     | `anthropic.ts`                           | ✅ `calculateApiCostAnthropic` on final chunk                                         | ✅ (self-computed)                                              | ✅                                  | ✅                     |
| **Direct upstream — OpenAI (native)**               | `openai-native.ts`                       | ✅ `calculateApiCostOpenAI` (tier-aware)                                              | ✅                                                              | ✅                                  | ✅                     |
| **Direct upstream — Gemini**                        | `gemini.ts`                              | ✅ unless model lacks pricing                                                         | ✅ priced models                                                | ✅ priced models                    | ✅ priced models       |
| **Direct upstream — OpenAI-compatible**             | `openai.ts`                              | ❌ never stamps                                                                       | ✅ **only if** custom model info has prices (sane defaults = 0) | ✅ via fallback (was ❌ pre-fix)    | ✅ if priced           |
| **Direct upstream — Bedrock**                       | `bedrock.ts`                             | ❌ never stamps                                                                       | ⚠️ priced models only; custom-ARN / guessed models = 0          | ✅ via fallback for priced (was ❌) | ✅ if priced           |
| **Direct upstream — DeepSeek**                      | `deepseek.ts`                            | ❌ never stamps                                                                       | ✅ `deepSeekModels` has real prices                             | ✅ via fallback (was ❌)            | ✅                     |
| **OpenRouter (direct)**                             | `openrouter.ts`                          | ✅ provider-reported `cost` + `upstream_inference_cost`                               | ⚠️ weak (varies)                                                | ✅ when OR returns cost             | ✅                     |
| **llm-router (local) — `shofer/*` & routed models** | `shofer.ts` (extends OpenRouter handler) | ✅ iff llm-router stamps `usage.cost`                                                 | ⚠️ composite info often has `inputPrice: 0`                     | ✅ when stamped                     | ✅ when stamped        |
| **shofer-router / llm-provider (VS Code LM)**       | `vscode-lm.ts`                           | ✅ iff `enableLlmProviderIntegration` **and** `shofer.router.getRequestCost` resolves | ⚠️ pricing also via side-channel; `0` when integration off      | ✅ when integration on              | ✅ when integration on |

Legend: ✅ enforced, ⚠️ conditional (depends on pricing data),
❌ cannot enforce. "(was ❌)" marks the in-stream gaps closed by the
`estimateRequestCostUsd` fallback (this change).

### Known Gaps by backend

These are the residual cases where cost can be `0`/unknown on both
axes, so the cap cannot trip. None are silent regressions of the
fallback — they are inherent "we can't price it" situations, listed so
operators debugging "my limit never fired" know where to look.

**Shofer-extension side (enforcement chokepoint):**

1. **Unpriced models** — any provider whose `getModel().info` has no
   `inputPrice`/`outputPrice` AND stamps no `totalCost` reports `0`.
   Affects: raw `openai.ts` against an OpenAI-compatible endpoint with
   no custom model info (sane defaults carry `0` prices); custom-ARN or
   `guessModelInfoFromId` Bedrock models; `vscode-lm` when
   `enableLlmProviderIntegration` is off (default) — both the cost
   side-channel and the pricing side-channel return `undefined`, so
   `info.inputPrice/outputPrice` default to `0`. **Mitigation:** set a
   `customPricing` override (Path 3) so the fallback has real prices.

2. **Composite `shofer/*` models** — their `ModelInfo` frequently
   carries `inputPrice: 0` (the real price is per-attempt and only
   known after the router selects an upstream). When llm-router stamps
   `usage.cost` (the normal case) this is fine; if stamping is missing
   the local fallback is `0`. Depends on llm-router behavior below.

**llm-router side (cost accuracy when traffic transits the router):**
verified in [`internal/services/provider.go`](../../../llm-router/internal/services/provider.go)
and [`internal/services/cost_stamper.go`](../../../llm-router/internal/services/cost_stamper.go).

3. **Non-streaming requests are not cost-stamped.**
   `handleNonStreamingRequest`
   ([`chat.go`](../../../llm-router/internal/handlers/chat.go)) never
   calls `stampUsageCost`/`stampCostInChatBody` (only the composite
   layer and the streaming loop stamp). A non-streaming direct request
   returns `usage` with no `cost`. Shofer's local fallback covers the
   cap **if** the model is priced; the displayed cost relies on the
   fallback too. **Recommended fix:** stamp cost in the non-streaming
   handler, mirroring the streaming path.

4. **OpenRouter-via-llm-router is uncosted.** `GetProviderForModel`
   defaults any unknown model id to OpenRouter, and the model registry
   has **zero** OpenRouter entries, so `GetModelByID` returns nil and
   `stampUsageCost` leaves the chunk uncosted. The router also does not
   set `usage: { include: true }` on the outbound OpenRouter request,
   so OpenRouter's own cost is never requested or passed through.
   **Recommended fix:** request OpenRouter usage-accounting and pass
   through its `cost`, or recompute from a registry entry.

5. **Discount divergence (needs an owner decision, NOT yet changed).**
   The streaming stamper `stampUsageCost` (provider.go) does **not**
   apply the registry's `Discount` field; the composite stamper
   `computeCostUSD` (cost_stamper.go) multiplies by `(1 - Discount)`
   unconditionally. The registry comments label these as "50% **batch**
   discount", which implies the discount should apply only to
   batch-API traffic — making the composite path's unconditional
   `(1 - Discount)` the likely bug (under-billing real-time traffic by
   ~2×), not the streaming path's omission. Because the correct
   semantics depend on whether composite/real-time traffic ever uses
   the batch API, this is flagged for the router owner rather than
   "fixed" here. Either way the two paths must agree.

**shofer-router vs llm-provider (the VS Code LM side-channel):**

6. **The live cost path recomputes; it does not read the router's
   stamped `usage.cost`.** `vscode-lm.ts` calls the **`shofer.router.*`**
   commands (registered by the **shofer-router** extension), gated
   behind the setting named `enableLlmProviderIntegration` (the
   documented "naming wart" — see
   [Operational Dependencies](#operational-dependencies)).
   shofer-router's ledger fills from a **local** `computeCost(model,
tokens…)` against its own registry, **not** from the upstream
   `usage.cost`. (The separate `llm-provider` extension's ledger _does_
   read `usage.cost`, but `vscode-lm.ts` does not call its
   `shofer.llm.*` commands, so that path is dead for this consumer.)
   Consequence: if shofer-router's registry is missing a served model,
   `computeCost` returns `0` and the ledger stays `0` forever even when
   llm-router stamped a correct cost — `getRequestCost` then yields a
   `0` delta and the cap can't trip via this backend. **Recommended
   fix:** have shofer-router prefer the upstream-stamped `usage.cost`
   when present, falling back to local recompute only when absent
   (i.e. converge its behavior with llm-provider's).

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
    - `abort` — `root.abortTask(false)` (clean abort: graceful stream
      teardown, error diagnostics persisted, user input salvaged).
    - `kill` — `root.abortTask(true)` (abandoned: skips stream teardown,
      drops error reporting and in-flight input; suppresses unhandled
      rejections to avoid host-process crashes). Intended for headless /
      CLI / evals. See [Design → Where the check fires](#where-the-check-fires)
      for a detailed breakdown of the four behavioral differences.
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
   `spent = _priorAggregateUsd + currentRequestCostUsd`, where
   `currentRequestCostUsd = chunk.totalCost ?? estimateRequestCostUsd(…)`.
   When the backend stamps a per-request `totalCost` (anthropic,
   openai-native, gemini, openrouter, llm-router/shofer-router via
   vscode-lm) the chunk value is used. When it does NOT (openai.ts,
   bedrock.ts, deepseek.ts, raw OpenAI-compatible endpoints), the gate
   falls back to a **local-pricing estimate** computed from the
   accumulated token counters via the same protocol-aware
   `calculateApiCost{Anthropic,OpenAI}` math `updateApiReqMsg` uses for
   the persisted `cost` field. This is what makes the tight cap enforce
   _regardless of which backend serves the traffic_ — see
   [`estimateRequestCostUsd`](../src/core/task/Task.ts) and the
   [Backend Coverage Matrix](#backend-coverage-matrix).
3. Bypass if `_costLimitBypassed`,
   `_costLimitEnforcementFiredForRequest`, or no snapshot.
4. If `spent >= limit.maxUsd`, latch the per-request flag and call
   `enforceCostLimit(root, limit, spent)` (shared with the
   post-stream check).

This is what makes the cap _tight_ — a single expensive completion
can't silently blow past a small limit (e.g. $0.05) before the
post-stream check fires, because the abort/pause is triggered as
soon as the running spend crosses the cap.

> **Before the fallback (≤ 3.54.10):** `checkInFlightCostLimit`
> no-opped whenever `chunk.totalCost` was `undefined`. The in-stream
> gate therefore only ever fired for backends that self-report cost;
> for openai.ts / bedrock.ts / deepseek.ts the tight cap was dead and
> enforcement degraded to the post-stream boundary, where a single
> expensive completion could already have blown past a small limit.
> The local-pricing fallback closes that gap. The estimate is `0` only
> when the model carries no pricing info at all (then nothing fires —
> by design we only cap real, priced spend; see
> [Known Gaps](#known-gaps-by-backend)).

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

Both `abort` and `kill` call the same `abortTask()` method, differing
only in the `isAbandoned` boolean parameter. `kill` sets
`this.abandoned = true` inside `abortTask()`, which has four practical
effects beyond changing the `TaskAborted` reason from `"user"` to
`"abandoned"`:

1. **Skips graceful HTTP stream abort** — under `abort` (`isAbandoned=false`),
   the streaming loop calls `abortStream("user_cancelled")` to cleanly
   tear down the HTTP connection before proceeding. Under `kill`
   (`isAbandoned=true`), this call is skipped entirely (Task.ts line
   4415). If the provider's stream is hanging (e.g. OpenRouter), the
   dangling stream is orphaned with no graceful-shutdown handshake.

2. **Drops in-flight error diagnostics** — under `abort`, any error
   caught during the streaming loop is persisted via
   `snapshotApiReqError()` and `api_req_failed` is emitted to the chat
   UI so the user can see what happened. Under `kill`, all error
   reporting is suppressed (Task.ts line 4632).

3. **Silently discards in-flight user input** — under `abort`, if a
   typed message arrives mid-abort but after the ask cleared,
   `handleWebviewAskResponse` prepends it back to the message queue
   (Task.ts line 2320). Under `kill`, the message is silently dropped.

4. **Suppresses unhandled rejections** — three catch blocks in
   `startTask()` and the resume/cancellation race handler (Task.ts
   lines 2849, 2857, 3191) use `this.abandoned` as a guard to
   swallow errors that would otherwise become unhandled promise
   rejections and crash the VS Code extension host process. Under
   `abort`, errors may still re-throw in narrow timing windows
   (before `this.abort` is set). Under `kill`, the `abandoned=true`
   flag guarantees all three catch blocks swallow.

In summary: `kill` tears down the task tree identically to `abort`
(disposal, background children, MCP calls, cost flush) but omits every
user-facing and stream-facing graceful step. It is designed for
automated / eval / headless scenarios where there is no user to show
errors to and hanging streams should be left to time out on their own.

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
      `estimateRequestCostUsd()` (local-pricing fallback so the
      in-stream gate enforces for backends that don't stamp
      `totalCost` — see [Backend Coverage Matrix](#backend-coverage-matrix)),
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
- **3.54.11** — **In-stream gate now enforces regardless of backend.**
  `checkInFlightCostLimit` previously no-opped whenever the backend
  didn't stamp `chunk.totalCost`, so the tight cap was dead for
  `openai.ts` / `bedrock.ts` / `deepseek.ts` (and any OpenAI-compatible
  endpoint) — enforcement degraded to the post-stream boundary, where a
  single expensive completion could already have blown past a small
  limit. Added `estimateRequestCostUsd()`: when the chunk carries no
  `totalCost`, the gate falls back to a local-pricing estimate from the
  accumulated token counters (same protocol-aware
  `calculateApiCost{Anthropic,OpenAI}` math `updateApiReqMsg` uses for
  the persisted cost), so the in-stream and post-stream gates agree on
  what an un-stamped request costs. The estimate is `0` only for models
  with no pricing info (then nothing fires — by design we only cap real,
  priced spend). New unit tests lock the fallback contract
  (positive estimate for priced models, `0` for unpriced) in
  [`cost-limit.spec.ts`](../src/core/task/__tests__/cost-limit.spec.ts).
  See the [Backend Coverage Matrix](#backend-coverage-matrix) and
  [Known Gaps by backend](#known-gaps-by-backend) for the full
  per-backend picture, including the residual llm-router-side gaps
  (non-streaming not stamped, OpenRouter uncosted, discount divergence)
  that remain open.

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
      untouched; current tests cover the pure pieces). Behavioral
      differences between `abort` and `kill` are documented in
      [Design → Where the check fires](#where-the-check-fires).
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

| Command                              | Registers in                                                             | Consumed by                                         | Role                                                     |
| ------------------------------------ | ------------------------------------------------------------------------ | --------------------------------------------------- | -------------------------------------------------------- |
| `shofer.router.getModelPricing`      | [`shofer-router/main.ts`](../../../extensions/shofer-router/src/main.ts) | [`vscode-lm.ts`](../src/api/providers/vscode-lm.ts) | Path 1: per-token USD rates for `calculateApiCostOpenAI` |
| `shofer.router.getRequestCost`       | [`shofer-router/main.ts`](../../../extensions/shofer-router/src/main.ts) | [`vscode-lm.ts`](../src/api/providers/vscode-lm.ts) | Path 2: per-conversation cumulative USD cost             |
| `shofer.router.getModelCapabilities` | [`shofer-router/main.ts`](../../../extensions/shofer-router/src/main.ts) | [`vscode-lm.ts`](../src/api/providers/vscode-lm.ts) | Tool calling, image input, prompt cache flags            |

> **Naming wart:** `vscode-lm.ts` actually calls the **`shofer.router.*`** commands
> registered by the **`shofer-router`** extension (verified in source), not the
> `shofer.llm.*` commands of `llm-provider` — even though the gating setting is named
> `enableLlmProviderIntegration`. Both extensions register the same logical commands
> under different namespaces; this is an unresolved architectural inconsistency (see
> [`images.md`](images.md#gaps-issues--improvement-areas)).

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

### Gaps, Issues & Improvements

These are accuracy and maintainability issues discovered during the
May 2026 doc-review verification (all corrected inline).

#### Line-Number Drift (caused by file growth)

When originally written, `Task.ts` was ~3,250 lines. By May 2026 it
had grown to 6,122 lines. Every code-example line number was off by
170–300 lines. There is no automated mechanism to detect this drift
other than a manual grep-and-compare pass.

**Corrected references:**

| Symbol                         | Doc claimed | Actual (May 2026) |
| ------------------------------ | ----------- | ----------------- |
| `api_req_started` emission     | ~3150       | 3418              |
| `case "usage":`                | 3438-3441   | 3735-3741         |
| `updateApiReqMsg()` definition | 3261        | 3554              |
| Orphan cleanup check           | 2344-2350   | 2517-2519         |

#### Code Example Simplifications

- The `api_req_started` example omitted the `model: modelId` and
  `retryAttempt` fields present in the actual source.
- The `consolidateTokenUsage.ts` example omitted the
  `message.type === "say"` guard and the `typeof` numeric checks
  that the real code uses for defensive parsing.

#### Potential Future Improvements

- [ ] Add a CI/lint rule or script that verifies doc line numbers
      against current source (similar to a link checker).
- [ ] Mark code examples that are simplified with a visible
      "(simplified)" annotation (already done for
      `consolidateTokenUsage.ts` in this review).
- [ ] Consider using symbol names (e.g. `#updateApiReqMsg`) instead
      of line numbers in doc anchors, since line numbers drift but
      function names are stable.

### Versioning

Shipped as Shofer **3.53.0** (minor bump): new user-visible
setting, new `ask` type, new persisted field on `HistoryItem`. No
backward-compat shims — missing `costLimit` is treated as "no limit".
Hardened across **3.54.1** – **3.54.11** (see "Bug fixes since
3.53.0" above). **3.54.11** made the in-stream gate backend-agnostic
via the `estimateRequestCostUsd` local-pricing fallback — a behavior
change for backends that don't stamp `totalCost` (the tight cap now
fires for them too), with no schema or persistence change.
