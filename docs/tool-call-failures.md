# Tool Call Failure Handling

> Source: [`src/core/task/Task.ts`](src/core/task/Task.ts)
> Source: [`src/core/assistant-message/presentAssistantMessage.ts`](src/core/assistant-message/presentAssistantMessage.ts)
> Source: [`src/core/assistant-message/NativeToolCallParser.ts`](src/core/assistant-message/NativeToolCallParser.ts)
> Source: [`src/core/tools/validateToolUse.ts`](src/core/tools/validateToolUse.ts)

When the LLM emits a tool call that cannot be executed — wrong tool name, malformed
JSON arguments, missing required parameters — the system must (a) show the user what
happened, (b) tell the LLM so it can self-correct, and (c) count the failure toward
the [mistake limit](mistake_limit.md). This document describes every failure path and
the guarantees each one upholds.

## Architecture overview

An LLM tool call travels through these stages before execution:

```
LLM emits tool_call → stream consumer (Task.ts) → NativeToolCallParser
→ assistantMessageContent → presentAssistantMessage → validateToolUse
→ tool.execute()
```

A failure at any stage must produce three outputs:

1. **Chat UI:**[`task.say("error", message)`](src/core/task/Task.ts) — user-visible error row
2. **LLM feedback:**[`pushToolResultToUserContent({ is_error: true })`](src/core/task/Task.ts) — matching `tool_result` so the model can recover
3. **Mistake counter:**[`consecutiveMistakeCount++`](src/core/task/Task.ts) — counted toward the limit

## Failure scenarios

### A. `NativeToolCallParser.parseToolCall()` returns `null`

**Location:** [`Task.ts` stream consumer, `"tool_call"` case](src/core/task/Task.ts)

`parseToolCall()` returns `null` when:
- The tool name is not in [`toolNames`](../packages/types/src/tool.ts), not a custom
  tool, and not a private LM tool — [`NativeToolCallParser.ts`](src/core/assistant-message/NativeToolCallParser.ts)
- The JSON arguments fail to parse — [`NativeToolCallParser.ts`](src/core/assistant-message/NativeToolCallParser.ts)

**Behavior (as of 2026-06-09):**
- ✅ `this.consecutiveMistakeCount++`
- ✅ `task.say("error", errorMessage)` — visible in chat
- ✅ `pushToolResultToUserContent({ is_error: true })` — LLM receives the error
- ✅ `recordToolError(chunk.name as ToolName, errorMessage)` — captured in tool usage stats

### B. `NativeToolCallParser.parseToolCall()` throws

**Location:** [`NativeToolCallParser.ts`](src/core/assistant-message/NativeToolCallParser.ts)

`parseToolCall()` throws when the tool name is valid but **required parameters are
missing** — the parser cannot construct `nativeArgs`:

```typescript
if (!nativeArgs && !customToolRegistry.has(resolvedName) && !isPrivateLmTool(resolvedName)) {
    throw new Error(`[NativeToolCallParser] Invalid arguments for tool '${resolvedName}'...`)
}
```

**Behavior depends on the stream format:**

| Stream format | Propagation | UI result |
|---|---|---|
| Legacy `tool_call` chunk | Throw propagates to `attemptApiRequest()` catch → fires `"api_req_failed"` ask | "Provider Error / API Request Failed" dialog |
| Streaming `tool_call_partial` + `tool_call_end` | `finalizeStreamingToolCall()` catches the throw, returns `null` → partial block finalized without `nativeArgs` → handled by `presentAssistantMessage` (see §C) | See §C |

The legacy path produces the familiar "Provider Error" dialog because the error occurs
on the **first chunk** of the stream — the API hasn't produced any output yet, so the
system treats it as a transport/API failure and offers a Retry button.

### C. `presentAssistantMessage`: known tool, missing `nativeArgs`

**Location:** [`presentAssistantMessage.ts`](src/core/assistant-message/presentAssistantMessage.ts)

When `presentAssistantMessage` receives a complete (non-partial) tool block for a
known tool but `nativeArgs` is `undefined`, the tool cannot be executed. This is the
default handling for streaming tool calls where `finalizeStreamingToolCall()` could
not produce valid arguments.

**Behavior (as of 2026-06-09):**
- ✅ `shofer.consecutiveMistakeCount++`
- ✅ `await shofer.say("error", errorMessage)` — visible in chat
- ✅ `shofer.pushToolResultToUserContent({ is_error: true })` — LLM receives the error
- ✅ `shofer.recordToolError(block.name as ToolName, errorMessage)` — captured in tool usage stats

### D. `presentAssistantMessage`: unknown tool name

**Location:** [`presentAssistantMessage.ts`](src/core/assistant-message/presentAssistantMessage.ts)

When `presentAssistantMessage` encounters a tool name that doesn't match any known
tool, custom tool, or private LM tool:

**Behavior:**
- ✅ `shofer.consecutiveMistakeCount++`
- ✅ `await shofer.say("error", t("tools:unknownToolError", { toolName: block.name }))` — visible in chat
- ✅ `shofer.recordToolError(block.name as ToolName, errorMessage)` — captured in tool usage stats
- ✅ `pushToolResultToUserContent({ is_error: true })` — LLM receives the error

### E. `presentAssistantMessage`: mode-validation fails

**Location:** [`presentAssistantMessage.ts`](src/core/assistant-message/presentAssistantMessage.ts)

When [`validateToolUse()`](src/core/tools/validateToolUse.ts) throws — the tool is not
allowed in the current mode per [`tool_access.md`](tool_access.md):

**Behavior:**
- ✅ `shofer.consecutiveMistakeCount++` (unless `disableMistakeLimitChecks` is enabled)
- ❌ No `say("error", ...)` — only `pushToolResultToUserContent({ is_error: true })` so the LLM can correct itself

