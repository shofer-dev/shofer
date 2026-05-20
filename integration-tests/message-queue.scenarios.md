# Integration Tests: Message Queue, Send Now, and Per-Task Drafts

> Feature docs: [`docs/message_queue.md`](../docs/message_queue.md),
> [`docs/user-manual/message-queue.md`](../docs/user-manual/message-queue.md)
> Implementation: [`MessageQueueService.ts`](../src/core/message-queue/MessageQueueService.ts),
> [`Task.ts`](../src/core/task/Task.ts),
> [`ChatView.tsx`](../webview-ui/src/components/chat/ChatView.tsx),
> [`webviewMessageHandler.ts`](../src/core/webview/webviewMessageHandler.ts)

## Scenarios

### 1. New message queues when task is busy (streaming)

**Given** a task is in `running` state with an active streaming API response
**When** the user types a message in ChatView and presses Enter
**Then** `handleSendMessage` posts `{ type: "queueMessage", text, images }`
**And** the webviewMessageHandler calls `task.messageQueueService.addMessage(text, images)`
**And** `MessageQueueService` emits `"stateChanged"` with the updated `messages[]`
**And** a `postStateToWebview` round-trip pushes the updated `messageQueue` to the webview
**And** the `QueuedMessages` component renders the new bubble

**Verification**: Inspect `extensionState.messageQueue` after the webview round-trip;
assert `length === 1` and `[0].text` matches the typed message.

### 2. New message queues when task is busy (tool execution window)

**Given** a task is between `api_req_started` finishing and the next ask appearing
**When** the user types a message and presses Enter
**Then** `shoferAskRef.current` is `undefined` → `handleSendMessage` posts `{ type: "queueMessage" }`
**And** the message is queued rather than delivered as a bare `messageResponse`

**Verification**: Assert that `handleWebviewAskResponse` is NOT called with
`askResponse: "messageResponse"` for this message. Assert `addMessage()` was called.

### 3. Queued message drains automatically on next ask

**Given** a task has `messageQueueService.messages.length === 1`
**When** the current tool finishes and `Task.ask()` posts a new `followup` ask
**Then** `processQueuedMessages()` is called at the top of `Task.ask()`
**And** the queued message is dequeued and submitted via `handleWebviewAskResponse("messageResponse", ...)`
**And** the `QueuedMessages` component clears (queue length → 0)

**Verification**: Assert `messageQueueService.isEmpty()` is `true` after the `followup`
ask begins. Assert the queued message text appears as a `user_feedback` ShoferSay
in the chat history.

### 4. Multiple messages preserve FIFO order

**Given** a task is busy streaming
**When** the user types message "A", then "B", then "C" in quick succession
**Then** `addMessage()` is called three times, pushing `[A, B, C]`
**And** when the task drains, the messages are dequeued in order A, B, C

**Verification**: After auto-drain, inspect ShoferMessages for three consecutive
`user_feedback` entries with text "A", "B", "C" in that order.

### 5. Send Now cancels current stream and restarts with queued message

**Given** a task is streaming and has queued message "Fix this now"
**When** the user clicks **Send Now** on the queued message bubble
**Then** `cancelAndSendQueuedMessages` is posted from the webview
**And** `cancelAndProcessQueuedMessages()` is called on the Task
**And** `dequeueMessage()` returns the message BEFORE abort plumbing runs
**And** `this._softCancelForQueuedMessage` is set to `true`
**And** `this.currentRequestAbortController.abort()` is called
**And** `this.abort` is set to `true`
**And** the `pWaitFor` in `Task.ask()` resolves on `this.abort`
**And** `AskIgnoredError("aborted while awaiting ask response")` is thrown
**And** the stream catch block detects `_softCancelForQueuedMessage` and `break`s
**And** `_cleanupOrphanedToolUses()` is called
**And** `_softCancelForQueuedMessage` is reset to `false`
**And** `this.abort` is reset to `false`
**And** `this._taskAbortController` is replaced with a fresh `AbortController`
**And** a `user_feedback` ShoferSay with the dequeued text is emitted
**And** `recursivelyMakeShoferRequests` is called with the dequeued message

**Verification**: Assert the API request was aborted (check `currentRequestAbortController.signal.aborted`
after the flow). Assert the original streaming response is truncated and a new response
for "Fix this now" begins. Assert the task is not disposed and `this.shoferMessages.length`
is greater than before Send Now.

### 6. Send Now does NOT dispose the task

**Given** a task is mid-stream with `_softCancelForQueuedMessage = true`
**When** the stream catch block runs
**Then** `abortTask()` is NOT called
**And** `messageQueueService.dispose()` is NOT called
**And** the queued message is still available for the restart

**Verification**: Assert `Task.abortTask` is never invoked during the Send Now flow.
Assert `messageQueueService.messages` is not cleared.

### 7. Send Now with empty queue is a no-op

**Given** a task is streaming but `messageQueueService.isEmpty()` is `true`
**When** the user clicks Send Now (edge case: UI state drift)
**Then** `cancelAndProcessQueuedMessages()` returns early
**And** no abort or restart occurs

