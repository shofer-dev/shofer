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

**Behavior (as of 2026-06-11):**

- ✅ `this.consecutiveMistakeCount++`
- ✅ `task.say("error", errorMessage)` — visible in chat
- ✅ `pushToolResultToUserContent({ is_error: true })` — LLM receives the error
- ✅ `recordToolError(chunk.name as ToolName, errorMessage)` — captured in tool usage stats
- ✅ The error message now includes `NativeToolCallParser.consumeLastParseError()` — the
  parser's specific failure reason (e.g., `"Invalid arguments for tool 'read_file'.
  Native tool calls require a valid JSON payload matching the tool schema. Received: {}"`)
  is included instead of the generic fallback.

### B. `NativeToolCallParser.parseToolCall()` fails (valid name, bad/incomplete args)

**Location:** [`NativeToolCallParser.parseToolCall`](src/core/assistant-message/NativeToolCallParser.ts:996)

> ⚠️ **Corrected 2026-06-11 — the previous description of this section was wrong.** > `parseToolCall()` does **not** throw to its caller. The `throw` for missing
> `nativeArgs` lives at [`NativeToolCallParser.ts:1641`](src/core/assistant-message/NativeToolCallParser.ts:1641),
> but it is **inside** the `try { … } catch (error) { return null }` block that
> spans [lines 1030–1674](src/core/assistant-message/NativeToolCallParser.ts:1030).
> The local `catch` at [line 1667](src/core/assistant-message/NativeToolCallParser.ts:1667)
> swallows it and returns `null`:
>
> ```typescript
> try {
>     // …switch builds nativeArgs…
>     if (!nativeArgs && !customToolRegistry.has(resolvedName) && !isPrivateLmTool(resolvedName)) {
>         throw new Error(`[NativeToolCallParser] Invalid arguments for tool '${resolvedName}'...`)
>     }
>     return result
> } catch (error) {
>     webviewLog.error(...)
>     return null          // ← the throw above lands here; never propagates
> }
> ```
>
> Consequently **both** malformed-JSON and missing-required-param cases return
> `null`, exactly like the unknown-name case in §A. There is no throw, no
> `"api_req_failed"` dialog, and no "Provider Error" Retry button on this path.

**Actual behavior by stream format:**

| Stream format                                   | What happens                                                                                                                                                                                                                                                              | UI result                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Legacy `tool_call` chunk                        | `parseToolCall()` returns `null` → the `if (!toolUse)` branch at [`Task.ts:4779`](src/core/task/Task.ts:4779) fires `say("error", …)` + `pushToolResultToUserContent({ is_error: true })`                                                                                 | ✅ Error row visible (same as §A) |
| Streaming `tool_call_partial` + `tool_call_end` | `finalizeStreamingToolCall()` returns `null` → the `else if (toolUseIndex !== undefined)` branch at [`Task.ts:4745`](src/core/task/Task.ts:4745) sets `partial = false` **and clears the stale partial `nativeArgs`** → presented → §C guard fires (**fixed 2026-06-11**) | ✅ Error row visible (via §C)     |

Both paths now reliably surface this failure. Before the 2026-06-11 fix, the streaming
path left a stale partial `nativeArgs` on the block, which defeated the §C guard and
caused the tool to be dispatched silently with incomplete arguments — see §C and Gaps.

### C. `presentAssistantMessage`: known tool, missing `nativeArgs`

**Location:** [`presentAssistantMessage.ts:569`](src/core/assistant-message/presentAssistantMessage.ts:569)

When `presentAssistantMessage` receives a complete (non-partial) tool block for a
known tool but `nativeArgs` is `undefined`, the tool cannot be executed:

```typescript
if (!block.partial) {
	const customTool = stateExperiments?.customTools ? customToolRegistry.get(block.name) : undefined
	const isKnownTool = isValidToolName(String(block.name), stateExperiments)
	if (isKnownTool && !block.nativeArgs && !customTool) {
		// say("error", …) + pushToolResultToUserContent({ is_error: true })
	}
}
```

**Behavior when the guard fires:**

- ✅ `shofer.consecutiveMistakeCount++`
- ✅ `await shofer.say("error", errorMessage)` — visible in chat
- ✅ `shofer.pushToolResultToUserContent({ is_error: true })` — LLM receives the error
- ✅ `shofer.recordToolError(block.name as ToolName, errorMessage)` — captured in tool usage stats
- ✅ **(2026-06-11)** Error message now includes `NativeToolCallParser.consumeLastParseError()`
  with the parser's specific failure reason, plus the partial params that were received
  during streaming — e.g., `"Invalid tool call for 'read_file': missing nativeArgs.
  Parser error: [NativeToolCallParser] Invalid arguments for tool 'read_file'. ...
  Received partial params: {}."`

