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

| Stream format                                   | What happens                                                                                                                                                                                                                            | UI result                                             |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Legacy `tool_call` chunk                        | `parseToolCall()` returns `null` → the `if (!toolUse)` branch at [`Task.ts:4779`](src/core/task/Task.ts:4779) fires `say("error", …)` + `pushToolResultToUserContent({ is_error: true })`                                               | ✅ Error row visible (same as §A)                     |
| Streaming `tool_call_partial` + `tool_call_end` | `finalizeStreamingToolCall()` returns `null` → the `else if (toolUseIndex !== undefined)` branch at [`Task.ts:4745`](src/core/task/Task.ts:4745) keeps the **stale partial block** and only sets `partial = false` → presented (see §C) | ⚠️ **Often NOT visible — see the bug in §C and Gaps** |

The legacy path is the only one that reliably surfaces this failure, and modern
providers stream tool calls, so the legacy path is rarely taken in practice. This is
the most likely reason failures are not surfacing in the UI.

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

> 🐞 **BUG (identified 2026-06-11): the guard `!block.nativeArgs` is unreliable on
> the streaming path, which is why failures go unsurfaced.**
>
> The guard assumes that when `finalizeStreamingToolCall()` returns `null`, the block
> left in `assistantMessageContent[toolUseIndex]` has **no** `nativeArgs`. That is
> false. During streaming, each `tool_call_delta` replaces the block with the output of
> [`createPartialToolUse`](src/core/assistant-message/NativeToolCallParser.ts:377),
> which **optimistically populates a partial `nativeArgs`** from whatever has parsed so
> far (e.g. for `read_file` it sets `nativeArgs = { path, mode, offset, limit, … }` as
> soon as a `path` appears — see [line 435](src/core/assistant-message/NativeToolCallParser.ts:435)).
>
> When the final strict parse then fails (malformed/incomplete JSON, or a required
> field that `createPartialToolUse` did not require), the stream consumer's null-branch
> at [`Task.ts:4745`](src/core/task/Task.ts:4745) / [`Task.ts:5206`](src/core/task/Task.ts:5206)
> only flips `partial = false` — it **does not clear the stale partial `nativeArgs`**.
> So `block.nativeArgs` is truthy, `!block.nativeArgs` is `false`, and this §C guard is
> **skipped**. `isKnownTool` is `true`, so §D (unknown tool) is also skipped. The block
> falls through to the dispatch `switch` at
> [`presentAssistantMessage.ts:895`](src/core/assistant-message/presentAssistantMessage.ts:895)
> and the tool is **executed with incomplete/partial args** — no error row, no mistake
> increment from this path. The comments at `Task.ts:4748` and `Task.ts:5208` ("execution
> will be short-circuited in presentAssistantMessage" / "validation will handle missing
> params") therefore describe a guarantee the code does not uphold.
>
> Net effect: on the common streaming path, a known tool with bad/incomplete arguments
> is silently dispatched instead of producing the visible error this section promises.
> See **Gaps** for proposed fixes.

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

| Scenario                                                                                                                   | Chat error row  | LLM receives error           | Mistake counter         |
| -------------------------------------------------------------------------------------------------------------------------- | --------------- | ---------------------------- | ----------------------- |
| `parseToolCall()` returns `null` — **legacy** `tool_call` chunk (unknown name / bad JSON / missing params)                 | ✅              | ✅                           | ✅                      |
| `parseToolCall()` returns `null` — **streaming**, valid name + bad/incomplete args, **stale partial `nativeArgs` present** | ❌ **(bug §C)** | ❌ (tool runs with bad args) | ❌                      |
| `parseToolCall()` returns `null` — **streaming**, valid name + **no** partial `nativeArgs`                                 | ✅ (via §C)     | ✅                           | ✅                      |
| `parseToolCall()` returns `null` — **streaming**, unknown tool name                                                        | ✅ (via §D)     | ✅                           | ✅                      |
| `presentAssistantMessage`: missing `nativeArgs` (guard fires)                                                              | ✅              | ✅                           | ✅                      |
| `presentAssistantMessage`: unknown tool                                                                                    | ✅              | ✅                           | ✅                      |
| `presentAssistantMessage`: mode-validation fails                                                                           | ❌              | ✅                           | ✅                      |
| Tool repetition limit                                                                                                      | ✅ (ask dialog) | ✅                           | N/A (separate detector) |
| Mistake limit reached                                                                                                      | ✅ (ask dialog) | — (blocks further execution) | Resets to 0             |

> The second row is the reported symptom: on the streaming path (the default for modern
> providers), a known tool with malformed/incomplete arguments is dispatched silently
> because the lingering partial `nativeArgs` defeats the §C guard.

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

### 🐞 Primary bug: streaming failures are silently dispatched (root cause of "failures not surfacing")

When `finalizeStreamingToolCall()` returns `null`, the two stream-consumer null-branches
([`Task.ts:4745`](src/core/task/Task.ts:4745) and [`Task.ts:5206`](src/core/task/Task.ts:5206))
keep the stale partial block built by `createPartialToolUse`, which carries an
optimistic partial `nativeArgs`. The §C guard in `presentAssistantMessage`
(`isKnownTool && !block.nativeArgs && !customTool`) then fails to fire, so the tool is
executed with incomplete args instead of producing a visible error. See §B and §C.

**Proposed fixes (pick one; ordered by preference):**

1. **Clear the stale `nativeArgs` in the null-branches.** In both `else if (toolUseIndex !== undefined)`
   branches, set `existingToolUse.nativeArgs = undefined` (alongside `partial = false`)
   before calling `presentAssistantMessage`. This restores the invariant the §C guard
   assumes — "finalize failed ⇒ no `nativeArgs`" — and makes the existing error path fire.
   Smallest, most targeted fix.

2. **Make the parser distinguish "invalid" from "absent".** Have `finalizeStreamingToolCall()`
   / `parseToolCall()` signal _invalid finalization_ explicitly (e.g. return a sentinel
   `{ invalid: true, reason }` or a typed result) rather than collapsing both the
   unknown-name and bad-args cases into a bare `null`. The stream consumer and §C could
   then surface a precise message and never rely on the truthiness of a partial
   `nativeArgs`. Cleanest long-term design (Schema-First / fail-closed spirit).

3. **Validate `nativeArgs` completeness in §C, not just presence.** Re-run the strict
   `parseToolCall` (or a schema validation) on the finalized block inside
   `presentAssistantMessage` and surface the error when it fails, instead of trusting
   `!block.nativeArgs`. More work per dispatch; duplicates parser logic.

> Whichever fix is chosen, add a regression test under
> `src/core/assistant-message/__tests__/` that drives a streaming tool call with a valid
> name but missing required param and asserts a `say("error", …)` is emitted and the
> tool's `handle()` is **not** invoked.

### Documentation accuracy note

§B previously claimed `parseToolCall()` _throws_ and that the legacy path raises an
`"api_req_failed"` "Provider Error" dialog. Neither is true — the internal throw is
caught locally and converted to `null`, and the legacy path surfaces the error inline
via `say("error", …)`. Corrected above.

### Pre-existing gaps (unchanged)

- **Mode-validation failures (§E) are still UI-silent.** Adding `say("error", …)` would
  make these visible to the user. The trade-off is noise: mode violations are common
  with weaker models and the self-correction via `tool_result` is usually fast enough
  that the user wouldn't notice.
- **MCP tool name format errors (§H)** could be handled more explicitly in the stream
  consumer rather than relying on the `presentAssistantMessage` fallback path. Note this
  path shares the same stale-`nativeArgs` exposure as the primary bug above.
- **`TOOL_DISPLAY_NAMES`** and the `toolDescription()` switch in
  `presentAssistantMessage.ts` could include the tool's canonical name formatting so
  error messages are more readable (e.g., `execute_command` → `execute command`).
