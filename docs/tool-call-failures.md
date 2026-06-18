# Tool Call Failure Modes

**Purpose:** Comprehensive catalog of every way a tool call can fail in Shofer — error messages, escalation paths, and recovery behavior. Update this document when new failure paths are added.

**Related files:**

- [`presentAssistantMessage.ts`](../src/core/assistant-message/presentAssistantMessage.ts) — main tool dispatch and error routing
- [`validateToolUse.ts`](../src/core/tools/validateToolUse.ts) — pre-execution validation (name, mode, disabled)
- [`Task.ts`](../src/core/task/Task.ts) — `consecutiveMistakeCount`, `recordToolError`, `sayAndCreateMissingParamError`
- [`NativeToolCallParser.ts`](../src/core/assistant-message/NativeToolCallParser.ts) — streaming arg construction
- [`ToolRepetitionDetector.ts`](../src/core/tools/ToolRepetitionDetector.ts) — identical-consecutive-call detection

---

## 1. Failure Mode Taxonomy

Every tool call goes through this pipeline. Failures at any stage short-circuit the call:

```
[LLM emits tool_use block]
    │
    ▼
Stage A — Structural validation
    ├─ Missing tool_use.id (XML tool calls unsupported)
    ├─ Missing nativeArgs (streaming truncation / malformed JSON)
    └─ Valid JSON but required fields missing (vscode-lm XML leak into string values)
    │
    ▼
Stage B — Semantic validation (validateToolUse)
    ├─ Unknown tool name
    ├─ Tool disabled by user
    ├─ Tool not allowed in current mode
    └─ File restriction error (write group regex mismatch)
    │
    ▼
Stage C — Repetition check (ToolRepetitionDetector)
    └─ Identical consecutive tool calls exceeding limit
    │
    ▼
Stage D — Approval gate (askApproval)
    ├─ User rejects ("No" button)
    └─ User provides feedback instead of approving
    │
    ▼
Stage E — Tool execution (tool handler)
    ├─ Missing required parameter
    ├─ Runtime error in handler
    ├─ Protected file / .shoferignore block
    └─ Tool-specific business-logic error
    │
    ▼
Stage F — Escalation (after tool returns)
    └─ consecutiveMistakeCount ≥ consecutiveMistakeLimit → task asks user for guidance
```

---

## 2. Failure Mode Reference

### A1. Missing `tool_use.id` (XML Tool Calls)

**Trigger:** Model emits a tool call without a native `tool_use.id` field — typically XML markup like `<read_file>path</read_file>`.

**Error message:**

> Invalid tool call: missing tool_use.id. XML tool calls are no longer supported. Remove any XML tool markup (e.g. \<read_file\>...\</read_file\>) and use native tool calling instead.

**Location:** [`presentAssistantMessage.ts`](../src/core/assistant-message/presentAssistantMessage.ts) — `case "tool_use"` guard at L368

**Effect:**

