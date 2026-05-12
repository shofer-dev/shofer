# Shofer Context Management & Summarization

## Overview

Shofer uses a **reactive** approach to context management — condensation/truncation is triggered when approaching context window limits, not proactively on every request.

## Key Components

### 1. Context Management (`src/core/context-management/index.ts`)

Main entry point for context management. Combines:

- **Condensation** (LLM-based summarization)
- **Sliding window truncation** (fallback)

Key exports:

- `manageContext()` - Main function to manage context
- `truncateConversation()` - Non-destructive sliding window (tags messages as hidden)
- `willManageContext()` - Checks if context management will be triggered
- `estimateTokenCount()` - Token counting via provider
- `TOKEN_BUFFER_PERCENTAGE = 0.1` - 10% buffer that acts as hard safety net (condensation/truncation triggers at ~90% usage regardless of percentage threshold)

### 2. Condense Module (`src/core/condense/index.ts`)

Handles LLM-based summarization of conversation history.

Key exports:

- `summarizeConversation()` - Main summarization function
- `getMessagesSinceLastSummary()` - Get messages to summarize
- `getEffectiveApiHistory()` - Get history with summaries applied
- `transformMessagesForCondensing()` - Converts tool blocks to text
- `toolUseToText()`, `toolResultToText()` - Convert tool calls for summarization
- `injectSyntheticToolResults()` - Handle orphan tool calls

Constants:

- [`MIN_CONDENSE_THRESHOLD = 5`](extensions/shofer/src/core/condense/index.ts:111) - Minimum user-configurable % of context window for condensation trigger
- [`MAX_CONDENSE_THRESHOLD = 100`](extensions/shofer/src/core/condense/index.ts:112) - Maximum user-configurable %
- Note: [`TOKEN_BUFFER_PERCENTAGE = 0.1`](extensions/shofer/src/core/context-management/index.ts:26) acts as a hard safety net—condensation/truncation fires when tokens exceed 90% of context window minus output reservation
- Default [`autoCondenseContextPercent = 90`](extensions/shofer/src/core/task/Task.ts:4460) per the Task state

### 3. System Prompt Generation (`src/core/webview/generateSystemPrompt.ts`)

Constructs system prompts with:

- Mode role definitions
- Custom instructions (`.roorules`, user settings)
- MCP tool schemas
- Todo list instructions
- Agent rules (AGENTS.md files)

Uses `SYSTEM_PROMPT()` from `src/core/prompts/system.ts`

## How Condensation Works

1. **Dual Trigger Mechanism** (either condition fires condensation):

    | Trigger                  | Formula                                               | Default Behavior                                                                                           |
    | ------------------------ | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
    | **Percentage threshold** | `contextPercent >= effectiveThreshold`                | Default `autoCondenseContextPercent = 90` (triggers at 90% utilization)                                    |
    | **Absolute safety net**  | `prevContextTokens > contextWindow * 0.9 - maxTokens` | Always active; fires at ~90% of context window (minus output reservation) regardless of percentage setting |

    The safety net is hardcoded via [`TOKEN_BUFFER_PERCENTAGE = 0.1`](extensions/shofer/src/core/context-management/index.ts:26) — meaning condensation **will always trigger by ~90% utilization** even if the user-configured percentage threshold is set higher (e.g., 100%). The percentage threshold is user-configurable between [`MIN_CONDENSE_THRESHOLD (5%)`](extensions/shofer/src/core/condense/index.ts:111) and [`MAX_CONDENSE_THRESHOLD (100%)`](extensions/shofer/src/core/condense/index.ts:112).

2. **Invocation point**: [`manageContext()`](extensions/shofer/src/core/context-management/index.ts:255) is called at the start of every API request in [`Task.attemptApiRequest()`](extensions/shofer/src/core/task/Task.ts:4580), before sending messages to the model.

3. **Process**:

    - Extracts messages since last summary via [`getMessagesSinceLastSummary()`](extensions/shofer/src/core/condense/index.ts:525)
    - Converts tool_use/tool_result blocks to text (no tools param needed for summarization call)
    - Calls LLM with [`SUMMARY_PROMPT`](extensions/shofer/src/core/condense/index.ts:114)
    - Tags all prior messages with `condenseParent` (non-destructive; messages are hidden, not deleted)
    - Appends a summary message with role `"user"` (fresh-start model)

4. **Fallback**: If condensation fails (API error, empty response) or has too few messages, falls back to sliding window truncation when `prevContextTokens > allowedTokens`.

## Sliding Window Truncation

Non-destructive approach:

- Messages are **tagged** with `truncationParent`, not deleted
- First message always retained
- Removes oldest messages (positional, not priority-based)
- Can restore if user rewinds past truncation point

## Events Emitted

- `condense_context` - When condensation happens/starts
- `condense_context_error` - When condensation fails
- `sliding_window_truncation` - When truncation occurs

Message fields:

- `contextCondense`: { cost, prevContextTokens, newContextTokens, summary }
- `contextTruncation`: { truncationId, messagesRemoved, prevContextTokens, newContextTokens }

## Source References

- Context Management: `src/core/context-management/index.ts`
- Condensation: `src/core/condense/index.ts`
- System Prompt: `src/core/webview/generateSystemPrompt.ts`, `src/core/prompts/system.ts`
- Tests: `src/core/condense/__tests__/condense.spec.ts`, `src/core/context-management/__tests__/context-management.spec.ts`
- Types: `packages/types/src/message.ts` (ShoferMessage, contextCondense, contextTruncation)
