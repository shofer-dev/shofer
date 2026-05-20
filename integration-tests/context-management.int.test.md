# Integration Tests: Context Management & Condensation

> Feature docs: [`docs/summarization.md`](../docs/summarization.md),
> [`docs/user-manual/context-management.md`](../docs/user-manual/context-management.md)
> Implementation: [`context-management/index.ts`](../src/core/context-management/index.ts),
> [`condense/index.ts`](../src/core/condense/index.ts),
> [`condense/foldedFileContext.ts`](../src/core/condense/foldedFileContext.ts),
> [`Task.ts`](../src/core/task/Task.ts)

## Scenarios

### 1. Automatic condensation triggers at percentage threshold

**Given** a task is running with `autoCondenseContextPercent = 90` on a 200K context window
**When** the accumulated token count crosses 90% of the context window
**Then** `manageContext()` calls `summarizeConversation()` with `isAutomaticTrigger: true`
**And** a `condense_context` ShoferSay message is emitted
**And** the context window bar in TaskHeader updates to reflect the new, smaller token count

**Verification**: Monitor `shoferMessages` for a `condense_context` say event. Confirm
the returned `newContextTokens` is lower than `prevContextTokens`. Confirm the
`condenseId` field is set on the summary message and `condenseParent` is set on all
prior messages.

### 2. Automatic condensation triggered by absolute safety net

**Given** a task has `autoCondenseContextPercent = 100` (threshold effectively disabled)
**When** the token count exceeds `contextWindow * (1 - TOKEN_BUFFER_PERCENTAGE) - reservedTokens`
**Then** condensation (or sliding window truncation) still fires
**And** the "Context safety net triggered" diagnostic log appears

**Verification**: Set threshold to 100, pump 95%+ tokens into history, assert
`manageContext()` returns a condensed or truncated result set.

### 3. Sliding window truncation fallback on condense failure

**Given** a task reaches the condensation threshold
**When** the condensation API call throws an error (simulate via mock)
**Then** `manageContext()` falls back to `truncateConversation()`
**And** a `sliding_window_truncation` ShoferSay message is emitted
**And** the returned messages include a truncation marker with `isTruncationMarker: true`
**And** all truncated messages have `truncationParent` set

**Verification**: Throw from the mocked `apiHandler.createMessage()` inside
`summarizeConversation()`, assert `truncationId` is present in the result and
`truncationParent` is set on the oldest visible messages (excluding the first).

### 4. Manual condensation (user-initiated)

**Given** a task with an active conversation of 50 messages
**When** the user triggers `condenseContext()` via slash command
**Then** `summarizeConversation()` is called with `isAutomaticTrigger: false`
**And** environment details are NOT included in the summary text
**And** the summary is appended as a `role: "user"` message with `isSummary: true`

**Verification**: Check the summary content blocks — no `<environment_details>`
block should be present when `isAutomaticTrigger` is false.

### 5. Per-profile threshold override

**Given** a task using an API profile with `profileThresholds["profile-abc"] = 75`
**When** token usage reaches 75% of the context window
**Then** condensation fires (not at the global 90% default)
**And** the effective threshold is logged as 75% in `[CONTEXT-DIAG]` output

**Given** the same profile has `profileThresholds["profile-abc"] = -1`
**When** token usage reaches 90% (global default)
**Then** condensation fires at the global threshold

**Verification**: Test with three cases: (a) explicit threshold, (b) `-1` (inherit),
(c) profile not in `profileThresholds` (falls back to global).

### 6. Profile threshold validation rejects invalid values

**Given** a profile has `profileThresholds["profile-abc"] = 150` (exceeds `MAX_CONDENSE_THRESHOLD`)
**When** `manageContext()` or `willManageContext()` resolves the effective threshold
**Then** the invalid value is ignored and the global threshold is used
**And** a warning is logged: `"Invalid profile threshold 150 for profile "profile-abc""`

**Verification**: Set threshold to 0, 150, and -5. All should fall back to the global
default, with a warning emitted to the output channel.

### 7. `willManageContext()` matches `manageContext()` threshold logic

**Given** any combination of `totalTokens`, `contextWindow`, `maxTokens`, `autoCondenseContextPercent`,
and `profileThresholds`
**When** `willManageContext()` returns `true`
**Then** `manageContext()` will attempt condensation or truncation under the same conditions

**Verification**: Fuzz-test with random values; assert that the effective threshold
computation in both functions produces the same `contextPercent >= effectiveThreshold` result.

### 8. Dual threshold resolution avoids copy-paste drift

**Given** the effective threshold resolution logic is duplicated in `willManageContext()`
(line 188–198) and `manageContext()` (line 295–312)
**When** a change is made to one block
**Then** a test compares the two blocks character-for-character (or at least logic-for-logic)

**Verification**: Extract both threshold resolution blocks into a helper
`resolveEffectiveThreshold()` and assert both call sites use it. If refactoring is
not done, maintain a byte-level diff test.

