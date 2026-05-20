# Task Export — Design & Implementation

> User-facing reference: [`task-export.md`](task-export.md)

## Overview

Shofer provides two export formats for task history:

| Format       | File                 | Source                                                                     |
| ------------ | -------------------- | -------------------------------------------------------------------------- |
| **Markdown** | `export-markdown.ts` | `api_conversation_history.json`                                            |
| **JSON**     | `export-json.ts`     | `api_conversation_history.json` + `ui_messages.json` + `history_item.json` |

Both are triggered from the task header buttons in [`TaskActions.tsx`](../webview-ui/src/components/chat/TaskActions.tsx), which send `exportCurrentTask` / `exportCurrentTaskJson` webview messages.

## Data Flow

```
┌─────────────────────────────────────────────────────────┐
│                    Webview (TaskActions.tsx)              │
│  exportCurrentTask / exportCurrentTaskJson                │
└─────────────────────┬───────────────────────────────────┘
                      │ postMessage
                      ▼
┌─────────────────────────────────────────────────────────┐
│              webviewMessageHandler.ts                     │
│  routes → provider.exportTaskWithId(id)                   │
│         → provider.exportTaskWithIdJson(id)               │
└─────────────────────┬───────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────┐
│                  ShoferProvider.ts                        │
│  getTaskWithId(id) → { historyItem,                      │
│    apiConversationHistory, uiMessagesFilePath }           │
│                                                          │
│  exportTaskWithId():                                      │
│    downloadTask(ts, apiConversationHistory, defaultUri)   │
│                                                          │
│  exportTaskWithIdJson():                                  │
│    reads ui_messages.json from disk                       │
│    buildJsonTrace(...)                                    │
│    downloadJsonTask(ts, trace, defaultUri)                │
└─────────────────────┬───────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────┐
│  export-markdown.ts          export-json.ts               │
│  formatContentBlockToMd()    buildJsonTrace()             │
│  downloadTask()              getJsonExportFileName()      │
│                              downloadJsonTask()           │
│                              estimateTokens()             │
│                              estimateMessageTokens()      │
└─────────────────────────────────────────────────────────┘
```

## Data Sources

All three files live under `{globalStorageUri}/tasks/{taskId}/`:

| File                            | Written by                           | Contents                                                                                                                            |
| ------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `history_item.json`             | `TaskHistoryStore`                   | `HistoryItem` — task metadata (id, task, mode, ts, tokens, cost, size)                                                              |
| `api_conversation_history.json` | `Task.addToApiConversationHistory()` | `Anthropic.Messages.MessageParam[]` — full message history with tool_use, tool_result, reasoning, thinking, thoughtSignature blocks |
| `ui_messages.json`              | `Task.saveShoferMessages()`          | `ShoferMessage[]` — UI-level messages including `api_req_started` entries with per-call metadata                                    |

## JSON Export Schema

The JSON export produces a [`JsonExportTrace`](../src/integrations/misc/export-json.ts) with one [`JsonExportCall`](../src/integrations/misc/export-json.ts) per API request. Each call entry includes:

### Conversation Data (from `api_conversation_history.json`)

- `messages` — Anthropic-format message array for this API call
- `toolCalls` — extracted tool uses with their results
- `reasoning` — chain-of-thought / extended thinking content

### Per-Call Metadata (from `ui_messages.json` → `api_req_started`)

- `apiProtocol`, `model`
- `inputTokens`, `outputTokens`, `cacheWriteTokens`, `cacheReadTokens`
- `costUsd`
- `cancelled`, `cancelReason`, `streamingFailedMessage`
- `retryAttempt` — number of retries before this attempt
- `error` — structured error info if the call failed
- `wireRequest` — serialised wire-level request metadata

### Token Estimation

When the provider does not emit `usage` chunks in streaming mode, token counts are estimated via char/4 heuristic. Affected calls are marked with `_tokensEstimated: true`.

## Call Partitioning

The [`buildJsonTrace()`](../src/integrations/misc/export-json.ts) function partitions `apiConversationHistory` by assistant message boundaries:

1. Walk the message array sequentially
2. Each `assistant` message closes an API call
3. Collect all messages from `currentCallStart` through the assistant message
4. Match with the `api_req_started` entry at the same `callIndex`

### Error-Only Calls

API calls that never received an assistant response (connection failures, rate limits, empty streams) are handled by a post-loop `while` block that catches any unmatched `api_req_started` entries. These get call entries with `messages: []`, `toolCalls: []` but still carry their error, wire request, and metadata.

## Wire Traffic Capture

### What's Captured

Before each `this.api.createMessage()` call in [`attemptApiRequest()`](../src/core/task/Task.ts), a JSON snapshot is captured containing:

- Model ID and API protocol
- System prompt length + truncated head (first 500 chars)
- Number of messages and tools sent
- Full normalised message payload
- Tool definitions (if any)

