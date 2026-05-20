# Integration Tests: Tool Preparation Progress Indicator

> Feature doc: [`docs/tool-preparing-progress.md`](../docs/tool-preparing-progress.md)
> Implementation: [`llm-provider/src/language-model-provider.ts`](../../extensions/llm-provider/src/language-model-provider.ts),
> [`vscode-lm.ts`](../src/api/providers/vscode-lm.ts),
> [`stream.ts`](../src/api/transform/stream.ts),
> [`Task.ts`](../src/core/task/Task.ts),
> [`ChatRow.tsx`](../webview-ui/src/components/chat/ChatRow.tsx)

## Scenarios

### 1. Large tool argument → progress row renders

**Given** a task is running with an AI provider that streams tool calls
**When** the model initiates a `write_to_file` with a >1 KB content argument
**Then** a partial `tool_preparing` message appears in the chat with:

- A spinner (`ProgressIndicator` component)
- The tool name in monospace font
- A right-aligned byte count that updates as chunks arrive
  **And** the row disappears when `tool_call_start` fires

**Verification**: Check the ChatView DOM for a row with class
`"tool_preparing"` containing a `VSCodeProgressRing` and a formatted byte
count.

### 2. Small tool argument → row appears briefly then vanishes

**Given** a task is running
**When** the model initiates a tool call with a tiny argument (< 100 bytes)
**Then** the `tool_preparing` row may appear for one or two frames
**And** it disappears cleanly when the tool call starts
**And** no orphaned partial row remains in the chat

**Verification**: Confirm no `partial: true` `tool_preparing` messages
remain in `shoferMessages` after the tool call completes.

### 3. Consecutive tool calls → each gets its own progress row

**Given** a task is running
**When** the model issues two tool calls back-to-back (e.g., `list_files`
then `write_to_file`)
**Then** the first tool's progress row appears and is dismissed
**And** the second tool's progress row appears independently
**And** the second row does not overlap or merge with the first

**Verification**: Check that `dismissToolPreparingRow` is called between
tool calls and that the second call's row has `partial: true` initially.

### 4. Progress row dismissed on stream error

**Given** a task is running
**When** a tool call argument stream is interrupted (e.g., provider
disconnects or `cancelTask` is triggered)
**Then** any outstanding `tool_preparing` row is dismissed
**And** the chat shows the appropriate error message
**And** no stale progress row persists

**Verification**: Simulate a stream teardown and check that
`dismissToolPreparingRow()` is invoked in the catch/finally path
of `Task.ts`.

### 5. Byte count formatting boundaries

**Given** a task is running with a streaming tool call
**When** the accumulated byte count crosses formatting thresholds
**Then** the displayed unit is correct:

- 0–1023 bytes → `"N B"` (e.g., `"512 B"`)
- 1024+ bytes → `"N.N KB"` with one decimal (e.g., `"1.5 KB"`, `"12.3 KB"`)

**Verification**: The `formatBytes` helper in `ChatRow.tsx` produces the
correct string for boundary values: `0`, `1`, `1023`, `1024`, `1536`, `102400`.

### 6. marker protocol round-trip

**Given** `llm-provider` emits a `\x00tool_preparing\x00myTool\x001234\x00`
**When** the marker passes through VS Code's `LanguageModelThinkingPart` →
`vscode-lm.ts` regex → `AiStreamToolPreparingChunk` → `Task.ts` case →
`ChatRow.tsx` render
**Then** the chat row displays "Preparing myTool…" with byte count "1.2 KB"
**And** no null bytes or marker artifacts leak into visible text

**Verification**: Full end-to-end test with a mock provider emitting the
exact marker string. Inspect the rendered DOM for the tool name and byte
count, confirm zero null bytes in visible text.

### 7. Regex false-positive resistance

**Given** the AI model emits legitimate thinking text
**When** that text contains characters or patterns that might resemble a
`tool_preparing` marker
**Then** the regex in `vscode-lm.ts` does NOT match
**And** the thinking text passes through as normal `reasoning` chunks

**Verification**: Feed thinking strings through the regex and confirm no
false matches. Edge cases: null bytes not at position 0, `tool_preparing`
as literal text without null delimiters, partial matches.

### 8. Multiple deltas for same tool → row kv-updates in-place

**Given** a tool call has `function.name` from the first delta
**When** subsequent deltas arrive carrying the same `function.name`
**Then** `Task.say("tool_preparing", …, partial=true)` is called for each
**And** the webview replaces the existing row rather than appending a new one
**And** only one progress row is visible at any time for this tool

**Verification**: Count `tool_preparing` messages in `shoferMessages` after
three deltas. Should have exactly one (the latest), not three.