**Verification**: Assert `this.abort` remains `false`. Assert the active stream
continues uninterrupted.

### 8. Per-task draft preserved across task switch

**Given** Task A is focused with `inputValue = "Draft for A"` in ChatView
**When** the user switches to Task B via TaskSelector
**Then** the task-id `useEffect` fires
**And** `taskDraftsRef.current.set(taskAId, { inputValue: "Draft for A", ... })` is called
**And** `inputValue` is set to Task B's restored draft (or cleared if none)

**Verification**: Assert `taskDraftsRef.current.get(taskAId).inputValue === "Draft for A"`.
Assert `inputValue` reflects Task B's draft. Switch back to A and assert `inputValue`
is restored to "Draft for A".

### 9. Per-task draft cleared on send

**Given** Task A has `inputValue = "Something to send"` and `taskDraftsRef` has no entry
**When** the user presses Enter with a valid ask awaiting (`shoferAskRef.current` is set)
**Then** `handleSendMessage` posts `{ type: "askResponse", ... }`
**And** `setInputValue("")` is called (input cleared for next message)
**And** no draft is snapshotted for Task A (it was sent, not abandoned)

**Verification**: After send, assert `inputValue === ""`. Task switch to B and back to A;
assert `inputValue` is still `""` (not the previously-sent message).

### 10. Starting a new task preserves the outgoing draft

**Given** Task A has `inputValue = "Draft for A"`
**When** the user clicks the pencil icon (new task) → `handleChatReset()` fires
**Then** `handleChatReset` does NOT clear `inputValue`
**And** `currentTaskItem.id` flips to a new task ID
**And** the task-id `useEffect` snapshots Task A's draft into `taskDraftsRef`
**And** the new task's input is restored from its (empty) draft

**Verification**: After new task is created, assert `taskDraftsRef.current.get(taskAId).inputValue === "Draft for A"`.
Assert the new task's `inputValue === ""`.

### 11. FIFO preserved under race (prependMessage path)

**Given** a task is processing with an ask awaiting
**When** the user types message "A" into the ask → `messageResponse` is posted
**And** before "A" reaches the host, the ask is consumed by another path
**And** `processQueuedMessages()` runs and dequeues any queued messages
**And** the user types message "B" which is queued via `addMessage("B")`
**Then** "A" arrives in `handleWebviewAskResponse` when `isAwaitingAskResponse` is `false`
**And** `prependMessage("A")` inserts "A" at the FRONT of the queue
**And** the queue is `["A", "B"]` (FIFO, not `["B", "A"]`)

**Verification**: After the race resolves, assert `messageQueueService.messages[0].text === "A"`
and `messageQueueService.messages[1].text === "B"`.

### 12. Non-messageResponse asks are dropped when no ask is awaiting

**Given** no ask is awaiting (`isAwaitingAskResponse = false`)
**When** `handleWebviewAskResponse("yesButtonClicked", ...)` is called
**Then** the call returns without side effects (no queue modification, no state change)

**Verification**: Assert `messageQueueService.messages` is unchanged. Assert
`this.askResponse` is still `undefined`.

### 13. Attempt completion drains remaining queue before finalizing

**Given** a task's `messageQueueService` has queued messages
**When** `attempt_completion` tool executes
**Then** `messageQueueService.isEmpty()` is checked BEFORE `emitTaskCompleted`
**And** if non-empty, the head is dequeued and rendered as `user_feedback`
**And** the task loop continues to the next LLM iteration (NOT finalized)

**Verification**: Assert `emitTaskCompleted` is NOT called while the queue is non-empty.
Assert a new `user_feedback` ShoferSay appears containing the dequeued message text.
After the next LLM iteration completes, assert the queue is empty and the task
finalizes correctly.

### 14. Webview re-renders on queue state change

**Given** `MessageQueueService` emits `"stateChanged"` with updated `messages[]`
**When** `ShoferProvider.getStateToPostToWebview()` runs
**Then** `messageQueue` in the `ExtensionState` reflects the current `this.messages`
**And** the webview's `QueuedMessages` component re-renders with the new count and bubbles

**Verification**: After `addMessage("test")`, assert the next `postStateToWebview`
call includes `messageQueue: [{ text: "test", ... }]`. Assert `QueuedMessages`
props reflect the same array.

### 15. Queue does not surface for completed/focused tasks

**Given** Task A is focused (active) with queued messages
**And** Task B is a completed history item with no live queue
**When** the webview renders Task A's state
**Then** `messageQueue` contains Task A's queued messages
**When** the webview renders Task B's state (via history preview or switch)
**Then** `messageQueue` is `[]` (completed tasks have no active queue)

**Verification**: Assert `getStateToPostToWebview` includes
`messageQueue: currentTask?.messageQueueService?.messages ?? []`. For
a completed task where `currentTask` is `undefined`, assert `messageQueue`
is `[]`.
