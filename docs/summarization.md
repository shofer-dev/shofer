# Shofer Context Management & Summarization

## Overview

Shofer uses a **reactive** approach to context management — condensation/truncation is triggered when approaching context window limits, not proactively on every request.

## Key Components

### 1. Context Management ([`src/core/context-management/index.ts`](extensions/shofer/src/core/context-management/index.ts))

Main entry point for context management. Combines:

- **Condensation** (LLM-based summarization)
- **Sliding window truncation** (fallback)

Key exports:

- [`manageContext()`](extensions/shofer/src/core/context-management/index.ts:256) — Main function to manage context
- [`truncateConversation()`](extensions/shofer/src/core/context-management/index.ts:68) — Non-destructive sliding window (tags messages as hidden)
- [`willManageContext()`](extensions/shofer/src/core/context-management/index.ts:162) — Checks if context management will be triggered (used for UI indicators)
- [`estimateTokenCount()`](extensions/shofer/src/core/context-management/index.ts:36) — Token counting via provider
- [`TOKEN_BUFFER_PERCENTAGE = 0.1`](extensions/shofer/src/core/context-management/index.ts:27) — 10% buffer that acts as hard safety net (condensation/truncation triggers at ~90% usage regardless of percentage threshold)

Types:

- [`ContextManagementOptions`](extensions/shofer/src/core/context-management/index.ts:218) — Full options for `manageContext()`, including `metadata`, `environmentDetails`, `filesReadByRoo`, `cwd`, `shoferIgnoreController`
- [`ContextManagementResult`](extensions/shofer/src/core/context-management/index.ts:243) — Return type including `truncationId`, `messagesRemoved`, `newContextTokensAfterTruncation`
- [`WillManageContextOptions`](extensions/shofer/src/core/context-management/index.ts:142) — Subset of options for `willManageContext()`, including `profileThresholds`, `currentProfileId`, `lastMessageTokens`

#### Profile-Level Thresholds

Each API profile can override the global [`autoCondenseContextPercent`](extensions/shofer/src/core/task/Task.ts:5063) (default [`90`](extensions/shofer/src/core/task/Task.ts:5063)) with a per-profile threshold stored in [`profileThresholds`](extensions/shofer/src/core/context-management/index.ts:229). A value of `-1` means "inherit from global." The effective threshold is resolved at the start of [`manageContext()`](extensions/shofer/src/core/context-management/index.ts:295-312).

### 2. Condense Module ([`src/core/condense/index.ts`](extensions/shofer/src/core/condense/index.ts))

Handles LLM-based summarization of conversation history.

Key exports:

- [`summarizeConversation()`](extensions/shofer/src/core/condense/index.ts:257) — Main summarization function
- [`getMessagesSinceLastSummary()`](extensions/shofer/src/core/condense/index.ts:526) — Get messages to summarize
- [`getEffectiveApiHistory()`](extensions/shofer/src/core/condense/index.ts:553) — Get history with summaries applied; also filters orphan tool_result blocks
- [`cleanupAfterTruncation()`](extensions/shofer/src/core/condense/index.ts:660) — Clears orphaned `condenseParent`/`truncationParent` references after rewind/delete
- [`transformMessagesForCondensing()`](extensions/shofer/src/core/condense/index.ts:103) — Converts tool blocks to text
- [`toolUseToText()`](extensions/shofer/src/core/condense/index.ts:22), [`toolResultToText()`](extensions/shofer/src/core/condense/index.ts:42) — Convert tool calls for summarization (handle both string and array content)
- [`injectSyntheticToolResults()`](extensions/shofer/src/core/condense/index.ts:135) — Handle orphan tool calls (prevents API rejections from providers like OpenAI)

Constants:

- [`MIN_CONDENSE_THRESHOLD = 5`](extensions/shofer/src/core/condense/index.ts:112) — Minimum user-configurable % of context window for condensation trigger
- [`MAX_CONDENSE_THRESHOLD = 100`](extensions/shofer/src/core/condense/index.ts:113) — Maximum user-configurable %
- Note: [`TOKEN_BUFFER_PERCENTAGE = 0.1`](extensions/shofer/src/core/context-management/index.ts:27) acts as a hard safety net — condensation/truncation fires when tokens exceed 90% of context window minus output reservation

### 3. File Context Folding ([`src/core/condense/foldedFileContext.ts`](extensions/shofer/src/core/condense/foldedFileContext.ts))

When Shofer has read files during the task (tracked via [`filesReadByRoo`](extensions/shofer/src/core/context-management/index.ts:236)), their structural definitions are folded into the condensed summary. This preserves awareness of file structure (function signatures, class declarations, etc.) without consuming the full token cost of file bodies.

