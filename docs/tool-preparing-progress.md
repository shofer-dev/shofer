# Tool Preparation Progress Indicator

> Source: [`../../extensions/llm-provider/src/language-model-provider.ts`](../../extensions/llm-provider/src/language-model-provider.ts)
> Source: [`src/api/providers/vscode-lm.ts`](src/api/providers/vscode-lm.ts)
> Source: [`src/api/transform/stream.ts`](src/api/transform/stream.ts)
> Source: [`src/core/task/Task.ts`](src/core/task/Task.ts)
> Source: [`webview-ui/src/components/chat/ChatRow.tsx`](webview-ui/src/components/chat/ChatRow.tsx)

When tools stream large arguments (e.g., multi-KB `write_to_file` payloads),
the user sees zero visible activity in the chat UI. The `llm-provider` used to
emit a one-shot `"Preparing tool call: …\n"` into the thinking bubble plus `"."`
dots as a 5s heartbeat — both polluted the collapsible thinking content and
conveyed no useful progress information.

This feature replaces that noise with an **inline chat row** that displays a
spinner, the tool name in monospace, and a byte-count progress metric. The row
updates in place via the existing partial-message mechanism and disappears when
`tool_call_start` fires.

## Data flow

```
llm-provider                  vscode-lm.ts            stream.ts            Task.ts              ChatRow.tsx
─────────────                 ────────────            ─────────             ───────              ───────────
emit structured marker  →     detect \x00 prefix  →   yield                post partial    →    inline row with
(\x00tool_preparing\x00       via regex, yield        tool_preparing       webview message       spinner + bytes
 toolName\x00bytes\x00)       tool_preparing chunk     chunk type          say(…,partial=true)
```

All markers for the same tool index pass through the same `say(…, partial=true)`
invocation, so the webview **replaces** the previous row rather than accumulating
duplicates.

## Protocol

### Marker format

The `llm-provider` emits markers as `LanguageModelThinkingPart` values with the
following null-byte-delimited structure:

```
\x00tool_preparing\x00<toolName>\x00<byteCount>\x00
```

| Field       | Description                                            |
| ----------- | ------------------------------------------------------ |
| `\x00`      | Null-byte delimiter — invisible if leaked, unambiguous |
| `toolName`  | The function name from the streaming tool call delta   |
| `byteCount` | Integer, bytes of accumulated JSON arguments received  |

### Emission rules

- **First name detection**: emitted immediately when a tool call delta first
  carries a `function.name`, even if `byteCount` is 0 or small.
- **Subsequent updates**: re-emitted on every subsequent tool call delta
  carrying the function name, with the updated accumulated byte count
  (each delta also updates `lastVisibleEmitMs` for any future
  idle-detection logic, though no timer-based re-emission is currently
  implemented).
- **Stop condition**: the provider stops emitting after the accumulated tool call
  is reported as a final `LanguageModelToolCallPart` on `finishReason`.

### Detection (vscode-lm.ts)

The `LanguageModelThinkingPart` handler checks each chunk value against:

```js
;/^\x00tool_preparing\x00([^\x00]+)\x00(\d+)\x00$/
```

A match yields `{ type: "tool_preparing", toolName, byteCount }`. Non-matching
values continue to yield `{ type: "reasoning", text }` as before. The regex
uses `\x00` as a delimiter so legitimate thinking text can never accidentally
trigger a false positive.

### Rendering (ChatRow.tsx)

The row renders only while `message.partial === true` and a valid JSON payload
(`{ toolName, byteCount }`) is parsed. When `tool_call_start` fires,
`partial` becomes `false` and the row returns `null` (disappears).

**Visual layout**:

```
┌──────────────────────────────────────────────┐
│ ◌  Preparing write_to_file…        1.4 KB   │
└──────────────────────────────────────────────┘
```

- Spinner: [`ProgressIndicator`](webview-ui/src/components/chat/ProgressIndicator.tsx)
  (wraps `VSCodeProgressRing` at 0.55x scale).
