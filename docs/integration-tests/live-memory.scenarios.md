# Live Memory — Integration Test Scenarios

> Design doc: [`docs/live_memory.md`](../docs/live_memory.md)
> User manual: [`docs/user-manual/live-memory.md`](../docs/user-manual/live-memory.md)
> Implementation: [`src/services/live-memory/manager.ts`](../src/services/live-memory/manager.ts),
> [`src/services/live-memory/conversation-store.ts`](../src/services/live-memory/conversation-store.ts),
> [`src/services/live-memory/question-queue.ts`](../src/services/live-memory/question-queue.ts),
> [`src/services/live-memory/context-window.ts`](../src/services/live-memory/context-window.ts),
> [`src/services/live-memory/llm-client.ts`](../src/services/live-memory/llm-client.ts),
> [`src/services/live-memory/tool-executor.ts`](../src/services/live-memory/tool-executor.ts),
> [`src/core/tools/AskLiveMemoryTool.ts`](../src/core/tools/AskLiveMemoryTool.ts),
> [`src/core/webview/LiveMemoryChatProvider.ts`](../src/core/webview/LiveMemoryChatProvider.ts)

## Prerequisites

- A workspace with at least one API Configuration profile configured and working.
- The workspace should contain a reasonable number of source files (50+ recommended).
- The `liveMemoryEnabled` setting toggled ON.
- An API Configuration profile linked via `liveMemoryApiConfigId`.

---

## Scenario 1: Enable and initialize the agent

**Goal:** Verify the agent starts from Standby and reaches Ready state.

1. Ensure `liveMemoryEnabled` is `true` and a valid profile is linked.
2. Trigger agent startup via the toolbar badge "Start" action or the
   `Shofer: Live Memory: Start` command.
3. Observe the `LiveMemoryStatusBadge` transitions:
   `Standby` → `Initializing...` → `Ready (0%)`.
4. Open the `LiveMemoryPopover`: confirm the linked model name is displayed,
   context usage shows `0 / N` tokens, and the "Start" action is replaced with
   "Stop".

**Expected:** Agent reaches Ready state within 10 seconds. No errors in the
output channel. The popover shows correct model + token window info.

---

## Scenario 2: Ask a simple question via the native tool

**Goal:** Verify the agent can answer a question end-to-end.

1. Start a new Shofer task (Code mode).
2. Ask: "What programming languages are used in this project?"
3. The task agent should call `ask_live_memory` with the question.
4. Verify the Live Memory transitions to `Busy`, processes the question,
   and returns to `Ready`.
5. Verify the answer is relevant to the project (mentions actual files/languages).
6. Check the `LiveMemoryCostTracking`: `totalInputTokens` and
   `totalOutputTokens` should both be > 0.

**Expected:** Answer returned within 120 seconds. Tool call shows in the task's
chat history. The Live Memory chat panel shows the Q&A pair.

---

## Scenario 3: Context files parameter

**Goal:** Verify the agent loads specified files into context.

1. Ask: "What does the file `src/core/tools/BaseTool.ts` export?" with
   `contextFiles: ["src/core/tools/BaseTool.ts"]`.
2. Verify the answer references the file's actual exports.
3. Open the Live Memory popover: confirm `src/core/tools/BaseTool.ts`
   appears in the "Files in context" list with a non-zero `tokenEstimate`.

**Expected:** The file is loaded into context and the answer is file-accurate.
The file persists in context for subsequent questions.

---

## Scenario 4: Conversation persistence across VS Code restarts

**Goal:** Verify the agent's memory survives a restart.

1. Perform Scenario 2 (ask a question, get an answer).
2. Note the answer content and the files-in-context list.
3. Close and re-open the VS Code window (or reload the extension).
4. Open the Live Memory chat panel: confirm the previous Q&A pair is visible.
5. Open the popover: confirm files-in-context are restored (validated against
   current disk state).