- [`generateFoldedFileContext()`](extensions/shofer/src/core/condense/foldedFileContext.ts:77) — Uses tree-sitter to extract signatures-only definitions
- Each file gets its own `<system-reminder>` block in the summary
- Configurable `maxCharacters` (default: 50000)
- Files that fail or are unsupported are gracefully skipped

### 4. System Prompt Generation ([`src/core/webview/generateSystemPrompt.ts`](extensions/shofer/src/core/webview/generateSystemPrompt.ts))

Constructs system prompts with:

- Mode role definitions
- Custom instructions (`.shofer/rules/`, user settings)
- MCP tool schemas
- Todo list instructions
- Agent rules (`.shofer/agent-rules/`, `AGENTS.md` files)
- Skill instructions

Uses [`SYSTEM_PROMPT()`](extensions/shofer/src/core/prompts/system.ts) from `src/core/prompts/system.ts`

## How Condensation Works

### Trigger Mechanism

Two conditions are checked; either fires condensation:

| Trigger                  | Formula                                                                              | Default Behavior                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| **Percentage threshold** | `contextPercent >= effectiveThreshold`                                               | Default [`autoCondenseContextPercent = 90`](extensions/shofer/src/core/task/Task.ts:5063) (triggers at 90% utilization) |
| **Absolute safety net**  | `prevContextTokens > contextWindow * (1 - TOKEN_BUFFER_PERCENTAGE) - reservedTokens` | Always active; fires at ~90% of context window minus output reservation regardless of percentage setting                |

The safety net is hardcoded via [`TOKEN_BUFFER_PERCENTAGE = 0.1`](extensions/shofer/src/core/context-management/index.ts:27) — meaning condensation **will always trigger by ~90% utilization** even if the user-configured percentage threshold is set higher (e.g., 100%). The percentage threshold is user-configurable between [`MIN_CONDENSE_THRESHOLD (5%)`](extensions/shofer/src/core/condense/index.ts:112) and [`MAX_CONDENSE_THRESHOLD (100%)`](extensions/shofer/src/core/condense/index.ts:113). Each API profile can also override the global threshold via [`profileThresholds`](extensions/shofer/src/core/context-management/index.ts:229).

### Invocation Points

[`manageContext()`](extensions/shofer/src/core/context-management/index.ts:256) is called in three places:

1. **Every API request** — In [`Task.attemptApiRequest()`](extensions/shofer/src/core/task/Task.ts:5051), before sending messages to the model. A pre-check via [`willManageContext()`](extensions/shofer/src/core/task/Task.ts:5115) determines whether to show an in-progress UI indicator.
2. **Context window exceeded recovery** — In [`Task.handleContextWindowExceededError()`](extensions/shofer/src/core/task/Task.ts:4889), forced with [`FORCED_CONTEXT_REDUCTION_PERCENT`](extensions/shofer/src/core/task/Task.ts:146) (aggressive reduction after API error).
3. **Manual condensation** — In [`Task.condenseContext()`](extensions/shofer/src/core/task/Task.ts:2076), triggered by user action (calls [`summarizeConversation()`](extensions/shofer/src/core/condense/index.ts:257) directly with `isAutomaticTrigger: false`).

### Process

1. Extracts messages since last summary via [`getMessagesSinceLastSummary()`](extensions/shofer/src/core/condense/index.ts:526)
2. Injects synthetic tool_results for orphan tool_calls via [`injectSyntheticToolResults()`](extensions/shofer/src/core/condense/index.ts:135) — prevents API rejections
3. Converts tool_use/tool_result blocks to text via [`transformMessagesForCondensing()`](extensions/shofer/src/core/condense/index.ts:103) (no tools param needed for summarization call)
4. Removes image blocks via [`maybeRemoveImageBlocks()`](extensions/shofer/src/core/condense/index.ts:322)
5. Calls LLM with a constructed prompt: the custom condensing prompt ([`customCondensingPrompt`](extensions/shofer/src/core/condense/index.ts:306), from user settings `customSupportPrompts.CONDENSE`) or the default [`supportPrompt.default.CONDENSE`](extensions/shofer/src/core/condense/index.ts:306)
6. Builds a summary message with **multiple content blocks**:
    - **Summary text** — The LLM-generated summary wrapped in `## Conversation Summary`
    - **Command blocks** — `<command>` blocks extracted from the original task via [`extractCommandBlocks()`](extensions/shofer/src/core/condense/index.ts:188), preserved in a `<system-reminder>` block to maintain active workflows across condensings
    - **Folded file context** — Signatures-only file definitions via [`generateFoldedFileContext()`](extensions/shofer/src/core/condense/foldedFileContext.ts:77), each file in its own `<system-reminder>` block
    - **Environment details** — Only for automatic condensation ([`isAutomaticTrigger: true`](extensions/shofer/src/core/condense/index.ts:451)); manual condensation skips this because fresh environment details are injected on the next turn
