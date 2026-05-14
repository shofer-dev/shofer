# Shofer Context Management & Summarization

## Overview

Shofer uses a **reactive** approach to context management — condensation/truncation is triggered when approaching context window limits, not proactively on every request.

## Key Components

### 1. Context Management ([`src/core/context-management/index.ts`](extensions/shofer/src/core/context-management/index.ts))

Main entry point for context management. Combines:

- **Condensation** (LLM-based summarization)
- **Sliding window truncation** (fallback)

Key exports:

- [`manageContext()`](extensions/shofer/src/core/context-management/index.ts:255) — Main function to manage context
- [`truncateConversation()`](extensions/shofer/src/core/context-management/index.ts:67) — Non-destructive sliding window (tags messages as hidden)
- [`willManageContext()`](extensions/shofer/src/core/context-management/index.ts:161) — Checks if context management will be triggered (used for UI indicators)
- [`estimateTokenCount()`](extensions/shofer/src/core/context-management/index.ts:35) — Token counting via provider
- [`TOKEN_BUFFER_PERCENTAGE = 0.1`](extensions/shofer/src/core/context-management/index.ts:26) — 10% buffer that acts as hard safety net (condensation/truncation triggers at ~90% usage regardless of percentage threshold)

Types:

- [`ContextManagementOptions`](extensions/shofer/src/core/context-management/index.ts:217) — Full options for `manageContext()`, including `metadata`, `environmentDetails`, `filesReadByRoo`, `cwd`, `shoferIgnoreController`
- [`ContextManagementResult`](extensions/shofer/src/core/context-management/index.ts:242) — Return type including `truncationId`, `messagesRemoved`, `newContextTokensAfterTruncation`
- [`WillManageContextOptions`](extensions/shofer/src/core/context-management/index.ts:141) — Subset of options for `willManageContext()`, including `profileThresholds`, `currentProfileId`, `lastMessageTokens`

#### Profile-Level Thresholds

Each API profile can override the global [`autoCondenseContextPercent`](extensions/shofer/src/core/task/Task.ts:4835) (default [`90`](extensions/shofer/src/core/task/Task.ts:4835)) with a per-profile threshold stored in [`profileThresholds`](extensions/shofer/src/core/context-management/index.ts:228). A value of `-1` means "inherit from global." The effective threshold is resolved at the start of [`manageContext()`](extensions/shofer/src/core/context-management/index.ts:294-311).

### 2. Condense Module ([`src/core/condense/index.ts`](extensions/shofer/src/core/condense/index.ts))

Handles LLM-based summarization of conversation history.

Key exports:

- [`summarizeConversation()`](extensions/shofer/src/core/condense/index.ts:256) — Main summarization function
- [`getMessagesSinceLastSummary()`](extensions/shofer/src/core/condense/index.ts:525) — Get messages to summarize
- [`getEffectiveApiHistory()`](extensions/shofer/src/core/condense/index.ts:552) — Get history with summaries applied; also filters orphan tool_result blocks
- [`cleanupAfterTruncation()`](extensions/shofer/src/core/condense/index.ts:659) — Clears orphaned `condenseParent`/`truncationParent` references after rewind/delete
- [`transformMessagesForCondensing()`](extensions/shofer/src/core/condense/index.ts:102) — Converts tool blocks to text
- [`toolUseToText()`](extensions/shofer/src/core/condense/index.ts:21), [`toolResultToText()`](extensions/shofer/src/core/condense/index.ts:41) — Convert tool calls for summarization (handle both string and array content)
- [`injectSyntheticToolResults()`](extensions/shofer/src/core/condense/index.ts:134) — Handle orphan tool calls (prevents API rejections from providers like OpenAI)

Constants:

- [`MIN_CONDENSE_THRESHOLD = 5`](extensions/shofer/src/core/condense/index.ts:111) — Minimum user-configurable % of context window for condensation trigger
- [`MAX_CONDENSE_THRESHOLD = 100`](extensions/shofer/src/core/condense/index.ts:112) — Maximum user-configurable %
- Note: [`TOKEN_BUFFER_PERCENTAGE = 0.1`](extensions/shofer/src/core/context-management/index.ts:26) acts as a hard safety net — condensation/truncation fires when tokens exceed 90% of context window minus output reservation