- Tool name: `font-family: var(--vscode-editor-font-family)`, weight 500.
- Byte count: right-aligned, formatted as `B` below 1024, `KB` with one
  decimal above. Uses `text-vscode-descriptionForeground` for subdued color.

## Files changed

| File                                                                                                                     | Change                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| [`extensions/llm-provider/src/language-model-provider.ts`](../../extensions/llm-provider/src/language-model-provider.ts) | Replace announcement + dot heartbeat with `buildPreparingMarker()` emitting `\x00`-delimited markers on first name and every 5s |
| [`packages/types/src/message.ts`](packages/types/src/message.ts)                                                         | Add `"tool_preparing"` to `shoferSays` / `ShoferSay` union                                                                      |
| [`src/api/transform/stream.ts`](src/api/transform/stream.ts)                                                             | Add `ApiStreamToolPreparingChunk` interface and union member                                                                    |
| [`src/api/providers/vscode-lm.ts`](src/api/providers/vscode-lm.ts)                                                       | Detect `\x00tool_preparing\x00…` via regex in `LanguageModelThinkingPart`, yield `tool_preparing` chunk                         |
| [`src/core/task/Task.ts`](src/core/task/Task.ts)                                                                         | Add `case "tool_preparing"` in stream consumer, posts partial via `say("tool_preparing", …, true)`                              |
| [`webview-ui/src/components/chat/ChatRow.tsx`](webview-ui/src/components/chat/ChatRow.tsx)                               | Render inline row with spinner, monospace tool name, and formatted byte count                                                   |
| [`webview-ui/src/i18n/locales/en/chat.json`](webview-ui/src/i18n/locales/en/chat.json)                                   | Add `toolPreparing.preparing` key                                                                                               |

## Design decisions

### Why `\x00` delimiters instead of a new VS Code API construct

- No VS Code release cycle dependency.
- Minimal changes (~7 files, ~100 lines total).
- Backward compatible: old Shofer ignores unknown chunk types.
- Null bytes are invisible if leaked into real thinking text and cannot
  occur in legitimate LLM reasoning output.

### Why partial-message mechanism instead of a new webview message type

The existing `say("type", text, images?, partial?)` machinery already handles
in-place row updates — when `partial=true` and the previous message has the
same `say` type, `Task.ts` calls `updateShoferMessage()` which replaces the
row instead of appending. Reusing this avoids duplicating the

## Issues & improvement areas

### Missing timer-based heartbeat

The original design described a 5s re-emission heartbeat, but
[`language-model-provider.ts`](../../extensions/llm-provider/src/language-model-provider.ts)
does not include a timer. The `lastVisibleEmitMs` variable (line 365) is
assigned in four places but never read. Re-emission piggybacks on every
tool call delta carrying a `function.name` — this works while deltas flow
but leaves the progress row frozen during network stalls.

**Suggested fix**: Add a `setInterval` that reads `lastVisibleEmitMs` and,
when >5s have elapsed since the last visible emission, re-emits the marker
for any in-progress tool call. Clear on `finishReason`.

### i18n key unused in ChatRow.tsx

The key `chat.toolPreparing.preparing` was added to
[`chat.json`](../webview-ui/src/i18n/locales/en/chat.json) (line 361) but
[`ChatRow.tsx`](../webview-ui/src/components/chat/ChatRow.tsx) line 1360
uses the hardcoded string `"Preparing"` instead of
`t("chat.toolPreparing.preparing", { toolName })`. This violates the i18n
String Rule in AGENTS.md. Either wire the i18n key or remove the unused
entry.

### `lastVisibleEmitMs` is dead code

The variable is initialized on line 365 and updated on lines 386, 393, 425
but never read. If a timer-based heartbeat is not planned, remove the
variable and all four assignments. If it IS planned, add a TODO comment.

### No explicit stop guard

Emission stops only because the stream ends on `finishReason` — there is no
`isPreparing` boolean flag to prevent accidental marker leaks if the stream
model changes. A defensive flag set on first emit and cleared on
`finishReason` would be safer.
.
