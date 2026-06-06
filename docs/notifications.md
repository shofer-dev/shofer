# Peer Notifications & Async Messaging

How `send_message_to_task` with `wait=false` delivers peer notifications to a running recipient task — the dedicated FIFO queue, system-prompt injection, and the separation from user messages and sync prompts.

---

## Design

Async peer messages (`wait=false`) use a **dedicated FIFO queue** ([`peerNotificationQueue`](../src/core/task/Task.ts:224–230)) that is completely independent of the user-message queue ([`MessageQueueService`](../src/core/message-queue/MessageQueueService.ts)). This separation ensures:

- Async notifications are **not** treated as user turns (they don't trigger `cancelAndProcessQueuedMessages`)
- Notifications are injected **once** into the system prompt at the start of the next agent loop iteration
- If the recipient is idle (loop not running), notifications accumulate in the queue but are never drained — there's no implicit wake-up

---

## Data Flow

```
Sender Task                              Recipient Task
───────────                              ──────────────

send_message_to_task
  (wait=false)
      │
      ▼
SendMessageToTaskTool.execute()
  async branch (line 247)
      │
      ├─ Validation: rootTaskId, knownPeers, etc.
      ├─ Approval: askApproval("tool", …)
      │
      ▼
targetState.peerNotificationQueue.push({
  senderTaskId, senderTitle, message, timestamp
})                                      ──────────────►  peerNotificationQueue[]
                                                               │
                                                               │  (queue sits; no wake-up)
                                                               │
                                                    ┌──────────▼──────────┐
                                                    │  Next agent loop     │
                                                    │  iteration starts    │
                                                    └──────────┬──────────┘
                                                               │
                                                    getSystemPrompt()
                                                      (line 5457)
                                                               │
                                                    ┌──────────▼──────────┐
                                                    │ peerNotificationQueue│
                                                    │ drained & injected   │
                                                    │ as "PEER MESSAGE"    │
                                                    │ blocks (line 5588)   │
                                                    └──────────┬──────────┘
                                                               │
                                                               ▼
                                                    Queue cleared
                                                    (line 5627)
```

---

## Key Components

### 1. `PeerNotification` type ([`Task.ts:207`](../src/core/task/Task.ts:207))

```typescript
export interface PeerNotification {
	senderTaskId: string // UUID of the sender
	senderTitle: string // Human-readable title of the sender
	message: string // The message body
	timestamp: number // Unix ms when the message was enqueued
}
```

### 2. `peerNotificationQueue` ([`Task.ts:230`](../src/core/task/Task.ts:230))

- Type: `PeerNotification[]`
- Lives on each [`Task`](../src/core/task/Task.ts) instance
- Separate from [`MessageQueueService`](../src/core/message-queue/MessageQueueService.ts) (which handles user messages and sync prompts)
- **No event emission on push** — no `stateChanged`, no `TaskUserMessage`, no wake-up

### 3. Enqueue ([`SendMessageToTaskTool.ts:255–261`](../src/core/tools/SendMessageToTaskTool.ts:255))

```typescript
// Async mode: fire-and-forget
if (targetState) {
	targetState.peerNotificationQueue.push({
		senderTaskId: task.taskId,
		senderTitle,
		message,
		timestamp: Date.now(),
	})
}
```

The push only succeeds when there's a live [`targetState`](../src/core/task/Task.ts) (the recipient is running and has an in-memory Task instance). If the recipient exists only in persisted history (idle/completed), the message is silently dropped — this is a [documented gap](#gaps).

### 4. Injection into system prompt ([`Task.ts:5588–5628`](../src/core/task/Task.ts:5588))

Each agent loop iteration calls [`getSystemPrompt()`](../src/core/task/Task.ts:5457) before making an API request. The function:

1. Checks `this.peerNotificationQueue.length > 0` (line 5592)
2. Formats each notification as a `PEER MESSAGE` block (lines 5596–5599):

```
====
PEER MESSAGE from task <senderTaskId> ("<senderTitle>"):
<message>

You may respond using send_message_to_task(task_id="<senderTaskId>", message=...).
This is a notification — no response is required. If the message is not urgent,
you may finish your current work first and respond later.
```

3. Emits telemetry (`capturePeerMessageReceived`, form: `"system-prompt"`) (lines 5607–5613)
4. Clears the queue: `this.peerNotificationQueue = []` (line 5627)

### 5. Sync path (unchanged)

Sync messages (`wait=true`) use a completely different path:

- Enqueued via [`MessageQueueService.addMessage()`](../src/core/message-queue/MessageQueueService.ts:36)
- Triggers `cancelAndProcessQueuedMessages()` to interrupt the current loop
- Delivered as an annotated user turn with `PEER PROMPT` header
- The sender blocks on a [`pendingSyncResolver`](../src/core/webview/ShoferProvider.ts:185) until the recipient calls `attempt_completion`

See [`SendMessageToTaskTool.ts:156–246`](../src/core/tools/SendMessageToTaskTool.ts:156) for the sync implementation.

---

## When Notifications Are Drained

`getSystemPrompt()` is called at these points in the agent loop:

| Call site                                            | Line | Context                                               |
| ---------------------------------------------------- | ---- | ----------------------------------------------------- |
| [`attemptApiRequest`](../src/core/task/Task.ts:5826) | 5826 | **Every API request** — before each call to the model |
| [`condenseContext`](../src/core/task/Task.ts:2611)   | 2611 | Context condensation (forced truncation)              |
| Condense truncation path                             | 5703 | `manageContext()` during truncation                   |

The primary call site is `attemptApiRequest` — it runs on every iteration of the agent loop:

```
initiateTaskLoop
  → recursivelyMakeShoferRequests
    → attemptApiRequest
      → getSystemPrompt()          ← notifications injected here
      → API call to model
      → tool execution
      → next iteration (loop back)
```

A notification pushed mid-loop (while the recipient is processing a tool) gets picked up cleanly on the **next** `attemptApiRequest` call — the recipient sees it as a system-prompt annotation before it processes its next request.

---

## Separation from MessageQueueService

| Concern               | `peerNotificationQueue`                 | `MessageQueueService`                                                       |
| --------------------- | --------------------------------------- | --------------------------------------------------------------------------- |
| **Purpose**           | Async peer notifications                | User messages, sync prompts                                                 |
| **Delivery**          | System-prompt injection (once per loop) | User-turn injection (interrupts loop)                                       |
| **Triggers wake-up?** | No                                      | Yes (`stateChanged` → `TaskUserMessage` → `cancelAndProcessQueuedMessages`) |
| **Persisted?**        | No (in-memory only)                     | Yes (via `QueuedMessage` in history)                                        |
| **UI visible?**       | No (injected in prompt only)            | Yes (shown in `QueuedMessages` panel)                                       |
| **Cleared on**        | Drained every loop iteration            | Drained on `dequeueMessage()` / `Send Now`                                  |

---

## Gaps

1. **No persistence**: Notifications are in-memory only. If the extension is reloaded while a notification is in the queue, it is lost. This matches the current behavior — idle tasks don't drain notifications, and persisted history would need a separate storage schema.

2. **No delivery to idle tasks**: If the recipient is not running (lifecycle is `idle`, `completed`, or the task exists only in persisted history), the `push` is skipped (`targetState` is `null`). There is no wake-up mechanism — this is intentional: async notifications are for in-flight coordination, not for cold-start delivery.

3. **No delivery to errored tasks**: If the recipient's lifecycle is `error`, the validation block (lines 102–129) rejects before reaching the async branch.

---

## Related Files

| File                                                                                        | Role                                                                               |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [`Task.ts`](../src/core/task/Task.ts)                                                       | Defines `PeerNotification`, `peerNotificationQueue`; drains in `getSystemPrompt()` |
| [`SendMessageToTaskTool.ts`](../src/core/tools/SendMessageToTaskTool.ts)                    | Enqueues notifications in async branch; sync branch uses `MessageQueueService`     |
| [`MessageQueueService.ts`](../src/core/message-queue/MessageQueueService.ts)                | User-message queue (not used by async peer notifications)                          |
| [`ShoferProvider.ts`](../src/core/webview/ShoferProvider.ts)                                | Manages `pendingSyncResolver` for sync path                                        |
| [`send_message_to_task.ts`](../src/core/prompts/tools/native-tools/send_message_to_task.ts) | Tool prompt description                                                            |