### 3. File Context Folding ([`src/core/condense/foldedFileContext.ts`](extensions/shofer/src/core/condense/foldedFileContext.ts))

When Shofer has read files during the task (tracked via [`filesReadByRoo`](extensions/shofer/src/core/context-management/index.ts:235)), their structural definitions are folded into the condensed summary. This preserves awareness of file structure (function signatures, class declarations, etc.) without consuming the full token cost of file bodies.

- [`generateFoldedFileContext()`](extensions/shofer/src/core/condense/foldedFileContext.ts:76) — Uses tree-sitter to extract signatures-only definitions
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
| **Percentage threshold** | `contextPercent >= effectiveThreshold`                                               | Default [`autoCondenseContextPercent = 90`](extensions/shofer/src/core/task/Task.ts:4835) (triggers at 90% utilization) |
| **Absolute safety net**  | `prevContextTokens > contextWindow * (1 - TOKEN_BUFFER_PERCENTAGE) - reservedTokens` | Always active; fires at ~90% of context window minus output reservation regardless of percentage setting                |

The safety net is hardcoded via [`TOKEN_BUFFER_PERCENTAGE = 0.1`](extensions/shofer/src/core/context-management/index.ts:26) — meaning condensation **will always trigger by ~90% utilization** even if the user-configured percentage threshold is set higher (e.g., 100%). The percentage threshold is user-configurable between [`MIN_CONDENSE_THRESHOLD (5%)`](extensions/shofer/src/core/condense/index.ts:111) and [`MAX_CONDENSE_THRESHOLD (100%)`](extensions/shofer/src/core/condense/index.ts:112). Each API profile can also override the global threshold via [`profileThresholds`](extensions/shofer/src/core/context-management/index.ts:228).

### Invocation Points

[`manageContext()`](extensions/shofer/src/core/context-management/index.ts:255) is called in three places:

1. **Every API request** — In [`Task.attemptApiRequest()`](extensions/shofer/src/core/task/Task.ts:4955), before sending messages to the model. A pre-check via [`willManageContext()`](extensions/shofer/src/core/task/Task.ts:4887) determines whether to show an in-progress UI indicator.
2. **Context window exceeded recovery** — In [`Task.handleContextWindowExceededError()`](extensions/shofer/src/core/task/Task.ts:4724), forced with [`FORCED_CONTEXT_REDUCTION_PERCENT`](extensions/shofer/src/core/task/Task.ts:4731) (aggressive reduction after API error).
3. **Manual condensation** — In [`Task.condenseContext()`](extensions/shofer/src/core/task/Task.ts:2045), triggered by user action (calls [`summarizeConversation()`](extensions/shofer/src/core/condense/index.ts:256) directly with `isAutomaticTrigger: false`).

### Process

1. Extracts messages since last summary via [`getMessagesSinceLastSummary()`](extensions/shofer/src/core/condense/index.ts:525)
2. Injects synthetic tool_results for orphan tool_calls via [`injectSyntheticToolResults()`](extensions/shofer/src/core/condense/index.ts:134) — prevents API rejections
3. Converts tool_use/tool_result blocks to text via [`transformMessagesForCondensing()`](extensions/shofer/src/core/condense/index.ts:102) (no tools param needed for summarization call)
4. Removes image blocks via [`maybeRemoveImageBlocks()`](extensions/shofer/src/core/condense/index.ts:320)
5. Calls LLM with a constructed prompt: the custom condensing prompt ([`customCondensingPrompt`](extensions/shofer/src/core/condense/index.ts:305), from user settings `customSupportPrompts.CONDENSE`) or the default [`supportPrompt.default.CONDENSE`](extensions/shofer/src/core/condense/index.ts:305)
6. Builds a summary message with **multiple content blocks**:
    - **Summary text** — The LLM-generated summary wrapped in `## Conversation Summary`
    - **Command blocks** — `<command>` blocks extracted from the original task via [`extractCommandBlocks()`](extensions/shofer/src/core/condense/index.ts:187), preserved in a `<system-reminder>` block to maintain active workflows across condensings
    - **Folded file context** — Signatures-only file definitions via [`generateFoldedFileContext()`](extensions/shofer/src/core/condense/foldedFileContext.ts:76), each file in its own `<system-reminder>` block
    - **Environment details** — Only for automatic condensation ([`isAutomaticTrigger: true`](extensions/shofer/src/core/condense/index.ts:450)); manual condensation skips this because fresh environment details are injected on the next turn