7. Tags all prior messages with [`condenseParent`](extensions/shofer/src/core/task-persistence/apiMessages.ts:31) (non-destructive; messages are hidden, not deleted)
8. Appends the summary message with role `"user"` (fresh-start model)

### Environment Details Handling

- **Automatic condensation** (`isAutomaticTrigger=true`): Environment details are included in the summary because the API request is already in progress and the next user message won't have fresh environment details.
- **Manual condensation** (`isAutomaticTrigger=false`): Environment details are NOT included — fresh environment details will be injected on the very next turn via `getEnvironmentDetails()`.

### Error Handling

Condensation failures are surfaced via localized error strings:

| Error Key                                                                              | Condition                                                                    |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [`condense_not_enough_messages`](extensions/shofer/src/i18n/locales/en/common.json:62) | Fewer than 2 messages to summarize                                           |
| [`condensed_recently`](extensions/shofer/src/i18n/locales/en/common.json:63)           | A recent summary already exists with too few new messages                    |
| [`condense_handler_invalid`](extensions/shofer/src/i18n/locales/en/common.json:64)     | API handler is missing or lacks `createMessage`                              |
| [`condense_api_failed`](extensions/shofer/src/core/condense/index.ts:390)              | API call threw an exception (detailed error info captured in `errorDetails`) |
| [`condense_failed`](extensions/shofer/src/core/condense/index.ts:398)                  | LLM returned an empty summary                                                |

### Fallback to Sliding Window Truncation

If condensation fails (API error, empty response) or has too few messages, falls back to sliding window truncation when `prevContextTokens > allowedTokens`.

## Sliding Window Truncation

Non-destructive approach:

- Messages are **tagged** with [`truncationParent`](extensions/shofer/src/core/task-persistence/apiMessages.ts:36), not deleted
- First message always retained
- Removes oldest visible messages (positional, not priority-based)
- A truncation marker message is inserted at the boundary
- Can restore if user rewinds past truncation point

### Cleanup After Rewind/Delete

When a summary message or truncation marker is deleted (via rewind), [`cleanupAfterTruncation()`](extensions/shofer/src/core/condense/index.ts:660) clears orphaned [`condenseParent`](extensions/shofer/src/core/task-persistence/apiMessages.ts:31) and [`truncationParent`](extensions/shofer/src/core/task-persistence/apiMessages.ts:36) references, restoring previously-hidden messages to active status.

## Events Emitted

- [`condense_context`](extensions/shofer/packages/types/src/context-management.ts:19) — When condensation succeeds
- [`condense_context_error`](extensions/shofer/packages/types/src/context-management.ts:20) — When condensation fails
- [`sliding_window_truncation`](extensions/shofer/packages/types/src/context-management.ts:21) — When truncation occurs

Message data fields ([`packages/types/src/message.ts`](extensions/shofer/packages/types/src/message.ts)):

- [`contextCondense`](extensions/shofer/packages/types/src/message.ts:248): `{ cost, prevContextTokens, newContextTokens, summary, condenseId? }`
- [`contextTruncation`](extensions/shofer/packages/types/src/message.ts:273): `{ truncationId, messagesRemoved, prevContextTokens, newContextTokens }`

### Effective API History

[`getEffectiveApiHistory()`](extensions/shofer/src/core/condense/index.ts:553) filters the full conversation to produce the subset actually sent to the API:

- **Fresh start model**: When a summary exists, returns only messages from the summary onwards
- Filters out messages tagged with [`condenseParent`](extensions/shofer/src/core/task-persistence/apiMessages.ts:31) (replaced by summary) or [`truncationParent`](extensions/shofer/src/core/task-persistence/apiMessages.ts:36) (hidden by truncation)
- Removes orphan tool_result blocks that reference tool_use IDs from condensed-away messages (orphan cleanup)

## Source References