> ✅ **FIXED (2026-06-11): the streaming path now clears the stale partial `nativeArgs`,
> so this guard fires reliably.**
>
> **The bug that was fixed:** the guard assumes that when `finalizeStreamingToolCall()`
> returns `null`, the block left in `assistantMessageContent[toolUseIndex]` has **no** > `nativeArgs`. During streaming this was false. Each `tool_call_delta` replaces the
> block with the output of
> [`createPartialToolUse`](src/core/assistant-message/NativeToolCallParser.ts:377),
> which **optimistically populates a partial `nativeArgs`** from whatever has parsed so
> far (e.g. for `read_file` it sets `nativeArgs = { path, mode, offset, limit, … }` as
> soon as a `path` appears — see [line 435](src/core/assistant-message/NativeToolCallParser.ts:435)).
> When the final strict parse then failed, the null-branches only flipped
> `partial = false` and left the stale partial `nativeArgs` in place, so
> `!block.nativeArgs` was `false`, the §C guard was skipped, and the tool was dispatched
> with incomplete args — no error row, no mistake increment.
>
> **The fix** clears `existingToolUse.nativeArgs = undefined` alongside
> `partial = false` in both stream-consumer null-branches —
> [`Task.ts:4753`](src/core/task/Task.ts:4753) (the `tool_call_end` path) and
> [`Task.ts:5217`](src/core/task/Task.ts:5217) (the `finalizeRawChunks()` tail). This
> restores the invariant the guard assumes ("finalize failed ⇒ no `nativeArgs`"), so a
> known tool with bad/incomplete arguments on the streaming path now produces the
> visible error this section promises. The previously-stale comments at those lines have
> been updated to match.

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

| Scenario                                                                                                   | Chat error row  | LLM receives error           | Mistake counter         |
| ---------------------------------------------------------------------------------------------------------- | --------------- | ---------------------------- | ----------------------- |
| `parseToolCall()` returns `null` — **legacy** `tool_call` chunk (unknown name / bad JSON / missing params) | ✅              | ✅                           | ✅                      |
| `parseToolCall()` returns `null` — **streaming**, valid name + bad/incomplete args (**fixed 2026-06-11**)  | ✅ (via §C)     | ✅                           | ✅                      |
| `parseToolCall()` returns `null` — **streaming**, valid name + **no** partial `nativeArgs`                 | ✅ (via §C)     | ✅                           | ✅                      |
| `parseToolCall()` returns `null` — **streaming**, unknown tool name                                        | ✅ (via §D)     | ✅                           | ✅                      |
| `presentAssistantMessage`: missing `nativeArgs` (guard fires)                                              | ✅              | ✅                           | ✅                      |
| `presentAssistantMessage`: unknown tool                                                                    | ✅              | ✅                           | ✅                      |
| `presentAssistantMessage`: mode-validation fails                                                           | ❌              | ✅                           | ✅                      |
| Tool repetition limit                                                                                      | ✅ (ask dialog) | ✅                           | N/A (separate detector) |
| Mistake limit reached                                                                                      | ✅ (ask dialog) | — (blocks further execution) | Resets to 0             |

> The second row was the reported symptom: on the streaming path (the default for modern
> providers), a known tool with malformed/incomplete arguments was dispatched silently
> because the lingering partial `nativeArgs` defeated the §C guard. Fixed 2026-06-11 by
> clearing `nativeArgs` in the stream-consumer null-branches (see Gaps → Resolved).

## Key files

| File                                                                                                             | Role                                                                                   |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| [`src/core/task/Task.ts`](src/core/task/Task.ts)                                                                 | Stream consumer, mistake counter, `recordToolError()`, `pushToolResultToUserContent()` |
| [`src/core/assistant-message/presentAssistantMessage.ts`](src/core/assistant-message/presentAssistantMessage.ts) | Tool validation gate, unknown tool / missing-nativeArgs handling                       |
| [`src/core/assistant-message/NativeToolCallParser.ts`](src/core/assistant-message/NativeToolCallParser.ts)       | Parses raw tool call JSON, validates names, constructs `nativeArgs`                    |
| [`src/core/tools/validateToolUse.ts`](src/core/tools/validateToolUse.ts)                                         | Mode-based tool access validation                                                      |
| [`src/core/tools/ToolRepetitionDetector.ts`](src/core/tools/ToolRepetitionDetector.ts)                           | Identical consecutive call detection                                                   |
| [`webview-ui/src/components/chat/ChatView.tsx`](webview-ui/src/components/chat/ChatView.tsx)                     | Renders `"api_req_failed"` and `"mistake_limit_reached"` ask dialogs                   |
| [`webview-ui/src/components/chat/ChatRow.tsx`](webview-ui/src/components/chat/ChatRow.tsx)                       | Renders error rows from `say("error", ...)`                                            |
| [`webview-ui/src/i18n/locales/en/tools.json`](webview-ui/src/i18n/locales/en/tools.json)                         | i18n strings for unknown tool error (`unknownToolError`)                               |

## Gaps & areas for improvement