7. Tags all prior messages with [`condenseParent`](extensions/shofer/src/core/task-persistence/apiMessages.ts:30) (non-destructive; messages are hidden, not deleted)
8. Appends the summary message with role `"user"` (fresh-start model)

### Environment Details Handling

- **Automatic condensation** (`isAutomaticTrigger=true`): Environment details are included in the summary because the API request is already in progress and the next user message won't have fresh environment details.
- **Manual condensation** (`isAutomaticTrigger=false`): Environment details are NOT included — fresh environment details will be injected on the very next turn via `getEnvironmentDetails()`.

### Error Handling

Condensation failures are surfaced via localized error strings:

| Error Key                                                                              | Condition                                                                    |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [`condense_not_enough_messages`](extensions/shofer/src/i18n/locales/en/common.json:61) | Fewer than 2 messages to summarize                                           |
| [`condensed_recently`](extensions/shofer/src/i18n/locales/en/common.json:62)           | A recent summary already exists with too few new messages                    |
| [`condense_handler_invalid`](extensions/shofer/src/i18n/locales/en/common.json:63)     | API handler is missing or lacks `createMessage`                              |
| [`condense_api_failed`](extensions/shofer/src/core/condense/index.ts:389)              | API call threw an exception (detailed error info captured in `errorDetails`) |
| [`condense_failed`](extensions/shofer/src/core/condense/index.ts:397)                  | LLM returned an empty summary                                                |

### Fallback to Sliding Window Truncation

If condensation fails (API error, empty response) or has too few messages, falls back to sliding window truncation when `prevContextTokens > allowedTokens`.

## Sliding Window Truncation

Non-destructive approach:

- Messages are **tagged** with [`truncationParent`](extensions/shofer/src/core/task-persistence/apiMessages.ts:35), not deleted
- First message always retained
- Removes oldest visible messages (positional, not priority-based)
- A truncation marker message is inserted at the boundary
- Can restore if user rewinds past truncation point

### Cleanup After Rewind/Delete

When a summary message or truncation marker is deleted (via rewind), [`cleanupAfterTruncation()`](extensions/shofer/src/core/condense/index.ts:659) clears orphaned [`condenseParent`](extensions/shofer/src/core/task-persistence/apiMessages.ts:30) and [`truncationParent`](extensions/shofer/src/core/task-persistence/apiMessages.ts:35) references, restoring previously-hidden messages to active status.

## Events Emitted

- [`condense_context`](extensions/shofer/packages/types/src/context-management.ts:19) — When condensation succeeds
- [`condense_context_error`](extensions/shofer/packages/types/src/context-management.ts:20) — When condensation fails
- [`sliding_window_truncation`](extensions/shofer/packages/types/src/context-management.ts:21) — When truncation occurs

Message data fields ([`packages/types/src/message.ts`](extensions/shofer/packages/types/src/message.ts)):

- [`contextCondense`](extensions/shofer/packages/types/src/message.ts:211): `{ cost, prevContextTokens, newContextTokens, summary, condenseId? }`
- [`contextTruncation`](extensions/shofer/packages/types/src/message.ts:236): `{ truncationId, messagesRemoved, prevContextTokens, newContextTokens }`

### Effective API History

[`getEffectiveApiHistory()`](extensions/shofer/src/core/condense/index.ts:552) filters the full conversation to produce the subset actually sent to the API:

- **Fresh start model**: When a summary exists, returns only messages from the summary onwards
- Filters out messages tagged with [`condenseParent`](extensions/shofer/src/core/task-persistence/apiMessages.ts:30) (replaced by summary) or [`truncationParent`](extensions/shofer/src/core/task-persistence/apiMessages.ts:35) (hidden by truncation)
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