**Expected:** Conversation history and file contexts are restored. If a file
was modified externally before reload, it is evicted from context.

---

## Scenario 5: Queue serialization with concurrent questions

**Goal:** Verify multiple concurrent questions are serialized via the FIFO queue.

1. Start 3 Shofer tasks simultaneously (or use `new_task` with
   `is_background=true`).
2. Each task should ask a distinct question via `ask_live_memory`.
3. Observe the Live Memory status: transitions `Ready` → `Busy` → `Ready`
   → `Busy` → `Ready` → `Busy` → `Ready` (no overlapping Busy periods).
4. Verify all 3 answers are returned, each different from the others.
5. Verify the chat panel shows 3 Q&A pairs in FIFO order.

**Expected:** Questions are processed one at a time. No task times out if the
total processing time is under the per-task timeout.

---

## Scenario 6: Timeout handling (hard timeout)

**Goal:** Verify the hard timeout aborts processing and returns an error.

1. Set the agent's model to one known to be very slow (or configure a very short
   timeout, e.g., `timeoutMs: 500`).
2. Ask a question that requires tool calls (e.g., "Read all TypeScript files
   and summarize them").
3. Verify the `ask_live_memory` call returns a timeout error.
4. Verify the Live Memory transitions back to `Ready`.
5. Verify any file reads already completed are retained in context (partial work
   is NOT rolled back).

**Expected:** Timeout error returned to the caller. Agent recovers and can
process the next question. Partially-loaded files remain in context.

---

## Scenario 7: Soft timeout and soft result length hints

**Goal:** Verify advisory parameters are embedded in the prompt but not enforced.

1. Ask a question with `softTimeoutSec: 10` and `softResultLength: 100`.
2. Verify the answer is returned normally (no hard cutoff at 100 chars, no
   abort at 10 seconds unless the model respects the hint).
3. The answer should be reasonably concise given the hint, but this is
   model-dependent.

**Expected:** No hard enforcement — the tool returns normally. The hints are
prompt-embedded as guidance.

---

## Scenario 8: Clear Context

**Goal:** Verify context reset works and preserves cost tracking.

1. Perform Scenarios 2 and 3 (accumulate messages + file contexts).
2. Note the cost tracking values (total input/output tokens, estimated cost).
3. Click "Clear Context" in the popover or run the command.
4. Verify the chat panel shows an empty conversation (no messages).
5. Verify the files-in-context list is empty.
6. Verify the cost tracking values are UNCHANGED (not reset).
7. Ask a new question — verify the agent answers without prior context.

**Expected:** Messages and file contexts are dropped. Cost tracking is preserved.
The agent functions normally after clearing.

---

## Scenario 9: File watcher — external edit invalidation

**Goal:** Verify external file edits are detected and context is invalidated.

1. Load a specific file into context (via Scenario 3's `contextFiles`).
2. Note the file's presence in the files-in-context list.
3. Edit that file externally (e.g., `echo "// modified" >> <file>`).
4. Wait ~1 second for the 500ms debounce.
5. Ask a question that requires re-reading the file.
6. Verify the agent re-reads the file (the old content hash no longer matches).

**Expected:** The file watcher detects the change, invalidates the context entry,
and the agent re-reads on next reference.

---

## Scenario 10: File watcher — delete invalidation

**Goal:** Verify deleted files are removed from context.

1. Load a specific file into context.
2. Delete the file from disk (e.g., `rm <file>`).
3. Wait ~1 second.
4. Verify the file is removed from the files-in-context list in the popover.

**Expected:** Deleted files are evicted from context.

---

## Scenario 11: Context window fill and truncation

**Goal:** Verify LRU eviction when the context window is full.

1. If possible, configure a very small context window (e.g., 4000 tokens)
   via the Max Context Tokens override.
2. Ask a series of questions that produce long answers, or load many files
   via `contextFiles`.
3. Monitor the context fill percentage: it should climb toward 100%.
4. When the window is full (over the fill threshold), verify older file contexts
   are evicted (disappear from the files-in-context list).
5. Verify older conversation turns are evicted if file contexts are insufficient.
6. Verify a truncation marker message appears in the conversation.

**Expected:** Truncation occurs with file-context-first, then message-pair
eviction order. The system prompt and directory tree are never truncated.
Truncated tokens are accumulated in `totalTokensTruncated`.

---

## Scenario 12: Toolbar badge states

**Goal:** Verify all toolbar badge states display correctly.

1. Start from **Standby** — badge shows "Standby", no pulsing.
2. Click Start → **Initializing** — badge shows "Initializing...".
3. Wait for **Ready** — badge shows "Ready (0%)", no pulsing.
4. Ask a question → **Busy** — badge shows "Busy (N%)", badge pulses.
5. If context fills past threshold → **Nearly Full** — badge shows
   "Nearly Full (87%)".
6. If config is invalid → **Error** — badge shows "Error".
7. Click Stop → **Standby** — badge returns to Standby.

**Expected:** All six states (`Standby`, `Initializing`, `Ready`, `Busy`,
`Nearly Full`, `Error`) render with distinct visual treatment. The pulsing
animation only activates during `Busy`.

---

## Scenario 13: Chat view panel — live streaming

**Goal:** Verify the chat panel shows live token-by-token updates during Busy.

1. Open the Live Memory chat panel via "View Chat".
2. Ask a question that requires a long answer.
3. Observe the chat panel: the latest answer should appear incrementally
   (partial text, not full replacement).
4. Verify reasoning blocks appear collapsed in `<details>`.
5. Verify tool call blocks appear with spinner while in progress, then
   expand to show args/results when complete.
6. Verify the panel scrolls to follow new content.

**Expected:** Live streaming with incremental DOM updates (no full re-render).
Tool calls render with progress indicators.

---

## Scenario 14: Error recovery

**Goal:** Verify the agent recovers from LLM errors.

1. Configure the agent with an invalid API key or unreachable endpoint.
2. Attempt to start the agent.
3. Verify the state transitions to `Error` (not stuck in `Initializing`).
4. Fix the configuration.
5. Click "Start" again — verify the agent transitions to `Ready`.
6. Ask a question — verify it processes normally.

**Expected:** The `Error` state is reachable and recoverable. The conversation
history prior to the error is not corrupted.

---

## Scenario 15: Stop while Busy

**Goal:** Verify graceful shutdown cancels the current question.

1. Ask a question that takes a long time (e.g., search across many files).
2. While the agent is `Busy`, click "Stop".
3. Verify the current question is aborted and the `ask_live_memory` call
   returns an error.
4. Verify the agent transitions to `Standby`.
5. Verify any queued questions are rejected.

**Expected:** The in-flight LLM call is cancelled. The agent stops cleanly
without leaving zombie state. Queued questions are rejected with appropriate
errors.

---

## Scenario 16: Directory tree in system prompt

**Goal:** Verify the workspace directory tree is injected into the system prompt.

1. Start the agent fresh (Clear Context).
2. Ask: "Based on the workspace directory tree you can see in your system prompt,
   what top-level directories exist in this project?"
3. Verify the answer lists actual top-level directories (`src/`, `docs/`,
   `packages/`, etc.) without the agent having called `list_files`.

**Expected:** The agent can answer directory-structure questions from its system
prompt without tool calls, confirming the directory tree is injected.

---

## Scenario 17: Multi-workspace isolation

**Goal:** Verify each workspace has its own independent live memory.

1. Open two VS Code windows with different workspaces, each with Shofer.
2. In workspace A, ask: "What is in the src directory of project A?"
3. In workspace B, ask: "What is in the src directory of project B?"
4. Verify each agent answers about its own workspace.
5. Verify workspace A's conversation does not appear in workspace B's chat panel.

**Expected:** Complete isolation between workspaces. Each has independent
conversation history, file context, and configuration.
