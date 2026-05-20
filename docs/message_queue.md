# Message Queue, Send Now, and Per-Task Drafts

This document describes how user input is buffered while a Task is busy, how
the **Send Now** button cancels the current turn and immediately resumes with
a queued message, and how the chat textarea preserves unsent drafts on a
per-Task basis.

It covers three tightly coupled subsystems:

1. The per-Task **`MessageQueueService`** that holds messages typed while the
   Task is mid-turn.
2. The **Send Now** ("cancel and process queued messages") flow that aborts
   the current API stream without disposing the Task and then drains the
   queue into a fresh loop.
3. The **per-Task input draft** preservation in `ChatView`, which keeps
   half-typed prompts attached to the Task they were typed in.

## Goals

1. Messages typed while the Task is busy must be delivered **in the order
   they were typed** (FIFO), even when delivery races with the Task's own
   ask/answer flow.
2. Pressing **Send Now** must immediately abort whatever the Task is
   currently doing and resume work with the queued message — without
   tearing down the Task instance, and without losing the message.
3. An unsent draft in the chat input must stay with the Task it was typed
   in. Switching to another Task (or starting a new one via the pencil
   icon) must not "drag" the draft along.

## Components and responsibilities

```
┌──────────────────────────┐  postMessage(askResponse|queueMessage)
│  Webview (ChatView.tsx)  │ ──────────────────────────────────────┐
│  - taskDraftsRef         │                                       │
│  - per-task input state  │                                       │
└──────────────────────────┘                                       ▼
                                              ┌────────────────────────────────┐
                                              │  Task (src/core/task/Task.ts)  │
                                              │  - messageQueueService         │
                                              │  - handleWebviewAskResponse()  │
                                              │  - processQueuedMessages()     │
                                              │  - cancelAndProcess…Messages() │
                                              │  - _softCancelForQueued…       │
                                              └────────────────────────────────┘
                                                              │ owns
                                                              ▼
                                              ┌────────────────────────────────┐
                                              │  MessageQueueService           │
                                              │  - addMessage()  (push)        │
                                              │  - prependMessage() (unshift)  │
                                              │  - dequeueMessage() (shift)    │
                                              │  - emit("stateChanged")        │
                                              └────────────────────────────────┘
```

The `MessageQueueService` instance is **owned by the Task** (one queue per
Task). The webview is rendered with `messageQueue` taken from the _currently
focused_ Task (`ShoferProvider.getStateToPostToWebview`), which is why a queue
appears to "follow" the focused Task — in reality every Task has its own
queue and the UI just shows the active one.

## ChatView send-path decision

`ChatView.handleSendMessage` chooses between three host messages based on
whether the Task is busy and whether an ask is awaiting:

| Condition (checked in order)                                                                                | Posted message                                                          |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `messagesRef.current.length === 0` (home screen)                                                            | `{ type: "newTask", text, images, worktreeDir }`                        |
| Task is busy: `sendingDisabled \|\| isStreaming \|\| messageQueue.length > 0 \|\| ask === "command_output"` | `{ type: "queueMessage", text, images }`                                |
| `shoferAskRef.current` is set (a known interactive ask is awaiting)                                         | `{ type: "askResponse", askResponse: "messageResponse", text, images }` |
| Otherwise (ongoing task, no ask currently awaiting)                                                         | `{ type: "queueMessage", text, images }`                                |

The **last row** is the important one: the webview MUST NOT post a bare
`messageResponse` when no ask is awaiting. Doing so would land in the
no-ask guard inside `handleWebviewAskResponse` on the host and rely on
the defensive `prependMessage` fallback to be recovered. Routing
through `queueMessage` makes the next `Task.ask()` drain it through the
existing well-tested path with no host-side fallback in the loop.

This rule is enforced as a convention in [AGENTS.md](../AGENTS.md)
("Webview Send-Path Rule").

## FIFO ordering

### The race

Even with the send-path discipline above, there is still a window where
an in-flight `messageResponse` can race the queue drain:

1. User clicks an inline button or types into a real ask → webview posts
   `askResponse: "messageResponse"` for message **A**.
2. Before that message reaches the host, the Task finishes the ask via
   another path → `processQueuedMessages()` runs and calls
   `dequeueMessage()` for whatever was queued.
3. Meanwhile the user types message **B** while the queue is empty →
   `addMessage("B")` → queue = `[B]`.
