# Cost Calculation

How Roo Code tracks API cost, token usage, and displays totals in the chat UI.

## Overview

Roo Code computes the **total cost** for a task by aggregating token usage and pricing data from every AI provider API call made during the conversation, plus any context condensation costs. The total is displayed in the [`TaskHeader`](../webview-ui/src/components/chat/TaskHeader.tsx) at the top of the chat window.

## Data Flow

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

## Key Files

| File                                                                                      | Role                                                                                        |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [`Task.ts`](../src/core/task/Task.ts)                                                     | Emits `api_req_started`, accumulates usage during streaming, calls `updateApiReqMsg()`      |
| [`consolidateTokenUsage.ts`](../packages/core/src/message-utils/consolidateTokenUsage.ts) | Aggregates all `api_req_started` and `condense_context` messages into a `TokenUsage` total  |
| [`ChatRow.tsx`](../webview-ui/src/components/chat/ChatRow.tsx)                            | Renders (or hides) the per-request `api_req_started` row in the chat                        |
| [`TaskHeader.tsx`](../webview-ui/src/components/chat/TaskHeader.tsx)                      | Displays the aggregated total cost                                                          |
| [`cost.ts`](../src/shared/cost.ts)                                                        | Provider-specific pricing functions (`calculateApiCostAnthropic`, `calculateApiCostOpenAI`) |

## Step-by-Step

### 1. Request Started

When Roo is about to call the AI provider, it emits a placeholder `api_req_started` message:

```typescript
// Task.ts line ~3150
await this.say("api_req_started", JSON.stringify({ apiProtocol }))
```

At this point the message has no cost or token data — just the protocol (`"anthropic"` or `"openai"`).

### 2. Streaming — Usage Accumulation

As the provider streams its response, Roo receives periodic `"usage"` chunks that carry token counts:

```typescript
// Task.ts lines 3438-3441
case "usage":
    inputTokens += chunk.inputTokens
    outputTokens += chunk.outputTokens
    cacheWriteTokens += chunk.cacheWriteTokens ?? 0
    cacheReadTokens += chunk.cacheReadTokens ?? 0
    totalCost = chunk.totalCost
```

### 3. Message Updated with Cost

The `updateApiReqMsg()` function (Task.ts line 3261) stamps the accumulated usage into the `api_req_started` message's `text` field:

```typescript
this.clineMessages[lastApiReqIndex].text = JSON.stringify({
	...existingData,
	tokensIn: costResult.totalInputTokens,
	tokensOut: costResult.totalOutputTokens,
	cacheWrites: cacheWriteTokens,
	cacheReads: cacheReadTokens,
	cost: totalCost ?? costResult.totalCost, // provider-reported or Roo-calculated
})
```

Cost is calculated using provider-specific functions:

- **Anthropic protocol**: [`calculateApiCostAnthropic`](../src/shared/cost.ts)
- **OpenAI protocol**: [`calculateApiCostOpenAI`](../src/shared/cost.ts)

`updateApiReqMsg()` is called:

- During the stream from `drainStreamInBackgroundToFindAllUsage` (captures usage even on interruptions)
- At the end of the stream
- On abort/cancellation (with `cancelReason`)

### 4. Aggregation — Total Cost

[`consolidateTokenUsage()`](../packages/core/src/message-utils/consolidateTokenUsage.ts:29) walks all messages and sums:

| Source                      | Fields aggregated                                            |
| --------------------------- | ------------------------------------------------------------ |
| `api_req_started` messages  | `tokensIn`, `tokensOut`, `cacheWrites`, `cacheReads`, `cost` |
| `condense_context` messages | `contextCondense.cost`                                       |

```typescript
// consolidateTokenUsage.ts lines 40-70
messages.forEach((message) => {
	if (message.say === "api_req_started" && message.text) {
		const { tokensIn, tokensOut, cacheWrites, cacheReads, cost } = JSON.parse(message.text)
		result.totalTokensIn += tokensIn
		result.totalTokensOut += tokensOut
		result.totalCost += cost
		// ...
	} else if (message.say === "condense_context") {
		result.totalCost += message.contextCondense?.cost ?? 0
	}
})
```

## What Is Counted

- **Every AI provider API call** — each turn that invokes the model (including tool call responses) creates an `api_req_started` message
- **Context condensation** — the cost of running the summarization model to condense conversation history
- **Cancelled/aborted requests** — partial cost is preserved via `updateApiReqMsg(cancelReason, ...)`
- **Background-subtask requests** — aggregated into the parent task's total (shown with `*` indicator for subtask-inclusive totals)

## What Is NOT Counted (Known Gap)

**Orphaned `api_req_started` messages** — if a request was started (`api_req_started` emitted) but the extension crashed or the task was force-closed before ANY response data arrived, the message has no `cost` and no `cancelReason`. These are removed during `saveClineMessages()`:

```typescript
// Task.ts lines 2344-2350
if (cost === undefined && cancelReason === undefined) {
	modifiedClineMessages.splice(lastApiReqStartedIndex, 1)
}
```

This means tokens from a request that was initiated but never received any response bytes are lost from the total. In practice this only happens on hard crashes or force-quits.

## Per-Request vs. Total Display

As of the current implementation:

- **Per-request "API Request" rows** are **hidden on success** (cost present, no cancel reason) to avoid chat clutter — same pattern as `tool_preparing` dismissal
- **Failure/cancellation** rows remain visible ("API Request Failed", "API Request Cancelled", "API Streaming Failed")
- **Total cost** in the TaskHeader aggregates all `api_req_started` costs regardless of whether individual rows are hidden

## Sub-Task Cost Aggregation

Parent tasks aggregate costs from all child subtasks. The [`TaskHeader`](../webview-ui/src/components/chat/TaskHeader.tsx) displays:

- `totalCost` — this task's own API costs
- `aggregatedCost` — this task + all subtask costs (when `hasSubtasks` is true)

A `*` indicator shows that the total includes subtask costs.
