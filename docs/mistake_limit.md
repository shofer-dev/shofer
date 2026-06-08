# Consecutive Mistake Limit

The "Shofer is having trouble…" dialog appears when [`consecutiveMistakeCount`](src/core/task/Task.ts:594) reaches [`consecutiveMistakeLimit`](src/core/task/Task.ts:595) (default: 3, configurable per API profile; 0 disables). The guard fires at the top of every iteration of [`recursivelyMakeShoferRequests()`](src/core/task/Task.ts:4001-4034), **before** the next API request is sent. When the limit is hit:

1. Telemetry is emitted (`captureConsecutiveMistakeError` + `captureException`)
2. An `ask("mistake_limit_reached", …)` is posted with the guidance text from [`common:errors.mistake_limit_guidance`](src/i18n/locales/en/common.json:59)
3. If the user responds with a message, it is forwarded to the LLM as `user_feedback`
4. `consecutiveMistakeCount` is **reset to 0** after the user reacts

The counter is also reset to 0 on any **successful** tool execution and on abort.

## UI Rendering

The dialog is rendered by [`ErrorRow`](webview-ui/src/components/chat/ErrorRow.tsx:143) with `type="mistake_limit"`:

- **Title:** `chat:troubleMessage` → "Shofer is having trouble…"
- **Message:** The `message` prop (i18n guidance text)
- **Icon:** `MessageCircleWarning` (lucide-react)

The `ask("mistake_limit_reached")` case in [`ChatRowContent`](webview-ui/src/components/chat/ChatRow.tsx:2117) also dispatches directly to `<ErrorRow type="mistake_limit" …>`.

## Mechanisms (categorized by what increments the counter)

### 1. Post-stream no-tool-use guard

**File:** [`Task.ts:5314-5322`](src/core/task/Task.ts:5314)

After each streaming response is consumed, the loop checks whether the LLM produced any `tool_use` blocks. If `!didToolUse`, `consecutiveNoToolUseCount` is incremented. On the **second** consecutive no-tool-use turn (1-turn grace), `consecutiveMistakeCount++` is also incremented. On success, `consecutiveNoToolUseCount` resets to 0.

This fires, for example, when the LLM repeatedly produces pure text without calling any tools.

### 2. Tool repetition detection

**File:** [`ToolRepetitionDetector.ts`](src/core/tools/ToolRepetitionDetector.ts)

Each complete tool call is serialized to canonical JSON (`safe-stable-stringify` of `{ name, params, nativeArgs }`). If 3 **consecutive identical** calls are detected (same tool, same args), the detector returns `allowExecution: false` and an `ask("mistake_limit_reached", …)` fires directly from [`presentAssistantMessage`](src/core/assistant-message/presentAssistantMessage.ts:841). The counter is reset when a different tool (or different args) is called.

`new_task` is exempt from repetition detection (legitimate fan-out parallelism).

### 3. Mode/tool-validation failures in presentAssistantMessage

**File:** [`presentAssistantMessage.ts:812`](src/core/assistant-message/presentAssistantMessage.ts:812)

Every tool call goes through `validateToolUse()` before execution. If the tool is not allowed in the current mode (or is unknown, disabled, etc.), the catch block increments `consecutiveMistakeCount++` **per blocked tool call**. Since the LLM may call multiple tools in a single turn, multiple blocked tools in one response can add 2+ to the counter.

This is the mechanism that triggered in the `delme.json` example: two blocked tools × two turns = 4, crossing the default limit of 3.

### 4. Tool-level parameter validation errors

**Location:** Individual tool files in [`src/core/tools/`](src/core/tools/)

Nearly every tool handler increments `consecutiveMistakeCount++` on parameter validation failure before calling `recordToolError`. Examples:

| Tool                                    | What triggers                                                                       |
| --------------------------------------- | ----------------------------------------------------------------------------------- |
| `apply_diff`                            | Missing path, missing diff, non-existent file, failed diff application              |
| `write_to_file`                         | Missing path, missing content, worktree error                                       |
| `edit` / `edit_file` / `search_replace` | Missing path/old/new, identical old/new, file not found, no match, multiple matches |
| `execute_command`                       | Missing command                                                                     |
| `read_file`                             | Missing path, empty results                                                         |
| `list_files`                            | Missing path                                                                        |
| `find_files`                            | Missing pattern                                                                     |
| `grep_search`                           | Missing path or query                                                               |
| `new_task`                              | Missing mode, message, or todos (when required)                                     |
| `attempt_completion`                    | Incomplete todos with `preventCompletionWithOpenTodos` setting, missing result      |
| `use_mcp_tool`                          | Missing server/tool name, invalid arguments shape                                   |
| `sed`                                   | Missing path/pattern/replacement, worktree error, file not found, regex error       |
| `set_task_title`                        | Missing title                                                                       |
| `give_feedback`                         | Missing feedback text                                                               |
| `skills`                                | Missing skill name                                                                  |
| `insert_edit`                           | Missing path/line/text, worktree error, file not found                              |
| …and more                               | (every tool follows the same pattern)                                               |

### 5. presentAssistantMessage dispatch errors

**File:** [`presentAssistantMessage.ts`](src/core/assistant-message/presentAssistantMessage.ts)

The main tool dispatch switch in `presentAssistantMessage` also increments the counter for:

- **Missing `tool_use.id`** (line 382): Legacy XML tool calls are no longer supported
- **Invalid tool call / missing `nativeArgs`** (line 577): Malformed streaming arguments that couldn't be finalized
- **Unknown tool** (line 1397): Model invented a tool name that doesn't exist
- **Custom tool execution failure** (line 1342): Custom tool threw during `execute()`
- **Custom tool argument validation failure** (line 1320): Parameters failed `Zod.parse()`
- **Private tool execution failure** (line 1385): Private provider tool threw during invocation

## Counter Reset

`consecutiveMistakeCount` is reset to 0 by:

- **Every tool on successful execution** — each tool handler explicitly sets `task.consecutiveMistakeCount = 0` in its success path
- **After the `mistake_limit_reached` dialog** — set to 0 after the user responds ([`Task.ts:4034`](src/core/task/Task.ts:4034))
- **On task abort** — `consecutiveNoToolUseCount` and `consecutiveNoAssistantMessagesCount` are reset; `consecutiveMistakeCount` persists but the dialog guard is gated by `this.abort` being false

## Configuration

| Setting                   | Default | Constant                                                                          |
| ------------------------- | ------- | --------------------------------------------------------------------------------- |
| `consecutiveMistakeLimit` | `3`     | [`DEFAULT_CONSECUTIVE_MISTAKE_LIMIT`](packages/types/src/provider-settings.ts:29) |

Set per API configuration profile. A value of `0` disables the "Shofer is having trouble" dialog entirely — the guard at [`Task.ts:4001`](src/core/task/Task.ts:4001) becomes a no-op.

## Known Issues

- **Mode-filtering failures (mechanism 3) share the same counter as real model errors.** A model calling two mode-blocked tools per turn will hit the limit in just two turns, even if it's trying _different_ tools each time (demonstrating adaptation). The counter increments per blocked tool, not per blocked turn.
- **ToolRepetitionDetector (mechanism 2) uses its own counter** (`consecutiveIdenticalToolCallCount`), not `consecutiveMistakeCount`. It fires an independent ask without going through the `recursivelyMakeShoferRequests` guard.