4. **A** finally arrives in `handleWebviewAskResponse`. By then
   `isAwaitingAskResponse` is `false` (the ask was consumed), so the
   handler enters the **defensive re-enqueue branch**.

If that branch had used `addMessage("A")`, the queue would become
`[B, A]` — reversing the user's send order.

### The fix

`MessageQueueService` exposes two insertion methods:

- `addMessage(text, images)` — append at the back (`Array.push`). Used
  for **new** input from the user (the webview's `queueMessage` path
  ends here).
- `prependMessage(text, images)` — insert at the front (`Array.unshift`).
  Used **only** when re-inserting a message that was just dequeued (or
  raced an `askResponse` past its ask) and must keep its original
  position relative to anything queued in the meantime.

`Task.handleWebviewAskResponse` calls `prependMessage` when it has to
return a `messageResponse` to the queue, preserving FIFO under the race
above:

```ts
if (!this.isAwaitingAskResponse && !this.abort && !this.abandoned) {
	if (askResponse === "messageResponse" && (text || (images && images.length > 0))) {
		this.messageQueueService.prependMessage(text ?? "", images)
	}
	return
}
```

This branch is now a **defensive backstop**, not a routine path: with
the webview send-path discipline above, the no-ask `messageResponse`
would only arrive here under a true race. Other response kinds
(`yesButtonClicked`, `noButtonClicked`, `objectResponse`) carry no user
text and are dropped — they are meaningless without the ask they were
answering.

## Send Now ("cancel and process queued messages")

`Task.cancelAndProcessQueuedMessages()` is the entry point for the
**Send Now** button on a queued message bubble. It must:

- Abort whatever the Task is currently doing (typically a streaming API
  request, possibly blocked on an ask).
- Keep the **same Task instance** alive so the conversation context is
  preserved.
- Restart the Task loop with the queued message as the next user turn.

### Three problems and their fixes

#### 1. `ask()` would hang on Send Now

`Task.ask()` parks on `pWaitFor(() => this.askResponse !== undefined)` until
the user answers. A Send Now triggered while the Task is awaiting an ask
would set `this.abort = true` but never satisfy the `pWaitFor` predicate,
so the wait would resolve only on its overall timeout — and meanwhile the
Send Now caller's `await this._taskLoopPromise` would never return.

Fix: `ask()`'s `pWaitFor` predicate now also resolves on `this.abort`, and
once it returns we check whether the abort happened **before** the user
ever responded. If so, we throw a dedicated `AskIgnoredError("aborted
while awaiting ask response")`, which unwinds the API loop cleanly:

```ts
await pWaitFor(() => this.askResponse !== undefined || this.abort, { interval: 100 })

if (this.abort && this.askResponse === undefined && this.lastMessageTs === askTs) {
	throw new AskIgnoredError("aborted while awaiting ask response")
}
```

#### 2. The queued message could be lost during abort

`abortTask()` calls `dispose()` on the Task's services, including
`messageQueueService.dispose()` which clears the queue. The original
order in `cancelAndProcessQueuedMessages` was:

1. Trigger abort plumbing.
2. Wait for the loop to unwind.
3. `dequeueMessage()`.

If anything along path (1)/(2) ever wiped the queue, the very message
the user just clicked **Send Now** on would be gone.

Fix: dequeue the message **first**, then trigger the abort:

```ts
const queued = this.messageQueueService.dequeueMessage()
if (!queued) return
// ... abort plumbing using `queued.text` / `queued.images`
```

#### 3. The streaming catch must NOT dispose the Task

The streaming code in `recursivelyMakeShoferRequests` has a catch block
that, on stream error, calls `abortTask()` to fully tear down the Task.
But on Send Now we _want_ the abort to propagate up to the streaming
code (to cancel the in-flight API request) **without** disposing the
Task — we still need it to drive a fresh loop with the queued message.

Fix: a new `_softCancelForQueuedMessage` flag on `Task`. When set:

- `cancelAndProcessQueuedMessages` flips the flag, then triggers the
  abort.
- The streaming catch block detects the flag and `break`s out of the
  loop _without_ calling `abortTask()`/`dispose()`.
- `cancelAndProcessQueuedMessages` clears the flag and then drives a
  fresh `recursivelyMakeShoferRequests` call with the dequeued message.

Pseudo-code:

```ts
// in recursivelyMakeShoferRequests' stream catch:
if (this._softCancelForQueuedMessage) {
	break // unwind only; leave the Task instance alive
}
await this.abortTask() // normal hard-abort path
```

### End-to-end Send Now sequence