> **Note:** This path does not emit a visible error row. It pushes a structured
> `tool_result` with `is_error: true` to the LLM, which is usually sufficient for the
> model to self-correct by choosing an allowed tool. Adding `say("error", …)` here
> would be straightforward; it was deferred because mode-violations are less surprising
> to the user (the model simply needs to pick a different tool).

### F. Tool repetition limit

**Location:** [`presentAssistantMessage.ts`](src/core/assistant-message/presentAssistantMessage.ts)

When [`ToolRepetitionDetector`](src/core/tools/ToolRepetitionDetector.ts) detects
identical consecutive tool calls:

**Behavior:**
- ✅ Asks user for guidance via [`"tool_repetition_limit_reached"`](webview-ui/src/i18n/locales/en/tools.json) ask
- ✅ `pushToolResult(formatResponse.toolError(...))` — LLM receives the error
- ✅ Telemetry captured via `ConsecutiveMistakeError`

### G. Mistake limit reached

**Location:** [`Task.ts` `recursivelyMakeShoferRequests`](src/core/task/Task.ts)

When `consecutiveMistakeCount >= consecutiveMistakeLimit`:

**Behavior:**
- ✅ Fires `"mistake_limit_reached"` ask — user sees guidance dialog
- ✅ Resets `consecutiveMistakeCount = 0` on response

### H. `parseToolCall()` returns `null` for streaming MCP tools

**Location:** [`NativeToolCallParser.ts` `parseDynamicMcpTool`](src/core/assistant-message/NativeToolCallParser.ts)

When a dynamic MCP tool (`mcp--serverName--toolName`) has an unparseable name format:

**Behavior:**
- ❌ Returns `null` — the stream consumer's `finalizeStreamingToolCall()` receives `null`
- Then `finalizeRawChunks()` flows into the same `else if (toolUseIndex !== undefined)`
  branch as §C — the partial block is finalized without `nativeArgs` and handled by
  `presentAssistantMessage`

## Mistake counter semantics

[`consecutiveMistakeCount`](src/core/task/Task.ts) is incremented on **each failed
tool invocation** from the model's perspective. When it reaches
[`consecutiveMistakeLimit`](src/core/task/Task.ts) (default:
[`DEFAULT_CONSECUTIVE_MISTAKE_LIMIT`](../packages/types/src/provider-settings.ts)),
the system fires the mistake-limit dialog.

Successful tool execution resets the counter to 0.

The counter is also incremented by the task loop itself when the LLM produces no
tools at all (the `"no_tools_used"` path in `initiateTaskLoop`).

## UI visibility summary

| Scenario | Chat error row | LLM receives error | Mistake counter |
|---|---|---|---|
| `parseToolCall()` returns `null` (unknown name / bad JSON) | ✅ | ✅ | ✅ |
| `parseToolCall()` throws — legacy `tool_call` chunk | ✅ ("Provider Error" dialog) | ✅ (via retry flow) | ✅ (via `attemptApiRequest`) |
| `parseToolCall()` throws — streaming, handled by `presentAssistantMessage` | ✅ | ✅ | ✅ |
| `presentAssistantMessage`: missing `nativeArgs` | ✅ | ✅ | ✅ |
| `presentAssistantMessage`: unknown tool | ✅ | ✅ | ✅ |
| `presentAssistantMessage`: mode-validation fails | ❌ | ✅ | ✅ |
| Tool repetition limit | ✅ (ask dialog) | ✅ | N/A (separate detector) |
| Mistake limit reached | ✅ (ask dialog) | — (blocks further execution) | Resets to 0 |

## Key files

| File | Role |
|---|---|
| [`src/core/task/Task.ts`](src/core/task/Task.ts) | Stream consumer, mistake counter, `recordToolError()`, `pushToolResultToUserContent()` |
| [`src/core/assistant-message/presentAssistantMessage.ts`](src/core/assistant-message/presentAssistantMessage.ts) | Tool validation gate, unknown tool / missing-nativeArgs handling |
| [`src/core/assistant-message/NativeToolCallParser.ts`](src/core/assistant-message/NativeToolCallParser.ts) | Parses raw tool call JSON, validates names, constructs `nativeArgs` |
| [`src/core/tools/validateToolUse.ts`](src/core/tools/validateToolUse.ts) | Mode-based tool access validation |
| [`src/core/tools/ToolRepetitionDetector.ts`](src/core/tools/ToolRepetitionDetector.ts) | Identical consecutive call detection |
| [`webview-ui/src/components/chat/ChatView.tsx`](webview-ui/src/components/chat/ChatView.tsx) | Renders `"api_req_failed"` and `"mistake_limit_reached"` ask dialogs |
| [`webview-ui/src/components/chat/ChatRow.tsx`](webview-ui/src/components/chat/ChatRow.tsx) | Renders error rows from `say("error", ...)` |
| [`webview-ui/src/i18n/locales/en/tools.json`](webview-ui/src/i18n/locales/en/tools.json) | i18n strings for unknown tool error (`unknownToolError`) |

## Gaps & areas for improvement

- **Mode-validation failures (§E) are still UI-silent.** Adding `say("error", …)` would
  make these visible to the user. The trade-off is noise: mode violations are common
  with weaker models and the self-correction via `tool_result` is usually fast enough
  that the user wouldn't notice.
- **MCP tool name format errors (§H)** could be handled more explicitly in the stream
  consumer rather than relying on the `presentAssistantMessage` fallback path.
- **`TOOL_DISPLAY_NAMES`** and the `toolDescription()` switch in
  `presentAssistantMessage.ts` could include the tool's canonical name formatting so
  error messages are more readable (e.g., `execute_command` → `execute command`).