### ✅ Resolved: streaming failures are now surfaced (root cause of "failures not surfacing")

**Status: fixed 2026-06-11 via option 1 below.** When `finalizeStreamingToolCall()`
returned `null`, the two stream-consumer null-branches kept the stale partial block built
by `createPartialToolUse`, which carried an optimistic partial `nativeArgs`. The §C guard
in `presentAssistantMessage` (`isKnownTool && !block.nativeArgs && !customTool`) then
failed to fire, so the tool was executed with incomplete args instead of producing a
visible error. See §B and §C.

The fix clears `existingToolUse.nativeArgs = undefined` (alongside `partial = false`) in
both `else if (toolUseIndex !== undefined)` branches —
[`Task.ts:4753`](src/core/task/Task.ts:4753) and [`Task.ts:5217`](src/core/task/Task.ts:5217) —
restoring the invariant the §C guard assumes ("finalize failed ⇒ no `nativeArgs`") so the
existing error path fires.

**Alternatives considered (not taken):**

2. **Make the parser distinguish "invalid" from "absent".** Have `finalizeStreamingToolCall()`
   / `parseToolCall()` signal _invalid finalization_ explicitly (e.g. return a sentinel
   `{ invalid: true, reason }` or a typed result) rather than collapsing both the
   unknown-name and bad-args cases into a bare `null`. Cleaner long-term design
   (Schema-First / fail-closed spirit); deferred as a larger change.

3. **Validate `nativeArgs` completeness in §C, not just presence.** Re-run the strict
   `parseToolCall` (or a schema validation) on the finalized block inside
   `presentAssistantMessage`. More work per dispatch; duplicates parser logic.

### ⚠️ Still outstanding: no regression test locks in the fix

The fix was verified against 23 existing tests, but **none of them exercises this path** —
no test references `finalizeStreamingToolCall`, `nativeArgs = undefined`, the §C guard, or
the streaming bad-args scenario. The fix can silently regress if either null-branch is
later "tidied up". Add a regression test under
`src/core/assistant-message/__tests__/` (or `src/core/task/__tests__/`) that:

1. Drives the streaming consumer through `tool_call_start` → `tool_call_delta` (partial
   args that populate `nativeArgs` for e.g. `read_file`) → `tool_call_end` with
   incomplete/invalid accumulated JSON so `finalizeStreamingToolCall()` returns `null`.
2. Asserts a `say("error", …)` row is emitted, a `tool_result` with `is_error: true` is
   pushed, `consecutiveMistakeCount` is incremented, and the tool's `handle()`/`execute()`
   is **not** invoked.
3. Covers the symmetric `finalizeRawChunks()` tail branch at
   [`Task.ts:5209`](src/core/task/Task.ts:5209) as well.

### Documentation accuracy note

§B previously claimed `parseToolCall()` _throws_ and that the legacy path raises an
`"api_req_failed"` "Provider Error" dialog. Neither is true — the internal throw is
caught locally and converted to `null`, and the legacy path surfaces the error inline
via `say("error", …)`. Corrected above.

### ✅ Resolved (2026-06-11): error messages now include parser-specific failure details

**Status: fixed.** Previously, when `parseToolCall()` returned `null` (unknown name, bad
JSON, missing params), the call sites in Task.ts and `presentAssistantMessage.ts` produced
a generic error message: *"Tool call failed for X: the parser could not produce a valid tool
invocation. This may be due to an unknown tool name, malformed JSON arguments, or missing
required parameters."* The parser internally knew the specific reason (e.g., `"Invalid
arguments for tool 'read_file'. Native tool calls require a valid JSON payload matching the
tool schema. Received: {}"`) but it was only logged and discarded.

**The fix** adds `NativeToolCallParser.lastParseError` — a static field set by
`parseToolCall()`'s catch block and `finalizeStreamingToolCall()`'s not-found branch.
Callers read it via `NativeToolCallParser.consumeLastParseError()` and include it in the
error message shown to the user and fed back to the LLM. The `presentAssistantMessage` §C
guard also includes the partial params that were received during streaming.

### Pre-existing gaps (unchanged)

- **Mode-validation failures (§E) are still UI-silent.** Adding `say("error", …)` would
  make these visible to the user. The trade-off is noise: mode violations are common
  with weaker models and the self-correction via `tool_result` is usually fast enough
  that the user wouldn't notice.
- **MCP tool name format errors (§H)** could be handled more explicitly in the stream
  consumer rather than relying on the `presentAssistantMessage` fallback path. This path
  flows through the same `finalizeRawChunks()` null-branch that now clears `nativeArgs`,
  so it is covered by the 2026-06-11 fix and no longer silently dispatches — but the
  explicit, named handling would still produce a clearer error message.
- **`TOOL_DISPLAY_NAMES`** and the `toolDescription()` switch in
  `presentAssistantMessage.ts` could include the tool's canonical name formatting so
  error messages are more readable (e.g., `execute_command` → `execute command`).