- Context Management: [`src/core/context-management/index.ts`](extensions/shofer/src/core/context-management/index.ts)
- Condensation: [`src/core/condense/index.ts`](extensions/shofer/src/core/condense/index.ts)
- File Context Folding: [`src/core/condense/foldedFileContext.ts`](extensions/shofer/src/core/condense/foldedFileContext.ts)
- System Prompt: [`src/core/webview/generateSystemPrompt.ts`](extensions/shofer/src/core/webview/generateSystemPrompt.ts), [`src/core/prompts/system.ts`](extensions/shofer/src/core/prompts/system.ts)
- API Messages: [`src/core/task-persistence/apiMessages.ts`](extensions/shofer/src/core/task-persistence/apiMessages.ts)
- Tests: [`src/core/condense/__tests__/condense.spec.ts`](extensions/shofer/src/core/condense/__tests__/condense.spec.ts), [`src/core/context-management/__tests__/context-management.spec.ts`](extensions/shofer/src/core/context-management/__tests__/context-management.spec.ts)
- Types: [`packages/types/src/message.ts`](extensions/shofer/packages/types/src/message.ts) (ShoferMessage, ContextCondense, ContextTruncation), [`packages/types/src/context-management.ts`](extensions/shofer/packages/types/src/context-management.ts) (event types)
- Task integration: [`src/core/task/Task.ts`](extensions/shofer/src/core/task/Task.ts) (attemptApiRequest, handleContextWindowExceededError, condenseContext)
- i18n: [`src/i18n/locales/en/common.json`](extensions/shofer/src/i18n/locales/en/common.json) (condense error strings)

## Gaps & Areas for Improvement

1. **`TruncationResult` type not documented** — The [`TruncationResult`](extensions/shofer/src/core/context-management/index.ts:47) type (`{ messages, truncationId, messagesRemoved }`) exists alongside [`ContextManagementResult`](extensions/shofer/src/core/context-management/index.ts:243) but is not mentioned in this doc. It is the return type of [`truncateConversation()`](extensions/shofer/src/core/context-management/index.ts:68).

2. **`convertToolBlocksToText()` not documented** — The document references [`transformMessagesForCondensing()`](extensions/shofer/src/core/condense/index.ts:103), but the actual per-message conversion workhorse is [`convertToolBlocksToText()`](extensions/shofer/src/core/condense/index.ts:72). The former is a thin mapper over the latter.

3. **`SUMMARY_PROMPT` constant not mentioned** — The prompt construction section (step 5) describes `customCondensingPrompt` and `supportPrompt.default.CONDENSE` but omits [`SUMMARY_PROMPT`](extensions/shofer/src/core/condense/index.ts:115-124), the system-level prefix prepended to every condensing call. This prompt disables tool calls and re-frames the task as summarization-only.

4. **`maybeRemoveImageBlocks()` import path not shown** — This function (step 4 of Process) is imported from [`../../api/transform/image-cleaning`](extensions/shofer/src/api/transform/image-cleaning.ts), not defined in the condense module. The doc should clarify this is an external dependency.

5. **`toolTokens` counting not documented** — In [`summarizeConversation()`](extensions/shofer/src/core/condense/index.ts:509-513), the `newContextTokens` calculation includes tool definition tokens (`metadata.tools`) via a separate `apiHandler.countTokens()` call on the JSON-serialized tools array. This detail is invisible in the current doc.

6. **`SummarizeResponse` ← `ContextManagementResult` relationship not explicit** — [`ContextManagementResult`](extensions/shofer/src/core/context-management/index.ts:243) extends [`SummarizeResponse`](extensions/shofer/src/core/condense/index.ts:215) with `prevContextTokens`, `truncationId?`, `messagesRemoved?`, and `newContextTokensAfterTruncation?`. The doc documents both types independently but doesn't explain that one is a superset of the other.

7. **Telemetry not documented** — Both [`summarizeConversation()`](extensions/shofer/src/core/condense/index.ts:271) and [`truncateConversation()`](extensions/shofer/src/core/context-management/index.ts:69) emit telemetry events (`captureContextCondensed`, `captureSlidingWindowTruncation`). The Events Emitted section only covers ShoferMessage events (`condense_context`, `sliding_window_truncation`), not telemetry.

8. **`maxCharacters` default for file folding not API-verified** — The doc states the default `maxCharacters` is 50000 (line 60), which matches the source default in [`generateFoldedFileContext()`](extensions/shofer/src/core/condense/foldedFileContext.ts:81). However, no tests verify this constant across the folded-file pipeline, so a change in the default could go unnoticed.

9. **No section on abort/cancellation interaction** — Condensation calls `apiHandler.createMessage()` inside [`summarizeConversation()`](extensions/shofer/src/core/condense/index.ts:342), which iterates a stream. There's no discussion of what happens when the user cancels the task mid-condensation — whether the stream is aborted, partial summaries are discarded, or stale `condenseParent` tags are left behind.

10. **No section on the dual-path threshold resolution** — The effective threshold is resolved identically in both [`manageContext()`](extensions/shofer/src/core/context-management/index.ts:295-312) and [`willManageContext()`](extensions/shofer/src/core/context-management/index.ts:188-198). These are copy-pasted blocks that could drift apart. The doc could note this as a maintenance hazard.