### 9. Cleanup after summary message deletion (rewind)

**Given** a task with a condensed conversation (summary + tagged messages)
**When** the user rewinds past the summary message (deleting it)
**Then** `cleanupAfterTruncation()` clears the orphaned `condenseParent` fields
**And** the previously-hidden messages become visible again in `getEffectiveApiHistory()`

**Verification**: Create a conversation, condense it, delete the summary,
call `cleanupAfterTruncation()`, assert no message has a `condenseParent` that
doesn't point to an existing summary.

### 10. Orphan tool_result filtering in effective history

**Given** a condensed conversation where a `tool_use` was in the condensed-away portion
**When** `getEffectiveApiHistory()` encounters a `tool_result` referencing that orphaned `tool_use` ID
**Then** the orphan `tool_result` block is filtered out
**And** if the user message becomes empty after filtering, the entire message is removed

**Verification**: Build a conversation with a `tool_use` → summary → `tool_result`
(orphan) chain, call `getEffectiveApiHistory()`, assert the orphan `tool_result` is
absent from the result.

### 11. Synthetic tool_result injection before condensation

**Given** a conversation with an unanswered `tool_use` block (e.g., `attempt_completion` pending)
**When** `summarizeConversation()` is called
**Then** `injectSyntheticToolResults()` appends a user message with synthetic `tool_result` blocks
**And** the synthetic message text reads "Context condensation triggered. Tool execution deferred."

**Verification**: Create a conversation ending with an assistant `tool_use` (no matching
`tool_result`), run `summarizeConversation()`, inspect the messages passed to the API — they
should include a synthetic user message with one `tool_result` per orphan `tool_use`.

### 12. Folded file context generation

**Given** a task that has read 3 TypeScript files via `read_file`
**When** `summarizeConversation()` is called with `filesReadByRoo` and `cwd`
**Then** `generateFoldedFileContext()` is called
**And** each successfully parsed file gets its own `<system-reminder>` block in the summary content
**And** files that fail or are unsupported are skipped with a batch warning log

**Verification**: Provide file paths, mock `parseSourceCodeDefinitionsForFile()` to return
signatures for 2/3 files, assert 2 `<system-reminder>` blocks appear in the summary and
1 file is counted as skipped.

### 13. Folded file context respects maxCharacters limit

**Given** `generateFoldedFileContext()` with `maxCharacters = 500`
**When** processing 10 files where each would contribute ~200 characters
**Then** only the first 2 files are included (total < 500) and the 3rd file is truncated
**And** remaining files are skipped with a count in `filesSkipped`

**Verification**: Set a low character limit, pass many files, assert `filesProcessed + filesSkipped = totalFiles`.

### 14. Summary message uses "user" role (fresh-start model)

**Given** a condensation operation completes successfully
**When** the summary message is appended to `apiConversationHistory`
**Then** the summary message has `role: "user"` and `isSummary: true`
**And** a unique `condenseId` is assigned
**And** the message timestamp is `lastMsgTs + 1` (immediately after the last original message)

**Verification**: Inspect the returned `ApiMessage[]` — the last element should have
`role: "user"` and `isSummary: true`.

### 15. `condensed_recently` guard

**Given** a conversation where condensation just ran (a summary exists in the last 2 messages)
**When** `summarizeConversation()` is called again
**Then** it returns an error with `t("common:errors.condensed_recently")`
**And** no API call is made

**Verification**: Condense → immediately call condense again → assert error string.

### 16. Error string localization keys resolve correctly

**Given** each documented error key in `docs/summarization.md`:
`condense_not_enough_messages`, `condensed_recently`, `condense_handler_invalid`,
`condense_api_failed`, `condense_failed`
**When** the corresponding condition is triggered
**Then** the error message is a non-empty string (not the raw key)

**Verification**: For each error condition, trigger it and assert the returned string
does not start with `"common:errors."`.

### 17. `ContextManagementResult` carries all fields from `SummarizeResponse`

**Given** `manageContext()` completes successfully via condensation
**When** the result is returned
**Then** it includes `summary`, `cost`, `messages`, `newContextTokens`, and `condenseId`
(from `SummarizeResponse`) AND `prevContextTokens` (from `ContextManagementResult`).

**Given** `manageContext()` falls back to truncation
**Then** it additionally includes `truncationId`, `messagesRemoved`, and `newContextTokensAfterTruncation`.

**Verification**: Call both paths and assert the field superset property.

### 18. Telemetry emitted on condense and truncation

**Given** condensation succeeds
**When** `summarizeConversation()` returns without error
**Then** `TelemetryService.instance.captureContextCondensed()` is called with
`(taskId, isAutomaticTrigger, !!customCondensingPrompt?.trim())`.

**Given** truncation occurs
**When** `truncateConversation()` is called
**Then** `TelemetryService.instance.captureSlidingWindowTruncation()` is called with `(taskId)`.

**Verification**: Spy on `TelemetryService.instance` and assert the correct capture
methods are called with the expected arguments.