```
ChatView                Task                       MessageQueueService
   │ click Send Now      │                                   │
   ├──────────cancelAndProcessQueuedMessages()──────────────▶│
   │                     │                                   │
   │                     │ dequeueMessage() ─────────────────▶
   │                     │◀──────── { text, images } ────────┤
   │                     │                                   │
   │                     │ _softCancelForQueuedMessage = true│
   │                     │ trigger abort (signal API stream) │
   │                     │ pWaitFor in ask() resolves on     │
   │                     │   this.abort                      │
   │                     │ ask() throws AskIgnoredError      │
   │                     │ stream catch sees soft-cancel,    │
   │                     │   `break`s instead of dispose     │
   │                     │ _softCancelForQueuedMessage = false│
   │                     │                                   │
   │                     │ say("user_feedback", text, images)│
   │                     │ recursivelyMakeShoferRequests([... │
   │                     │       { type:"text", text } ...]) │
```

## Per-Task input drafts (`ChatView`)

`ChatView` is mounted **once** for the lifetime of the webview. Its
`inputValue`, `selectedImages`, and `droppedContextFiles` are local
React state, so without scoping they would persist verbatim across Task
switches — meaning a draft typed for Task A would visibly appear in
Task B when the user switched.

### Snapshot-and-restore via `useRef`

A ref-backed map keyed by Task id holds the per-Task draft:

```ts
const taskDraftsRef = useRef<
  Map<string, { inputValue: string; selectedImages: string[]; droppedContextFiles: ... }>
>(new Map())
const previousTaskIdRef = useRef<string | undefined>(currentTaskItem?.id)
```

A `useEffect` keyed on `currentTaskItem?.id` performs the swap whenever
the focused Task changes:

1. Save the outgoing Task's draft into the map (read via
   `inputValueRef.current` — see below).
2. Restore the incoming Task's draft from the map (or clear if none).
3. Update `previousTaskIdRef`.

We deliberately keep the map in `useRef`, not state — other Tasks'
drafts changing must not trigger a re-render of the chat view.

### The pencil / new-chat race

The "start a new Task" button (pencil icon) fires `handleChatReset()`,
which performs housekeeping (clearing auto-approval timeouts, resetting
ask/button state) but does **not** touch `inputValue`, `selectedImages`,
or `droppedContextFiles`. When `currentTaskItem.id` subsequently flips
to the new Task id, the task-id `useEffect` described above fires and
snapshots the outgoing draft using the still-intact input value — so the
draft is saved before the incoming task's (empty) state is restored.

An earlier version of this code cleared `inputValue` inside
`handleChatReset`, which caused the outgoing draft to be wiped before
the `useEffect` could read it. The fix was to remove that clear and
make the `useEffect` the single source of truth for snapshot/restore.

### Why `inputValueRef.current` and not `inputValue`?

`inputValue` is captured by the effect's closure when the effect was
_last_ registered, not when it _runs_. If we depended on `inputValue`,
the effect would re-fire on every keystroke (defeating the purpose).
We instead mirror `inputValue` into `inputValueRef` on every change and
read the ref at swap time — so the effect only re-runs on task-id
changes but always sees the latest text.

## Files

- [src/core/message-queue/MessageQueueService.ts](../src/core/message-queue/MessageQueueService.ts) —
  per-Task FIFO queue; `addMessage` / `prependMessage` / `dequeueMessage`.
- [src/core/task/Task.ts](../src/core/task/Task.ts) —
  `messageQueueService` ownership, `handleWebviewAskResponse`,
  `processQueuedMessages`, `cancelAndProcessQueuedMessages`,
  `_softCancelForQueuedMessage`, the `ask()` abort observation.
- [src/core/webview/ShoferProvider.ts](../src/core/webview/ShoferProvider.ts) —
  exposes the focused Task's queue to the webview via
  `getStateToPostToWebview` and `focusTask`.
- [webview-ui/src/components/chat/ChatView.tsx](../webview-ui/src/components/chat/ChatView.tsx) —
  `taskDraftsRef`, the task-id swap effect, and the
  per-Task input draft lifecycle (`handleChatReset`
  preserves drafts so the `useEffect` can snapshot them).

## Related

- [cancellation.md](cancellation.md) — full Stop / abort propagation
  end-to-end. Send Now is a _soft_ variant of that flow that avoids the
  final `abortTask()`/`dispose()` step.
- [task_states.md](task_states.md) — Task lifecycle and focus model.