- `consecutiveMistakeCount++`
- Error rendered in chat via `shofer.say("error", …)`
- Error pushed to `userMessageContent` as text (not as a `tool_result` — there's no `tool_use_id` to pair with)
- `didAlreadyUseTool = true` (stream continues)
- If `consecutiveMistakeCount` hits the limit, task escalates to `mistake_limit_reached` ask

**Recovery:** LLM must retry with proper native tool calling format. No automatic recovery.

---

### A2. Missing `nativeArgs` (Streaming Truncation / Malformed JSON)

**Trigger:** A complete (`!partial`) tool_use block for a known tool where `NativeToolCallParser` could not construct `nativeArgs` — typically because the provider terminated mid-argument-JSON or the JSON syntax was irrecoverably malformed.

**Error message:**

> Invalid tool call for '\<name\>': missing nativeArgs.\<details\>\<receivedParams\>

Where `\<details\>` is ` Parser error: <parseError>` when the parser captured a specific failure (via `NativeToolCallParser.consumeLastParseError()`), otherwise the fallback ` This usually means the model streamed invalid or incomplete arguments and the call could not be finalized.`; and `\<receivedParams\>` is ` Received partial params: <json>.` when partial params exist.

**Location:** [`presentAssistantMessage.ts`](../src/core/assistant-message/presentAssistantMessage.ts) — L572-608 (message construction L578-586)

**Effect:**

- `consecutiveMistakeCount++`
- `recordToolError(name, errorMessage)` called
- Single error `tool_result` pushed (not fragmented across multiple pushes)
- `didAlreadyUseTool` is **not** set — stream continues gracefully
- Custom tools (from `customToolRegistry`) and private LM tools are exempt (they carry raw args)

**Recovery:** LLM receives the tool_result error and must retry with valid arguments.

---

### A3. Valid JSON but Required Fields Missing (vscode-lm XML Leak)

**Trigger:** A vscode-lm model (particularly composite `shofer/*` models via `LanguageModelToolCallPart`) emits structurally valid JSON but embeds a trailing `<parameter name="..." string="true">VALUE` XML suffix inside one of the string values instead of as a separate JSON key. Example: `{"diff": "...SEARCH/REPLACE content...\n<parameter name=\"path\" string=\"true\">extensions/shofer/src/core/workflow/WorkflowTask.ts"}`. `JSON.parse()` succeeds because the `<parameter>` text is just literal content inside the diff string. The parser's `apply_diff` guard `(args.path !== undefined || ...)` then fails because `args.path` is `undefined`.

**Error message:**

> [NativeToolCallParser] Invalid arguments for tool 'apply_diff'. Native tool calls require a valid JSON payload matching the tool schema. Missing required field(s): path. Received (truncated): {"diff":"...<parameter name=\"path\"...\"}

This is the literal string thrown by `parseToolCall()`. It reaches the chat as the `Parser error:` portion of the missing-`nativeArgs` envelope described in A2 (the `apply_diff` guard fails on the missing `path`, so `nativeArgs` is never produced and the call falls through to the A2 path).

**Location:** [`NativeToolCallParser.ts`](../src/core/assistant-message/NativeToolCallParser.ts) — `parseToolCall()` `apply_diff` case at L1249–1276, error thrown at L1776–1779, XML leak recovery helper `extractPathFromXMLLeak()` at L343–353 (JSDoc from L329)

**Effect:**

- `consecutiveMistakeCount++`
- `recordToolError(name, errorMessage)` called
- Error surfaced to chat UI via `shofer.say("error", …)`
- Tool call is dropped — LLM must retry

**Recovery:** `NativeToolCallParser` now has an automatic recovery path: when `path` is missing but `diff` is present, `extractPathFromXMLLeak()` attempts to recover the path from a trailing `<parameter name="path" string="true">VALUE` suffix on the diff string. If found, the suffix is stripped and the extracted path is used. A warning is logged to the webview log. This is best-effort — if the XML markup is malformed or absent, the original error is still thrown.

---

### B1. Unknown Tool Name

**Trigger:** Model calls a tool that doesn't exist in `toolNames`, isn't an MCP tool, isn't a custom tool, and isn't a private LM tool.

**Error message:**

> Unknown tool "\<name\>". This tool does not exist. Please use one of the available tools: \<comma-separated tool list\>.

**Location:** [`validateToolUse.ts`](../src/core/tools/validateToolUse.ts) — `isValidToolName()` at L61-64

**Effect:**

- `consecutiveMistakeCount++`
- Error `tool_result` pushed (`validateToolUse(…)` call at L816, validation catch block at L825 of `presentAssistantMessage.ts`)
- `didAlreadyUseTool` **not** set

**Recovery:** LLM must pick a valid tool from the listed names. No automatic recovery.

---

### B2. Tool Disabled by User

**Trigger:** Model calls a tool listed in the user's `disabledTools` setting (Settings → Tools). Disabled tools are removed from the LLM's tool catalog at build time, so this usually means the model hallucinated the tool from training data.

**Error message:**

> Tool "\<name\>" has been disabled by the user in Settings → Tools and is not available in any mode. Do not attempt to call it again. Use a different tool to accomplish the task.

**Location:** [`validateToolUse.ts`](../src/core/tools/validateToolUse.ts) — L76-86

**Effect:**

- `consecutiveMistakeCount++`
- Error `tool_result` pushed

**Recovery:** LLM must choose a different tool. Repeated attempts will increment the mistake counter toward the limit.

---

### B3. Tool Not Allowed in Current Mode

**Trigger:** Model calls a tool whose `ToolGroup` is not included in the current mode's `tools` array, and the tool is not explicitly in `tools_allowed`.

**Error message:**

> Tool "\<name\>" is not allowed in \<mode\> mode.

**Location:** [`validateToolUse.ts`](../src/core/tools/validateToolUse.ts) — L99-101

**Effect:**

- `consecutiveMistakeCount++`
- Error `tool_result` pushed

**Recovery:** LLM can either switch modes (via `switch_mode`) or use a tool allowed in the current mode.

---

### B4. File Restriction Error (Write Group Regex)

**Trigger:** A write-group tool targets a file that doesn't match the mode's `fileRegex` pattern. This is a mode-level scope restriction on which files can be edited.

**Error message:**

> Tool '\<tool\>' in mode '\<mode\>' can only edit files matching pattern: \<regex\> (\<description\>). Got: \<path\>

When no `tool` is supplied the prefix is instead `This mode (\<mode\>) can only edit files matching pattern: …`. The `(\<description\>)` clause is omitted when `description` is unset.

**Type:** `FileRestrictionError` (custom error class — message defined in [`modes.ts`](../src/shared/modes.ts) L180-188)

**Location:** [`validateToolUse.ts`](../src/core/tools/validateToolUse.ts) — `doesFileMatchRegex` at L252-260, `FileRestrictionError` thrown at L402-409

**Effect:**

- `consecutiveMistakeCount++` (thrown as a caught `Error` in the validation catch block)
- Error `tool_result` pushed

**Recovery:** LLM must target a file matching the mode's allowed pattern, or switch modes.

---

### C1. Identical Consecutive Tool Calls (ToolRepetitionDetector)

**Trigger:** The same tool is called with identical parameters consecutively (detected via JSON serialization comparison). `new_task` is exempt (legitimate fan-out). The repetition limit equals `consecutiveMistakeLimit`.

**Error message:**

> Tool call repetition limit reached for \<name\>. Please try a different approach.

**Notable:** The detector triggers an ask (`"tool_repetition"`) before emitting the error, so the user can provide guidance inline.

**Location:** [`presentAssistantMessage.ts`](../src/core/assistant-message/presentAssistantMessage.ts) — L858-905

**Effect:**

- User is asked for guidance (same pattern as `mistake_limit_reached`)
- Telemetry exception captured with reason `"tool_repetition"`
- Error `tool_result` pushed

**Recovery:** LLM must try a different tool or approach. The user's feedback is injected into the conversation.

---

### D1. User Rejects Tool Approval

**Trigger:** During `askApproval(type="tool", …)`, the user clicks "No" (or the equivalent rejection action).

**Effect:**

- `shofer.didRejectTool = true`
- `pushToolResult(formatResponse.toolDenied())` or `formatResponse.toolDeniedWithFeedback(text)` if feedback was provided
- **All subsequent tool calls in the same turn are skipped** with:
    > Skipping tool \<description\> due to user rejecting a previous tool.

**Location:** [`presentAssistantMessage.ts`](../src/core/assistant-message/presentAssistantMessage.ts) — `askApproval` callback at L713-755, rejection path at L726-736; skip path at L545-561

**Recovery:** The tool result contains the rejection. The LLM receives it and can try a different approach in the next turn.

---

### E1. Missing Required Parameter

**Trigger:** A tool handler detects that a required parameter is missing from the call.

**Error message:**

> Shofer tried to use \<tool\> without value for required parameter '\<param\>'. Retrying...

**Location:** [`Task.sayAndCreateMissingParamError`](../src/core/task/Task.ts) — L3096 (message at L3099-3101)

**Effect:**

- Error rendered to chat via `shofer.say("error", …)`
- `task.didToolFailInCurrentTurn = true` (set by tool handler before calling)
- `task.recordToolError(toolName)` called (in most handlers)
- The returned error string is pushed as `tool_result`

**Recovery:** The error message explicitly says "Retrying..." — the LLM is expected to retry with the missing parameter provided.

---

### E2. Runtime Error in Tool Handler

**Trigger:** Any unhandled exception thrown during tool execution (e.g., filesystem error, network error, logic bug).

**Error message:**

> Error \<action\>:\n\<error.message or serialized error\>

Where \<action\> is the `action` parameter passed to `handleError`.

**Location:** [`presentAssistantMessage.ts`](../src/core/assistant-message/presentAssistantMessage.ts) — `handleError` callback at L759

**Effect:**

- Error serialized with `serializeError` and rendered to chat
- `pushToolResult(formatResponse.toolError(errorString))`
- `AskIgnoredError` is silently swallowed (internal control-flow signal, not a real error)

**Recovery:** LLM receives the error message and can decide how to proceed.

---

### E3. Protected File / `.shoferignore` Block

**Trigger:** A write tool targets a file matching `ShoferProtectedController.PROTECTED_PATTERNS` or excluded by `.shoferignore`.

**Files covered by `PROTECTED_PATTERNS`:** `.shofer/**`, `.vscode/**`, `*.code-workspace`, `.shoferprotected`, `AGENTS.md`, `AGENT.md` (the exact array at [`ShoferProtectedController.ts`](../src/core/protect/ShoferProtectedController.ts) L16-23). The separate `.shoferignore` exclusion is enforced by the ignore-controller pipeline, **not** by `PROTECTED_PATTERNS`; `.shofermodes` / `.shoferrules*` are not in the protected list.

**Location:** [`ShoferProtectedController.ts`](../src/core/protect/ShoferProtectedController.ts)

**Effect:**

- Tool handler checks `isWriteProtected(relPath)` and returns an error
- The UI marks the target with `SHIELD_SYMBOL` (🛡️)

**Recovery:** LLM must target a different file or the user must modify protection settings.

---

### F1. Consecutive Mistake Limit Reached

**Trigger:** `consecutiveMistakeCount` reaches `consecutiveMistakeLimit` (default: 3) within a single turn. Counter increments on: validation errors (B1-B4), missing nativeArgs (A2), XML tool calls (A1), and certain handler-level errors.

**Error message (via ask):**

> "mistake_limit_reached" ask type — user is prompted for guidance.

**Location:** [`Task.ts`](../src/core/task/Task.ts) — `recursivelyMakeShoferRequests`: mistake-limit gate at L4219-4220, `mistake_limit_reached` ask at L4239

**Effect:**

- `captureConsecutiveMistakeError` telemetry event
- User asked via `mistake_limit_reached` ask
- Counter reset to 0 after the ask resolves
- If user provides feedback, it's injected into the conversation

**Recovery:** User provides guidance; counter resets. Task continues.

---

## 3. Error Counter Behavior

| Failure Stage            | Increments `consecutiveMistakeCount`         | Calls `recordToolError`               | Sets `didAlreadyUseTool`            |
| ------------------------ | -------------------------------------------- | ------------------------------------- | ----------------------------------- |
| A1 — Missing tool_use.id | ✅                                           | Best-effort (if name available)       | ✅                                  |
| A2 — Missing nativeArgs  | ✅                                           | ✅                                    | ❌                                  |
| B1 — Unknown tool        | ✅                                           | ❌ (validation throws before handler) | ❌                                  |
| B2 — Tool disabled       | ✅                                           | ❌                                    | ❌                                  |
| B3 — Not allowed in mode | ✅                                           | ❌                                    | ❌                                  |
| B4 — File restriction    | ✅                                           | ❌                                    | ❌                                  |
| C1 — Repetition          | ✅ (via telemetry only)                      | ❌                                    | ❌                                  |
| D1 — User reject         | ❌                                           | ❌                                    | ✅ (indirectly via `didRejectTool`) |
| E1 — Missing param       | ❌ (handler sets `didToolFailInCurrentTurn`) | ✅                                    | ❌                                  |
| E2 — Runtime error       | ❌                                           | ❌                                    | ❌                                  |
| E3 — Protected file      | ❌                                           | ❌                                    | ❌                                  |

**Key insight:** `consecutiveMistakeCount` is primarily for _model errors_ (invalid calls, wrong tools, wrong modes) — not for _execution errors_ (filesystem, network, business logic). The model can't fix a disk-full error by trying again, but it can fix a wrong tool name.

---

## 4. Tool-Result Contract

Every tool_use block MUST receive exactly one `tool_result` (native tool calling requirement). The dispatch code enforces this:

- `hasToolResult` flag prevents duplicates (L563, L616)
- `pushToolResult` is the single choke point for emitting results
- Error paths use `pushToolResult` or `shofer.pushToolResultToUserContent(…)` directly
- `didAlreadyUseTool = true` signals the stream loop to stop collecting more tool_use blocks in this turn

---

## 5. Adding a New Failure Mode

When adding a new failure path:

1. Add it to the taxonomy diagram in §1
2. Add a detailed entry in §2
3. Update the counter table in §3 if the new mode affects counters
4. Ensure the failure emits exactly one `tool_result` with `is_error: true`
5. Consider whether the failure should increment `consecutiveMistakeCount` (model-recoverable errors → yes; infrastructure errors → no)