### How It's Stored

1. [`snapshotWireRequest()`](../src/core/task/Task.ts) merges the wire request JSON into the last `api_req_started` ShoferMessage
2. The message is persisted to `ui_messages.json` via `saveShoferMessages()`
3. The JSON export reads it as `wireRequest` and surfaces it as-is

### Trade-offs

- **Pro**: Captures what was actually sent without modifying provider handlers
- **Con**: Does not capture raw HTTP headers, status codes, or provider-specific wire format (the messages are always in normalised Anthropic format)

## Error Capture

### Structured Error (`ApiReqError`)

Defined in [`vscode-extension-host.ts`](../packages/types/src/vscode-extension-host.ts):

```typescript
interface ApiReqError {
	message: string // Human-readable error message
	type?: string // e.g. "rate_limit_error", "invalid_request_error"
	statusCode?: number // HTTP status code
	stack?: string // Stack trace at the point of error
}
```

### Capture Points

| Location                                         | When                                                          | Method                                                                            |
| ------------------------------------------------ | ------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `attemptApiRequest` first-chunk catch            | Provider errors, context window exceeded, connection failures | `snapshotApiReqError(this.buildApiReqError(error))`                               |
| `recursivelyMakeShoferRequests` mid-stream catch | Stream interruption, tool execution failures                  | `snapshotApiReqError(this.buildApiReqError(error))` — only for non-user-cancelled |

### Persistence

Both capture points call [`snapshotApiReqError()`](../src/core/task/Task.ts) which merges the structured error into the last `api_req_started` ShoferMessage, then persisted to `ui_messages.json`.

## Version History

| Version | Date       | Changes                                                                                                        |
| ------- | ---------- | -------------------------------------------------------------------------------------------------------------- |
| 0.11.7  | 2026-05-16 | Added `error`, `retryAttempt`, `wireRequest` fields; fixed field name mismatch; added error-only call handling |
| 0.11.6  | 2026-05-14 | Initial JSON export with `api_req_started`-based metadata                                                      |

## Gaps & Areas for Improvement

### Undocumented Dependencies

- **`TaskHistoryStore`** — [`src/core/task-persistence/TaskHistoryStore.ts`](../src/core/task-persistence/TaskHistoryStore.ts) writes `history_item.json` but its file path is never given in the doc.
- **`GlobalFileNames`** constants — [`src/shared/globalFileNames.ts`](../src/shared/globalFileNames.ts) provides `apiConversationHistory` and `uiMessages` keys used in `getTaskWithId()` to construct task-directory file paths. Not mentioned.
- **`resolveDefaultSaveUri` / `saveLastExportPath`** — [`src/utils/export.ts`](../src/utils/export.ts) provides export path resolution and last-path persistence used by both export flows. Not mentioned.
- **`ExtendedContentBlock`** — [`export-json.ts`](../src/integrations/misc/export-json.ts) imports this union type from [`export-markdown.ts`](../src/integrations/misc/export-markdown.ts). The cross-file dependency is implicit.

### Missing Edge Case Coverage

- **Concurrent read/write**: The doc does not discuss what happens when `exportTaskWithIdJson` reads `ui_messages.json` while `Task.saveShoferMessages()` is writing it (race between export read and live-task write).
- **Schema version mismatch**: The three persisted JSON files have no embedded `version` field. Exporting a task persisted by an older Shofer version may produce a trace whose shape the current `buildJsonTrace()` cannot parse correctly. The `try/catch` around `JSON.parse` in `getTaskWithId` provides a safety net but is not documented.

### Missing Flow Steps

- **Filename generation**: `ShoferProvider.exportTaskWithId()` calls `getTaskFileName()` to build the default filename BEFORE calling `downloadTask()`. The Data Flow diagram skips this intermediate step.
- **Filesystem pre-check**: `ShoferProvider.exportTaskWithIdJson()` calls `fs.stat()` to check `ui_messages.json` existence before reading — a defensive guard not mentioned in the doc.

### Token Estimation Trigger

The doc says token estimation fires "when the provider does not emit `usage` chunks in streaming mode", but the actual trigger in [`buildJsonTrace()`](../src/integrations/misc/export-json.ts) is broader: `calls.every(c => c.inputTokens === 0 && c.outputTokens === 0)` — it fires whenever ALL calls have zero tokens, regardless of cause (e.g., all error-only calls, or a provider that emits usage but the capture failed).

### Missing Glossary Terms

No formal definitions for:

- **`api_req_started`** — the `ShoferSay` type used as the anchor for per-call metadata in both export formats.
- **Error-only call** — an API call that never received an assistant response; export produces a `JsonExportCall` with `messages: []` and `toolCalls: []` but carries error and wire metadata.
- **Token estimation** — the char/4 fallback heuristic, marked by `_tokensEstimated: true`.
